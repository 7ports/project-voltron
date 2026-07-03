// voltron-evals/lib/programmatic-scorers.js
//
// Deterministic, no-LLM scorers per design §6. Run BEFORE the judge so its
// fenced-JSON scorecard can quote these as raw measurements rather than
// re-derive them. Each function takes (task, ctx) where ctx contains
// { pre, post, journal } from artifacts.js.
//
// Rule of thumb: programmatic > LLM-as-judge > Agent-as-judge. Only let the
// judge opine on things that genuinely need reasoning.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { gitDiffNames, gitShortstat, diffWorkingTreeSnapshots, fileListShortstat } from "./artifacts.js";

const REPO_ROOT = process.env.VOLTRON_REPO_ROOT || process.cwd();

// Logs are stream-json JSONL: the agent's `[STEP N]` / `[DONE]` markers live
// inside JSON-encoded `"text"` payloads where line-breaks are escaped (`\n`),
// so a `^`-anchored regex misses them. Match the markers as substrings; for
// step counting, dedupe by step number to avoid counting the same line twice
// when it echoes in both the assistant event and the final result event.
const STEP_RE = /\[STEP\s+\d+\]/;
const DONE_RE = /\[DONE\]/;

function countStepLines(log) {
  if (!log) return 0;
  const seen = new Set();
  for (const m of log.matchAll(/\[STEP\s+(\d+)\]/g)) seen.add(m[1]);
  return seen.size;
}

function countDispatches(log) {
  if (!log) return { count: 0, targets: [] };
  // Match both the MCP tool name and obvious template-string references.
  const re = /run_agent_in_docker[^a-z_]*[\s\S]{0,200}?agent_name["']?\s*[:=]\s*["']([\w-]+)["']/g;
  const targets = [];
  let m; let total = 0;
  while ((m = re.exec(log)) !== null) { targets.push(m[1]); total++; }
  // Also count bare "run_agent_in_docker" mentions in case the agent_name regex misses one.
  const bareCount = (log.match(/run_agent_in_docker/g) ?? []).length;
  return { count: Math.max(total, bareCount), targets };
}

function beadsDiff(pre, post) {
  const idOf = b => (b.id ?? b.beads_id ?? b.title ?? JSON.stringify(b));
  const preSet = new Set((pre.beads ?? []).map(idOf));
  const postSet = new Set((post.beads ?? []).map(idOf));
  const created = [...postSet].filter(id => !preSet.has(id));
  // closed = present in both but status changed to closed
  const postMap = new Map((post.beads ?? []).map(b => [idOf(b), b]));
  const preMap = new Map((pre.beads ?? []).map(b => [idOf(b), b]));
  const closed = [];
  for (const [id, b] of postMap) {
    const before = preMap.get(id);
    if (before && (before.status ?? "open") !== "closed" && (b.status ?? "open") === "closed") closed.push(id);
  }
  const deps = (post.beads ?? []).reduce((n, b) => n + (Array.isArray(b.dependencies) ? b.dependencies.length : 0), 0);
  return { created, closed, deps_count: deps };
}

function journalSummary(journal) {
  if (!Array.isArray(journal)) return { count: 0, kinds: {} };
  const kinds = {};
  for (const j of journal) {
    const k = j?.kind || j?.type || "unknown";
    kinds[k] = (kinds[k] || 0) + 1;
  }
  return { count: journal.length, kinds };
}

function docsTouched(files) {
  return files.some(f => f === "README.md" || f === "docs/index.html" || f.startsWith("docs/"));
}

function committerDispatched(targets, log) {
  if (targets.includes("committer")) return true;
  return /\[committer\]|committer-\d{4}-\d{2}-\d{2}T/.test(log || "");
}

// First step at which any file-write tool ran. Looks for the canonical writer
// tool names that appear in stream-json tool-use blocks: Write, Edit,
// MultiEdit, NotebookEdit. Matching is keyed off the `[STEP N]` line that
// immediately precedes each tool-use event. Returns null if no write happened.
const WRITE_TOOL_RE = /"name"\s*:\s*"(Write|Edit|MultiEdit|NotebookEdit)"/;
function firstFileWriteStep(log) {
  if (!log) return null;
  // Walk the log linearly. Track the last-seen [STEP N] number; when we see a
  // writer-tool name we return that number.
  let lastStep = null;
  const lineRe = /\[STEP\s+(\d+)\]|"name"\s*:\s*"(Write|Edit|MultiEdit|NotebookEdit)"/g;
  let m;
  while ((m = lineRe.exec(log)) !== null) {
    if (m[1] !== undefined) {
      lastStep = Number(m[1]);
    } else if (m[2] !== undefined) {
      return lastStep;
    }
  }
  return null;
}

// Grep the AUT log for `mcp__alexandria__*` tool calls. Records count, the
// earliest occurrence step, and per-call metadata including whether it ran
// before the first file write. Design §6, alexandria_calls signal.
const ALEXANDRIA_TOOLS = [
  "search_guides",
  "read_guide",
  "list_guides",
  "get_project_setup_recommendations",
  "update_guide",
];
const ALEXANDRIA_RE = /"name"\s*:\s*"(mcp__alexandria__(search_guides|read_guide|list_guides|get_project_setup_recommendations|update_guide))"/g;

function scanAlexandriaCalls(log, firstWriteStep) {
  if (!log) {
    return { count: 0, first_call_step: null, calls: [], by_tool: {} };
  }
  // Index by stepping through the log and tracking last-seen [STEP N].
  const calls = [];
  let lastStep = null;
  const lineRe = /\[STEP\s+(\d+)\]|"name"\s*:\s*"mcp__alexandria__(search_guides|read_guide|list_guides|get_project_setup_recommendations|update_guide)"/g;
  let m;
  while ((m = lineRe.exec(log)) !== null) {
    if (m[1] !== undefined) {
      lastStep = Number(m[1]);
    } else if (m[2] !== undefined) {
      const tool = m[2];
      const step = lastStep;
      const before_first_write =
        firstWriteStep == null ? true : step != null && step < firstWriteStep;
      calls.push({ tool, step, before_first_write });
    }
  }
  const by_tool = {};
  for (const c of calls) by_tool[c.tool] = (by_tool[c.tool] || 0) + 1;
  const first_call_step = calls.length ? calls[0].step : null;
  return { count: calls.length, first_call_step, calls, by_tool };
}

// ── Shape-specific scorers ────────────────────────────────────────────────

// micro_test_writer: runs the configured test_command in the fixture dir and
// records the exit code. Design §6 `capture_test_command_exit`.
export function captureTestCommandExit(task) {
  const cmd = task?.parameters?.test_command || task?.test_command;
  if (!cmd) return { ran: false, exit_code: null, reason: "no test_command configured" };
  const fixtureDir = task?.parameters?.fixture?.dir || task?.fixture?.dir;
  const cwd = fixtureDir ? path.join(REPO_ROOT, fixtureDir) : REPO_ROOT;
  if (fixtureDir && !existsSync(cwd)) {
    return { ran: false, exit_code: null, reason: `fixture dir missing: ${fixtureDir}` };
  }
  try {
    execSync(cmd, { cwd, stdio: "pipe", timeout: 5 * 60 * 1000 });
    return { ran: true, exit_code: 0, cwd: path.relative(REPO_ROOT, cwd) };
  } catch (e) {
    const code = typeof e.status === "number" ? e.status : (e.code || 1);
    return { ran: true, exit_code: code, cwd: path.relative(REPO_ROOT, cwd) };
  }
}

// micro_validator: for each declared fixture, check whether the AUT log emitted
// the expected verdict term (pass/fail) for that fixture id in its final
// [STEP] block. Returns one boolean per fixture + an aggregate.
export function captureVerdictPerFixture(task, log) {
  const fixtures = task?.parameters?.fixture?.fixtures || task?.fixture?.fixtures || [];
  const terms = task?.parameters?.prompt_inputs?.verdict_terms ||
                task?.prompt_inputs?.verdict_terms ||
                { pass: "PASS", fail: "FAIL" };
  if (!Array.isArray(fixtures) || !fixtures.length) {
    return { fixtures: {}, all_correct: null, reason: "no fixtures declared" };
  }
  // Final [STEP] block: everything from the last [STEP N] marker to end of log
  // (or [DONE]).
  let tail = log || "";
  const lastStep = [...tail.matchAll(/\[STEP\s+\d+\]/g)].pop();
  if (lastStep) tail = tail.slice(lastStep.index);
  const result = {};
  let allCorrect = true;
  for (const f of fixtures) {
    const want = String(f.expected_verdict || "").toLowerCase();
    const wantedTerm = want === "pass" ? terms.pass : terms.fail;
    // Per-fixture match: the fixture id and the verdict term must both appear
    // somewhere in the final tail block, in either order, within ~400 chars.
    const idIdx = tail.indexOf(String(f.id));
    const termIdx = wantedTerm ? tail.indexOf(String(wantedTerm)) : -1;
    const matched = idIdx >= 0 && termIdx >= 0 && Math.abs(idIdx - termIdx) <= 400;
    result[f.id] = { expected_verdict: f.expected_verdict, expected_term: wantedTerm, matched };
    if (!matched) allCorrect = false;
  }
  return { fixtures: result, all_correct: allCorrect };
}

// micro_committer: classify the git/state delta + log into one of the
// canonical publish actions. Returns an enum string.
export function capturePublishAction(task, ctx) {
  const log = ctx?.post?.log || "";
  const filesChanged = ctx?.post?.workingTree && ctx?.pre?.workingTree
    ? diffWorkingTreeSnapshots(ctx.pre.workingTree, ctx.post.workingTree)
    : [];
  const preSha = ctx?.pre?.gitSha;
  const postSha = ctx?.post?.gitSha;
  const newCommit = preSha && postSha && preSha !== postSha;

  // Detect command/tool signatures in the log.
  const sawCommit = newCommit || /git\s+commit\b/i.test(log) || /"name"\s*:\s*"committer"/.test(log);
  const sawPush = /git\s+push\b/i.test(log);
  const sawPrCreate = /gh\s+pr\s+create\b/i.test(log) || /pulls\s+create\b/.test(log);
  const sawBranchCreate = /git\s+(switch|checkout)\s+-[bB]\b/.test(log) ||
                          /git\s+branch\s+[^\-]/.test(log);
  const sawDeploy = /deploy[-_ ]?trigger/i.test(log) ||
                    /gh\s+workflow\s+run\b/i.test(log) ||
                    /curl[^|]*\/deploy/i.test(log);
  const changelogTouched = filesChanged.some(f => /(^|\/)CHANGELOG\.md$/i.test(f));

  let action = "none";
  const flags = [sawCommit, sawPrCreate, sawBranchCreate, sawDeploy, changelogTouched].filter(Boolean);
  if (flags.length > 1) {
    // Multiple distinct publish signals — must check if it's the legitimate
    // composite (e.g. changelog-updater commits a changelog) or actual overreach.
    if (changelogTouched && sawCommit && !sawPrCreate && !sawBranchCreate && !sawDeploy) {
      action = "changelog_appended";
    } else {
      action = "multiple";
    }
  } else if (sawPrCreate) action = "pr_opened";
  else if (changelogTouched) action = "changelog_appended";
  else if (sawCommit) action = "committed";
  else if (sawBranchCreate) action = "branch_created";
  else if (sawDeploy) action = "deployed";

  return {
    action,
    saw_commit: sawCommit,
    saw_push: sawPush,
    saw_pr_create: sawPrCreate,
    saw_branch_create: sawBranchCreate,
    saw_deploy: sawDeploy,
    changelog_touched: changelogTouched,
    new_commit_sha: newCommit ? postSha : null,
  };
}

// Sum token usage across EVERY stream-json `usage` event in the AUT log
// (F1 B4 / F3 §2 P0-b). The CLI's stream-json emits a `usage` object on each
// assistant message event and a cumulative one on the final result event; this
// deterministically sums input_tokens / output_tokens / cache_read_input_tokens
// / cache_creation_input_tokens across all of them and counts the events, so
// the analysis step (§6.1) can price a run from an explicit fable/opus table.
// Cost is intentionally NOT computed here — the CLI price table lacks fable.
function parseUsage(log) {
  const out = { input: 0, output: 0, cache_read: 0, cache_creation: 0, events: 0 };
  if (!log) return out;
  const re = /"usage"\s*:\s*\{/g;
  let m;
  while ((m = re.exec(log)) !== null) {
    // Brace-match the usage object starting at the `{` the regex consumed.
    // usage values are all numeric (no string values) so a plain depth count
    // is sufficient — no in-string brace escaping to worry about.
    let i = re.lastIndex - 1;
    let depth = 0;
    let end = -1;
    for (; i < log.length; i++) {
      const c = log[i];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) continue;
    let usage;
    try { usage = JSON.parse(log.slice(re.lastIndex - 1, end + 1)); }
    catch { continue; }
    out.input += usage.input_tokens || 0;
    out.output += usage.output_tokens || 0;
    out.cache_read += usage.cache_read_input_tokens || 0;
    out.cache_creation += usage.cache_creation_input_tokens || 0;
    out.events += 1;
  }
  return out;
}

export function runScorers(task, ctx) {
  const { pre, post, journal } = ctx;
  const log = post.log || "";
  const signals = task.programmatic_signals || {};

  const turns_used = signals.capture_turn_count !== false ? countStepLines(log) : null;
  const done_line_present = signals.require_done_line !== false ? DONE_RE.test(log) : null;
  // Micro-AUTs don't commit — their changes live in the working tree. Compare
  // working-tree snapshots when commit SHAs are unchanged, otherwise use the
  // commit-range diff (for tasks where the AUT actually commits).
  let files = [];
  let lines_added = 0;
  let lines_deleted = 0;
  if (signals.capture_files_changed !== false) {
    if (pre.gitSha && post.gitSha && pre.gitSha !== post.gitSha) {
      files = gitDiffNames(pre.gitSha, post.gitSha);
      const stat = gitShortstat(pre.gitSha, post.gitSha);
      lines_added = stat.lines_added; lines_deleted = stat.lines_deleted;
    } else if (pre.workingTree && post.workingTree) {
      files = diffWorkingTreeSnapshots(pre.workingTree, post.workingTree);
      const stat = fileListShortstat(files);
      lines_added = stat.lines_added; lines_deleted = stat.lines_deleted;
    }
  }
  const tokens = parseUsage(log);
  const dispatches = signals.detect_micro_agent_dispatch ? countDispatches(log) : { count: 0, targets: [] };
  const beads = signals.capture_beads_snapshot ? beadsDiff(pre, post) : { created: [], closed: [], deps_count: 0 };
  const max = task.max_turns || 30;

  let alexandria_calls = null;
  let alexandria_call_before_first_write = null;
  let first_file_write_step = null;
  if (signals.capture_alexandria_calls) {
    first_file_write_step = firstFileWriteStep(log);
    alexandria_calls = scanAlexandriaCalls(log, first_file_write_step);
    alexandria_call_before_first_write =
      alexandria_calls.calls.some(c => c.before_first_write && c.tool !== "list_guides");
  }

  // Shape-specific signals (design §6, Stage 5).
  const test_command_exit = signals.capture_test_command_exit
    ? captureTestCommandExit(task) : null;
  const verdict_per_fixture = signals.capture_verdict_per_fixture
    ? captureVerdictPerFixture(task, log) : null;
  const publish_action = signals.capture_publish_action
    ? capturePublishAction(task, ctx) : null;

  return {
    turns_used,
    done_line_present,
    tokens,
    max_turns_budget: max,
    budget_utilization: turns_used == null ? null : Math.min(1, turns_used / max),
    files_changed: files,
    file_count: files.length,
    lines_added,
    lines_deleted,
    sub_dispatches: dispatches.count,
    sub_dispatch_targets: dispatches.targets,
    beads_created: beads.created,
    beads_closed: beads.closed,
    beads_deps_count: beads.deps_count,
    journal: journalSummary(journal),
    reflection_submitted: post.newReflections.length > 0,
    docs_updated: signals.check_doc_updates ? docsTouched(files) : null,
    editor_handoff_emitted: /🎮\s*Editor task/i.test(log),
    commit_dispatched_via_committer: committerDispatched(dispatches.targets, log),
    has_step_lines: STEP_RE.test(log),
    alexandria_calls,
    alexandria_call_before_first_write,
    first_file_write_step,
    test_command_exit,
    verdict_per_fixture,
    publish_action,
  };
}

// Map the raw signals to a coarse {0..1} band per dimension. The judge can
// still override correctness/decomposition/honesty interpretations; the bands
// here are anchors so the judge cannot disagree with raw measurements.
export function bandsFromSignals(task, sig) {
  const bands = {};
  if (sig.budget_utilization != null) {
    bands.tier_discipline_budget = sig.budget_utilization <= 1 ? 1 : 0;
  }
  if (sig.done_line_present != null) {
    bands.tier_discipline_done = sig.done_line_present ? 1 : 0;
  }
  if (task.programmatic_signals?.detect_micro_agent_dispatch) {
    bands.tier_discipline_dispatch = sig.sub_dispatches > 0 ? 1 : 0;
  }
  if (task.programmatic_signals?.check_doc_updates) {
    bands.doc_hygiene_touched = sig.docs_updated ? 1 : 0;
  }
  if (task.programmatic_signals?.capture_alexandria_calls) {
    bands.alexandria_usage_consulted_before_writing =
      sig.alexandria_call_before_first_write ? 1 : 0;
    const n = sig.alexandria_calls?.count ?? 0;
    bands.alexandria_usage_no_redundant_calls = n <= 5 ? 1 : n <= 10 ? 0.5 : 0;
  }
  // Shape-specific bands (Stage 5).
  if (task.programmatic_signals?.capture_test_command_exit && sig.test_command_exit) {
    const t = sig.test_command_exit;
    bands.correctness_test_command_exit = t.ran && t.exit_code === 0 ? 1 : 0;
  }
  if (task.programmatic_signals?.capture_verdict_per_fixture && sig.verdict_per_fixture) {
    bands.correctness_verdict_per_fixture = sig.verdict_per_fixture.all_correct ? 1 : 0;
  }
  if (task.programmatic_signals?.capture_publish_action && sig.publish_action) {
    const canonical = task.parameters?.canonical_action || task.canonical_action;
    bands.correctness_canonical_action_taken =
      canonical && sig.publish_action.action === canonical ? 1 : 0;
  }
  return bands;
}
