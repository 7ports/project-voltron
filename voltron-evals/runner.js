#!/usr/bin/env node
// voltron-evals/runner.js
//
// Thin harness for the Voltron eval loop (design §5). Loads task YAMLs,
// dispatches the agent-under-test via the local MCP server, captures
// artifacts, runs deterministic scorers, dispatches `voltron-judge`, parses
// its fenced-JSON scorecard, merges, writes
//   voltron-evals/results/<task>/<ts>/scorecard.json
// and mirrors a reflection envelope into reflections/.
//
// Usage: node voltron-evals/runner.js [--task=T1-001 | --all] [--judge-model=sonnet] [--dry-run]
//
// Runs INSIDE the Voltron Docker image (reuses node_modules + bd + claude
// CLI). The MCP server is launched as a stdio child so we can reuse
// `run_agent_in_docker` and progress streaming.

import { promises as fs } from "node:fs";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse as parseYaml } from "yaml";
import Ajv from "ajv";
import * as artifacts from "./lib/artifacts.js";
import { runScorers, bandsFromSignals } from "./lib/programmatic-scorers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const TASKS_DIR = path.join(__dirname, "tasks");
const SCHEMA_PATH = path.join(__dirname, "schemas", "task.schema.json");
const REFLECTIONS_DIR = path.join(REPO_ROOT, "reflections");

function parseArgs(argv) {
  const out = { task: null, all: false, judgeModel: "sonnet", dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === "--all") out.all = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--task=")) out.task = a.slice("--task=".length);
    else if (a.startsWith("--judge-model=")) out.judgeModel = a.slice("--judge-model=".length);
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!out.task && !out.all) throw new Error("Pass --task=<id> or --all");
  return out;
}

function loadTasks(filter) {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, "utf-8")));
  const files = readdirSync(TASKS_DIR).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
  const tasks = [];
  for (const f of files) {
    const p = path.join(TASKS_DIR, f);
    const t = parseYaml(readFileSync(p, "utf-8"));
    if (!validate(t)) throw new Error(`Task ${f} failed schema: ${ajv.errorsText(validate.errors)}`);
    t._path = p;
    if (!filter || t.id === filter) tasks.push(t);
  }
  if (!tasks.length) throw new Error(filter ? `No task matches ${filter}` : "No tasks found");
  return tasks;
}

function checkRubricPinned(task) {
  const rubricPath = path.join(REPO_ROOT, task.rubric);
  if (!existsSync(rubricPath)) throw new Error(`Rubric not found: ${task.rubric}`);
  const raw = readFileSync(rubricPath, "utf-8");
  const fm = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!fm) throw new Error(`Rubric ${task.rubric} missing YAML frontmatter`);
  const v = /rubric_version:\s*(\S+)/.exec(fm[1])?.[1];
  if (v !== task.rubric_version_expected) {
    throw new Error(`Rubric version mismatch: file=${v} expected=${task.rubric_version_expected}`);
  }
  return rubricPath;
}

async function connectMcp() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(REPO_ROOT, "src", "index.js")],
    cwd: REPO_ROOT,
  });
  const client = new Client({ name: "voltron-evals-runner", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

async function callTool(client, name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content ?? []).map(c => c.text ?? "").join("\n");
  return { text, raw: r };
}

function extractFencedJson(text) {
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function buildJudgePrompt(task, paths, programmatic) {
  return [
    "You are voltron-judge. Read the run artifacts and rubric below and emit a scorecard",
    "per your template's Output Contract (one fenced ```json``` block, no surrounding prose).",
    "",
    `Run directory:   ${paths.run_dir}`,
    `Rubric:          ${paths.rubric}`,
    `Rubric version:  ${task.rubric_version_expected}`,
    `Task definition: ${paths.task_yaml}`,
    `Agent under test: ${task.agent_under_test}`,
    "",
    "Programmatic signals (pre-computed by runner — quote these verbatim, do not re-derive):",
    "```json",
    JSON.stringify(programmatic, null, 2),
    "```",
    "",
    "Score every criterion atomically with file:line evidence. Emit ONE fenced ```json``` block.",
  ].join("\n");
}

function reflectionEnvelope(task, scorecard, programmatic, scorecardPath) {
  const agent = task.agent_under_test;
  const aggs = scorecard.aggregates || {};
  const summary = `Eval ${task.id} (${task.category}) — AUT=${agent}. Aggregates: ${Object.entries(aggs).map(([k, v]) => `${k} ${v}`).join(" / ")}`;
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
      task_id: task.id,
      rubric_version: task.rubric_version_expected,
      rubric_path: task.rubric,
      template_versions: scorecard.template_versions || {},
      scores: aggs,
      programmatic,
      judge_model: scorecard.judge_model || null,
      scorecard_path: path.relative(REPO_ROOT, scorecardPath),
    },
  };
}

async function runTask(task, client, opts) {
  const ts = artifacts.timestamp();
  const runDir = await artifacts.mkRunDir(task.id, ts);
  const rubricPath = checkRubricPinned(task);

  process.stdout.write(`[STEP] runner: dispatching AUT ${task.agent_under_test} for ${task.id}\n`);
  const pre = await artifacts.capturePre();

  let autText = "";
  if (!opts.dryRun) {
    const { text } = await callTool(client, "run_agent_in_docker", {
      agent_name: task.agent_under_test,
      task: task.prompt,
      max_turns: task.max_turns,
    });
    autText = text;
  } else {
    autText = "[dry-run] AUT not dispatched";
  }

  const post = await artifacts.capturePost(task.agent_under_test, pre);
  if (!post.log) post.log = autText;
  const programmatic = runScorers(task, { pre, post, journal: [] });
  const paths = await artifacts.writeArtifacts(runDir, {
    task, taskYamlPath: task._path, rubricPath, pre, post,
    programmatic, journal: [],
  });

  process.stdout.write(`[STEP] runner: dispatching voltron-judge for ${task.id}\n`);
  let scorecard = null;
  if (!opts.dryRun) {
    const judgePrompt = buildJudgePrompt(task, paths, programmatic);
    const { text: judgeText } = await callTool(client, "run_agent_in_docker", {
      agent_name: "voltron-judge",
      task: judgePrompt,
      max_turns: 20,
      model: opts.judgeModel,
    });
    scorecard = extractFencedJson(judgeText);
    if (!scorecard) scorecard = { cannot_grade: { reason: "judge_parse_failed", detail: judgeText.slice(0, 500) } };
  } else {
    scorecard = { cannot_grade: { reason: "dry_run" } };
  }

  scorecard.task_id = task.id;
  scorecard.rubric_version = task.rubric_version_expected;
  scorecard.rubric_path = task.rubric;
  scorecard.agent_under_test = task.agent_under_test;
  scorecard.programmatic = programmatic;
  scorecard.bands = bandsFromSignals(task, programmatic);

  const scorecardPath = path.join(runDir, "scorecard.json");
  await fs.writeFile(scorecardPath, JSON.stringify(scorecard, null, 2), "utf-8");

  if (!scorecard.cannot_grade) {
    const env = reflectionEnvelope(task, scorecard, programmatic, scorecardPath);
    const reflectionFile = path.join(REFLECTIONS_DIR, `${env.timestamp}-eval-${task.id}.json`);
    await fs.mkdir(REFLECTIONS_DIR, { recursive: true });
    await fs.writeFile(reflectionFile, JSON.stringify(env, null, 2), "utf-8");
  }

  const verdict = scorecard.cannot_grade ? "CANNOT_GRADE" : "OK";
  return { taskId: task.id, runDir, scorecardPath, verdict, scorecard };
}

async function main() {
  const opts = parseArgs(process.argv);
  const tasks = loadTasks(opts.all ? null : opts.task);
  const { client, transport } = opts.dryRun ? { client: null, transport: null } : await connectMcp();
  const results = [];
  try {
    for (const t of tasks) {
      try {
        results.push(await runTask(t, client, opts));
      } catch (err) {
        results.push({ taskId: t.id, error: err.message });
      }
    }
  } finally {
    if (transport) await transport.close().catch(() => {});
  }

  // Summary table.
  process.stdout.write("\n=== voltron-evals summary ===\n");
  for (const r of results) {
    if (r.error) process.stdout.write(`  ${r.taskId}: ERROR ${r.error}\n`);
    else process.stdout.write(`  ${r.taskId}: ${r.verdict} → ${path.relative(REPO_ROOT, r.scorecardPath)}\n`);
  }
  const failed = results.some(r => r.error || r.verdict === "CANNOT_GRADE");
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(2); });
