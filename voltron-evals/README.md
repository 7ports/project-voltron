# voltron-evals

A repeatable evaluation harness for Voltron agents. Loads benchmark task YAMLs, dispatches the agent under test (AUT), captures artifacts, invokes the `voltron-judge` agent against a pinned rubric, and writes a scorecard JSON.

> **MVP status:** parts 1 and 2 of 2 shipped (v3.9.0). Task catalog, rubrics, judge template, runner, programmatic scorers, and artifact capture are all in place. Three additional benchmark tasks (T2-002 WebGL, T3-001 Stripe, T3-003 resume-after-compaction) ship in a follow-up sprint.

## Layout

```
voltron-evals/
  README.md                       — this file
  runner.js                       — orchestrator (loads YAML, dispatches AUT + judge, merges scorecard)
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
  lib/artifacts.js                — capture helpers (git diff, bd list, log tail)
  lib/programmatic-scorers.js     — deterministic no-LLM signals
  lib/fixtures/T1-001/            — minimal fixture for T1-001
  results/<task>/<ts>/            — per-run artifact bundles + scorecard.json
```

## Tasks (MVP)

| ID | Tier | AUT | Category |
|---|---|---|---|
| T1-001 | 1 | `route-adder` | single-file web edit |
| T2-001 | 2 | `fullstack-dev` | small fullstack feature |
| T3-002 | 3 | `code-analyst` | pure orchestration (no code) |

Three more tasks (T2-002 WebGL bugfix, T3-001 multi-file Stripe webhook, T3-003 resume-after-compaction) ship in a follow-up sprint.

## Quick start

```bash
node voltron-evals/runner.js --task=T1-001                       # one task
node voltron-evals/runner.js --all                               # full sweep
node voltron-evals/runner.js --task=T2-001 --judge-model=haiku   # cheaper judge
node voltron-evals/runner.js --task=T1-001 --dry-run             # skip AUT + judge dispatch
```

Exit code 0 if all tasks scored without `cannot_grade`; 1 if any task came back ungradeable or a task errored; 2 on fatal runner error.

## How a run works

1. Runner loads the task YAML and validates it against `schemas/task.schema.json` (Ajv).
2. Runner snapshots pre-state (`git rev-parse HEAD`, `bd list --json`, `reflections/` listing).
3. Runner dispatches the AUT via `run_agent_in_docker` with the task prompt and `max_turns` budget. (`StdioClientTransport` spawns `src/index.js` as the MCP server child process.)
4. Runner snapshots post-state, tails the AUT's log file from `.voltron/logs/`, captures any new reflection it submitted.
5. Programmatic scorers run first — turn count, `[DONE]` presence, budget utilization, files changed, sub-dispatch grep, beads diff. Injected into the judge prompt as raw measurements.
6. Runner dispatches `voltron-judge` (model: Sonnet) with the rubric path, artifact paths, and programmatic JSON. The judge emits ONE fenced ```json``` scorecard block.
7. Runner parses the fenced JSON, merges with programmatic signals, and writes `results/<task>/<ts>/scorecard.json`.
8. If the judge could grade, the scorecard is wrapped in a reflection envelope (per design §7.1) and written to `reflections/<ts>-eval-<task>.json` for the existing `harness-engineer` pipeline to pick up.

## Rubric pinning

Each task YAML names a rubric path and a `rubric_version_expected`. The runner refuses to grade if the rubric's `rubric_version` frontmatter does not match — this prevents silent drift.

## Adding a task

1. Drop a YAML in `tasks/` matching `schemas/task.schema.json`.
2. Write a rubric Markdown in `rubrics/` with `rubric_version: 1.0.0` frontmatter.
3. (Optional) Add fixtures under `lib/fixtures/<task-id>/`.
4. Run `node voltron-evals/runner.js --task=<id>` once part 2 lands.

## Anti-loop guard

Reflections produced by this harness (those with `project_name: voltron-eval-harness`) MUST NOT be used by `harness-engineer` to modify the `voltron-judge` template — that would let the judge tune itself out of detecting failures. Human change-control only on `voltron-judge`.
