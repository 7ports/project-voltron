#!/usr/bin/env node
// scripts/test-parallel-dispatch.mjs
//
// Tier-A parallel-dispatch verification (design: docs/parallel-dispatch-test-design.md).
// Opens a single MCP StdioClientTransport to local src/index.js, fires two
// run_agent_in_docker calls in Promise.all, then parses the resulting probe logs
// for [entry]/[exit] timestamps and classifies the dispatch as
// PASS / FAIL_SEQUENTIAL / INCONCLUSIVE.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const LOGS_DIR = join(REPO_ROOT, ".voltron", "logs");

const PROBE_SLEEP_SECONDS = 90;
const TOOL_CALL_TIMEOUT_MS = 6 * 60 * 1000;

function buildProbePrompt(role, agentSlug, runId) {
  return `PARALLEL-DISPATCH PROBE — agent=${role} run-id=${runId}

This task is a timing probe for the Voltron parallel-dispatch test harness.
Do NOTHING beyond the two steps below. Do not read other files, do not analyze
dependencies, do not call any other tools. Your only job is to consume
approximately ${PROBE_SLEEP_SECONDS} seconds of wall time inside this container so the
[entry] and [exit] timestamps in your log can be compared to a peer agent's.

Step 1 — execute exactly ONE Bash tool call, verbatim:

    sleep ${PROBE_SLEEP_SECONDS} && echo "[probe-marker] role=${role} run-id=${runId} agent=${agentSlug}"

Step 2 — emit exactly ONE final assistant line, verbatim:

    [DONE] probe ${role} complete run-id=${runId}

Acceptance:
- Total wall time between [entry] and [exit] >= 85s and <= 110s.
- The string "run-id=${runId}" appears at least once in the log file
  (.voltron/logs/${agentSlug}-<TS>.log).
- No file modifications, no git operations, no other tool calls.`;
}

function parseArgs(argv) {
  const out = { dryRun: false, help: false };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/test-parallel-dispatch.mjs [--dry-run]

Fires two run_agent_in_docker calls via an MCP StdioClientTransport against the
local src/index.js, inside Promise.all. Parses the resulting probe logs and
reports a PASS / FAIL_SEQUENTIAL / INCONCLUSIVE verdict.

  --dry-run   Print the chosen probe prompts and exit (no dispatch).
  --help, -h  Show this help.

Exit codes: 0=PASS, 1=FAIL_SEQUENTIAL, 2=INCONCLUSIVE or pre-flight error.
`);
}

function preflight() {
  try {
    execSync("docker info", { stdio: "ignore" });
  } catch {
    throw new Error("Docker daemon unreachable (`docker info` failed). Start Docker and retry.");
  }
  try {
    execSync("docker image inspect voltron-agent", { stdio: "ignore" });
  } catch {
    throw new Error(
      "voltron-agent image not found. Build it first by running any run_agent_in_docker call (e.g. via the MCP tool) so this test does not pay a 30+s image-build cost that masks the timing signal.",
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
    { name: "parallel-dispatch-test", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport };
}

async function callTool(client, args) {
  return client.callTool(
    { name: "run_agent_in_docker", arguments: args },
    undefined,
    {
      timeout: TOOL_CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: TOOL_CALL_TIMEOUT_MS,
    },
  );
}

function findLog(agentSlug, runId) {
  const files = readdirSync(LOGS_DIR).filter(
    (f) => f.startsWith(`${agentSlug}-`) && f.endsWith(".log"),
  );
  const matches = files
    .map((f) => join(LOGS_DIR, f))
    .filter((p) => {
      try {
        return readFileSync(p, "utf-8").includes(`run-id=${runId}`);
      } catch {
        return false;
      }
    });
  if (matches.length === 0) {
    throw new Error(`no log for ${agentSlug} containing run-id=${runId}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `multiple logs for ${agentSlug} containing run-id=${runId} — regenerate run-id`,
    );
  }
  return matches[0];
}

function parseEntryExit(logPath) {
  const lines = readFileSync(logPath, "utf-8").split("\n");
  const entryLine = lines.find((l) => l.startsWith("[entry] "));
  const exitLine = lines.find((l) => l.startsWith("[exit] "));
  if (!entryLine || !exitLine) {
    throw new Error(`log ${logPath} missing [entry] or [exit]`);
  }
  const entryMatch = entryLine.match(/\[entry\]\s+(\S+)/);
  const exitMatch = exitLine.match(/\[exit\]\s+(\S+)/);
  if (!entryMatch || !exitMatch) {
    throw new Error(`could not parse timestamps in ${logPath}`);
  }
  return {
    entry: new Date(entryMatch[1]).getTime(),
    exit: new Date(exitMatch[1]).getTime(),
  };
}

function classify(runId, slugA, slugB) {
  const logA = findLog(slugA, runId);
  const logB = findLog(slugB, runId);
  const a = parseEntryExit(logA);
  const b = parseEntryExit(logB);
  const [first, second] = a.entry <= b.entry ? [a, b] : [b, a];
  const entrySkewMs = Math.abs(a.entry - b.entry);
  const gapAfterFirst = second.entry - first.exit;
  const overlapMs = Math.max(
    0,
    Math.min(a.exit, b.exit) - Math.max(a.entry, b.entry),
  );
  const SEC = 1000;
  let verdict;
  if (
    entrySkewMs < 5 * SEC &&
    first.entry <= second.entry &&
    second.entry <= first.exit &&
    overlapMs >= 60 * SEC
  ) {
    verdict = "PASS";
  } else if (gapAfterFirst > 0 && gapAfterFirst < 10 * SEC) {
    verdict = "FAIL_SEQUENTIAL";
  } else {
    verdict = "INCONCLUSIVE";
  }
  return { verdict, entrySkewMs, gapAfterFirst, overlapMs, logA, logB };
}

async function prewarm(client) {
  process.stdout.write("[prewarm] dispatching dep-reader to warm voltron-agent image cache...\n");
  await callTool(client, {
    agent_name: "dep-reader",
    task: "PREWARM — execute exactly ONE Bash tool call: echo prewarm-ok. Then emit exactly: [DONE] prewarm",
    max_turns: 4,
  });
  process.stdout.write("[prewarm] done\n");
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const runId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const slugA = "dep-reader";
  const slugB = "git-state-reader";
  const promptA = buildProbePrompt("A", slugA, runId);
  const promptB = buildProbePrompt("B", slugB, runId);

  if (opts.dryRun) {
    process.stdout.write(`run-id: ${runId}\n\n=== PROBE A (${slugA}) ===\n${promptA}\n\n=== PROBE B (${slugB}) ===\n${promptB}\n`);
    process.exit(0);
  }

  preflight();
  process.stdout.write(`run-id: ${runId}\n`);
  process.stdout.write(`probe A: agent=${slugA}\n`);
  process.stdout.write(`probe B: agent=${slugB}\n`);

  const { client, transport } = await connectMcp();
  let dispatchStart, dispatchEnd;
  try {
    await prewarm(client);

    dispatchStart = Date.now();
    process.stdout.write(`[dispatch] firing Promise.all of two run_agent_in_docker calls at ${new Date(dispatchStart).toISOString()}\n`);
    const [resA, resB] = await Promise.all([
      callTool(client, { agent_name: slugA, task: promptA, max_turns: 8 }),
      callTool(client, { agent_name: slugB, task: promptB, max_turns: 8 }),
    ]);
    dispatchEnd = Date.now();
    process.stdout.write(`[dispatch] both resolved at ${new Date(dispatchEnd).toISOString()} (wall=${dispatchEnd - dispatchStart}ms)\n`);

    // Surface any errors in the tool results (the response shape includes
    // text content that begins with "❌" or "Error:" when the handler bails out).
    for (const [label, res] of [["A", resA], ["B", resB]]) {
      const text = (res?.content ?? []).map((c) => c?.text ?? "").join("\n");
      if (/^Error:|❌/.test(text.trim())) {
        process.stdout.write(`[dispatch] probe ${label} returned error: ${text.split("\n")[0]}\n`);
      }
    }
  } finally {
    await transport.close().catch(() => {});
  }

  let result;
  try {
    result = classify(runId, slugA, slugB);
  } catch (err) {
    process.stdout.write(`INCONCLUSIVE — log parsing failed: ${err.message}\n`);
    process.exit(2);
  }

  const { verdict, entrySkewMs, gapAfterFirst, overlapMs, logA, logB } = result;
  const summary = {
    runId,
    verdict,
    entrySkewMs,
    gapAfterFirst,
    overlapMs,
    logA,
    logB,
    dispatchWallMs: dispatchEnd - dispatchStart,
  };
  process.stdout.write(`\n=== result ===\n${JSON.stringify(summary, null, 2)}\n\n`);

  if (verdict === "PASS") {
    process.stdout.write(`PASS — parallel dispatch confirmed (entrySkew=${entrySkewMs}ms, overlap=${overlapMs}ms)\n`);
    process.exit(0);
  }
  if (verdict === "FAIL_SEQUENTIAL") {
    process.stdout.write(`FAIL_SEQUENTIAL — gap between A.exit and B.entry was ${gapAfterFirst}ms (parallel would have overlap > 60s)\n`);
    process.exit(1);
  }
  process.stdout.write(`INCONCLUSIVE — entrySkew=${entrySkewMs}ms, overlap=${overlapMs}ms, gapAfterFirst=${gapAfterFirst}ms — see logs ${logA} and ${logB}\n`);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err?.stack || err?.message || err}\n`);
  process.exit(2);
});
