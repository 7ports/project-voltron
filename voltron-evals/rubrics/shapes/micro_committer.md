---
rubric_version: 1.0.0
shape_id: micro_committer
last_updated: 2026-05-23
extends: [voltron-evals/rubrics/COMMON.md]
scoring: programmatic-only
---

# Shape Rubric — micro_committer

Shared across instances of the `micro_committer` shape (committer,
branch-creator, pr-opener, deploy-trigger, changelog-updater). The shape
catches publish-family agents that overreach (commit + push, edit + commit,
branch + checkout-and-modify).

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

### correctness.canonical_action_taken

**Question:** Does `programmatic_signals.publish_action_taken` equal the
instance's `canonical_action`?
**Evidence required:** publish-action scorer enum output + the git/state
delta that supports the classification.
**Verdict scale:**
- `MET` — exact match.
- `PARTIAL` — canonical action taken AND one tolerated incidental side
  effect (e.g. committer also amended the staging index with a `git add`
  on already-staged files).
- `UNMET` — wrong action (e.g. committer pushed; branch-creator switched
  branches; pr-opener also committed) OR `none` OR `multiple`.

### correctness.no_side_effects

**Question:** Are `files_changed` empty for every path not in the instance's
`expected_files` (default empty for non-changelog actions)?
**Evidence required:** `forbidden_files_clean` + `files_changed` diff.
**Verdict scale:**
- `MET` — only `expected_files` (if any) were touched.
- `UNMET` — any file touched outside `expected_files`.

### correctness.canonical_payload_present

**Question:** Does the action's payload match the instance's prompt input?
For `committer`: does the commit message contain `prompt_inputs.commit_message_hint`?
For `branch-creator`: does the new ref name equal `prompt_inputs.branch_name`?
For `pr-opener`: does the PR title equal `prompt_inputs.pr_title`?
For `changelog-updater`: does the new CHANGELOG entry contain `prompt_inputs.entry_summary`
under `prompt_inputs.section`?
**Evidence required:** git log / refs / PR-stub state / CHANGELOG diff
hunk, quoted.
**Verdict scale:**
- `MET` — payload matches exactly (substring for messages, equality for refs).
- `PARTIAL` — payload semantically equivalent but reworded (commit message
  paraphrased while preserving the hint).
- `UNMET` — payload missing or wrong.

### tier_discipline.budget

See `common.tier_discipline.budget`. Default budget 6 turns. Publish
actions are atomic; overruns indicate the agent is doing something other
than its one action.

### tier_discipline.no_sub_dispatch

Publish-family agents are Tier-3 — no sub-dispatch permitted.

### reflection_honesty

See `common.reflection_honesty`. `CANNOT_ASSESS` acceptable.

### doc_hygiene

`CANNOT_ASSESS` unless `canonical_action == changelog_appended`, in which
case the changelog itself IS the doc artifact and is already scored by
`correctness.canonical_payload_present`.

## Aggregation

Weighted average per dimension; `CANNOT_ASSESS` excluded.
**Pass threshold (informational):** `correctness.canonical_action_taken =
MET` AND `correctness.no_side_effects = MET`. A publish-family agent that
took the wrong action OR took its action plus extras fails regardless of
aggregate score.

## Scoring path

Programmatic-only. The `capture_publish_action` scorer classifies the
git/state delta into one of the canonical enum values; payload checks are
literal substring or equality against `prompt_inputs`.
