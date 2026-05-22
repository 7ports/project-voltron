// voltron-evals/lib/programmatic-scorers.js
//
// Deterministic, no-LLM scorers per design §6. Run BEFORE the judge so its
// fenced-JSON scorecard can quote these as raw measurements rather than
// re-derive them. Each function takes (task, ctx) where ctx contains
// { pre, post, journal } from artifacts.js.
//
// Rule of thumb: programmatic > LLM-as-judge > Agent-as-judge. Only let the
// judge opine on things that genuinely need reasoning.

import { gitDiffNames, gitShortstat } from "./artifacts.js";

const STEP_RE = /^\[STEP \s*\d+\]/m;
const DONE_RE = /^\[DONE\]/m;

function countStepLines(log) {
  if (!log) return 0;
  return (log.match(/^\[STEP \s*\d+\]/gm) ?? []).length;
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

export function runScorers(task, ctx) {
  const { pre, post, journal } = ctx;
  const log = post.log || "";
  const signals = task.programmatic_signals || {};

  const turns_used = signals.capture_turn_count !== false ? countStepLines(log) : null;
  const done_line_present = signals.require_done_line !== false ? DONE_RE.test(log) : null;
  const files = signals.capture_files_changed !== false ? gitDiffNames(pre.gitSha, post.gitSha) : [];
  const { lines_added, lines_deleted } = gitShortstat(pre.gitSha, post.gitSha);
  const dispatches = signals.detect_micro_agent_dispatch ? countDispatches(log) : { count: 0, targets: [] };
  const beads = signals.capture_beads_snapshot ? beadsDiff(pre, post) : { created: [], closed: [], deps_count: 0 };
  const max = task.max_turns || 30;

  return {
    turns_used,
    done_line_present,
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
  return bands;
}
