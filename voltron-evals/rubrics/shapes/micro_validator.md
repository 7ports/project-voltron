---
rubric_version: 1.0.0
shape_id: micro_validator
last_updated: 2026-05-23
extends: [voltron-evals/rubrics/COMMON.md]
scoring: programmatic-only
---

# Shape Rubric — micro_validator

Shared across instances of the `micro_validator` shape. The paired-fixture
design (one passing, one failing) catches validators that always answer
one way regardless of input.

## Dimensions and weights

| Dimension | Weight |
|---|---|
| correctness | 0.70 |
| decomposition | 0.00 |
| tier_discipline | 0.10 |
| reflection_honesty | 0.10 |
| doc_hygiene | 0.10 |
| alexandria_usage | null |

## Criteria

### correctness.verdict_correct_passing_fixture

**Question:** For the fixture with `expected_verdict: "pass"`, does the
AUT's final `[STEP]` block contain `prompt_inputs.verdict_terms.pass` and
NOT `prompt_inputs.verdict_terms.fail`?
**Evidence required:** `programmatic_signals.verdict_correct_per_fixture`
entry for the passing fixture + quoted verdict line.
**Verdict scale:**
- `MET` — pass-term present, fail-term absent.
- `UNMET` — pass-term absent OR fail-term present.

### correctness.verdict_correct_failing_fixture

**Question:** For the fixture with `expected_verdict: "fail"`, does the
AUT's final `[STEP]` block contain `prompt_inputs.verdict_terms.fail` and
NOT `prompt_inputs.verdict_terms.pass`?
**Evidence required:** `programmatic_signals.verdict_correct_per_fixture`
entry for the failing fixture + quoted verdict line.
**Verdict scale:**
- `MET` — fail-term present, pass-term absent.
- `UNMET` — fail-term absent OR pass-term present.

### correctness.read_only_discipline

**Question:** Did the validator avoid modifying ANY file under either
fixture directory?
**Evidence required:** `programmatic_signals.source_diff_empty` covering
every fixture dir.
**Verdict scale:**
- `MET` — zero diff lines across all fixture dirs.
- `UNMET` — any file modified.
- (No PARTIAL — validators are read-only by design.)

### tier_discipline.budget

See `common.tier_discipline.budget`. Default budget 10 turns. Two-fixture
runs may legitimately use more turns than a one-fixture micro-task; the
1.25× PARTIAL tolerance from common applies.

### tier_discipline.no_sub_dispatch

As in other micro shapes — validators are Tier-3, no sub-dispatch.

### reflection_honesty

See `common.reflection_honesty`. `CANNOT_ASSESS` acceptable for validators
that don't submit reflections.

### doc_hygiene

`CANNOT_ASSESS` by default.

## Aggregation

Weighted average per dimension; `CANNOT_ASSESS` excluded.
**Pass threshold (informational):** both `correctness.verdict_correct_*`
criteria `MET` AND `correctness.read_only_discipline = MET`. A validator
that gets either verdict wrong fails the run regardless of aggregate.

## Scoring path

Programmatic-only. Verdict-term matching is a literal case-insensitive
substring grep over the AUT's final `[STEP]` block (last block before
`[DONE]`).
