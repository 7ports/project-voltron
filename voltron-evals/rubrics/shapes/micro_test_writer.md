---
rubric_version: 1.0.0
shape_id: micro_test_writer
last_updated: 2026-05-23
extends: [voltron-evals/rubrics/COMMON.md]
scoring: programmatic-only
---

# Shape Rubric — micro_test_writer

Shared across instances of the `micro_test_writer` shape. The load-bearing
question is whether the produced test file EXECUTES SUCCESSFULLY against
the supplied implementation — not whether its diff matches a frozen target.

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

### correctness.test_file_at_expected_path

**Question:** Does the file at `prompt_inputs.test_path` exist after the run,
and is its set membership in `files_changed` exactly the instance's
`expected_files`?
**Evidence required:** `expected_files_match` scorer output.
**Verdict scale:**
- `MET` — file present, set equality holds.
- `PARTIAL` — file present at a near-miss path (e.g. `.test.ts` instead of
  `.spec.ts`) AND no other unexpected files.
- `UNMET` — file missing OR extra files outside expected.

### correctness.test_command_exits_zero

**Question:** Did `prompt_inputs.test_command` exit with code 0 when run
against the produced file?
**Evidence required:** `programmatic_signals.test_command_exit` value and
the captured stdout/stderr tail.
**Verdict scale:**
- `MET` — exit code 0.
- `PARTIAL` — exit code 0 BUT zero assertions reported (skeleton test
  detected via reporter output regex).
- `UNMET` — non-zero exit code.

### correctness.implementation_untouched

**Question:** Was `prompt_inputs.implementation_path` left unmodified?
**Evidence required:** `programmatic_signals.source_diff_empty` filtered to
the implementation path.
**Verdict scale:**
- `MET` — zero diff lines for that path.
- `UNMET` — any modification to the implementation file.
- (No PARTIAL — refactor-during-test-writing is a binary tier_discipline
  failure for test-writers.)

### correctness.behaviour_spec_coverage

**Question:** Does the produced test file contain at least one `describe`
/ `it` / `test` / `def test_*` block whose name references each clause of
`prompt_inputs.behaviour_spec`?
**Evidence required:** literal substring grep of the test file's block
names against the spec's clauses.
**Verdict scale:**
- `MET` — every clause matched (case-insensitive substring).
- `PARTIAL` — at least half the clauses matched.
- `UNMET` — fewer than half matched.

### tier_discipline.budget

See `common.tier_discipline.budget`. Default budget 12 turns; verdict scale
as in common rubric.

### tier_discipline.no_sub_dispatch

As in `micro_single_file_edit` — test-writers are micro-agents, no
sub-dispatch permitted.

### reflection_honesty

See `common.reflection_honesty`. `CANNOT_ASSESS` acceptable.

### doc_hygiene

`CANNOT_ASSESS` by default — test-writers don't update docs.

## Aggregation

Weighted average per dimension; `CANNOT_ASSESS` excluded.
**Pass threshold (informational):** `correctness >= 0.66` AND
`correctness.test_command_exits_zero != UNMET`.

## Scoring path

Programmatic-only. The runner executes `prompt_inputs.test_command` as a
post-dispatch step and feeds the exit code into `test_command_exit`.
