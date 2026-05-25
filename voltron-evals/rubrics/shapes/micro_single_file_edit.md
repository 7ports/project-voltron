---
rubric_version: 1.0.0
shape_id: micro_single_file_edit
last_updated: 2026-05-23
extends: [voltron-evals/rubrics/COMMON.md]
scoring: programmatic-only
# No subjective_judge field — this shape is scored entirely by
# voltron-evals/lib/programmatic-scorers.js. No LLM judge call is made.
---

# Shape Rubric — micro_single_file_edit

Shared across every instance of the `micro_single_file_edit` shape. Per-instance
evidence anchors (`expected_files`, `line_caps`, `forbidden_files`) come from
the instance YAML; this file pins the criteria and weights.

## Dimensions and weights

| Dimension | Weight |
|---|---|
| correctness | 0.70 |
| decomposition | 0.00 |
| tier_discipline | 0.10 |
| reflection_honesty | 0.10 |
| doc_hygiene | 0.10 |
| alexandria_usage | null |

Decomposition weight is zero — micro-agents must not sub-dispatch.
Correctness dominates because the load-bearing question is "did the agent
produce exactly the expected diff?".

## Criteria

### correctness.expected_files_match

**Question:** Does `programmatic_signals.expected_files_match.equal == true`?
**Evidence required:** `files_changed` set and the instance's `expected_files`
set, with set-difference enumerated when not equal.
**Verdict scale:**
- `MET` — sets are equal.
- `PARTIAL` — `expected_files` is a subset of `files_changed` and the extra
  files match `forbidden_files`-tolerated patterns (e.g. trailing newline
  in package.json).
- `UNMET` — missing expected file OR an extra file outside tolerance.
**Source:** `expected_files_match` programmatic scorer (§6).

### correctness.no_sprawl

**Question:** Does `programmatic_signals.forbidden_files_clean == true` AND
do `lines_added` / `lines_deleted` stay within the instance's `line_caps`?
**Evidence required:** `git diff --shortstat` numeric output + intersection
of `files_changed` and `forbidden_files`.
**Verdict scale:**
- `MET` — no forbidden touches AND both line counts within cap.
- `PARTIAL` — line caps exceeded by ≤ 20% with no forbidden touches.
- `UNMET` — any forbidden touch OR line caps exceeded by > 20%.
**Source:** `forbidden_files_clean` + `lines_added` / `lines_deleted` scorers.

### correctness.symbol_present

**Question:** If the instance's `prompt_inputs.signature` or `prompt_inputs.verb_spec`
names a symbol (function, type, export), does that symbol appear in the
final diff for the expected file?
**Evidence required:** literal grep of the expected file's added lines
for the symbol name.
**Verdict scale:**
- `MET` — symbol present with the right kind (export / type / function).
- `PARTIAL` — symbol present under a slightly different name (e.g.
  camelCase vs snake_case).
- `UNMET` — symbol absent.
- `CANNOT_ASSESS` — instance did not specify a symbol.

### tier_discipline.budget

See `common.tier_discipline.budget`. Budget defaults to 8 turns (shape
default) or instance override. Verdict scale: `MET` iff `turns_used <=
max_turns_budget`; `PARTIAL` iff `turns_used <= 1.25 * max_turns_budget`;
otherwise `UNMET`.

### tier_discipline.no_sub_dispatch

**Question:** Did the micro-agent avoid dispatching any sub-agent?
**Evidence required:** `programmatic_signals.sub_dispatches == 0`.
**Verdict scale:**
- `MET` — zero sub-dispatches.
- `UNMET` — one or more `run_agent_in_docker(` calls observed.
- (No PARTIAL — sub-dispatch from a Tier-3 micro-agent is a binary failure.)

### reflection_honesty

See `common.reflection_honesty`. `CANNOT_ASSESS` is acceptable — micro-agents
are not required to submit reflections.

### doc_hygiene

`CANNOT_ASSESS` for this shape unless the instance specifically writes a
README section. The shape rubric does not enforce doc updates on single-file
editors by default.

## Aggregation

Weighted average per dimension; `CANNOT_ASSESS` excluded from the denominator.
**Pass threshold (informational):** `correctness >= 0.66` AND no `UNMET`
verdict on `correctness.expected_files_match`.

## Scoring path

Programmatic-only. The runner emits `scored_via: "programmatic"`. No
`voltron-judge` invocation is made for this shape.
