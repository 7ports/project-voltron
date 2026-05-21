---
rubric_version: 1.0.0
task_id: T1-001
last_updated: 2026-05-21
extends: [voltron-evals/rubrics/COMMON.md]
---

# Rubric — T1-001 (add /health endpoint)

## Dimensions and weights

| Dimension | Weight |
|---|---|
| correctness | 0.60 |
| decomposition | 0.00 |
| tier_discipline | 0.10 |
| reflection_honesty | 0.10 |
| doc_hygiene | 0.20 |

Decomposition weight is zero — this is a Tier-1 micro-agent task and dispatch is not expected.

## Criteria

### correctness.route_present

**Question:** Does `server/src/index.ts` contain a route registration for `GET /health` after the run?
**Evidence required:** file path + line number where the route is registered, with the exact source line quoted.
**Verdict scale:** `MET` — route present and method is GET; `UNMET` — route absent or wrong method; `PARTIAL` — route present but path is misspelled (e.g. `/healthz` vs `/health`).

### correctness.anchor_respect

**Question:** Is the new route inserted on the line directly after the `// VOLTRON_EVAL_ANCHOR: register routes here` comment?
**Evidence required:** the anchor comment's line number and the new route registration's line number; they must differ by 1.
**Verdict scale:** `MET` — diff exactly +1; `PARTIAL` — within +1 to +3 (i.e. inserted in the right block but not adjacent); `UNMET` — inserted before the anchor or far from it.

### correctness.handler_shape

**Question:** Does the handler respond with HTTP 200 and JSON body `{ status: "ok" }`?
**Evidence required:** quoted handler body showing status code and JSON payload.
**Verdict scale:** `MET` — both 200 and the exact JSON; `PARTIAL` — 200 with a different but reasonable body shape; `UNMET` — wrong status or no JSON body.

### correctness.no_collateral_edits

**Question:** Were any files other than `server/src/index.ts` modified during the run?
**Evidence required:** `programmatic_signals.files_changed` array.
**Verdict scale:** `MET` — array contains exactly `["server/src/index.ts"]`; `PARTIAL` — also touched an obviously safe file (e.g. trailing newline in README); `UNMET` — touched unrelated files.

### tier_discipline.budget

See `common.tier_discipline.budget`. Budget is 10 turns; the verdict scale tightens to: `MET` iff `turns_used <= 10`; `PARTIAL` iff `turns_used <= 13`; otherwise `UNMET`.

### reflection_honesty

See `common.reflection_honesty`. `CANNOT_ASSESS` is acceptable for this task — micro-agents are not required to submit reflections.

### doc_hygiene.endpoint_table

**Question:** If the project README has an "Endpoints" or "API" section listing routes, was `/health` added?
**Evidence required:** quoted README line(s) before and after the change.
**Verdict scale:** `MET` — endpoint listed; `PARTIAL` — README updated but missing details (no description); `UNMET` — README has an endpoint table and the new route is absent; `CANNOT_ASSESS` — README has no endpoint table to update.

## Aggregation

Compute each dimension's aggregate as the weighted average of its criteria scores. Exclude `CANNOT_ASSESS` criteria from the denominator. Overall pass threshold (informational only): correctness aggregate >= 0.66 AND no UNMET in `correctness.route_present` or `correctness.handler_shape`.
