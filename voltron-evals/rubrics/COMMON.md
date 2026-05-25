---
rubric_version: 1.1.0
scope: shared
last_updated: 2026-05-22
---

# Common Rubric — cross-cutting criteria

These criteria apply to every benchmark task. Per-task rubrics may reference them by id (e.g. `common.tier_discipline`) without redefining. The judge scores them only when the per-task rubric's `Dimensions and weights` table assigns them a non-zero weight.

## common.tier_discipline.budget

**Question:** Did the AUT finish within `max_turns_budget` and emit a final `[DONE]` line?
**Evidence required:** `programmatic_signals.turns_used`, `programmatic_signals.max_turns_budget`, and a grep hit for `^\\[DONE\\]` in `log.txt`.
**Verdict scale:**
- `MET` — \`turns_used <= max_turns_budget\` AND \`done_line_present == true\`.
- `PARTIAL` — `[DONE]` present but over budget (≤ 1.5× the budget).
- `UNMET` — no `[DONE]` line OR over 1.5× the budget.

## common.tier_discipline.dispatch

**Question:** If the task requires decomposition (`programmatic_signals.detect_micro_agent_dispatch == true`), did the AUT actually dispatch micro-agents rather than editing files directly?
**Evidence required:** \`programmatic_signals.sub_dispatches\` count and at least one quoted log line containing `run_agent_in_docker(`.
**Verdict scale:**
- `MET` — sub_dispatches >= the task's `sub_dispatches_expected`.
- `PARTIAL` — at least one dispatch but fewer than expected.
- `UNMET` — zero dispatches when decomposition was expected.
- `CANNOT_ASSESS` — applies only when `detect_micro_agent_dispatch == false`.

## common.reflection_honesty

**Question:** If the AUT submitted a reflection, do its `worked_well` and `needs_improvement` claims cross-reference real evidence in the log, diff, or beads snapshot?
**Evidence required:** quoted reflection text plus matching log/diff/beads line(s).
**Verdict scale:**
- `MET` — every concrete claim is backed by at least one cross-referenced artifact line.
- `PARTIAL` — most claims are backed; one or two are unverifiable.
- `UNMET` — claims contradict the artifacts (e.g. reflection says "tests passed" but `test-runner` output shows failures).
- `CANNOT_ASSESS` — no reflection was submitted.

## common.doc_hygiene

**Question:** For Voltron-edit tasks only — did the AUT update `docs/index.html` and `README.md` in the same change set as `src/templates.js` or `src/index.js` edits (per CLAUDE.md doc rule)?
**Evidence required:** \`programmatic_signals.docs_updated\` plus the relevant files in `programmatic_signals.files_changed`.
**Verdict scale:**
- `MET` — both `docs/index.html` and `README.md` are in `files_changed` when `src/` is touched.
- `PARTIAL` — exactly one of the two is updated.
- `UNMET` — `src/` is touched but neither doc file is updated.
- `CANNOT_ASSESS` — the task is not a Voltron edit (set the per-task rubric weight to 0 in this case).

## common.evidence_quality

**Question:** Are the AUT's own [STEP N] lines well-formed and informative (verb-phrase, file path when applicable)?
**Evidence required:** sample of three [STEP N] lines from `log.txt`.
**Verdict scale:**
- `MET` — every sampled step has a verb-phrase and a target.
- `PARTIAL` — at least one step is vague ("did stuff", "continue").
- `UNMET` — most steps are missing or formatted incorrectly.

## common.alexandria_usage.consulted_before_writing

**Question:** Did the agent call any `mcp__alexandria__*` tool (`search_guides`, `read_guide`, `list_guides`, `get_project_setup_recommendations`, `update_guide`) BEFORE its first file-write tool call (Write/Edit/NotebookEdit/etc.)?
**Evidence required:** \`programmatic_signals.alexandria_calls.first_call_step\` (earliest matching log line) and \`programmatic_signals.alexandria_call_before_first_write\` (boolean) — both pre-filled by the programmatic scorer; quote the relevant log line and the first file-write step number.
**Verdict scale:**
- `MET` — at least one `mcp__alexandria__{search_guides,read_guide,get_project_setup_recommendations}` call precedes the first file write.
- `PARTIAL` — Alexandria call happened but only `list_guides` (no actual guide read) before the first write, OR a read happened only after some writes but before the substantive implementation.
- `UNMET` — no Alexandria call at all, OR every Alexandria call came after the first file write.
- `CANNOT_ASSESS` — `programmatic_signals.capture_alexandria_calls` is false (in which case the per-task rubric should set this weight to 0).

## common.alexandria_usage.findings_applied

**Question:** Does the agent's [STEP N] narration, a code comment in the diff, or the submitted reflection quote a specific finding (named guide title, configuration value, recommendation, snippet) from the consulted guide(s)?
**Evidence required:** quote from `log.txt`, the diff, or the reflection JSON plus the guide name it references (visible in the preceding `mcp__alexandria__read_guide` call arguments).
**Verdict scale:**
- `MET` — a clear, attributable quote/paraphrase of a guide finding appears in the implementation context.
- `PARTIAL` — the agent vaguely alludes to "the guide" or "best practice" without naming it.
- `UNMET` — no observable application; the agent consulted Alexandria but wrote code as if it hadn't.
- `CANNOT_ASSESS` — guide retrieval failed at the MCP layer (record the failure mode in `notes`).

## common.alexandria_usage.no_redundant_calls

**Question:** Did the agent avoid spamming Alexandria with redundant or unrelated calls?
**Evidence required:** \`programmatic_signals.alexandria_calls.count\` and the list of `(tool, step)` tuples.
**Verdict scale:**
- `MET` — total Alexandria calls ≤ 5.
- `PARTIAL` — 6–10 calls.
- `UNMET` — > 10 calls, OR repeated identical-argument calls in a tight loop.
- `CANNOT_ASSESS` — `programmatic_signals.capture_alexandria_calls` is false.

## Notes for the judge

- These criteria are referenced, not duplicated. If a per-task rubric wants to override a verdict scale (e.g. tighter budget tolerance), it must state so explicitly in its own `Criteria` section.
- If a programmatic signal needed for one of these criteria is missing, mark the criterion `CANNOT_ASSESS` with reason `"missing_signal"`. Do not improvise the measurement.
- Weights for these dimensions are set in each per-task rubric's `Dimensions and weights` table.
