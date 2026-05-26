#!/usr/bin/env node
// voltron-evals/runner.js
//
// Thin harness for the Voltron eval loop (design §5). Loads Deep-task YAMLs
// and Broad-layer shape-instance YAMLs, consults the template_hash cache
// (§6.1), dispatches the agent-under-test via the local MCP server (NEVER
// passing a `model` argument — §5.7), captures artifacts, runs deterministic
// scorers, and routes scoring by layer:
//   - Deep tasks               → voltron-judge (Opus by default, §2.4)
//   - Broad shape-instances    → programmatic scorers only (or Haiku, if the
//                                shape rubric opts in via subjective_judge)
// Writes voltron-evals/results/<id>/<ts>/scorecard.json and mirrors a
// reflection envelope into reflections/ — except cache-hits, which are not
// mirrored (§6.1 / §7.6).
//
// Usage:
//   node voltron-evals/runner.js --task=T1-001
//   node voltron-evals/runner.js --instance=function-writer
//   node voltron-evals/runner.js --tier=pr|all|deep|broad [--cache=on|off|refresh-fails-only]
//   node voltron-evals/runner.js --doctor

import { promises as fs } from "node:fs";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse as parseYaml } from "yaml";
import Ajv from "ajv";
import * as artifacts from "./lib/artifacts.js";
import { runScorers, bandsFromSignals } from "./lib/programmatic-scorers.js";
import { templateHashFor, listAgentNames } from "./lib/template-hash.js";
import { resolveBroadInstance } from "./lib/shape-loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const TASKS_DIR = path.join(__dirname, "tasks");
const INSTANCES_DIR = path.join(__dirname, "instances");
const RESULTS_DIR = path.join(__dirname, "results");
const TASK_SCHEMA_PATH = path.join(__dirname, "schemas", "task.schema.json");
const REFLECTIONS_DIR = path.join(REPO_ROOT, "reflections");

// Agents the Broad-layer coverage map deliberately omits (design §3.5).
const BROAD_LAYER_EXCLUDED = new Set(["voltron-judge"]);

function parseArgs(argv) {
  const out = {
    task: null,
    instance: null,
    tier: null,           // "pr" | "all" | "deep" | "broad"
    doctor: false,
    judgeModel: "opus",   // design §2.4 — Opus default for Deep judge
    cache: null,          // resolved later: "on" | "off" | "refresh-fails-only"
    dryRun: false,
  };
  for (const a of argv.slice(2)) {
    if (a === "--doctor") out.doctor = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--all") out.tier = "all"; // backcompat
    else if (a.startsWith("--task=")) out.task = a.slice("--task=".length);
    else if (a.startsWith("--instance=")) out.instance = a.slice("--instance=".length);
    else if (a.startsWith("--tier=")) out.tier = a.slice("--tier=".length);
    else if (a.startsWith("--judge-model=")) out.judgeModel = a.slice("--judge-model=".length);
    else if (a.startsWith("--cache=")) out.cache = a.slice("--cache=".length);
    else throw new Error(`Unknown arg: ${a}`);
  }

  if (out.tier && !["pr", "all", "deep", "broad"].includes(out.tier)) {
    throw new Error(`--tier must be one of pr|all|deep|broad (got '${out.tier}')`);
  }
  if (out.cache && !["on", "off", "refresh-fails-only"].includes(out.cache)) {
    throw new Error(`--cache must be on|off|refresh-fails-only (got '${out.cache}')`);
  }

  // Cache default (design §5, §6.1.1): off for single-job invocations, on for
  // sweeps. --doctor never uses the cache.
  if (out.cache == null) {
    if (out.task || out.instance) out.cache = "off";
    else out.cache = "on";
  }

  if (!out.doctor && !out.task && !out.instance && !out.tier) {
    throw new Error("Pass one of --task=<id>, --instance=<agent>, --tier=pr|all|deep|broad, or --doctor");
  }
  return out;
}

// ── Job loading ───────────────────────────────────────────────────────────────

function loadDeepTasks(filter) {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(JSON.parse(readFileSync(TASK_SCHEMA_PATH, "utf-8")));
  const files = readdirSync(TASKS_DIR).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
  const tasks = [];
  for (const f of files) {
    const p = path.join(TASKS_DIR, f);
    const t = parseYaml(readFileSync(p, "utf-8"));
    if (!validate(t)) throw new Error(`Task ${f} failed schema: ${ajv.errorsText(validate.errors)}`);
    if (t.kind && t.kind !== "deep") {
      throw new Error(`Task ${f} has kind='${t.kind}' but lives under tasks/ (expected 'deep')`);
    }
    t.kind = "deep";
    t._path = p;
    if (!filter || t.id === filter) tasks.push(t);
  }
  if (filter && !tasks.length) throw new Error(`No deep task matches ${filter}`);
  return tasks;
}

function loadBroadInstances(filter) {
  if (!existsSync(INSTANCES_DIR)) return [];
  const out = [];
  walkInstancesDir(INSTANCES_DIR, out);
  const instances = [];
  for (const p of out) {
    const raw = parseYaml(readFileSync(p, "utf-8"));
    const job = resolveBroadInstance(raw, p, REPO_ROOT);
    job.id = raw.id || `${job.shape}/${job.agent_under_test}`;
    job._path = p;
    if (!filter || job.agent_under_test === filter) instances.push(job);
  }
  if (filter && !instances.length) throw new Error(`No broad-layer instance matches ${filter}`);
  return instances;
}

function walkInstancesDir(dir, out) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkInstancesDir(full, out);
    } else if (ent.isFile() && (ent.name.endsWith(".yaml") || ent.name.endsWith(".yml"))) {
      out.push(full);
    }
  }
}

function loadJobs(opts) {
  if (opts.task) return loadDeepTasks(opts.task);
  if (opts.instance) return loadBroadInstances(opts.instance);

  let deep = [];
  let broad = [];
  switch (opts.tier) {
    case "deep":
      deep = loadDeepTasks(null);
      break;
    case "broad":
      broad = loadBroadInstances(null);
      break;
    case "pr": {
      // PR-tier: all Tier-1 Deep tasks + a deterministic 10-instance Broad
      // sample rotated by (commit_sha mod N). When no instances exist yet,
      // the broad sample is empty.
      deep = loadDeepTasks(null).filter(t => t.tier === 1);
      const allInstances = loadBroadInstances(null);
      broad = sampleInstances(allInstances, 10);
      break;
    }
    case "all":
    default:
      deep = loadDeepTasks(null);
      broad = loadBroadInstances(null);
      break;
  }
  return [...deep, ...broad];
}

function sampleInstances(instances, n) {
  if (instances.length <= n) return instances;
  let sha = process.env.GITHUB_SHA || "";
  if (!sha) {
    try {
      const head = readFileSync(path.join(REPO_ROOT, ".git", "HEAD"), "utf-8").trim();
      const ref = head.startsWith("ref: ") ? head.slice(5) : null;
      if (ref) sha = readFileSync(path.join(REPO_ROOT, ".git", ref), "utf-8").trim();
      else sha = head;
    } catch { sha = ""; }
  }
  // Stable rotation: convert first 8 hex chars of sha to int, modulo length.
  const seed = sha ? parseInt(sha.slice(0, 8), 16) : 0;
  const start = Number.isFinite(seed) ? seed % instances.length : 0;
  const sorted = [...instances].sort((a, b) => a.id.localeCompare(b.id));
  const out = [];
  for (let i = 0; i < n; i++) out.push(sorted[(start + i) % sorted.length]);
  return out;
}

// ── Doctor mode (§3.5, §7.6) ──────────────────────────────────────────────────

function doctorMode() {
  const agents = listAgentNames();
  const missing = [];
  const have = new Set();
  if (existsSync(INSTANCES_DIR)) {
    let instances = [];
    try { instances = loadBroadInstances(null); }
    catch (e) {
      process.stderr.write(`[DOCTOR] Failed to load instances: ${e.message}\n`);
      process.exit(2);
    }
    for (const inst of instances) have.add(inst.agent_under_test);
  }
  for (const a of agents) {
    if (BROAD_LAYER_EXCLUDED.has(a)) continue;
    if (!have.has(a)) missing.push(a);
  }
  if (missing.length) {
    process.stdout.write(`[DOCTOR] Coverage drift: ${missing.length} agent(s) lack a Broad-layer instance YAML in voltron-evals/instances/:\n`);
    for (const a of missing) process.stdout.write(`  - ${a}\n`);
    process.exit(1);
  }
  process.stdout.write(`[DOCTOR] OK — all ${agents.length - BROAD_LAYER_EXCLUDED.size} non-judge agents have an instance YAML.\n`);
  process.exit(0);
}

// ── Rubric pinning ────────────────────────────────────────────────────────────

function checkRubricPinned(job) {
  const rubricPath = path.join(REPO_ROOT, job.rubric);
  if (!existsSync(rubricPath)) throw new Error(`Rubric not found: ${job.rubric}`);
  const raw = readFileSync(rubricPath, "utf-8");
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!fm) throw new Error(`Rubric ${job.rubric} missing YAML frontmatter`);
  const v = /rubric_version:\s*(\S+)/.exec(fm[1])?.[1];
  if (v !== job.rubric_version_expected) {
    throw new Error(`Rubric version mismatch: file=${v} expected=${job.rubric_version_expected}`);
  }
  return { rubricPath, frontmatter: fm[1] };
}

function loadShapeRubricMeta(job) {
  if (job.kind !== "shape-instance") return null;
  // Shape rubric path may be specified on the instance directly, or derived
  // from the shape id.
  const rubricRel = job.rubric || `voltron-evals/rubrics/shapes/${job.shape}.md`;
  const rubricPath = path.join(REPO_ROOT, rubricRel);
  if (!existsSync(rubricPath)) return { subjective_judge: null, subjective_criteria: [] };
  const raw = readFileSync(rubricPath, "utf-8");
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!fm) return { subjective_judge: null, subjective_criteria: [] };
  const judgeMatch = /subjective_judge:\s*"?(\w+)"?/.exec(fm[1]);
  const judge = judgeMatch ? judgeMatch[1] : null;
  // Hard schema check (§5.6): shapes may only opt into Haiku.
  if (judge && judge !== "haiku") {
    throw new Error(`Shape rubric ${rubricRel} sets subjective_judge='${judge}' — only 'haiku' is permitted on shape rubrics (§5.6, §11.4)`);
  }
  const critBlock = /subjective_criteria:\s*\n([\s\S]*?)(\n[a-zA-Z_]+:|\n---|$)/.exec(fm[1]);
  const criteria = [];
  if (critBlock) {
    for (const line of critBlock[1].split("\n")) {
      const m = /^\s*-\s*"?([^"\n]+)"?\s*$/.exec(line);
      if (m) criteria.push(m[1].trim());
    }
  }
  return { subjective_judge: judge, subjective_criteria: criteria };
}

// ── Cache (§6.1) ──────────────────────────────────────────────────────────────

function findLastPassingScorecard(jobId) {
  const dir = path.join(RESULTS_DIR, jobId);
  if (!existsSync(dir)) return null;
  let entries;
  try { entries = readdirSync(dir); } catch { return null; }
  const candidates = [];
  for (const e of entries) {
    const sp = path.join(dir, e, "scorecard.json");
    if (!existsSync(sp)) continue;
    let sc;
    try { sc = JSON.parse(readFileSync(sp, "utf-8")); } catch { continue; }
    if (sc.cannot_grade) continue;
    if (sc.scored_via === "cache-hit") continue; // do not chain cache to cache; require a real pass underneath
    // Treat a scorecard as "passing" if no criterion has a 0-score UNMET verdict.
    const fail = (sc.criteria || []).some(c => c.verdict === "UNMET");
    if (fail) continue;
    candidates.push({ sc, sp, ts: e });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.ts.localeCompare(a.ts));
  return candidates[0];
}

function shouldSkip(job, currentHash, opts) {
  if (opts.cache === "off") return null;
  if (opts.doctor) return null;
  const prev = findLastPassingScorecard(job.id);
  if (!prev) return null;
  if (opts.cache === "refresh-fails-only") {
    // Already filtered to passing-only; this mode wants pass-cached, fail-rerun.
  }
  if (prev.sc.rubric_version !== job.rubric_version_expected) return null;
  if (prev.sc.template_hash !== currentHash) return null;
  return prev;
}

async function emitCacheHitScorecard(job, currentHash, prev, ts) {
  const runDir = path.join(RESULTS_DIR, job.id, ts);
  await fs.mkdir(runDir, { recursive: true });
  const sc = {
    task_id: job.id,
    kind: job.kind,
    agent_under_test: job.agent_under_test,
    template_hash: currentHash,
    scored_via: "cache-hit",
    cached_from: path.relative(REPO_ROOT, prev.sp),
    rubric_version: job.rubric_version_expected,
    rubric_path: job.rubric,
    aggregates: prev.sc.aggregates || {},
    criteria: prev.sc.criteria || [],
    judge_model: null,
    judge_turns_used: 0,
  };
  const scorecardPath = path.join(runDir, "scorecard.json");
  await fs.writeFile(scorecardPath, JSON.stringify(sc, null, 2), "utf-8");
  // §6.1 / §7.6: cache-hits are NOT mirrored to reflections/.
  return { scorecardPath, scorecard: sc };
}

// ── MCP wiring ────────────────────────────────────────────────────────────────

async function connectMcp() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(REPO_ROOT, "src", "index.js")],
    cwd: REPO_ROOT,
    env: { ...process.env },
  });
  const client = new Client({ name: "voltron-evals-runner", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

const TOOL_CALL_TIMEOUT_MS = 15 * 60 * 1000;

async function callTool(client, name, args) {
  const r = await client.callTool(
    { name, arguments: args },
    undefined,
    { timeout: TOOL_CALL_TIMEOUT_MS, resetTimeoutOnProgress: true, maxTotalTimeout: TOOL_CALL_TIMEOUT_MS },
  );
  const text = (r.content ?? []).map(c => c.text ?? "").join("\n");
  return { text, raw: r };
}

// §5.7: construct AUT dispatch args explicitly. Never pass `model` — agents
// run on their template-pinned tier. The assertion below is the runtime guard
// the design calls for.
function buildAutArgs(job) {
  const args = {
    agent_name: job.agent_under_test,
    task: job.prompt,
    max_turns: job.max_turns,
  };
  if ("model" in args || "model_override" in args) {
    throw new Error("AUT dispatch args contain a forbidden 'model' key (§5.7 model-pinning rule violated)");
  }
  return args;
}

// ── Judge dispatch ────────────────────────────────────────────────────────────

function extractFencedJson(text) {
  const direct = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  if (direct) {
    try { return JSON.parse(direct[1]); } catch { /* fall through */ }
  }
  let buf = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "result" && typeof ev.result === "string") {
      buf += ev.result + "\n";
    } else if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block && block.type === "text" && typeof block.text === "string") buf += block.text + "\n";
      }
    }
  }
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(buf);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function buildJudgePrompt(job, paths, programmatic, opts) {
  const lines = [
    "You are voltron-judge. Read the run artifacts and rubric below and emit a scorecard",
    "per your template's Output Contract (one fenced ```json``` block, no surrounding prose).",
    "",
    `Run directory:   ${paths.run_dir}`,
    `Rubric:          ${paths.rubric}`,
    `Rubric version:  ${job.rubric_version_expected}`,
    `Task definition: ${paths.task_yaml}`,
    `Agent under test: ${job.agent_under_test}`,
    "",
    "Programmatic signals (pre-computed by runner — quote these verbatim, do not re-derive):",
    "```json",
    JSON.stringify(programmatic, null, 2),
    "```",
    "",
  ];
  if (opts.subjectiveOnly && opts.subjectiveOnly.length) {
    lines.push("Score ONLY the following criteria atomically (others have been scored programmatically):");
    for (const c of opts.subjectiveOnly) lines.push(`  - ${c}`);
    lines.push("");
  } else {
    lines.push("Score every criterion atomically with file:line evidence.");
  }
  lines.push("Emit ONE fenced ```json``` block.");
  return lines.join("\n");
}

async function dispatchJudge(client, job, paths, programmatic, model, opts = {}) {
  const judgePrompt = buildJudgePrompt(job, paths, programmatic, opts);
  const judgeStartTs = Date.now();
  const { text: judgeText } = await callTool(client, "run_agent_in_docker", {
    agent_name: "voltron-judge",
    task: judgePrompt,
    max_turns: 20,
    model,
  });
  let scorecard = extractFencedJson(judgeText);
  if (!scorecard) {
    const judgeLogPath = artifacts.findAgentLog("voltron-judge", judgeStartTs);
    if (judgeLogPath) {
      const judgeLog = await artifacts.tailLog(judgeLogPath, 10 * 1024 * 1024);
      scorecard = extractFencedJson(judgeLog);
    }
  }
  if (!scorecard) {
    scorecard = { cannot_grade: { reason: "judge_parse_failed", detail: judgeText.slice(0, 500) } };
  }
  return scorecard;
}

// ── Reflection envelope ───────────────────────────────────────────────────────

function reflectionEnvelope(job, scorecard, programmatic, scorecardPath) {
  const agent = job.agent_under_test;
  const aggs = scorecard.aggregates || {};
  const summary = `Eval ${job.id} (${job.category || job.shape || "shape-instance"}) — AUT=${agent}. Aggregates: ${Object.entries(aggs).map(([k, v]) => `${k} ${v}`).join(" / ")}`;
  const unmet = (scorecard.criteria || []).filter(c => c.verdict === "UNMET" || c.verdict === "PARTIAL");
  const suggestion = unmet.length
    ? `Address: ${unmet.map(c => `${c.id} (${c.verdict})`).join("; ")}`
    : "No criteria failed.";
  return {
    timestamp: new Date().toISOString().replace(/[:.]/g, "-").replace("Z", ""),
    project_name: "voltron-eval-harness",
    project_type: "general",
    session_summary: summary,
    agents_used: [agent, ...(programmatic.sub_dispatch_targets || [])],
    agent_feedback: [
      {
        agent,
        worked_well: unmet.length ? "" : "All rubric criteria met.",
        needs_improvement: unmet.map(c => `${c.id}: ${c.notes ?? c.verdict}`).join(" | "),
        suggested_change: suggestion,
      },
    ],
    overall_notes: scorecard.cannot_grade ? `cannot_grade: ${JSON.stringify(scorecard.cannot_grade)}` : "",
    processed: false,
    eval_metadata: {
      task_id: job.id,
      kind: job.kind,
      rubric_version: job.rubric_version_expected,
      rubric_path: job.rubric,
      template_versions: scorecard.template_versions || {},
      template_hash: scorecard.template_hash,
      scored_via: scorecard.scored_via,
      scores: aggs,
      programmatic,
      judge_model: scorecard.judge_model || null,
      scorecard_path: path.relative(REPO_ROOT, scorecardPath),
    },
  };
}

// ── Job execution ─────────────────────────────────────────────────────────────

async function runJob(job, client, opts) {
  const ts = artifacts.timestamp();
  const currentHash = templateHashFor(job.agent_under_test);

  // §6.1: content-hash incremental skip.
  const cached = shouldSkip(job, currentHash, opts);
  if (cached) {
    process.stdout.write(`[STEP] runner: cache-hit for ${job.id} (template_hash unchanged)\n`);
    const { scorecardPath } = await emitCacheHitScorecard(job, currentHash, cached, ts);
    return { jobId: job.id, scorecardPath, verdict: "CACHE_HIT" };
  }

  const runDir = await artifacts.mkRunDir(job.id, ts);
  checkRubricPinned(job);

  process.stdout.write(`[STEP] runner: dispatching AUT ${job.agent_under_test} for ${job.id}\n`);
  const pre = await artifacts.capturePre();

  let autText = "";
  if (!opts.dryRun) {
    const autArgs = buildAutArgs(job);
    const { text } = await callTool(client, "run_agent_in_docker", autArgs);
    autText = text;
  } else {
    autText = "[dry-run] AUT not dispatched";
  }

  const post = await artifacts.capturePost(job.agent_under_test, pre);
  if (!post.log) post.log = autText;
  const programmatic = runScorers(job, { pre, post, journal: [] });
  const paths = await artifacts.writeArtifacts(runDir, {
    task: job, taskYamlPath: job._path,
    rubricPath: path.join(REPO_ROOT, job.rubric),
    pre, post, programmatic, journal: [],
    changedFiles: programmatic.files_changed || [],
  });

  // §2.4: layer-aware scoring routing.
  let scorecard;
  let scoredVia;
  if (job.kind === "deep") {
    process.stdout.write(`[STEP] runner: dispatching voltron-judge (opus) for deep job ${job.id}\n`);
    if (!opts.dryRun) {
      scorecard = await dispatchJudge(client, job, paths, programmatic, opts.judgeModel);
      scoredVia = "judge";
    } else {
      scorecard = { cannot_grade: { reason: "dry_run" } };
      scoredVia = "judge";
    }
  } else {
    // Broad layer (shape-instance). Programmatic-only by default; Haiku
    // opt-in when the shape rubric sets subjective_judge: "haiku".
    const shapeMeta = loadShapeRubricMeta(job);
    if (shapeMeta && shapeMeta.subjective_judge === "haiku" && shapeMeta.subjective_criteria.length) {
      process.stdout.write(`[STEP] runner: dispatching voltron-judge (haiku) for ${job.id} subjective criteria\n`);
      if (!opts.dryRun) {
        scorecard = await dispatchJudge(client, job, paths, programmatic, "haiku", {
          subjectiveOnly: shapeMeta.subjective_criteria,
        });
        scoredVia = "haiku-subjective";
      } else {
        scorecard = { cannot_grade: { reason: "dry_run" } };
        scoredVia = "haiku-subjective";
      }
    } else {
      // Programmatic-only: no LLM call. Synthesize a scorecard from
      // programmatic signals so the result still flows through the same
      // pipeline. Full criterion-from-shape-rubric synthesis is the next
      // stage's job — for now, ship the programmatic block and let the
      // bands aggregator drive verdicts.
      process.stdout.write(`[STEP] runner: programmatic-only scoring for shape-instance ${job.id}\n`);
      scorecard = {
        criteria: [],
        aggregates: {},
        judge_model: null,
        judge_turns_used: 0,
      };
      scoredVia = "programmatic";
    }
  }

  scorecard.task_id = job.id;
  scorecard.kind = job.kind;
  scorecard.rubric_version = job.rubric_version_expected;
  scorecard.rubric_path = job.rubric;
  scorecard.agent_under_test = job.agent_under_test;
  scorecard.programmatic = programmatic;
  scorecard.bands = bandsFromSignals(job, programmatic);
  scorecard.template_hash = currentHash;
  scorecard.scored_via = scoredVia;
  if (scoredVia === "programmatic") scorecard.judge_model = null;

  const scorecardPath = path.join(runDir, "scorecard.json");
  await fs.writeFile(scorecardPath, JSON.stringify(scorecard, null, 2), "utf-8");

  if (!scorecard.cannot_grade) {
    const env = reflectionEnvelope(job, scorecard, programmatic, scorecardPath);
    const reflectionFile = path.join(REFLECTIONS_DIR, `${env.timestamp}-eval-${job.id.replace(/[/\\]/g, "_")}.json`);
    await fs.mkdir(REFLECTIONS_DIR, { recursive: true });
    await fs.writeFile(reflectionFile, JSON.stringify(env, null, 2), "utf-8");
  }

  const verdict = scorecard.cannot_grade ? "CANNOT_GRADE" : "OK";
  return { jobId: job.id, runDir, scorecardPath, verdict, scorecard };
}

// ── Entry ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.doctor) {
    doctorMode();
    return; // unreachable; doctorMode() calls process.exit
  }

  const jobs = loadJobs(opts);
  if (!jobs.length) {
    process.stdout.write("No jobs to run.\n");
    process.exit(0);
  }

  const needsMcp = !opts.dryRun;
  const { client, transport } = needsMcp ? await connectMcp() : { client: null, transport: null };

  const results = [];
  try {
    for (const j of jobs) {
      try {
        results.push(await runJob(j, client, opts));
      } catch (err) {
        results.push({ jobId: j.id, error: err.message });
      }
    }
  } finally {
    if (transport) await transport.close().catch(() => {});
  }

  process.stdout.write("\n=== voltron-evals summary ===\n");
  let cacheHits = 0;
  for (const r of results) {
    if (r.error) process.stdout.write(`  ${r.jobId}: ERROR ${r.error}\n`);
    else {
      if (r.verdict === "CACHE_HIT") cacheHits++;
      const rel = r.scorecardPath ? path.relative(REPO_ROOT, r.scorecardPath) : "(no scorecard)";
      process.stdout.write(`  ${r.jobId}: ${r.verdict} → ${rel}\n`);
    }
  }
  if (cacheHits) process.stdout.write(`  (${cacheHits} cache-hit${cacheHits === 1 ? "" : "s"})\n`);

  const failed = results.some(r => r.error || r.verdict === "CANNOT_GRADE");
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(2); });
