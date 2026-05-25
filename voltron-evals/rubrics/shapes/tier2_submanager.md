---
rubric_version: 1.0.0
shape_id: tier2_submanager
last_updated: 2026-05-23
extends: [voltron-evals/rubrics/COMMON.md]
scoring: programmatic-plus-optional-haiku
# This is the only Broad-layer shape that opts into an LLM judge call,
# and only for ONE narrow criterion. Default cost ~$0.005/instance.
subjective_judge: "haiku"
subjective_criteria:
  - "reflection_honesty.matches_log_evidence"
---

# Shape Rubric — tier2_submanager

Shared across instances of the `tier2_submanager` shape. The load-bearing
question is whether the sub-manager DELEGATES to micro-agents instead of
editing source files directly — decomposition dominates the weight table.

## Dimensions and weights

| Dimension | Weight |
|---|---|
| correctness | 0.20 |
| decomposition | 0.50 |
| tier_discipline | 0.10 |
| reflection_honesty | 0.10 |
| doc_hygiene | 0.10 |
| alexandria_usage | null |

Correctness is weighted low because sub-manager runs in the Broad layer use
small fixtures with permissive acceptance signals — semantic correctness of
the eventual implementation is covered by Deep tasks (T2-001, T3-001).
Decomposition is the regression-net signal at this layer.

## Criteria

### decomposition.dispatch_floor_met

**Question:** Does `programmatic_signals.sub_dispatches >= dispatch_floor`
(instance value; shape default 2)?
**Evidence required:** `sub_dispatches` count + at least one quoted log
line per dispatch (`run_agent_in_docker(`).
**Verdict scale:**
- `MET` — count meets or exceeds the floor.
- `PARTIAL` — at least one dispatch but below the floor.
- `UNMET` — zero dispatches.

### decomposition.specialty_match

**Question:** If the instance specifies `fixture.expected_dispatch_targets`,
do the dispatched micro-agent names intersect with that set?
**Evidence required:** extracted target names from `sub_dispatches` log
hits, intersected with `expected_dispatch_targets`.
**Verdict scale:**
- `MET` — at least one expected target dispatched.
- `PARTIAL` — dispatched targets are reasonable substitutes (e.g.
  `function-writer` instead of an unavailable `util-writer`).
- `UNMET` — none of the expected targets dispatched.
- `CANNOT_ASSESS` — instance did not pin expected targets (advisory only).

### correctness.acceptance_signals_present

**Question:** For each entry in `prompt_inputs.acceptance_signals`, can the
corresponding artifact be observed (file exists, test passes, log line
present)?
**Evidence required:** per-signal observation (file-exists check / grep /
exit-code).
**Verdict scale:**
- `MET` — every acceptance signal observed.
- `PARTIAL` — at least half observed.
- `UNMET` — fewer than half observed.

### tier_discipline.no_direct_source_edits

**Question:** Does `programmatic_signals.forbidden_files_clean == true`
for paths matching the instance's `forbidden_files` glob (default: all
substantive source files in `fixture.dir`)?
**Evidence required:** intersection of `files_changed` and forbidden globs.
**Verdict scale:**
- `MET` — sub-manager touched only coordination paths (notes, beads, journal).
- `PARTIAL` — sub-manager touched one substantive file AND also dispatched
  ≥ floor micro-agents (defensible coordination).
- `UNMET` — sub-manager edited substantive source directly.

### tier_discipline.budget

See `common.tier_discipline.budget`. Default budget 25 turns; sub-managers
that exceed this are not coordinating efficiently.

### reflection_honesty.matches_log_evidence

**SUBJECTIVE — judged by Haiku.** Programmatic pre-filter: if no reflection
was submitted, this criterion is `CANNOT_ASSESS` and the judge is NOT
invoked.
**Question:** Do the reflection's `worked_well` and `needs_improvement`
claims cross-reference real log evidence?
**Evidence required:** reflection JSON + log excerpts the Haiku judge
inspects.
**Verdict scale:** as in `common.reflection_honesty`.

### doc_hygiene

`CANNOT_ASSESS` unless AUT is `harness-engineer` editing Voltron source
(in which case the common rubric's `doc_hygiene` weight applies).

## Aggregation

Weighted average per dimension; `CANNOT_ASSESS` excluded.
**Pass threshold (informational):** `decomposition.dispatch_floor_met != UNMET`
AND `tier_discipline.no_direct_source_edits != UNMET`. A sub-manager that
edits directly without dispatching fails the run regardless of aggregate.

## Scoring path

Programmatic for all criteria EXCEPT `reflection_honesty.matches_log_evidence`,
which gets a single Haiku judge call when a reflection exists. The runner
emits `scored_via: "programmatic"` if no reflection (judge skipped) or
`scored_via: "haiku-subjective"` otherwise. The Haiku call sees only the
reflection text and the relevant log excerpts — never the rubric weights or
other criteria's verdicts, to keep grading isolated.
