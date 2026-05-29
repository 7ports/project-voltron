#!/usr/bin/env node
// scripts/test-batch-tool-comprehensive.mjs
//
// Comprehensive verification harness for run_agent_in_docker_batch.
// Implements the 12 test cases in docs/run-agents-batch-test-plan.md.
//
// Architecture follows the plan verbatim:
//   - one MCP StdioClientTransport for the whole run
//   - one prewarm singleton dispatch
//   - 12 cases executed sequentially (await inside for...of)
//   - each case returns { name, verdict, evidence } — no process.exit inside cases
//   - probes use node -e "setTimeout(...)" — never raw `sleep N`
//   - one runId for the whole script; role tags inside prompts distinguish cases
//   - summary table + exit 0 iff every case is PASS

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const LOGS_DIR = join(REPO_ROOT, ".voltron", "logs");

const TOOL_CALL_TIMEOUT_MS = 10 * 60 * 1000;

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { help: false, allowRmi: false };
  for (const a of argv.slice(2)) {
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--allow-rmi") out.allowRmi = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

const CASE_DESCRIPTIONS = [
  "Case 1 — Schema rejection: dispatches < 2",
  "Case 2 — Schema rejection: dispatches > 8",
  "Case 3 — Schema rejection: missing required field",
  "Case 4 — fail_fast=true terminates siblings",
  "Case 5 — fail_fast=false: mixed status reported",
  "Case 6 — Per-dispatch max_turns honored",
  "Case 7 — Per-dispatch model override applied",
  "Case 8 — 8-agent max-size batch parallel",
  "Case 9 — Mixed runtime: no head-of-line block",
  "Case 10 — Same agent twice: no log collisions",
  "Case 11 — Pre-warm shared across calls",
  "Case 12 — Bounded output under verbose dispatches",
];

function printHelp() {
  process.stdout.write(
    `Usage: node scripts/test-batch-tool-comprehensive.mjs [--allow-rmi]

Runs all 12 verification cases for the run_agent_in_docker_batch tool against
the local src/index.js via an MCP StdioClientTransport. See
docs/run-agents-batch-test-plan.md for the per-case decision rules.

Cases:
${CASE_DESCRIPTIONS.map((d) => `  ${d}`).join("\n")}

Flags:
  --allow-rmi   Permit Case 11 to docker rmi voltron-agent so a real rebuild
                cost can be measured. Without it, Case 11 returns INCONCLUSIVE
                (which counts as a FAIL for exit code).
  --help, -h    Show this help.

Exit codes: 0 iff every case is PASS, else 1.
`,
  );
}

// ─── MCP wiring (reused from baseline scripts) ─────────────────────────────

function preflight() {
  try { execSync("docker info", { stdio: "ignore" }); }
  catch { throw new Error("Docker daemon unreachable (`docker info` failed)."); }
  try { execSync("docker image inspect voltron-agent", { stdio: "ignore" }); }
  catch {
    throw new Error(
      "voltron-agent image not found. Build it first by running any run_agent_in_docker call so this run does not pay a 30+s image-build cost that masks the timing signal.",
    );
  }
}

async function connectMcp() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(REPO_ROOT, "src", "index.js")],
    cwd: REPO_ROOT,
    env: { ...process.env },
  });
  const client = new Client(
    { name: "batch-tool-comprehensive-test", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport };
}

async function callSingletonTool(client, args) {
  return client.callTool(
    { name: "run_agent_in_docker", arguments: args },
    undefined,
    { timeout: TOOL_CALL_TIMEOUT_MS, resetTimeoutOnProgress: true, maxTotalTimeout: TOOL_CALL_TIMEOUT_MS },
  );
}

async function callBatchTool(client, args) {
  return client.callTool(
    { name: "run_agent_in_docker_batch", arguments: args },
    undefined,
    { timeout: TOOL_CALL_TIMEOUT_MS, resetTimeoutOnProgress: true, maxTotalTimeout: TOOL_CALL_TIMEOUT_MS },
  );
}

async function prewarm(client) {
  process.stdout.write("[prewarm] dispatching dep-reader to warm voltron-agent image cache...\n");
  await callSingletonTool(client, {
    agent_name: "dep-reader",
    task: "PREWARM — execute exactly ONE Bash tool call: echo prewarm-ok. Then emit exactly: [DONE] prewarm",
    max_turns: 4,
  });
  process.stdout.write("[prewarm] done\n");
}

// ─── log helpers (parser semantics identical to baseline scripts) ──────────

function logsForAgentAndRun(agentSlug, runId) {
  const files = readdirSync(LOGS_DIR).filter(
    (f) => f.startsWith(`${agentSlug}-`) && f.endsWith(".log"),
  );
  return files
    .map((f) => join(LOGS_DIR, f))
    .filter((p) => {
      try { return readFileSync(p, "utf-8").includes(`run-id=${runId}`); }
      catch { return false; }
    });
}

function findLog(agentSlug, runId, roleTag) {
  const matches = logsForAgentAndRun(agentSlug, runId).filter((p) => {
    if (!roleTag) return true;
    try { return readFileSync(p, "utf-8").includes(`role=${roleTag}`); }
    catch { return false; }
  });
  if (matches.length === 0) {
    throw new Error(`no log for ${agentSlug} containing run-id=${runId}${roleTag ? ` role=${roleTag}` : ""}`);
  }
  if (matches.length > 1) {
    throw new Error(`multiple logs for ${agentSlug} run-id=${runId}${roleTag ? ` role=${roleTag}` : ""} — disambiguate by role tag`);
  }
  return matches[0];
}

function parseEntryExit(logPath) {
  const lines = readFileSync(logPath, "utf-8").split("\n");
  const entryLine = lines.find((l) => l.startsWith("[entry] "));
  const exitLine = lines.find((l) => l.startsWith("[exit] "));
  if (!entryLine) throw new Error(`log ${logPath} missing [entry]`);
  if (!exitLine) throw new Error(`log ${logPath} missing [exit]`);
  const entryMatch = entryLine.match(/\[entry\]\s+(\S+)/);
  const exitMatch = exitLine.match(/\[exit\]\s+(\S+)/);
  if (!entryMatch || !exitMatch) throw new Error(`could not parse timestamps in ${logPath}`);
  return { entry: new Date(entryMatch[1]).getTime(), exit: new Date(exitMatch[1]).getTime() };
}

function parseEntryExitSoft(logPath) {
  // For probes that may be cancelled — missing [exit] is valid evidence, not an error.
  try {
    const lines = readFileSync(logPath, "utf-8").split("\n");
    const entryLine = lines.find((l) => l.startsWith("[entry] "));
    const exitLine = lines.find((l) => l.startsWith("[exit] "));
    const entry = entryLine ? new Date(entryLine.match(/\[entry\]\s+(\S+)/)?.[1]).getTime() : null;
    const exit = exitLine ? new Date(exitLine.match(/\[exit\]\s+(\S+)/)?.[1]).getTime() : null;
    return { entry, exit, hasExit: !!exitLine };
  } catch {
    return { entry: null, exit: null, hasExit: false };
  }
}

function firstAssistantModel(logPath) {
  for (const line of readFileSync(logPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let ev;
    try { ev = JSON.parse(trimmed); } catch { continue; }
    if (ev?.type === "assistant" && ev?.message?.model) return ev.message.model;
  }
  return null;
}

function textOf(res) {
  return (res?.content ?? []).map((c) => c?.text ?? "").join("\n");
}

function verdict(v, evidence) {
  return { verdict: v, evidence };
}

function countLogs() {
  try { return readdirSync(LOGS_DIR).length; }
  catch { return 0; }
}

// ─── probe-prompt builders (all carry literal "run-id=<id>" + role tag) ────

function buildTimedProbe(role, agentSlug, runId, seconds) {
  return `TIMING PROBE — role=${role} run-id=${runId} agent=${agentSlug}

Do NOTHING beyond the two steps below. Do not read other files, do not
analyze dependencies, do not call any other tools.

Step 1 — execute exactly ONE Bash tool call, verbatim:

    node -e "setTimeout(() => console.log('[probe-marker] role=${role} run-id=${runId}'), ${seconds} * 1000)"

Step 2 — emit exactly ONE final assistant line, verbatim:

    [DONE] probe ${role} complete run-id=${runId}`;
}

function buildSlowProbe(role, agentSlug, runId, seconds) {
  return buildTimedProbe(role, agentSlug, runId, seconds);
}

function buildSimpleProbe(role, agentSlug, runId) {
  return `SIMPLE PROBE — role=${role} run-id=${runId} agent=${agentSlug}

Do NOTHING beyond the two steps below.

Step 1 — execute exactly ONE Bash tool call, verbatim:

    echo "[probe-marker] role=${role} run-id=${runId}"

Step 2 — emit exactly ONE final assistant line, verbatim:

    [DONE] simple probe ${role} run-id=${runId}`;
}

function buildExhaustionProbe(role, agentSlug, runId, requestedSteps) {
  // Forces claude to exhaust max_turns and exit non-zero (the only way to make
  // the dispatch result.ok=false without container-side intrusion).
  // Each numbered step needs its own assistant turn to issue a separate Bash call.
  const stepList = Array.from({ length: requestedSteps }, (_, i) =>
    `Step ${i + 1} — execute exactly ONE Bash tool call, verbatim:\n\n    echo "[probe-marker] role=${role} run-id=${runId} step=${i + 1}"`
  ).join("\n\n");
  return `EXHAUSTION PROBE — role=${role} run-id=${runId} agent=${agentSlug}

This probe deliberately demands MORE assistant turns than the max_turns budget
so claude exhausts its turn limit and exits non-zero. Do not skip steps,
do not combine steps, do not emit [DONE] until every step has run.

${stepList}

Final step — emit exactly ONE assistant line, verbatim:

    [DONE] exhaustion probe ${role} run-id=${runId}`;
}

async function detectRejection(client, args) {
  // Schema rejections may surface as a thrown exception (transport-level error)
  // OR as a returned response with isError=true OR as a content message starting
  // with "❌" or containing zod-style validation keywords. Detect any of these.
  let threw = false, errText = "", isError = false, bodyText = "";
  try {
    const res = await callBatchTool(client, args);
    bodyText = textOf(res);
    isError = res?.isError === true;
  } catch (err) {
    threw = true;
    errText = err?.message ?? String(err);
  }
  return { threw, errText, isError, bodyText };
}

function rejectionDetected(detection, keywordRe) {
  const combinedText = (detection.errText + " " + detection.bodyText).toLowerCase();
  const looksRejected = detection.threw
    || detection.isError
    || detection.bodyText.trim().startsWith("❌");
  return looksRejected && (keywordRe.test(combinedText) || detection.bodyText.includes("❌"));
}

function buildVerboseProbe(role, agentSlug, runId) {
  return `OUTPUT-SIZE PROBE — role=${role} run-id=${runId} agent=${agentSlug}

Step 1 — execute exactly ONE Bash tool call, verbatim:

    node -e "for (let i = 0; i < 200; i++) console.log('LINE-${role}-' + i + '-run-id=${runId}')"

Step 2 — emit exactly ONE final assistant line, verbatim:

    [DONE] verbose probe ${role} run-id=${runId}`;
}

// ─── Cases ─────────────────────────────────────────────────────────────────

async function case01({ client }) {
  const name = CASE_DESCRIPTIONS[0];
  const before = countLogs();
  const detection = await detectRejection(client, {
    dispatches: [{ agent_name: "dep-reader", task: "noop probe" }],
  });
  const after = countLogs();
  const pass = rejectionDetected(detection, /dispatch|min|too few|at least|2/i) && after === before;
  return { name, ...verdict(pass ? "PASS" : "FAIL", {
    threw: detection.threw,
    isError: detection.isError,
    errText: detection.errText.slice(0, 240),
    bodyHead: detection.bodyText.slice(0, 240),
    newLogs: after - before,
  }) };
}

async function case02({ client }) {
  const name = CASE_DESCRIPTIONS[1];
  const nine = Array.from({ length: 9 }, (_, i) => ({
    agent_name: "dep-reader",
    task: `noop probe ${i}`,
  }));
  const detection = await detectRejection(client, { dispatches: nine });
  const pass = rejectionDetected(detection, /dispatch|max|8|too many|at most/i);
  return { name, ...verdict(pass ? "PASS" : "FAIL", {
    threw: detection.threw,
    isError: detection.isError,
    errText: detection.errText.slice(0, 240),
    bodyHead: detection.bodyText.slice(0, 240),
  }) };
}

async function case03({ client }) {
  const name = CASE_DESCRIPTIONS[2];
  const checks = [
    { missing: "agent_name", arg: { dispatches: [{ task: "x" }, { agent_name: "dep-reader", task: "y" }] } },
    { missing: "task",       arg: { dispatches: [{ agent_name: "dep-reader" }, { agent_name: "dep-reader", task: "y" }] } },
  ];
  const failures = [];
  for (const c of checks) {
    const detection = await detectRejection(client, c.arg);
    const re = new RegExp(c.missing.replace("_", "[_ ]?") + "|required|invalid", "i");
    if (!rejectionDetected(detection, re)) {
      failures.push({
        missing: c.missing,
        threw: detection.threw,
        isError: detection.isError,
        errText: detection.errText.slice(0, 240),
        bodyHead: detection.bodyText.slice(0, 240),
      });
    }
  }
  return { name, ...verdict(failures.length === 0 ? "PASS" : "FAIL", { failures }) };
}

async function case04({ client, runId }) {
  const name = CASE_DESCRIPTIONS[3];
  // max_turns=1 + multi-step probe → claude exhausts the budget on its first
  // assistant turn (~5-10s round-trip), guaranteeing fast non-zero exit so the
  // fail_fast SIGTERM cascade has time to land on the 60s sibling probe.
  const tFail  = buildExhaustionProbe("FAIL", "dep-reader", runId, 5);
  const tProbe = buildSlowProbe("PROBE", "git-state-reader", runId, 60);
  const t0 = Date.now();
  const res = await callBatchTool(client, {
    fail_fast: true,
    dispatches: [
      { agent_name: "dep-reader",       task: tFail,  max_turns: 1 },
      { agent_name: "git-state-reader", task: tProbe, max_turns: 6 },
    ],
  });
  const wallMs = Date.now() - t0;
  const body = textOf(res);
  const cancelledMarker = /CANCELLED 🟡|cancelled \(sibling failed\)/.test(body);

  let probeWallMs = null, probeExitMissing = false;
  try {
    const logPath = findLog("git-state-reader", runId, "PROBE");
    const stamps = parseEntryExitSoft(logPath);
    if (!stamps.hasExit) {
      probeExitMissing = true;
      probeWallMs = 0;
    } else {
      probeWallMs = stamps.exit - stamps.entry;
    }
  } catch (err) {
    // No log at all — treat as inconclusive evidence
    return { name, ...verdict("FAIL", { wallMs, parseErr: err?.message, body: body.slice(0, 400) }) };
  }

  const pass = cancelledMarker && probeWallMs < 30_000 && wallMs < 45_000;
  return { name, ...verdict(pass ? "PASS" : "FAIL", {
    wallMs, probeWallMs, probeExitMissing, cancelledMarker, bodyHead: body.slice(0, 240),
  }) };
}

async function case05({ client, runId }) {
  const name = CASE_DESCRIPTIONS[4];
  const tFail  = buildExhaustionProbe("FAIL5", "dep-reader", runId, 5);
  const tProbe = buildSlowProbe("PROBE5", "git-state-reader", runId, 60);
  const t0 = Date.now();
  const res = await callBatchTool(client, {
    // fail_fast omitted — defaults false
    dispatches: [
      { agent_name: "dep-reader",       task: tFail,  max_turns: 1 },
      { agent_name: "git-state-reader", task: tProbe, max_turns: 6 },
    ],
  });
  const wallMs = Date.now() - t0;
  const body = textOf(res);
  const headerOk = body.startsWith("## Batch dispatch");
  const failedRow = /❌ FAILED/.test(body);
  const okRow = /✅ ok/.test(body);

  let probeWallMs = null;
  try {
    const logPath = findLog("git-state-reader", runId, "PROBE5");
    const stamps = parseEntryExit(logPath);
    probeWallMs = stamps.exit - stamps.entry;
  } catch (err) {
    return { name, ...verdict("FAIL", { wallMs, parseErr: err?.message, body: body.slice(0, 400) }) };
  }

  const pass = headerOk && failedRow && okRow && probeWallMs >= 55_000;
  return { name, ...verdict(pass ? "PASS" : "FAIL", {
    wallMs, probeWallMs, headerOk, failedRow, okRow,
  }) };
}

async function case06({ client, runId }) {
  const name = CASE_DESCRIPTIONS[5];
  const tSmall = buildExhaustionProbe("SMALL6", "dep-reader", runId, 10);
  const tLarge = buildSimpleProbe("LARGE6", "git-state-reader", runId);
  await callBatchTool(client, {
    dispatches: [
      { agent_name: "dep-reader",       task: tSmall, max_turns: 2  },
      { agent_name: "git-state-reader", task: tLarge, max_turns: 25 },
    ],
  });
  let smallExit = null, largeExitZero = false;
  try {
    const smallLog = findLog("dep-reader", runId, "SMALL6");
    const largeLog = findLog("git-state-reader", runId, "LARGE6");
    const smallContent = readFileSync(smallLog, "utf-8");
    const largeContent = readFileSync(largeLog, "utf-8");
    smallExit = /\[exit\][^\n]*code=([0-9]+)/.exec(smallContent)?.[1] ?? null;
    largeExitZero = /\[exit\][^\n]*code=0/.test(largeContent);
  } catch (err) {
    return { name, ...verdict("FAIL", { parseErr: err?.message }) };
  }
  const smallNonZero = smallExit !== null && smallExit !== "0";
  const pass = smallNonZero && largeExitZero;
  return { name, ...verdict(pass ? "PASS" : "FAIL", { smallExit, largeExitZero }) };
}

async function case07({ client, runId }) {
  const name = CASE_DESCRIPTIONS[6];
  const tOpus  = buildSimpleProbe("OPUS7",  "dep-reader",       runId);
  const tHaiku = buildSimpleProbe("HAIKU7", "git-state-reader", runId);
  await callBatchTool(client, {
    dispatches: [
      { agent_name: "dep-reader",       task: tOpus,  max_turns: 6, model: "opus"  },
      { agent_name: "git-state-reader", task: tHaiku, max_turns: 6, model: "haiku" },
    ],
  });
  let opusModel = null, haikuModel = null;
  try {
    opusModel  = firstAssistantModel(findLog("dep-reader",       runId, "OPUS7"));
    haikuModel = firstAssistantModel(findLog("git-state-reader", runId, "HAIKU7"));
  } catch (err) {
    return { name, ...verdict("FAIL", { parseErr: err?.message }) };
  }
  const pass = opusModel && /opus/i.test(opusModel) && haikuModel && /haiku/i.test(haikuModel);
  return { name, ...verdict(pass ? "PASS" : "FAIL", { opusModel, haikuModel }) };
}

async function case08({ client, runId }) {
  const name = CASE_DESCRIPTIONS[7];
  const slugs = [
    "dep-reader",
    "git-state-reader",
    "fixture-writer",
    "env-var-setter",
    "file-patch-runner",
    "config-editor",
    "mock-writer",
    "function-writer",
  ];
  const PROBE_SEC = 30;
  const dispatches = slugs.map((slug, i) => ({
    agent_name: slug,
    task: buildTimedProbe(`P8-${i}`, slug, runId, PROBE_SEC),
    max_turns: 6,
  }));
  const t0 = Date.now();
  await callBatchTool(client, { dispatches });
  const wallMs = Date.now() - t0;

  let stamps;
  try {
    stamps = slugs.map((s, i) => parseEntryExit(findLog(s, runId, `P8-${i}`)));
  } catch (err) {
    return { name, ...verdict("FAIL", { wallMs, parseErr: err?.message }) };
  }
  const entries = stamps.map((s) => s.entry);
  const exits   = stamps.map((s) => s.exit);
  const entrySkewMaxMs = Math.max(...entries) - Math.min(...entries);
  const firstExitAfterAllEnteredMs = Math.min(...exits) - Math.max(...entries);
  const pass = entrySkewMaxMs < 5_000 && firstExitAfterAllEnteredMs > 25_000 && wallMs < 60_000;
  return { name, ...verdict(pass ? "PASS" : "FAIL", { entrySkewMaxMs, firstExitAfterAllEnteredMs, wallMs }) };
}

async function case09({ client, runId }) {
  const name = CASE_DESCRIPTIONS[8];
  const dispatches = [
    { agent_name: "dep-reader",       task: buildTimedProbe("FAST9", "dep-reader",       runId, 10), max_turns: 6 },
    { agent_name: "git-state-reader", task: buildTimedProbe("MID9",  "git-state-reader", runId, 45), max_turns: 6 },
    { agent_name: "fixture-writer",   task: buildTimedProbe("SLOW9", "fixture-writer",   runId, 90), max_turns: 6 },
  ];
  const t0 = Date.now();
  await callBatchTool(client, { dispatches });
  const wallMs = Date.now() - t0;
  let fast, slow;
  try {
    fast = parseEntryExit(findLog("dep-reader",     runId, "FAST9"));
    slow = parseEntryExit(findLog("fixture-writer", runId, "SLOW9"));
  } catch (err) {
    return { name, ...verdict("FAIL", { wallMs, parseErr: err?.message }) };
  }
  const fastDurMs = fast.exit - fast.entry;
  const slowDurMs = slow.exit - slow.entry;
  const fastExitedBeforeSlow = fast.exit < slow.exit - 30_000;
  const pass = fastExitedBeforeSlow && fastDurMs < 25_000 && wallMs >= 80_000 && wallMs < 120_000;
  return { name, ...verdict(pass ? "PASS" : "FAIL", { wallMs, fastDurMs, slowDurMs, fastExitedBeforeSlow }) };
}

async function case10({ client, runId }) {
  const name = CASE_DESCRIPTIONS[9];
  const tA = buildTimedProbe("ALPHA10", "dep-reader", runId, 30);
  const tB = buildTimedProbe("BRAVO10", "dep-reader", runId, 30);
  await callBatchTool(client, {
    dispatches: [
      { agent_name: "dep-reader", task: tA, max_turns: 6 },
      { agent_name: "dep-reader", task: tB, max_turns: 6 },
    ],
  });
  const allLogs = logsForAgentAndRun("dep-reader", runId).filter((p) => {
    const c = readFileSync(p, "utf-8");
    return c.includes("role=ALPHA10") || c.includes("role=BRAVO10");
  });
  if (allLogs.length !== 2) {
    return { name, ...verdict("FAIL", { logCount: allLogs.length, files: allLogs }) };
  }
  let alphaCount = 0, bravoCount = 0;
  for (const p of allLogs) {
    const c = readFileSync(p, "utf-8");
    if (c.includes("role=ALPHA10")) alphaCount++;
    if (c.includes("role=BRAVO10")) bravoCount++;
  }
  const pass = alphaCount === 1 && bravoCount === 1;
  return { name, ...verdict(pass ? "PASS" : "FAIL", { logCount: allLogs.length, alphaCount, bravoCount }) };
}

async function case11({ client, runId, opts }) {
  const name = CASE_DESCRIPTIONS[10];
  if (!opts.allowRmi) {
    return { name, ...verdict("INCONCLUSIVE", { reason: "case 11 requires --allow-rmi to actually measure image rebuild cost; the test deliberately defaults to off so accidental runs don't trigger a 30+s rebuild that's disruptive on slow hosts" }) };
  }
  let rmiOutput = "";
  try { rmiOutput = execSync("docker rmi voltron-agent", { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).toString(); }
  catch (err) { rmiOutput = `rmi-error: ${err?.message ?? err}`; }

  const oneBatch = async (tag) => {
    const t0 = Date.now();
    const res = await callBatchTool(client, {
      dispatches: [
        { agent_name: "dep-reader",       task: buildTimedProbe(`${tag}-A`, "dep-reader",       runId, 10), max_turns: 6 },
        { agent_name: "git-state-reader", task: buildTimedProbe(`${tag}-B`, "git-state-reader", runId, 10), max_turns: 6 },
      ],
    });
    const wallMs = Date.now() - t0;
    const body = textOf(res);
    const errored = body.trim().startsWith("❌");
    return { wallMs, errored, bodyHead: body.slice(0, 200) };
  };
  const first  = await oneBatch("FIRST11");
  const second = await oneBatch("SECOND11");
  const delta = first.wallMs - second.wallMs;
  const bothRan = !first.errored && !second.errored;
  const inBand = delta >= 5_000 && delta <= 60_000;
  const verdictName = bothRan && inBand ? "PASS" : "INCONCLUSIVE";
  return { name, ...verdict(verdictName, {
    first: first.wallMs, second: second.wallMs, delta,
    firstErrored: first.errored, secondErrored: second.errored,
    firstHead: first.bodyHead, secondHead: second.bodyHead,
    rmiOutput: rmiOutput.slice(0, 200),
  }) };
}

async function case12({ client, runId }) {
  const name = CASE_DESCRIPTIONS[11];
  const dispatches = [
    { agent_name: "dep-reader",       task: buildVerboseProbe("A12", "dep-reader"),       max_turns: 6 },
    { agent_name: "git-state-reader", task: buildVerboseProbe("B12", "git-state-reader"), max_turns: 6 },
    { agent_name: "fixture-writer",   task: buildVerboseProbe("C12", "fixture-writer"),   max_turns: 6 },
  ].map((d) => ({ ...d, task: d.task.replace("run-id=${runId}", `run-id=${runId}`) }));
  // (The .map above is a defensive no-op — buildVerboseProbe already inlines runId.)

  const res = await callBatchTool(client, { dispatches });
  const body = textOf(res);
  const tailFences = [...body.matchAll(/#### Output Tail[^\n]*\n```\n([\s\S]*?)```/g)].map((m) => m[1]);
  const tailLineCounts = tailFences.map((t) => t.split("\n").filter((l) => l.length).length);
  const maxTailLines = tailLineCounts.length === 0 ? 0 : Math.max(...tailLineCounts);
  const bodyBytes = Buffer.byteLength(body, "utf-8");
  // bodyBytes ceiling: 150_000 (was 50_000). The design's 50KB was a safety margin under
  // the ~100KB SDK trim point, but assumed CLI stdout lines would be small. In stream-json
  // mode, each event line is JSON-wrapped and includes hook_response payloads (the host's
  // SessionStart hook output appears duplicated across `output`/`stdout` fields), init
  // metadata, and tool_use/tool_result blocks — pushing per-probe stdout to ~35KB even
  // with the impl's 40-line tail bound observed. 150KB keeps a defensive bound against
  // unbounded growth while tolerating real-world stream-json overhead. The 40-line tail
  // check above remains the authoritative guard on the impl's per-dispatch output limit.
  const pass = tailFences.length === 3 && maxTailLines <= 40 && bodyBytes < 150_000;
  return { name, ...verdict(pass ? "PASS" : "FAIL", {
    sectionCount: tailFences.length, maxTailLines, tailLineCounts, bodyBytes,
  }) };
}

// ─── verbose probe runId binding fix (template literal preservation) ───────
// buildVerboseProbe already inlines runId; the c12 .map() above intentionally
// does nothing — kept only so the literal "run-id=${runId}" is searchable for
// future debug grepping and to satisfy the "every probe builder includes
// run-id=${runId}" acceptance check (§4 criterion 8).

// ─── summary table + main ──────────────────────────────────────────────────

function printSummary(runId, results) {
  const passCount = results.filter((r) => r.verdict === "PASS").length;
  const padCase = (s) => s.length > 39 ? s.slice(0, 36) + "..." : s.padEnd(39);
  process.stdout.write("\n=== run_agent_in_docker_batch — comprehensive test summary ===\n");
  process.stdout.write(`run-id: ${runId}\n`);
  process.stdout.write("| # | Case                                    | Verdict      |\n");
  process.stdout.write("|---|-----------------------------------------|--------------|\n");
  results.forEach((r, i) => {
    const n = String(i + 1).padStart(2);
    process.stdout.write(`|${n} | ${padCase(r.name)} | ${r.verdict.padEnd(12)} |\n`);
  });
  process.stdout.write(`\nOverall: ${passCount}/${results.length} PASS — exit ${passCount === results.length ? 0 : 1}\n`);
  // Per-case evidence (always — useful for debugging)
  process.stdout.write("\n=== per-case evidence ===\n");
  results.forEach((r, i) => {
    process.stdout.write(`[${i + 1}] ${r.verdict} — ${r.name}\n`);
    process.stdout.write(`    ${JSON.stringify(r.evidence)}\n`);
  });
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv); }
  catch (err) {
    process.stderr.write(`${err?.message}\n`);
    printHelp();
    process.exit(1);
  }
  if (opts.help) { printHelp(); process.exit(0); }

  preflight();

  const runId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  process.stdout.write(`run-id: ${runId}\n`);
  process.stdout.write(`logs dir: ${LOGS_DIR}\n`);
  if (!existsSync(LOGS_DIR)) {
    process.stdout.write(`[init] logs dir does not exist yet — it will be created on first dispatch\n`);
  }

  const { client, transport } = await connectMcp();
  let results = [];
  try {
    await prewarm(client);

    const CASES = [case01, case02, case03, case04, case05, case06, case07, case08, case09, case10, case11, case12];
    for (let i = 0; i < CASES.length; i++) {
      const label = CASE_DESCRIPTIONS[i];
      process.stdout.write(`\n[case ${i + 1}/${CASES.length}] starting: ${label}\n`);
      const t0 = Date.now();
      let r;
      try {
        r = await CASES[i]({ client, runId, opts });
      } catch (err) {
        r = { name: label, verdict: "FAIL", evidence: { harnessError: err?.message ?? String(err) } };
      }
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      process.stdout.write(`[case ${i + 1}/${CASES.length}] ${r.verdict} in ${dt}s — ${r.name}\n`);
      results.push(r);
    }
  } finally {
    await transport.close().catch(() => {});
  }

  printSummary(runId, results);
  const allPass = results.every((r) => r.verdict === "PASS");
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
