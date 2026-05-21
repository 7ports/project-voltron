# voltron-evals

A repeatable evaluation harness for Voltron agents. Loads benchmark task YAMLs, dispatches the agent under test (AUT), captures artifacts, invokes the `voltron-judge` agent against a pinned rubric, and writes a scorecard JSON.

> **MVP status:** part 1 of 2 — task catalog, rubrics, and judge template are in place. The runner (`runner.js`) ships in part 2.

## Layout

```
voltron-evals/
  README.md                       — this file
  schemas/task.schema.json        — JSON Schema for task YAMLs
  tasks/                          — benchmark task definitions
    T1-001-add-health-endpoint.yaml
    T2-001-debounce-hook.yaml
    T3-002-decompose-trello.yaml
  rubrics/                        — pinned, versioned rubrics
    COMMON.md                     — shared cross-cutting criteria
    T1-001.md
    T2-001.md
    T3-002.md
  results/                        — scorecards land here (gitkept until part 2)
  lib/fixtures/T1-001/            — minimal fixture for T1-001
```

## Tasks (MVP)

| ID | Tier | AUT | Category |
|---|---|---|---|
| T1-001 | 1 | `route-adder` | single-file web edit |
| T2-001 | 2 | `fullstack-dev` | small fullstack feature |
| T3-002 | 3 | `code-analyst` | pure orchestration (no code) |

Three more tasks (T2-002 WebGL bugfix, T3-001 multi-file Stripe webhook, T3-003 resume-after-compaction) ship in a follow-up sprint.

## How a run will work (part 2)

1. Runner loads the task YAML and validates it against `schemas/task.schema.json`.
2. Runner dispatches the AUT via `run_agent_in_docker` with the task prompt and fixtures.
3. Runner captures artifacts (log, diff, beads pre/post, journal, reflection).
4. Programmatic scorers run first — turn count, files changed, sub-dispatch grep, `[DONE]` presence.
5. Runner dispatches `voltron-judge` against the rubric; judge emits a fenced JSON scorecard.
6. Runner merges programmatic + judge output and writes `results/<task>/<ts>/scorecard.json`.
7. Scorecard is mirrored into `reflections/` so `harness-engineer` consumes it on the next pass.

## Rubric pinning

Each task YAML names a rubric path and a `rubric_version_expected`. The runner refuses to grade if the rubric's `rubric_version` frontmatter does not match — this prevents silent drift.

## Adding a task

1. Drop a YAML in `tasks/` matching `schemas/task.schema.json`.
2. Write a rubric Markdown in `rubrics/` with `rubric_version: 1.0.0` frontmatter.
3. (Optional) Add fixtures under `lib/fixtures/<task-id>/`.
4. Run `node voltron-evals/runner.js --task=<id>` once part 2 lands.

## Anti-loop guard

Reflections produced by this harness (those with `project_name: voltron-eval-harness`) MUST NOT be used by `harness-engineer` to modify the `voltron-judge` template — that would let the judge tune itself out of detecting failures. Human change-control only on `voltron-judge`.
