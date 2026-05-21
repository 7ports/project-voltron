---
rubric_version: 1.0.0
scope: shared
last_updated: 2026-05-21
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

## Notes for the judge

- These criteria are referenced, not duplicated. If a per-task rubric wants to override a verdict scale (e.g. tighter budget tolerance), it must state so explicitly in its own `Criteria` section.
- If a programmatic signal needed for one of these criteria is missing, mark the criterion `CANNOT_ASSESS` with reason `"missing_signal"`. Do not improvise the measurement.
- Weights for these dimensions are set in each per-task rubric's `Dimensions and weights` table.
