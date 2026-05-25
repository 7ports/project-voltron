---
rubric_version: 1.0.0
shape_id: tier1_coordinator
last_updated: 2026-05-23
extends: [voltron-evals/rubrics/COMMON.md]
scoring: programmatic-only
---

# Shape Rubric — tier1_coordinator

Shared across instances of the `tier1_coordinator` shape (scrum-master,
code-analyst, doc-writer, researcher, adr-writer, api-doc-generator,
diagram-maker). Coordinators don't write production code, so correctness
is zeroed; decomposition dominates.

## Dimensions and weights

| Dimension | Weight |
|---|---|
| correctness | 0.00 |
| decomposition | 0.60 |
| tier_discipline | 0.10 |
| reflection_honesty | 0.10 |
| doc_hygiene | 0.20 |
| alexandria_usage | null |

Correctness is zero because the shape asks "did the coordinator produce
planning/doc artifacts?" — not "did the code work?". Decomposition is the
flagship dimension here: it scores the QUALITY of the planning artifact
(work plan, beads graph, ADR, dashboard registration).

## Criteria

### decomposition.artifact_present

**Question:** Does the instance's `expected_files` set match
`files_changed` (set equality)?
**Evidence required:** `expected_files_match` scorer output.
**Verdict scale:**
- `MET` — sets equal.
- `PARTIAL` — expected artifact present at a near-miss path, no extras.
- `UNMET` — expected artifact missing OR extra source files touched.

### decomposition.artifact_anchors_present

**Question:** Does the produced artifact (file at `prompt_inputs.test_path`
or the first member of `expected_files`) contain every literal substring
in `prompt_inputs.artifact_anchors`?
**Evidence required:** literal grep of each anchor in the artifact text;
quote the matching line.
**Verdict scale:**
- `MET` — every anchor matched.
- `PARTIAL` — at least half of anchors matched.
- `UNMET` — fewer than half matched.

### decomposition.beads_floor_met

**Question:** If `parameters.expected_beads_floor > 0`, does
`programmatic_signals.beads_created.length >= expected_beads_floor`?
**Evidence required:** `beads-pre.json` vs `beads-post.json` diff + the
new bead IDs.
**Verdict scale:**
- `MET` — floor met or exceeded.
- `PARTIAL` — at least one bead created but below floor.
- `UNMET` — zero new beads when a floor was set.
- `CANNOT_ASSESS` — `expected_beads_floor == 0` (no expectation).

### tier_discipline.no_source_edits

**Question:** Does `programmatic_signals.source_diff_empty == true` for
paths matching the instance's `source_globs`?
**Evidence required:** `git diff --name-only` filtered by `source_globs`.
**Verdict scale:**
- `MET` — zero source-file modifications.
- `UNMET` — any source file modified.
- (No PARTIAL — coordinator editing source is a binary tier failure.)

### tier_discipline.budget

See `common.tier_discipline.budget`. Default budget 15 turns.

### reflection_honesty

See `common.reflection_honesty`. `CANNOT_ASSESS` acceptable for short
coordinator runs that don't submit a reflection.

### doc_hygiene.artifact_well_formed

**Question:** For artifact kinds that have a structural expectation
(work plan table, ADR file, OpenAPI/JSON-Schema doc), does the artifact
contain the structural markers required by `expected_artifact_kind`?
**Evidence required:**
  - `work_plan_table` → markdown table header `| Task |` and `| Owner |`
  - `adr_file` → frontmatter or `## Status` + `## Decision` + `## Consequences`
  - `doc_section` → at least one `#` heading and one paragraph
  - `dashboard_entry` → a URL in the artifact OR a `dashboard.html` mention
  - `research_summary` → at least one cited source URL or guide name
  - `beads_graph` → ≥ 2 beads created with at least one `bd dep add` log line
**Verdict scale:**
- `MET` — required markers present.
- `PARTIAL` — at least one marker present.
- `UNMET` — none present.
- `CANNOT_ASSESS` — `expected_artifact_kind` not set.

## Aggregation

Weighted average per dimension; `CANNOT_ASSESS` excluded.
**Pass threshold (informational):** `decomposition.artifact_present != UNMET`
AND `tier_discipline.no_source_edits = MET`. A coordinator that produced
no artifact OR edited source fails regardless of aggregate.

## Scoring path

Programmatic-only. The scrum-master instance is a stub (Track B postmortem —
see design §8): the runner skips dispatch and emits a stub scorecard
pointing at the operator-invoked postmortem workflow.
