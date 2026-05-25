# voltron-evals — Design Spec

> Buildable design for Voltron's repeatable agent evaluation harness.
> Builds on `.voltron/phaseA-research.txt`. **DESIGN ONLY** — no code, no template edits.
> Consumed by `@agent-scrum-master` and `@agent-harness-engineer` for the build phase.

---

## 0. Overview

Add a `voltron-evals/` directory containing:
1. A **two-layer task model**:
   - **Deep layer** — a small set (6) of bespoke, rich, end-to-end benchmark tasks (T1–T3).
   - **Broad layer** — generic, parameterized test **shapes** instantiated per agent. Every one of the 71 templates is covered by ≥1 shape instance so each agent has a sanity-check eval, even when no rich bespoke task names it.
2. A YAML **task catalog** (Deep tasks) + a YAML **shapes catalog** + **shape-instances catalog** (Broad-layer fixtures + specs, one per agent).
3. **Versioned rubrics** — one Markdown file per Deep task plus one per shape (shared across all its instances).
4. A thin Node **runner** (`runner.js`) that loops tasks/instances → dispatches agent-under-test → captures artifacts → invokes a judge agent → writes a scorecard.
5. A new Voltron agent template **`voltron-judge`** added to `src/templates.js`. Inspect-only, Agent-as-a-Judge pattern, evidence-cited multi-criteria JSON output shaped as a `reflections/*.json`.
6. **Results** written into `voltron-evals/results/` **and** copied into `reflections/` so the existing `harness-engineer` self-improvement loop consumes them unchanged.

**Architectural anchor:** `voltron-judge` is *another* Voltron agent — it dispatches like all the others (`run_agent_in_docker`), has a pinned `model`, and lives in `src/templates.js`. The runner is small (~200 LOC) because all judging logic lives in the template content.

**Cost discipline (load-bearing — see §2.4, §6, §7.4):**
- The **Broad layer (70 instances) is graded ENTIRELY by programmatic scorers** (file-presence, diff caps, expected-fact strings, `[DONE]` line, verdict-string match — §6). No LLM judge is invoked by default for any Broad instance. The Opus `voltron-judge` is NEVER invoked on a Broad instance.
- The **Opus `voltron-judge` runs only for the 7 Deep-layer tasks** (T1-001 through T3-003). That bounds judge cost at ~7 Opus invocations per full sweep instead of 77.
- For the rare Broad-layer criterion that is genuinely subjective (e.g. "is the reflection narrative honest given the log?"), a per-shape rubric MAY opt into a **Haiku** judge call — never Sonnet, never Opus. The default is no judge call at all (§4.4).
- A scheduled sweep is **incremental by content hash**: an agent whose `src/templates.js` entry hash equals its last passing scorecard's `template_hash` is SKIPPED — the prior result still stands. Cost becomes proportional to template churn, not template count (§6.1, §7.6).

**Model-override rule (load-bearing):** the runner MUST NOT pass a `model` parameter when dispatching agents-under-test. Every one of the 71 templates pins its own model tier (55 haiku, 18 opus, 11 sonnet — counted from `src/templates.js`); overriding that pin in the harness would test a different agent than the one shipped to users. Run each agent as pinned. The only place the harness has a say in model choice is the judge (§2.4).

```
┌────────────────────────────────────────────────────────────────────────────┐
│ voltron-evals/                                                             │
│   tasks/*.yaml             ── Deep-layer bespoke benchmark definitions     │
│   shapes/*.yaml            ── Broad-layer test shapes (parameterized)      │
│   instances/<agent>.yaml   ── per-agent shape instances (one per template) │
│   rubrics/<task>.md        ── pinned, versioned per-task rubrics (Deep)    │
│   rubrics/shapes/<id>.md   ── per-shape rubric (shared across instances)   │
│   runner.js                ── orchestrates tasks → AUT → scoring           │
│   results/<task|instance>/<ts>/ ── artifacts + scorecard.json              │
│   schemas/{task,shape,instance}.schema.json ── JSON Schemas                │
│   README.md                ── how to run the harness                       │
└────────────────┬───────────────────────────────────────────────────────────┘
                 │ runner: for each job, check template_hash cache (§6.1, §7.6).
                 │ Skip if unchanged from last passing scorecard.
                 ▼
        run_agent_in_docker(<agent-under-test>, task)
                 │   ── NO model parameter passed; AUT runs on pinned tier
                 ▼
        (.voltron/logs/, journal, beads snapshot, git diff, alexandria-calls.txt)
                 │
                 ├── Broad-layer job (one of 70):
                 │     programmatic scorers ONLY → scorecard.json
                 │     (no voltron-judge call by default; optional Haiku
                 │      judge only if shape rubric opts in — §4.4)
                 │
                 └── Deep-layer job (one of 7):
                       run_agent_in_docker("voltron-judge", {artifacts, rubric})
                       judge runs on model: "opus" (see §2.4)
                       → scorecard.json
                 ▼
   voltron-evals/results/<id>/<ts>/scorecard.json
                 │   (records `template_hash` so the next sweep can skip)
                 │ (mirrored, with eval_metadata block prepended)
                 ▼
   reflections/<ts>-eval-<id>.json
                 │
                 ▼
   harness-engineer (Reflection Processing Mode) → src/templates.js
```

---

## 1. File Manifest

Every file the build phase must create. Sized to match the research's "~100–200 LOC runner; heavy lifting in template" rule.

| Path | Purpose |
|---|---|
| `voltron-evals/README.md` | Quick-start: how to run a sweep (`node voltron-evals/runner.js`), how to add a Deep task, how to add a shape, how to instantiate a shape for a new agent, how to roll rubrics. |
| `voltron-evals/runner.js` | Node harness. Loads task YAMLs and shape instances → consults the `template_hash` cache and skips unchanged agents (§6.1, §7.6) → dispatches AUT via `run_agent_in_docker` MCP call (no `model` parameter — see §0) → captures artifacts → routes scoring by layer: **Deep tasks → `voltron-judge` (Opus)**; **Broad instances → programmatic scorers only** (optional Haiku judge if a shape rubric opts into a subjective criterion, §4.4) → writes scorecard JSON + mirrors into `reflections/`. |
| `voltron-evals/schemas/task.schema.json` | JSON Schema for Deep-task YAML. |
| `voltron-evals/schemas/shape.schema.json` | JSON Schema for a shape definition (parameter set, rubric pointer, programmatic-scorer toggles, applicable-agent predicate). |
| `voltron-evals/schemas/instance.schema.json` | JSON Schema for a shape instance (fixture path, agent-under-test, expected artifact path, one-verb spec). |
| **Deep-layer tasks (6):** | |
| `voltron-evals/tasks/T1-001-add-health-endpoint.yaml` | T1 task definition (single-file edit). |
| `voltron-evals/tasks/T2-001-debounce-hook.yaml` | T2 task (small fullstack feature). |
| `voltron-evals/tasks/T2-002-webgl-bugfix.yaml` | T2 task (Unity platform-aware bugfix). |
| `voltron-evals/tasks/T2-003-alexandria-tool-setup.yaml` | T2 task whose correct behaviour REQUIRES consulting Alexandria first (see §3.3 and §4). Probes the `alexandria_usage` dimension. |
| `voltron-evals/tasks/T3-001-stripe-webhook.yaml` | T3 task (multi-file feature). |
| `voltron-evals/tasks/T3-002-decompose-trello.yaml` | T3 task (pure orchestration — work plan only). |
| `voltron-evals/tasks/T3-003-resume-after-compaction.yaml` | T3 robustness task (resume from artifacts). |
| **Broad-layer shapes (6):** | |
| `voltron-evals/shapes/micro-agent-write.yaml` | Shape: given a fixture file + a precise one-verb write spec, did the agent produce exactly the expected diff in budget? |
| `voltron-evals/shapes/micro-agent-inspect.yaml` | Shape: given a fixture + a precise read spec, did the agent emit the expected fact set without mutating any file? |
| `voltron-evals/shapes/micro-agent-validate.yaml` | Shape: given a fixture (intentionally failing + intentionally passing), did the validator-style agent correctly classify each and emit `[DONE]` with the right verdict? |
| `voltron-evals/shapes/sub-manager-delegation.yaml` | Shape: given a small multi-step request, did the sub-manager dispatch ≥N micro-agents (per its template guidance) rather than editing directly? |
| `voltron-evals/shapes/coordinator-planning.yaml` | Shape: given a 3-card backlog, did the coordinator produce the required planning artifacts (work plan table, beads, dashboard entry) without touching source code? |
| `voltron-evals/shapes/publish.yaml` | Shape: given a clean staged change, did the publish-family agent (committer / pr-opener / branch-manager / deploy-trigger / changelog-updater) take its exact one publish action with no side effects? |
| `voltron-evals/instances/<agent>.yaml` | Per-agent shape instance — one file per template (70 files; `voltron-judge` excluded for anti-self-grading). Each instance picks ONE shape + supplies the agent-specific fixture + one-verb spec + expected output. Coverage map in §3.4. |
| **Rubrics:** | |
| `voltron-evals/rubrics/T1-001.md` … `T3-003.md` | Per-criterion rubric for each Deep task, pinned by `rubric_version`. |
| `voltron-evals/rubrics/shapes/micro-agent-write.md` | Shape rubric (criteria + weights) — shared across all instances of this shape; the instance YAML supplies only the per-instance evidence anchors. |
| `voltron-evals/rubrics/shapes/micro-agent-inspect.md` | Shape rubric. |
| `voltron-evals/rubrics/shapes/micro-agent-validate.md` | Shape rubric. |
| `voltron-evals/rubrics/shapes/sub-manager-delegation.md` | Shape rubric. |
| `voltron-evals/rubrics/shapes/coordinator-planning.md` | Shape rubric. |
| `voltron-evals/rubrics/shapes/publish.md` | Shape rubric. |
| `voltron-evals/rubrics/COMMON.md` | Shared cross-cutting criteria (tier discipline, `[DONE]` line, reflection honesty, doc hygiene, **alexandria_usage**) referenced by per-task and per-shape rubrics. |
| **Libraries / fixtures:** | |
| `voltron-evals/lib/programmatic-scorers.js` | Pure-Node scorers (no LLM): turn count, dispatch grep, file-diff stat, beads snapshot diff, `[DONE]` presence, doc-update detection, **`mcp__alexandria__*` call grep**, shape-specific helpers (expected-diff match, expected-fact extraction). |
| `voltron-evals/lib/artifacts.js` | Snapshot/capture helpers (cwd diff, `.voltron/logs/<file>` tail, `get_journal`, `bd list --json`, `git diff --stat`, `alexandria-calls.txt` extraction). |
| `voltron-evals/lib/fixtures/` | Per-task and per-shape-instance fixtures the AUT may rely on (e.g. a minimal Express scaffold for T1-001; per-shape micro-fixtures one per instance). Each fixture is tiny, scoped, and lives in its own subdirectory. |
| `voltron-evals/results/.gitkeep` | Result outputs are committed (historical record), like `reflections/`. |
| **CI (now in scope — see §7.4):** | |
| `.github/workflows/voltron-evals.yml` | NEW CI workflow that runs the harness on PRs (T1 + a sample of Broad-layer instances), and on a weekly cron (full Deep + full Broad sweep). Mirrors scorecards into `reflections/`, where `process-reflections.yml` then consumes them. See §7.4. |
| `.github/workflows/process-reflections.yml` (existing — modify, do not create) | Change cron from `'0 10 * * 1,3,5'` (3×/week) to `'0 10 * * 1'` (1×/week, Monday) and update the comment on line 3. See §7.5. |

**Single source of truth note:** The `voltron-judge` template lives in `src/templates.js` (not in `voltron-evals/`). The `voltron-evals/` directory does not duplicate agent content.

---

## 2. `voltron-judge` Agent Template Spec

A complete spec for the new entry to be added to `TEMPLATES` in `src/templates.js`.

### 2.1 Template metadata

```javascript
"voltron-judge": {
  name: "voltron-judge",
  filename: "voltron-judge.md",
  description:
    "Agent-as-a-Judge for Voltron evaluation runs. Inspects a single agent run's artifacts (changed files, .voltron/logs/, beads snapshot, journal, reflection) against a pinned rubric and emits a multi-criteria, evidence-cited scorecard JSON shaped as a reflections/*.json file. Inspect-only — never dispatches other agents.",
  category: "agent",
  destination: ".claude/agents/voltron-judge.md",
  tags: ["internal"],          // same family as harness-engineer; NOT scaffolded into user projects
  model: "opus",               // see §2.4 for rationale (revised — was sonnet)
  nestable: false,             // judge must not start sub-containers
  content: `<see §2.3>`
}
```

### 2.2 Wiring into exports

- **`PROJECT_TYPE_TAGS`** — no change. `internal` tag is *not* listed in any project type, which already excludes `harness-engineer` from user-project scaffolds. `voltron-judge` inherits the same exclusion automatically.
- **`AGENT_NAMES`** — auto-derived (`Object.keys(TEMPLATES).filter(...category === "agent")`). No manual edit.
- **`getTemplatesForType()`** — no change. Internal-tagged templates never match a user project type, which is the desired behaviour.
- **`README.md` / `docs/index.html`** — must be updated to mention the new internal agent (per CLAUDE.md doc rule). Show in the "Internal agents" subsection alongside `harness-engineer`.

### 2.3 Template `content` outline

The full YAML frontmatter + Markdown body the build phase will write. Headings, not full prose — harness-engineer fills in the wording.

```yaml
---
name: voltron-judge
description: Agent-as-a-Judge for Voltron evaluations. Inspects artifacts from a single agent run, scores each rubric criterion atomically with cited evidence, and writes a scorecard JSON in reflections/*.json shape. Inspect-only — never dispatches.
tools: Read, Bash, Glob, Grep, mcp__project-voltron__get_journal, mcp__project-voltron__list_reflections, mcp__project-voltron__get_progress
---
```

**Notably absent from `tools`:**
- `mcp__project-voltron__run_agent_in_docker` — **explicitly omitted.** A judge must never dispatch.
- `Write`, `Edit` — **omitted.** The judge emits its scorecard **only via stdout** in a fenced JSON block. The runner parses that block and writes the file. Removing Write/Edit prevents accidental code edits and prevents grade-time tampering with the artifacts under review.
- `mcp__project-voltron__submit_reflection` — **omitted.** Reflections are written by the runner, not the judge, so the rubric output shape is deterministic and runner-controlled.

Body sections (each a Markdown section in the agent template content):

1. **Role** — "Agent-as-a-Judge. You inspect, you do not dispatch. You score atomically with evidence."
2. **Hard constraints** — Inspect-only; no file modifications; one scorecard JSON per invocation; reject any task that asks you to dispatch or edit.
3. **Input contract** — what the runner injects into the `task` parameter: artifact paths (`run_dir/`, `log_path`, `diff_path`, `beads_snapshot_path`, `journal_path`), rubric path (`rubric_path`), task definition (`task_yaml_path`), template versions used.
4. **Scoring protocol** (Autorubric + G-Eval recipe):
   - For each rubric criterion:
     - Read the criterion's question and evidence requirement.
     - Gather evidence (file path + line number, log grep hit, beads command output, etc.).
     - Decide a verdict: `MET` / `UNMET` / `PARTIAL` / `CANNOT_ASSESS`.
     - Emit a 1–2 sentence justification quoting the evidence.
   - Do not assign an overall single score until every criterion has been individually scored.
5. **Output contract** — final tool output must be a single fenced `json` block matching the schema in §2.5. No prose around it. Runner parses by regex on the first `\n```json\n...\n```\n`.
6. **Bias controls** (research §A):
   - Strip identifying preambles before quoting the agent's output.
   - Penalize verbosity if `[STEP]` count exceeds rubric guidance (programmatic; do not re-weigh).
   - Never compare two runs in the same invocation (no pairwise scoring at this layer).
7. **Cost cap** — judge `max_turns` set by runner; default 20 (research recommendation). Judge must terminate cleanly with `[DONE]` even if some criteria are `CANNOT_ASSESS`.
8. **Progress reporting** — same `[STEP N]` and `[DONE]` discipline as every other Voltron agent.
9. **Refuse-to-grade conditions:**
   - Rubric file missing or rubric hash mismatch → emit `cannot_grade: "rubric_unpinned"` and exit.
   - Artifacts directory missing critical files → emit `cannot_grade: "missing_artifacts"` and list which.
   - The agent under test is itself `voltron-judge` → refuse (anti-self-grading guard).

### 2.4 Model tier choice

**`opus`** is the default for `voltron-judge.model`, but the judge is **invoked only for the 7 Deep-layer tasks** — not for any of the 70 Broad-layer instances.

**How the runner decides judge-vs-programmatic per layer:**

| Layer | Job source | Scoring path | LLM call? |
|---|---|---|---|
| **Deep** | `voltron-evals/tasks/*.yaml` (`kind: "deep"`) | Programmatic scorers (§6) **then** `voltron-judge` on Opus, evidence-cited per criterion | **YES — Opus** (1 invocation per Deep task) |
| **Broad** | `voltron-evals/instances/*.yaml` referencing a shape | Programmatic scorers (§6) **only**; the shape rubric's pass/fail aggregates directly from those signals (§4.4) | **NO** by default |
| **Broad (rare opt-in)** | Broad instance whose **shape rubric** sets `subjective_judge: "haiku"` for ≥1 criterion (§4.4) | Programmatic scorers + a single **Haiku** judge call scoring ONLY the subjective criteria | **YES — Haiku** (optional, narrow) |
| Track B (scrum-master postmortem, §8) | Operator-invoked | `voltron-judge` on Opus against captured artifacts | **YES — Opus** (1 invocation per postmortem) |

**Runner pseudocode for the routing decision** (see §5.1 for the full execution shape):

```
function scoreJob(job, artifacts):
  programmatic = runProgrammaticScorers(job, artifacts)
  if job.kind == "deep":
    judge = dispatchJudge(job, artifacts, model: "opus")          # always for Deep
  elif job.kind == "shape-instance":
    shapeRubric = loadShapeRubric(job.shape)
    if shapeRubric.subjective_judge == "haiku":                   # opt-in only
      judge = dispatchJudge(job, artifacts, model: "haiku",
                            criteria: shapeRubric.subjective_only)
    else:
      judge = null                                                 # programmatic-only
  return mergeScorecard(programmatic, judge, job)
```

The `--judge-model` CLI flag (§5) overrides Opus → Sonnet/Haiku for local spot-checks **only on Deep tasks**; it cannot upgrade Broad-layer scoring above its tier (programmatic, or Haiku if opted in).

**Why Opus for the Deep layer specifically:**

- **Judge quality dominates on Deep tasks.** Each Deep task is end-to-end and rubric-rich (5–12 weighted criteria with required evidence quotes). A sloppy scorecard here generates misleading `agent_feedback[*].suggested_change` strings that go straight to `harness-engineer` and could degrade templates rather than improve them.
- **Multi-criteria, evidence-required scoring** is exactly the regime where the marginal Opus uplift over Sonnet is largest — the judge must read logs, grep for tool calls, cross-reference rubric criteria, and emit structured JSON with citations. Sonnet would more often skip the evidence step or hand-wave criteria as `CANNOT_ASSESS`.
- **Self-preference bias is minor here.** The corpus of AUTs is dominated by haiku (55) and sonnet (11), with only 18 opus templates (counts from `src/templates.js`). Opus-as-judge is a *different* model from most AUTs. Of the 7 Deep AUTs, even fewer are opus-tier. Intra-family risk on the residual pairing is mitigated by:
  - Evidence-required scoring (criterion verdicts must cite file + line or log-line quotes — vague self-praise can't pass).
  - Programmatic scorers running BEFORE the judge (the judge cannot disagree with raw measurements; see §6).
  - The anti-self-grading guard already in §2.3 (the judge refuses to score `voltron-judge` itself).

**Why Broad-layer is programmatic-only:**

- The six shape rubrics in §4.4 are dominated by signals already computable in pure Node: file-set equality, line-cap thresholds, `[DONE]` presence, verdict-string match, no-source-edits, dispatch counts, expected-fact literal grep. These are exactly the kinds of checks where an LLM judge adds cost without adding signal — and where research's `programmatic > LLM-as-judge > Agent-as-judge` rule of thumb (§6) is sharpest.
- 70 instances × 1 Opus call each was the dominant cost driver in the prior design (~$15–25 per sweep). Eliminating it brings the full-sweep cost down by an order of magnitude (§3.6, §7.4) without losing the regression-net signal: file-set equality and verdict-string match catch the failure modes the broad layer was built to catch.
- For the few genuinely subjective Broad-layer criteria (e.g. reflection-honesty), the per-shape rubric may opt into a single **Haiku** judge call covering ONLY those criteria — never Sonnet, never Opus. Haiku is sufficient because the criterion is narrow and the evidence has already been pre-extracted by the programmatic layer.

**Cost is now well bounded.** A full sweep with the Broad layer programmatic-only and the Deep layer on Opus is ~$8–12 baseline, dropping to ~$1–3 per sweep once content-hash caching (§6.1, §7.6) kicks in for unchanged agents. See §3.6 and §7.4 for the breakdown.

Decision recorded in §11.

### 2.5 Scorecard JSON schema (judge output)

```jsonc
{
  "task_id": "T2-001",
  "rubric_version": "1.0.0",
  "rubric_path": "voltron-evals/rubrics/T2-001.md",
  "agent_under_test": "fullstack-dev",
  "template_versions": { "fullstack-dev": "3.8.4", "scrum-master": "3.8.4" },
  "criteria": [
    {
      "id": "correctness.acceptance_1",
      "question": "Does client/src/hooks/useDebounce.ts export a typed function with signature (cb, ms) => void?",
      "verdict": "MET",            // MET | UNMET | PARTIAL | CANNOT_ASSESS
      "score": 1.0,                 // 0.0, 0.5 (PARTIAL), 1.0 — never freeform
      "evidence": [
        { "file": "client/src/hooks/useDebounce.ts", "line": 12, "quote": "export function useDebounce<T>(fn: T, ms: number): T" }
      ],
      "notes": "Signature matches; generic parameter preserves callback type."
    }
    /* ...repeat per criterion... */
  ],
  "aggregates": {
    "correctness":        0.83,
    "decomposition":      1.0,
    "tier_discipline":    0.5,
    "reflection_honesty": 1.0,
    "doc_hygiene":        0.0,
    "alexandria_usage":   null   // null when NA (no Alexandria expectation in rubric); 0.0–1.0 otherwise
  },
  "cannot_grade": null,             // or { "reason": "missing_artifacts", "detail": "..." }
  "judge_model": "claude-opus-4-7", // null on Broad-layer programmatic-only scorecards; "claude-haiku-4-5-…" on Haiku-opt-in shapes
  "judge_turns_used": 14,           // 0 on programmatic-only scorecards
  "template_hash": "sha256:e3b0c44298fc1c149afbf4c8996fb924…",  // see §6.1 — hash of the AUT's src/templates.js entry; key for incremental skip
  "scored_via": "judge"             // "judge" | "programmatic" | "haiku-subjective" — drives §7.6 skip logic
}
```

The runner then prepends a `reflections/*.json`-shaped envelope (see §7) and writes the merged document into both `voltron-evals/results/<task>/<ts>/scorecard.json` and `reflections/<ts>-eval-<task>.json`.

---

## 3. Benchmark Task Catalog (Two-Layer Model)

This section defines both layers:
- **Deep layer (§3.1, §3.2, §3.3)** — bespoke, end-to-end tasks. Each one is hand-written, has its own rubric, and exercises a specific multi-agent flow.
- **Broad layer (§3.4, §3.5, §3.6)** — generic test **shapes** instantiated per agent. The shape supplies the rubric and scorers; the per-agent instance supplies only the fixture + one-verb spec + expected artifact. Every one of the 71 templates is covered.

Mental model: a *task* is a specific question — "did the agent do this specific thing?". A *shape* is a reusable template that asks the same generic question across many agents — "given this kind of one-verb spec, did the agent produce exactly the right artifact in budget?".

### 3.1 Deep-task YAML schema

```yaml
# voltron-evals/tasks/<id>.yaml — Deep-layer tasks ONLY
id: "T2-001"                              # required; pattern T[1-3]-NNN
kind: "deep"                              # NEW: "deep" | "shape-instance"; default "deep" for backcompat
tier: 2                                   # 1|2|3 — maps to scrum-master max_turns guidance
category: "fullstack-feature"             # free-text; used for grouping in dashboards
agent_under_test: "fullstack-dev"         # MUST exist in AGENT_NAMES; never "scrum-master" (see §8)
max_turns: 30                             # budget envelope for AUT; per scrum-master.md:111-119
project_type: "web"                       # fixture set to bring in (web|unity|general)

# IMPORTANT: there is NO `model` or `model_override` field. The runner MUST NOT pass a model
# parameter when dispatching the AUT — the AUT runs on the model tier pinned in its template
# (per §0 model-override rule). The schema explicitly forbids any such field.

prompt: |                                  # injected into the AUT's `task` parameter
  Add a typed `useDebounce(callback, ms)` React hook to client/src/hooks/useDebounce.ts.
  Write a Vitest spec covering the typical debounce behavior and edge cases at
  client/src/hooks/useDebounce.test.ts. Then run typecheck. Acceptance criteria below.

acceptance_criteria:                       # checked by judge atomically + by programmatic scorers
  - id: "ac_1"
    text: "File client/src/hooks/useDebounce.ts exists and exports useDebounce."
    type: "programmatic"                   # file-exists + grep
  - id: "ac_2"
    text: "Hook signature is generic and preserves the callback type."
    type: "judged"
  - id: "ac_3"
    text: "A Vitest spec exists and passes."
    type: "programmatic"                   # npx vitest run client/src/hooks/useDebounce.test.ts → exit 0
  - id: "ac_4"
    text: "Typecheck passes (npx tsc --noEmit)."
    type: "programmatic"

rubric: "voltron-evals/rubrics/T2-001.md"  # pinned path; rubric_version inside the file
rubric_version_expected: "1.0.0"           # runner refuses to grade on mismatch
fixtures: "voltron-evals/lib/fixtures/T2-001"  # optional; runner copies into a scratch workspace

programmatic_signals:                      # toggles for the no-LLM scorers in §6
  capture_turn_count: true
  capture_files_changed: true
  detect_micro_agent_dispatch: true
  capture_beads_snapshot: true
  require_done_line: true
  check_doc_updates: false                 # T2-001 is not a Voltron edit
  capture_alexandria_calls: false          # NEW: grep log for mcp__alexandria__* calls; default false

notes: |
  Tests whether scrum-master-style decomposition flows through fullstack-dev to function-writer
  + test-writer + typecheck-runner. NOT a scrum-master test — see §8 for orchestrator handling.
```

### 3.2 The seven Deep-layer tasks (shipped in first build)

| ID | Tier | AUT | Category | Tests… |
|---|---|---|---|---|
| **T1-001** | 1 | `route-adder` (micro-agent, direct) | Single-file web edit | Can a micro-agent add `GET /health` to a known anchor in `server/src/index.ts` in ≤10 turns? Anchor-precomputed. |
| **T2-001** | 2 | `fullstack-dev` (sub-manager) | Small fullstack feature | Does the sub-manager actually dispatch `function-writer` + `test-writer` + `typecheck-runner` rather than editing directly? |
| **T2-002** | 2 | `csharp-dev` + `build-validator` (sub-manager pair) | Bug fix w/ platform awareness | Does `csharp-dev` surface the WebGL `PlatformNotSupportedException` constraint and gate the fix on `build-validator`? **Note Editor exception:** this task runs the *file-only* portion (csharp-dev) in Docker; the build-validator slice is marked `skip_in_ci: true` (see §8). |
| **T2-003** | 2 | `devops-engineer` | Alexandria-required tool setup | NEW (probes `alexandria_usage`). Prompt: "set up Stripe webhook signing locally" — correct behaviour REQUIRES calling `mcp__alexandria__search_guides` / `mcp__alexandria__read_guide` BEFORE writing config. Programmatic scorer asserts ≥1 `mcp__alexandria__*` call appears in the log before any file write. See §3.3 for full task spec and §4 for the new rubric dimension. |
| **T3-001** | 3 | `fullstack-dev` (driving a multi-file plan) | Multi-file feature | Phase decomposition; parallel dispatch; beads dependency graph correctness; whether the commit step is its own micro-agent dispatch (per the 2026-05-20 reflection). |
| **T3-002** | 3 | `code-analyst` + `doc-writer` (composing a work plan) | Pure orchestration (no code) | Tests the *planning artifacts* a coordinator pair produces. Runner stubs scrum-master's role by injecting a 3-card backlog as the prompt; judges the work plan table, beads created, and dashboard registration. |
| **T3-003** | 3 | `harness-engineer` | Robustness | Resume-after-compaction: prompt names `.voltron/logs/<fixture>` + `bd ready` state, and AUT must recover and complete one bead without re-asking the user. |

**Notes on task selection:**
- Six of the seven Deep-layer AUTs are dockerizable. The orchestrator gap (scrum-master) is handled in §8 (Track B).
- Tier mapping matches `scrum-master.md:111-119`: T1 = 10 turns, T2 = 20–30, T3 = 30–45.
- Tasks T2-002 and T3-003 borrow from real reflections (2026-04-04 Unity WebGL; 2026-05-20 compaction notes) — ground truth is the documented behavior in `scrum-master.md`.
- T2-003 is the **only Deep-layer task with `alexandria_usage` as a weighted rubric dimension**. Other tasks set `alexandria_usage: null` (NA), exactly the way `doc_hygiene` is currently scoped — see §4 weights table.

### 3.3 T2-003 Alexandria-required task — detail

This task exists because using project-alexandria as the knowledge base is a Voltron prime directive (see `harness-engineer` and `researcher` template content). It must be explicitly tested, not assumed.

**AUT:** `devops-engineer` (a sub-manager whose own template instructs it to consult Alexandria for ops/tooling setup).

**Prompt sketch:**
```
We need to set up Stripe webhook signature verification for the existing
server/src/routes/webhooks.ts handler. Before writing any code, consult
the project's knowledge base for current best practice and configuration
patterns. Then implement the verification + a smoke test, and update the
endpoint table in README.md.
```

**Why this works:**
- The "Before writing any code, consult the project's knowledge base" line names Alexandria implicitly. An agent that ignores Alexandria can still satisfy the file-writing acceptance criteria, but will fail the `alexandria_usage` dimension.
- The programmatic scorer (`capture_alexandria_calls: true`) greps the AUT log for any `mcp__alexandria__*` tool call (`search_guides`, `read_guide`, `list_guides`, `get_project_setup_recommendations`, `update_guide`) and records the earliest occurrence relative to the first file-write call. The judge confirms whether the call's results actually informed the implementation (evidence: did the agent quote a guide finding in its `[STEP]` lines or in the diff comment?).
- This task explicitly does NOT score correctness of the Stripe verification itself heavily — that's covered by T3-001. T2-003's dominant weight is on `alexandria_usage` (see §4.2).

### 3.4 Broad-layer shapes — catalog

A **shape** is a reusable test template parameterized by `(fixture, one-verb spec, expected artifact)`. The rubric and programmatic scorers belong to the shape; the per-agent instance only supplies the parameters.

**Scoring path (load-bearing — see §2.4):** Broad-layer instances are graded by **programmatic scorers only** (§6). The six shape rubrics below were intentionally designed so every criterion can be answered by a deterministic check: file-set equality, line-cap threshold, expected-fact grep, `[DONE]` presence, verdict-string match, no-source-edits, dispatch count. No `voltron-judge` invocation is made for a Broad instance by default. A shape rubric MAY opt into a single Haiku judge call for a narrow subjective criterion (§4.4), but the default is none.

Six shapes cover the full 71-agent template set:

| Shape ID | Question it answers | Programmatic scorers it leans on |
|---|---|---|
| **micro-agent-write** | Given a fixture file + a precise one-verb write spec (e.g. "add a `committer` function exporting (msg) → CommitResult"), did the agent produce **exactly the expected diff** in budget, with no sprawl outside the named target? | `files_changed` set equality vs. `expected_files`; `lines_added`/`lines_deleted` ≤ caps; presence of `[DONE]`; turn-budget headroom. |
| **micro-agent-inspect** | Given a fixture + a precise read spec (e.g. "list every route registered in `server/src/index.ts`"), did the agent emit the **expected fact set** in its stdout/log **without mutating any file**? | `git diff --stat` empty; presence of expected literal strings in last `[STEP]` block; `[DONE]` present; turn-budget headroom. |
| **micro-agent-validate** | Given paired fixtures (one intentionally-passing, one intentionally-failing) and a verdict spec (e.g. "typecheck both, report which fails"), did the validator-style agent correctly classify each and emit `[DONE]` with the right verdict words? | Verdict-string match per fixture; no edits to source under test; turn-budget. |
| **sub-manager-delegation** | Given a small multi-step request that crosses ≥2 micro-agent specialties, did the sub-manager **dispatch ≥N micro-agents** (per its template guidance, e.g. fullstack-dev ≥2) instead of editing files directly? | `sub_dispatches` ≥ shape-defined floor; `files_changed` shape: at most the parent's own coordination notes, not the substantive source files; reflection submitted. |
| **coordinator-planning** | Given a 3-card backlog stub, did the coordinator produce the **required planning artifacts** (work plan table, beads parent/children, dashboard URL surfaced) **without touching source code**? | `git diff --stat` empty for source paths; beads-created count ≥ shape floor; `update_progress` journal entries present; presence of work-plan-table markdown anchor. |
| **publish** | Given a clean staged change, did the publish-family agent take its one exact publish action (committer→commit / pr-opener→PR / branch-manager→branch / deploy-trigger→deploy / changelog-updater→changelog entry) **with no side effects** beyond that action? | git-state delta matches exactly one action; no source-file diff; no extra tool calls beyond the canonical sequence; `[DONE]` present. |

#### 3.4.1 Shape YAML schema

```yaml
# voltron-evals/shapes/<shape-id>.yaml
id: "micro-agent-write"
description: "Did the agent produce exactly the expected diff for a one-verb write spec?"
rubric: "voltron-evals/rubrics/shapes/micro-agent-write.md"
rubric_version_expected: "1.0.0"

required_instance_fields:
  - fixture_dir            # path to per-instance fixture
  - prompt                 # one-verb spec given to the AUT
  - expected_files         # set of paths that MUST change
  - forbidden_files        # set of paths that must NOT change (defaults to "anything outside fixture_dir")
  - max_turns              # cap (shape default: 10; instance may override down, not up)

programmatic_signals:      # shared by all instances of this shape
  capture_turn_count: true
  capture_files_changed: true
  detect_micro_agent_dispatch: false   # micro-agents shouldn't sub-dispatch
  capture_beads_snapshot: false
  require_done_line: true
  check_doc_updates: false
  capture_alexandria_calls: false

applies_to:                # predicate: which agents this shape can score
  category: "micro-agent-write"
```

#### 3.4.2 Instance YAML schema

```yaml
# voltron-evals/instances/<agent-name>.yaml — one file per template
agent_under_test: "function-writer"
shape: "micro-agent-write"
fixture_dir: "voltron-evals/lib/fixtures/instances/function-writer"
prompt: |
  Add a pure function `slugify(input: string): string` exported from
  src/utils/slugify.ts. Strip non-alphanumerics, lowercase, hyphenate.
expected_files:
  - "src/utils/slugify.ts"
forbidden_files: []        # defaults to anything outside fixture_dir; can override
max_turns: 8
# NO `model` field — runner uses the template's pinned model (per §0 rule).
```

The instance schema is intentionally minimal: everything reusable lives in the shape, everything agent-specific lives in the instance. Adding a 72nd agent later means writing one ~10-line YAML, not a whole task.

### 3.5 Per-agent coverage map — every one of the 71 templates

The table below assigns each agent to exactly one shape (its primary sanity-check eval). Where an agent is also exercised by a Deep-layer task, that's noted in the "Also in Deep" column.

> **`voltron-judge` is excluded by design** (anti-self-grading guard in §2.3 and §7.3). 70 templates get a Broad-layer instance; with `voltron-judge` that totals 71 covered (the judge is "covered" by human change-control, not by automated eval).

| Shape | Count | Agents (template name in `src/templates.js`) |
|---|---|---|
| **micro-agent-write** | 24 | route-adder, component-scaffolder, test-writer, migration-writer, config-editor, fixture-writer, type-definer, env-var-setter, dockerfile-editor, yaml-patcher, readme-section-writer, function-writer, middleware-writer, store-slice-writer, css-writer, design-token-writer, csharp-script-writer, csharp-member-adder, unity-manifest-editor, ci-workflow-writer, docker-compose-editor, test-config-writer, mock-writer, file-patch-runner |
| **micro-agent-inspect** | 13 | dep-reader, route-lister, schema-inspector, log-tailer, test-lister, lint-reader, type-error-reader, git-state-reader, api-shape-probe, bundle-sizer, dead-code-finder, stringer-baseline-builder, stringer-delta-reader |
| **micro-agent-validate** | 10 | typecheck-runner, test-runner, lint-runner, build-runner, schema-validator, url-route-matcher, accessibility-auditor, lighthouse-runner, security-scanner, coverage-runner |
| **sub-manager-delegation** | 12 | scrum-master (graded via Track B postmortem only, see §8), project-planner, scene-architect, csharp-dev, shader-artist, build-validator, asset-manager, fullstack-dev, devops-engineer, ui-designer, qa-tester, harness-engineer |
| **coordinator-planning** | 6 | researcher, code-analyst, doc-writer, adr-writer, api-doc-generator, diagram-maker |
| **publish** | 5 | committer, pr-opener, branch-manager, deploy-trigger, changelog-updater |
| **excluded** | 1 | voltron-judge (anti-self-grading; human review only) |
| **TOTAL** | **71** | all templates in `src/templates.js` |

**Also in Deep-layer:** route-adder (T1-001), fullstack-dev (T2-001, T3-001), csharp-dev + build-validator (T2-002), devops-engineer (T2-003), code-analyst + doc-writer (T3-002), harness-engineer (T3-003), scrum-master (Track B only). Deep coverage augments — it does not replace — the Broad-layer instance.

**Maintaining the map:** the `bd preflight` step in CI (and a `node voltron-evals/runner.js --doctor` mode) compares `Object.keys(TEMPLATES)` from `src/templates.js` against `voltron-evals/instances/*.yaml`. Any agent without an instance (other than `voltron-judge`) fails the check. This makes coverage drift visible the moment a new agent lands.

### 3.6 Notes on the two-layer design

- **Cost (baseline full sweep, every agent re-evaluated):** Broad-layer runs are short (≤10 turns each on small fixtures, scored programmatically with no LLM judge call). Deep-layer adds 7 Opus judge invocations. Rough budget:
  - Broad layer: 70 instances × ~$0.05 AUT cost ≈ $3–5 (no judge).
  - Deep layer: 7 AUTs (varied tiers) ≈ $2–4 + 7 Opus judge invocations ≈ $3–5.
  - **Baseline full sweep total: ~$8–12 (one-time).** This is the cost the *first* monthly sweep pays, and any sweep that follows wholesale template changes.
- **Cost (typical post-baseline monthly sweep):** with content-hash caching (§6.1, §7.6), only agents whose `src/templates.js` entry changed are re-evaluated. On a typical month touching ~5–10 agents: **~$1–3 per sweep.** Cost is proportional to template churn, not to template count.
- **Signal quality:** the Broad layer answers "does this agent still work at all?" — useful as a regression net (programmatic checks are deterministic, so signal is binary and unambiguous). The Deep layer answers "does the orchestration flow still produce the right artifacts?" — useful as a quality signal (Opus judge reasons about evidence and decomposition). Together they catch both kinds of regression.
- **Parameter discipline:** a shape's rubric is **frozen** per `rubric_version`. Adding a criterion to a shape rubric is a versioned change that re-grades all instances on next sweep — and because shape scoring is programmatic, the re-grade has no LLM cost. Per-instance overrides of shape rubrics are NOT permitted; that's what Deep tasks are for.
- **No judge bias on the Broad layer:** because shape rubrics are scored programmatically with no LLM in the loop, there is no model-as-judge bias to worry about across the 70 Broad instances. Bias considerations apply only to the 7 Deep tasks (where evidence-required scoring + programmatic pre-pass already mitigate it — §2.4).

---

## 4. Rubric Files

### 4.1 Format

Markdown with YAML frontmatter; one file per task plus a `COMMON.md` referenced by all.

```markdown
---
rubric_version: 1.0.0
task_id: T2-001
last_updated: 2026-05-21
extends: [voltron-evals/rubrics/COMMON.md]
---

# Rubric — T2-001 (useDebounce hook)

## Dimensions and weights

| Dimension | Weight |
|---|---|
| correctness | 0.40 |
| decomposition | 0.20 |
| tier_discipline | 0.20 |
| reflection_honesty | 0.10 |
| doc_hygiene | 0.10 |
| alexandria_usage | 0.00 |  <!-- NA for T2-001; non-zero only for tasks that probe Alexandria use -->

## Criteria

### correctness.acceptance_1
**Question:** Does `client/src/hooks/useDebounce.ts` exist and export a function named `useDebounce`?
**Evidence required:** File path + line number where `export ... useDebounce` appears.
**Verdict scale:** MET = export present and named correctly; UNMET = file missing or export absent; PARTIAL = file exists but export uses a different name.

### correctness.acceptance_2
**Question:** Is the hook signature generic such that the callback's return type is preserved?
**Evidence required:** Quoted signature with generic parameter.
...

### tier_discipline.dispatch
**Question:** Did the agent under test dispatch at least one micro-agent (grep `run_agent_in_docker` in `.voltron/logs/<run>`), rather than editing files directly?
**Evidence required:** Grep count + at least one quoted log line.
**Source:** Programmatic scorer pre-fills this; judge confirms.

### reflection_honesty
**Question:** If the AUT submitted a reflection during the run, does its `needs_improvement` field cite real issues (cross-reference log evidence)?
**Evidence required:** Reflection quote + matching log lines.
```

### 4.2 Per-task rubric outlines (criterion-level skeletons)

Weights below are normalized to sum to 1.0 per task. `alexandria_usage` is `null` (NA) on tasks that don't probe it — the runner excludes nulls from aggregation, identical to how `doc_hygiene` was already handled.

| Task | correctness | decomp | tier-disc | honesty | docs | alexandria | Criterion count | Key per-task criteria |
|---|---|---|---|---|---|---|---|---|
| **T1-001** | 0.60 | 0.00 | 0.10 | 0.10 | 0.20 | null | 5 | `/health` route present; returns 200; uses the precomputed anchor; turn budget respected; README endpoint table updated. |
| **T2-001** | 0.40 | 0.20 | 0.20 | 0.10 | 0.10 | null | 9 | File exists; generic signature; cleanup-on-unmount; Vitest spec passes; typecheck clean; sub-manager dispatched ≥2 micro-agents; beads graph contains parent + 2 children; reflection cites real log lines; no `docs/` changes. |
| **T2-002** | 0.50 | 0.10 | 0.20 | 0.10 | 0.10 | null | 8 | Fix references `Application.platform != RuntimePlatform.WebGLPlayer`; no banned APIs; csharp-dev *did not* try to dispatch `build-validator` in Docker; handoff present; reflection mentions WebGL constraint. |
| **T2-003** *(NEW)* | 0.25 | 0.10 | 0.10 | 0.10 | 0.10 | **0.35** | 8 | ≥1 `mcp__alexandria__*` call appears BEFORE first file-write; quoted finding from a guide influences implementation; signature verification works; smoke test passes; README endpoint table updated; reflection mentions which guide was used. **Dominant weight on `alexandria_usage`** — this is the dimension's flagship test. |
| **T3-001** | 0.30 | 0.30 | 0.20 | 0.10 | 0.10 | null | 12 | All 5 files exist; webhook signature verification; retry helper covered by integration test; beads parent→children dependencies match phase plan; commit done via `committer` micro-agent; CHANGELOG + README updated. |
| **T3-002** | 0.00 | 0.50 | 0.20 | 0.10 | 0.20 | null | 7 | Work plan table well-formed; beads created with sensible deps; no code files changed; dashboard URL surfaced; journal entries at `session_start` + `dispatch`. |
| **T3-003** | 0.20 | 0.30 | 0.20 | 0.10 | 0.20 | null | 6 | Read `.voltron/logs/<fixture>` first; did NOT re-ask the user; resumed from last incomplete bead; closed at least one bead; `submit_reflection` mentions compaction; doc rule respected for any Voltron file changes. |

Each rubric file pins its `rubric_version`. The runner validates `task.rubric_version_expected === rubric.rubric_version` before invoking the judge; on mismatch the run is skipped with a clear error.

### 4.3 The `alexandria_usage` dimension

A new rubric dimension scored on any task whose `programmatic_signals.capture_alexandria_calls: true`. Identical pattern to `doc_hygiene`: nonzero weight only when relevant, `null` aggregate otherwise.

**Criterion structure (in COMMON.md, referenced by per-task rubrics):**

```markdown
### alexandria_usage.consulted_before_writing
**Question:** Did the agent call any `mcp__alexandria__*` tool BEFORE its first file-write tool call?
**Evidence required:** Earliest matching log line + first file-write line; programmatic scorer pre-fills both.
**Verdict scale:** MET = Alexandria call precedes first write; UNMET = no Alexandria call, or call(s) come only after writes; PARTIAL = call happened but only `list_guides` (no actual read of a guide).

### alexandria_usage.findings_applied
**Question:** Does the agent's [STEP] narration, code comment, or reflection quote a specific finding from the consulted guide(s)?
**Evidence required:** Quote from log/diff/reflection + the guide name it references.
**Verdict scale:** MET = clear quote/reference; PARTIAL = vague mention; UNMET = no observable application; CANNOT_ASSESS = guide retrieval failed (record in `notes`).

### alexandria_usage.no_redundant_calls
**Question:** Did the agent avoid spamming Alexandria (e.g. >5 unrelated calls)?
**Evidence required:** Count from programmatic scorer.
**Verdict scale:** MET = ≤5; PARTIAL = 6–10; UNMET = >10.
```

### 4.4 Per-shape rubrics

Each shape has one rubric file at `voltron-evals/rubrics/shapes/<shape-id>.md`, shared across every instance of that shape. The file structure mirrors per-task rubrics but its criteria reference shape-level parameters (e.g. `expected_files` from the instance YAML) rather than literal paths.

**Shape rubrics are scored programmatically by default.** Every criterion in the table below maps to a deterministic signal in §6: file-set equality, line-cap threshold, expected-fact grep, `[DONE]` presence, verdict-string match, no-source-edits, dispatch count, beads-created count. There is no `voltron-judge` Opus call for a Broad instance. The runner aggregates signals → criterion verdicts → shape score directly (see §5.1 and §6).

**Optional Haiku opt-in for subjective criteria.** A shape rubric MAY mark one or more criteria as subjective by setting:

```yaml
---
rubric_version: 1.0.0
shape_id: sub-manager-delegation
subjective_judge: "haiku"          # opt-in; absent = no LLM judge at all
subjective_criteria:               # only these criteria are sent to the judge
  - "reflection_honesty.matches_log_evidence"
---
```

When present, the runner makes a single Haiku call scoring ONLY the listed criteria, given the pre-extracted programmatic evidence as context. This costs ~$0.005/instance — about 1% of an Opus invocation. Default: NO `subjective_judge` field, i.e. zero LLM cost for the shape.

| Shape | Default weights (correctness / decomp / tier-disc / honesty / docs / alexandria) | Default criterion count | Scoring path |
|---|---|---|---|
| **micro-agent-write** | 0.70 / 0.00 / 0.10 / 0.10 / 0.10 / null | 5 (diff matches expected, no out-of-scope changes, line caps respected, `[DONE]` present, reflection if submitted is honest) | Programmatic only |
| **micro-agent-inspect** | 0.60 / 0.00 / 0.20 / 0.10 / 0.10 / null | 5 (expected facts emitted, zero file mutations, no sprawl, `[DONE]`, reflection honesty) | Programmatic only |
| **micro-agent-validate** | 0.70 / 0.00 / 0.10 / 0.10 / 0.10 / null | 4 (verdicts correct per fixture, no source edits, `[DONE]`, reflection) | Programmatic only |
| **sub-manager-delegation** | 0.20 / 0.50 / 0.10 / 0.10 / 0.10 / null | 6 (dispatched ≥ floor, decomp reasonable, didn't edit substantive files, beads parent/children, `[DONE]`, reflection honesty) | Programmatic + **Haiku** for `reflection_honesty.matches_log_evidence` (opt-in) |
| **coordinator-planning** | 0.00 / 0.60 / 0.10 / 0.10 / 0.20 / null | 5 (artifacts present, no source edits, beads sensible, dashboard surfaced, reflection) | Programmatic only |
| **publish** | 0.70 / 0.00 / 0.10 / 0.10 / 0.10 / null | 4 (exact action taken, no side effects, `[DONE]`, reflection) | Programmatic only |

The reflection-honesty criterion under `sub-manager-delegation` is the only Broad-layer criterion currently marked subjective — sub-managers are the most likely place a misleading reflection narrative could slip past raw counts. All other reflection-honesty checks remain programmatic (does a reflection exist? does it reference at least one log line that actually appears in the log?).

`alexandria_usage` is `null` for every shape by default — the dimension is exercised by Deep-task T2-003 (and any future Deep task that opts in). Shapes don't probe it because the prompt set is too short to require knowledge-base consultation.

---

## 5. `runner.js` Architecture

A small (~200 LOC) Node script. Run via:

```
node voltron-evals/runner.js \
  [--task=T2-001]                # single Deep task — implies --cache=off
  [--instance=function-writer]   # single Broad-layer instance — implies --cache=off
  [--shape=micro-agent-write]    # all instances of one shape
  [--tier=deep|broad|all|pr]     # default: tier matched to invocation context (see §7.4 for CI mapping)
  [--judge-model=opus|sonnet|haiku]  # default: opus (see §2.4); affects Deep-layer judge only
  [--cache=on|off|refresh-fails-only]  # default: on for sweeps, off for single-job runs (see §6.1, §7.6)
  [--doctor]                     # validate coverage map; exit 1 on drift; ignores cache by design
```

### 5.1 Execution shape (pseudocode, not committed code)

```
main(args):
  jobs = loadJobs(args)                            // Deep tasks ∪ Broad instances; YAML validated
  for job in jobs:
    // --- §6.1 / §7.6: content-hash incremental skip ---
    currentHash = templateHashFor(job.agent_under_test)        // sha256 of src/templates.js entry
    lastPassing = findLastPassingScorecard(job.id)             // most recent results/<id>/<ts>/scorecard.json
                                                               // with `verdict: pass` (or no fail)
    if args.cache != "off"
       and lastPassing != null
       and lastPassing.template_hash == currentHash
       and lastPassing.rubric_version == rubricVersionFor(job):
      emitCacheHitScorecard(job, lastPassing, currentHash)     // copy-forward; no AUT dispatch, no judge
      continue
    // --- end skip block ---

    runDir = mkRunDir(job.id, timestamp)           // voltron-evals/results/<id>/<ts>/
    snapshotPre = capture(job)                     // git HEAD, bd list, .voltron/logs/ list
    log = dispatchAUT(job)                         // → run_agent_in_docker(job.agent_under_test, ...)
                                                   // CRITICAL: never pass `model` (see §5.7)
    snapshotPost = capture(job)
    artifacts = collectArtifacts(runDir, log, snapshotPre, snapshotPost)
    programmaticScores = runProgrammaticScorers(job, artifacts)  // includes Alexandria grep

    // --- §2.4: layer-aware scoring path ---
    if job.kind == "deep":
      rubricPath = job.rubric
      judgeOutput = dispatchJudge(job, runDir, rubricPath, model: "opus")
      scoredVia = "judge"
    else:                                            // shape-instance
      shapeRubric = loadShapeRubric(job.shape)
      if shapeRubric.subjective_judge == "haiku":
        judgeOutput = dispatchJudge(job, runDir, shapeRubric.path,
                                    model: "haiku",
                                    criteria: shapeRubric.subjective_criteria)
        scoredVia = "haiku-subjective"
      else:
        judgeOutput = null                           // programmatic-only — no LLM call
        scoredVia = "programmatic"
    // --- end scoring path ---

    scorecard = mergeScorecard(programmaticScores, judgeOutput, job,
                               template_hash: currentHash, scored_via: scoredVia)
    writeScorecard(runDir, scorecard)
    mirrorToReflections(scorecard)                 // wraps in reflection envelope
  printSummaryTable()                              // includes per-job cache hit/miss
  exit(failuresPresent ? 1 : 0)
```

**CLI flag for the skip behavior** (extends §5 flag list): `--cache=on|off|refresh-fails-only` (default `on` for scheduled CI sweeps and PR-tier; `off` for `--doctor` and any manual `--task=…` / `--instance=…` invocation, so single-job runs never silently short-circuit).

### 5.2 How `dispatchAUT` works

Voltron's MCP server is Node and the runner is invoked **from inside the Voltron Docker container** (i.e. the harness container). That means:
- For Deep-task Tier-2/3 micro-agent AUTs (T1-001, T2-001, T2-003, T3-001, T3-003) and every Broad-layer instance: the runner calls the MCP tool `run_agent_in_docker` directly via a thin JS-RPC client to the MCP server, or alternately spawns `docker` against the host socket the same way the server does. **Decision: reuse the MCP path** so the runner gets free progress streaming, log capture, and the same env wiring as a normal session.
- For T3-002 (`code-analyst` + `doc-writer`): two sequential `run_agent_in_docker` calls — runner passes the prior call's output forward as part of the second's `task`.
- For T2-002 (mixed Editor-required slice): runner calls only the Docker-compatible portion (`csharp-dev`) and explicitly marks the validator slice `skipped_in_ci: true` in the scorecard.
- For Broad-layer `sub-manager-delegation` instance on `scrum-master`: instance YAML is present but the runner **skips dispatch** and emits a stub scorecard pointing to the Track B postmortem workflow (§8). This keeps the coverage map honest without violating the `src/index.js:1902` block.

### 5.3 Artifact capture (calls into `voltron-evals/lib/artifacts.js`)

For each run, write into `voltron-evals/results/<task>/<ts>/`:

| File | Source |
|---|---|
| `task.yaml` | copy of the task definition (audit) |
| `rubric.md` | copy of the rubric used (audit) |
| `log.txt` | `.voltron/logs/<file>` produced by the AUT's container |
| `diff.patch` | `git diff <pre-sha> <post-sha>` |
| `beads-pre.json`, `beads-post.json` | `bd list --json` snapshots |
| `journal-during.json` | `mcp__project-voltron__get_journal` for the run window |
| `reflection.json` | if AUT called `submit_reflection`, copy from `reflections/` |
| `programmatic.json` | output of §6 scorers |
| `scorecard.json` | merged judge + programmatic output (the final artifact) |

### 5.4 `dispatchJudge` contract

The runner builds the judge's `task` parameter as:

```
You are voltron-judge. Read the run artifacts and rubric below and emit a scorecard
per your template's Output Contract.

Run directory:   <abs path>
Rubric:          <abs path to rubrics/T2-001.md>
Rubric version:  1.0.0
Task definition: <abs path to tasks/T2-001.yaml>
Programmatic signals (pre-computed by runner):
  <inlined JSON from programmatic.json>

Score every criterion atomically with evidence. Emit ONE fenced ```json``` block.
```

Runner parses the first `\n```json\n...\n```\n` from the `voltron-judge` output and validates it against the scorecard schema (§2.5). On parse failure → mark run as `judge_parse_failed`, do not silently retry (research: avoid retry loops that hide bugs).

### 5.5 Concurrency

Default sequential. A `--parallel=N` flag is in scope for Phase 2 if total wall time exceeds ~20 min; on first build run sequentially to keep log capture deterministic.

### 5.6 Failure modes the runner must handle

| Failure | Behavior |
|---|---|
| AUT exits with non-zero | Still proceed to judge — failure-mode behavior IS what we want to score. |
| AUT exceeds `max_turns` | Record `done_line_present: false`; judge still runs. |
| Judge `cannot_grade` | Write a partial scorecard; do NOT mirror to `reflections/` (no false signal). |
| Rubric hash mismatch | Skip task with explicit error; do not invoke judge. |
| MCP unavailable | Hard error; exit 2 with diagnostic. |
| Instance YAML contains a `model` field | **Hard schema-validation failure.** The instance and task schemas explicitly disallow any model override (see §5.7). Exit 2. |
| Coverage drift (template added to `src/templates.js` without instance YAML) | `--doctor` mode exits 1; CI fails. **Note:** the `--doctor` check is unaffected by the cache (§7.6); it inspects instance file existence, not freshness. |
| Cache hit — agent's `template_hash` matches last passing scorecard | Skip dispatch + scoring; emit a cache-hit scorecard pointing back to the prior result (§7.6). Cached jobs are reported in the summary but do not count toward LLM cost. |
| Cache hit but rubric version drift | Cache miss — re-run. A rubric version change forces a re-grade across all affected agents (§6.1). |
| Broad-layer instance whose shape rubric sets `subjective_judge: "opus"` | **Hard schema-validation failure.** Only `"haiku"` (or absent) is permitted on shape rubrics. Exit 2. |

### 5.7 Model-pinning rule (enforcement)

This is a load-bearing constraint, not a convention:

1. **Schemas** — `task.schema.json` and `instance.schema.json` use `"additionalProperties": false` and **omit** any `model` / `model_override` field. Authors cannot smuggle a model override past the schema.
2. **Runner** — the call site that builds the `run_agent_in_docker` invocation MUST construct the argument object explicitly (no spread of unvalidated user input) and MUST NOT include a `model` key under any code path. A unit-style assertion in `runner.js` checks that the constructed args object lacks `model` before dispatch.
3. **Why** — every one of the 71 templates pins its own model tier in `src/templates.js`. Sweeping in an override would mean the harness measures agent-X-on-some-other-model rather than the agent-X actually shipped. That gap silently degrades the eval signal harness-engineer relies on.
4. **The only legal model knob** is `--judge-model` (§2.4), which affects ONLY `voltron-judge`, never AUTs.

---

## 6. Programmatic Scorers (No LLM)

Implemented in `voltron-evals/lib/programmatic-scorers.js`. Cheap, deterministic, run before the judge and injected as `programmatic` field in the scorecard so the judge cannot disagree with raw measurements (only with their interpretation).

| Signal | Source | Implementation sketch |
|---|---|---|
| `turns_used` | tail `.voltron/logs/<file>` and count `[STEP N]` lines | `(log.match(/^\[STEP \d+\]/gm) ?? []).length` |
| `done_line_present` | grep log for `^\[DONE\]` | boolean |
| `max_turns_budget` | from task.yaml | echoed |
| `budget_utilization` | `turns_used / max_turns_budget` | clamp to [0,1] |
| `files_changed` | `git diff --name-only <pre>..<post>` | array |
| `lines_added`, `lines_deleted` | `git diff --shortstat` | parse |
| `sub_dispatches` | grep log for `run_agent_in_docker(` calls inside the container | count + extracted target names |
| `sub_dispatches_expected` | from task rubric metadata | comparison emitted as `tier_discipline.dispatched_micro_agents: bool` |
| `beads_created` | `beads-post.json` set minus `beads-pre.json` set | array of IDs |
| `beads_closed` | by status diff | array of IDs |
| `beads_deps_count` | parse beads JSON | int |
| `journal_entries` | `journal-during.json` length and kind breakdown | object |
| `reflection_submitted` | did `reflections/` gain a file during the run? | boolean |
| `docs_updated` | `git diff --name-only` filtered by `docs/`, `README.md` | boolean (relevant only when task is a Voltron edit per `CLAUDE.md`) |
| `editor_handoff_emitted` | grep AUT output for `🎮 Editor task — please invoke manually` | boolean (relevant for T2-002) |
| `commit_dispatched_via_committer` | grep log for a `committer` micro-agent dispatch vs raw `git commit` line | boolean (relevant for T3-001) |
| **`alexandria_calls`** *(NEW)* | grep log for `mcp__alexandria__(search_guides\|read_guide\|list_guides\|get_project_setup_recommendations\|update_guide)` | object: `{ count, first_call_step, calls: [{ tool, step, before_first_write }] }` |
| **`alexandria_call_before_first_write`** *(NEW)* | derived from `alexandria_calls` + earliest file-write step | boolean (relevant when `capture_alexandria_calls: true`) |
| **`expected_files_match`** *(NEW — shape)* | `files_changed` set equality vs. instance `expected_files` | boolean + diff (missing/extra) — primary signal for `micro-agent-write` shape |
| **`forbidden_files_clean`** *(NEW — shape)* | intersection of `files_changed` and instance `forbidden_files` is empty | boolean — primary signal for shape sprawl detection |
| **`source_diff_empty`** *(NEW — shape)* | `git diff --stat` for paths matching the instance's `source_globs` is empty | boolean — primary signal for `micro-agent-inspect` + `coordinator-planning` shapes |
| **`expected_facts_present`** *(NEW — shape)* | every literal in instance `expected_facts` appears in the last `[STEP]` block of the AUT log | boolean + missing-facts list — primary signal for `micro-agent-inspect` shape |
| **`verdict_correct_per_fixture`** *(NEW — shape)* | for each fixture in `micro-agent-validate`, agent's emitted verdict matches the expected one | object: `{ fixture_id: bool }` — primary signal for `micro-agent-validate` shape |
| **`publish_action_taken`** *(NEW — shape)* | git-state delta corresponds to exactly the canonical action for the publish-family agent | enum: `committed | pr_opened | branch_created | deployed | changelog_appended | none | multiple` |

These signals are the foundation: any rubric criterion that *can* be answered by a programmatic check (e.g. "did typecheck pass?", "was Alexandria called before any file write?") is wired to a programmatic scorer first; the judge only opines on the dimensions that genuinely require reasoning (decomposition quality, reflection honesty, evidence interpretation, whether an Alexandria *finding* informed the implementation).

**Rule of thumb from research §B:** `programmatic > LLM-as-judge > Agent-as-judge` — only escalate when the prior tier can't answer. This is what makes the Broad layer programmatic-only (§2.4, §4.4): every criterion in the six shape rubrics fits cleanly in the "programmatic" tier, so the rule says don't escalate.

### 6.1 Content-hash incremental caching — `template_hash`

The runner avoids re-evaluating agents whose template hasn't changed since their last passing eval. Cost becomes proportional to template churn, not to template count.

**What gets hashed.** For each agent under test, the runner computes:

```
template_hash = sha256(canonicalJSON({
  templateContent:    TEMPLATES["<agent-name>"].content,
  templateDescription: TEMPLATES["<agent-name>"].description,
  templateTools:       TEMPLATES["<agent-name>"].tools         // if present in entry
  templateModel:       TEMPLATES["<agent-name>"].model,        // pinned model tier
  templateName:        TEMPLATES["<agent-name>"].name
}))
```

- Hash inputs are limited to fields that *change agent behavior*. We deliberately do NOT hash `filename`, `destination`, or `tags` (which can change without behavioral effect), nor the surrounding `TEMPLATES` map (which would invalidate every cache entry whenever any template changes).
- For sub-managers that compose micro-agents, the hash covers ONLY that sub-manager's own template entry. If `function-writer` changes, `function-writer`'s hash changes, but `fullstack-dev`'s hash does not — even though a downstream `fullstack-dev` eval may now produce different artifacts. This is acceptable because:
  - Deep tasks (the orchestration-quality signal) run on a fresh schedule regardless of caching, since Deep tasks are few and their cache hit is rare in practice.
  - Cross-agent regressions are the orchestration signal — caught by the Deep layer, not the per-agent Broad layer.
  - Broad shape rubrics intentionally probe only the AUT's own contract, not its downstream effects.

**Where the hash is computed.** In `voltron-evals/runner.js`, before each job. The runner imports `src/templates.js` (the same module the MCP server uses), reads `TEMPLATES[<aut>]`, and computes the canonical JSON hash. The implementation lives in `voltron-evals/lib/template-hash.js` (a new file, ~30 LOC: `canonicalJSON` + `crypto.createHash('sha256')`).

**Where the hash is stored.** In every scorecard, at the top-level `template_hash` field (§2.5). No separate cache database — the scorecards already in `voltron-evals/results/<id>/<ts>/` ARE the cache. Lookup is by directory listing: find the most recent `scorecard.json` for the job ID where the recorded `verdict` is `pass` (or where no criterion is below the rubric's pass threshold) and the `rubric_version` matches.

**Runner skip logic.** Before dispatching the AUT for a job:

```
function shouldSkip(job, currentHash):
  if --cache=off: return false                          // explicit overrides
  if --doctor mode: return false                        // §7.6: doctor never uses cache
  lastPassing = mostRecentPassingScorecardFor(job.id)
  if lastPassing == null: return false                  // never run before
  if lastPassing.rubric_version != rubricVersionFor(job): return false
  if lastPassing.template_hash != currentHash: return false
  return true                                           // ✅ skip — copy-forward
```

When skipped, the runner writes a small **cache-hit scorecard** to `voltron-evals/results/<id>/<ts>/scorecard.json` carrying:

```jsonc
{
  "task_id": "T2-001",
  "agent_under_test": "fullstack-dev",
  "template_hash": "sha256:e3b0c44…",
  "scored_via": "cache-hit",
  "cached_from": "voltron-evals/results/T2-001/2026-04-15T06-03-11/scorecard.json",
  "rubric_version": "1.0.0",
  "aggregates": <copied from cached_from>,
  "criteria":    <copied from cached_from>,
  "judge_model": null,
  "judge_turns_used": 0
}
```

The cache-hit scorecard is **NOT** mirrored to `reflections/` — only fresh evaluations enter the improvement loop, otherwise harness-engineer's 2-of-N frequency rule would inflate with stale duplicates.

**What invalidates a cache entry:**

| Trigger | Effect |
|---|---|
| `TEMPLATES["<agent>"].content` edited (any character) | `template_hash` changes → cache miss → fresh run |
| `TEMPLATES["<agent>"].model` changed (e.g. haiku → sonnet) | `template_hash` changes → fresh run |
| Shape or task rubric `rubric_version` bumped | Cache miss for all affected jobs → fresh run (re-grade by design) |
| Programmatic scorer added/changed in `lib/programmatic-scorers.js` | NO automatic invalidation — bump the rubric `rubric_version` to force re-run, or pass `--cache=off` (§6.1.1) |
| New template added to `src/templates.js` | New instance YAML required (caught by `--doctor`); first run is by definition a cache miss |
| Manual operator override | `--cache=off` or `--cache=refresh-fails-only` (§5.1) |

#### 6.1.1 Edge cases & operator controls

- **`--cache=off`** — force re-evaluation of every job in this run. Used by manual `--task=…` / `--instance=…` invocations (which set this implicitly), and by operators who want to confirm a cached pass is still real.
- **`--cache=refresh-fails-only`** — re-evaluate any job whose most recent scorecard is a fail; cache-hit anything that previously passed. Useful for partial recovery sweeps after a known regression is fixed.
- **First-ever sweep** — every job is a cache miss; this is the **baseline full sweep** referenced in §3.6 and §7.4 cost estimates (~$8–12).
- **Cache poisoning is not a concern** — the cache key is content-derived (no external trust), and the cache values are the actual scorecards on disk (no out-of-band store). The worst case from a corrupted scorecard is one bad cache hit, fixable by deleting that scorecard file.

---

## 7. Results → Self-Improvement Loop

The scorecard is the bridge into Voltron's existing reflection pipeline.

### 7.1 Reflection envelope

After the scorecard is written, the runner mirrors it into `reflections/` wrapped in the existing reflection shape:

```jsonc
{
  "timestamp": "2026-05-21T14-22-08.193Z",
  "project_name": "voltron-eval-harness",
  "project_type": "general",
  "session_summary": "Eval T2-001 (useDebounce hook) — AUT=fullstack-dev @ v3.8.4. Aggregate: correctness 0.83 / decomposition 1.0 / tier_discipline 0.5 / honesty 1.0 / docs 0.0.",
  "agents_used": ["fullstack-dev", "function-writer", "test-writer", "typecheck-runner"],
  "agent_feedback": [
    {
      "agent": "fullstack-dev",
      "worked_well": "Dispatched function-writer and test-writer in parallel; emitted [DONE] within budget.",
      "needs_improvement": "tier_discipline scored 0.5 — typecheck-runner was never dispatched; agent ran tsc directly.",
      "suggested_change": "Add an explicit 'always dispatch typecheck-runner after function-writer' line to the fullstack-dev template, or wire it as a default sub-recipe."
    }
  ],
  "overall_notes": "Doc hygiene NA for this task type (no Voltron change).",
  "processed": false,
  "eval_metadata": {
    "task_id": "T2-001",
    "rubric_version": "1.0.0",
    "rubric_path": "voltron-evals/rubrics/T2-001.md",
    "template_versions": { "fullstack-dev": "3.8.4", "scrum-master": "3.8.4" },
    "scores": { "correctness": 0.83, "decomposition": 1.0, "tier_discipline": 0.5, "reflection_honesty": 1.0, "doc_hygiene": 0.0, "alexandria_usage": null },
    "programmatic": { "turns_used": 18, "max_turns": 30, "files_changed": 3, "sub_dispatches": 2, "alexandria_calls": { "count": 0 } },
    "judge_model": "claude-opus-4-7",
    "scorecard_path": "voltron-evals/results/T2-001/2026-05-21T14-22-08/scorecard.json"
  }
}
```

### 7.2 Pipeline contract

- `harness-engineer` Reflection Processing Mode already reads every `reflections/*.json` with `processed: false`, groups by agent, prioritizes by frequency. It **needs no code change** — eval reflections plug in as additional data points.
- `agent_feedback[*].suggested_change` strings derive directly from `UNMET`/`PARTIAL` criteria with concrete evidence, so harness-engineer gets actionable, citation-backed suggestions rather than vague gripes.
- The `eval_metadata` block is **additive and optional** — `harness-engineer` ignores fields it doesn't recognise (it only reads `processed`, `agent_feedback`, and friends today).
- **Frequency signal works as designed:** running the same task 3× on `templates.js@v3.8.4` produces 3 reflections with the same `agent`/`suggested_change`, which crosses the "2+ reflection" threshold harness-engineer already uses.

### 7.3 Anti-loop safety

- Do **not** allow `harness-engineer` to edit `voltron-judge`'s template based on its own reflections — that would let the judge tune itself out of detecting failures. Build phase MUST add an explicit guard in `harness-engineer`'s template (or in the rubric for eval reflections) that says: "reflections with `project_name: voltron-eval-harness` may not be used to modify the `voltron-judge` template." Human change-control only.

### 7.4 CI integration — eval harness in `.github/workflows/`

CI is now part of the first-build scope (lifted from the deferred Phase 4). Two workflows, kept independent and chained only through the filesystem (`reflections/`):

#### 7.4.1 New workflow: `.github/workflows/voltron-evals.yml`

```yaml
name: Voltron Evals

on:
  pull_request:
    paths:
      - 'src/templates.js'
      - 'voltron-evals/**'
      - 'src/index.js'
  schedule:
    - cron: '0 6 1 * *'      # 06:00 UTC on the 1st of each month — full sweep, monthly
  workflow_dispatch:

permissions:
  contents: write            # write scorecards + mirrored reflections to repo on schedule
  pull-requests: read

jobs:
  pr-tier:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4
      - run: node voltron-evals/runner.js --doctor                # coverage map check (cache-agnostic)
      - run: node voltron-evals/runner.js --tier=pr --cache=on    # T1 Deep tasks + 10-instance Broad sample

  full-sweep:
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    timeout-minutes: 90
    steps:
      - uses: actions/checkout@v4
      - run: node voltron-evals/runner.js --doctor
      - run: node voltron-evals/runner.js --tier=all --cache=on   # all Deep + all 70 Broad, skip unchanged
      - name: Commit scorecards and mirrored reflections
        run: |
          git config user.name "voltron-evals[bot]"
          git config user.email "voltron-evals[bot]@users.noreply.github.com"
          git add voltron-evals/results/ reflections/
          if git diff --staged --quiet; then
            echo "No new results to commit."
          else
            git commit -m "voltron-evals: monthly sweep $(date -u +%Y-%m-%d)"
            git push
          fi
```

**Tier mapping (which job runs which work):**

| CI trigger | Tier | Scope | Cache | Wall time budget | Why |
|---|---|---|---|---|---|
| `pull_request` (touches `src/templates.js`, `src/index.js`, or `voltron-evals/**`) | `--tier=pr` | All Deep T1 tasks + a deterministic 10-instance Broad sample (rotated by `(commit_sha mod 70)`) | on | ≤25 min | Fast signal on the PR diff; rotation means full coverage over ~7 PRs. |
| `schedule` (monthly, 1st of month 06:00 UTC) | `--tier=all` | All Deep (7 tasks) + all Broad (70 instances) + the coverage doctor | on | ≤90 min (worst case — baseline; typically <20 min once cache warms) | Monthly authoritative scorecard for every agent **that has changed since last pass**. |
| `workflow_dispatch` | `--tier=all` (default) or override | Operator's choice | on by default; `--cache=off` for full rerun | per choice | Manual sweeps; e.g. before a release, or to force a cache-bypass full sweep. |

**Cost rationale (updated for the three optimizations — see §3.6, §11.4, §11.7, §11.12):**

| Sweep type | LLM calls | Estimated cost |
|---|---|---|
| **Baseline full sweep** (first-ever, or after `--cache=off`) | 7 Opus judge calls + 70 Broad AUT runs (no judge) + 7 Deep AUT runs + 0–1 Haiku opt-in calls | **~$8–12 (one-time)** |
| **Typical post-baseline monthly sweep** (cache hits on ~80–90% of agents — only changed templates re-run) | ~1–2 Opus calls + ~5–10 Broad AUT runs + ~1–2 Deep AUT runs | **~$1–3 per sweep** |
| **PR-tier** (T1 Deep tasks + 10-instance Broad sample; mostly cache-hits when the PR diff is small) | 1 Opus call (T1 Deep) + 10 Broad AUT runs (no judge) | **~$0.50–1.50 per PR** |

Compare to the prior weekly-Opus-on-every-instance design: ~$60–100/month → **~$1–6/month** typical, capped at ~$12 if every monthly sweep is a worst-case baseline. The PR-tier cost halves as well (judge no longer invoked on the Broad sample). All three optimizations (Opus only on Deep, programmatic Broad, content-hash caching, monthly cadence) compound to deliver that.

#### 7.4.2 Relationship to `process-reflections.yml`

**Independent workflows on different cadences, chained through the filesystem.** Not a single workflow, not a hard chain (`workflow_run`), because the two have different cadences AND different change-control postures: the eval harness writes machine-generated scorecards monthly (§7.4.1); reflection processing opens a PR humans review weekly (§7.5).

```
voltron-evals.yml — schedule: '0 6 1 * *'   (monthly: 1st of month, 06:00 UTC)
  └── writes scorecards into voltron-evals/results/
  └── mirrors each FRESH (non-cache-hit) scorecard into reflections/<ts>-eval-<id>.json (processed: false)

process-reflections.yml — schedule: '0 10 * * 1'   (weekly: every Monday, 10:00 UTC)
  └── picks up any reflections/*.json with processed: false (eval + organic + any prior weeks')
  └── runs the existing Claude Code agent against process-reflections.md
  └── opens an auto-improvement PR
```

**Cadence relationship.** The two workflows are intentionally **decoupled in time**:
- Monthly eval sweep produces a fresh batch of eval reflections; cache-hits do NOT mirror (§6.1), so the batch size scales with how many agents actually changed that month.
- Weekly reflection processing consumes whatever's in the queue — organic reflections submitted by user-session agents, plus the monthly eval batch when it lands. On the Monday immediately after a monthly sweep, the processing run sees both kinds; on the other ~3 Mondays of the month, it sees only organic reflections.
- This is deliberate, not accidental. Reflection processing is driven by the existence of `processed: false` files, not by a tight temporal handshake with the eval workflow. If a month's sweep is empty (no template changed → all cache hits), processing still runs weekly against organic reflections.

**Why decoupled cadences (instead of "eval Mon 06:00 → process Mon 10:00 same week")?**
- Eval results are mostly stable month-over-month once the cache warms; running the eval workflow weekly would produce nearly-identical scorecards (most agents cache-hit) at the cost of one full sweep's compute.
- Organic reflections arrive continuously from user sessions; weekly processing batches them at a cadence that's frequent enough to keep template-improvement turnaround short.
- The 2-of-N frequency rule (§7.2) naturally handles "this eval scorecard just landed in the same batch as last week's organic reflections": frequency only fires when ≥2 reflections cite the same issue across the *combined* queue.

**If the eval workflow fails or yields no scorecards**, `process-reflections.yml` still runs and processes any organic reflections it finds — the two workflows remain independent and degrade gracefully.

**Do eval results gate the improvement run? — No, they *inform* it.** Rationale:
- Eval reflections enter the same queue as organic reflections. `harness-engineer`'s existing 2-of-N frequency rule (§7.2) already filters noise; a single low score does not auto-edit a template.
- Gating would create a circular feedback (a noisy judge turn would block all improvements). Independence + frequency-filtering preserves the existing improvement pipeline's safety properties.
- A future `Block on red` mode is recorded in §11.8 as an open knob, but explicitly deferred — current default is purely informational.

### 7.5 Reflection-processing cadence — 3×/week → 1×/week

`.github/workflows/process-reflections.yml` currently runs on `cron: '0 10 * * 1,3,5'` (Mon/Wed/Fri — 3×/week; the comment on line 3 says "3x/week"). The design changes this to **1×/week** (Monday 10:00 UTC) to reduce churn on `src/templates.js` and let evidence batches grow.

**Explicit build-phase change item:**

| File | Line | Change |
|---|---|---|
| `.github/workflows/process-reflections.yml` | line 11 | `- cron: '0 10 * * 1,3,5'` → `- cron: '0 10 * * 1'` |
| `.github/workflows/process-reflections.yml` | line 3 | Update comment: "Runs on a schedule **3x/week**" → "Runs on a schedule **1×/week** (Monday)" |

**Why weekly (independent of the monthly eval cadence):**
- Most reflections in the queue are *organic* — submitted by agents during real user sessions throughout the week. Weekly processing batches them at a cadence frequent enough to keep template-improvement turnaround short.
- Running 3×/week mostly re-processes the same set of `processed: false` files (the auto-improvement run rarely accumulates a meaningfully different batch between Mon and Wed). Weekly gives evidence batches time to grow, which strengthens the 2-of-N frequency signal `harness-engineer` already uses (§7.2).
- The cadence is **independent of** the monthly eval workflow (§7.4.1, §7.4.2). On the first Monday after a monthly eval sweep, the queue includes both organic + eval reflections; on the other Mondays it's organic-only. Either case still runs through the same processor unchanged.
- The `workflow_dispatch` trigger is preserved — humans can still kick off an improvement run manually if a hot fix lands mid-week.

**What does NOT change in `process-reflections.yml`:**
- The agent prompt (`process-reflections.md`) — eval reflections are shaped to be additive (§7.2), so the existing processor handles them with zero code change.
- The PR-opening flow and review requirements.
- The dynamic `max_turns` calculation — it scales with reflection count, which is naturally larger under the weekly batch and slightly larger again on the first Monday after a monthly eval sweep.

### 7.6 CI integration of the `template_hash` cache

The cache mechanism is fully described in §6.1. Its CI-level implications:

- **No new artifact store.** The cache IS the existing `voltron-evals/results/` tree. Scorecards committed by the `full-sweep` job (§7.4.1) become the next sweep's cache. No S3, no Actions cache, no extra credentials.
- **Self-warming.** The first scheduled monthly sweep after merge produces the baseline scorecards; from the next month onward, only changed agents pay the LLM cost. The repository is the single source of truth.
- **`--doctor` is cache-agnostic.** The coverage check inspects whether `voltron-evals/instances/<agent>.yaml` exists for every template in `Object.keys(TEMPLATES)`; it does not consult `template_hash` and is unaffected by cache state. A new agent will fail `--doctor` immediately, regardless of how recent the last sweep was.
- **PR-tier respects the cache too.** PR-tier sweeps (§7.4.1) also pass `--cache=on`. If a PR touches `src/templates.js` for agent `function-writer` only, the PR-tier run actually re-evaluates `function-writer`'s Broad instance and `T1-001` (which references it) — everything else is a cache hit, keeping PR-time wall-clock and cost minimal.
- **Operator override for confidence sweeps.** `workflow_dispatch` with input `cache: off` (or operator-edited workflow file) forces a baseline full sweep — used before a release, or after a programmatic-scorer change that doesn't bump a rubric version.
- **What if results/ is wiped?** A clean `voltron-evals/results/` directory is treated as "never run before" — the next sweep is a baseline (cost ~$8–12). This is the same cost we already accept for the very first sweep.

---

## 8. Resolving the Orchestrator-Testing Gap

### 8.1 The constraint

`src/index.js:1902-1909` hard-blocks `run_agent_in_docker("scrum-master", …)` with a specific error message. The runner therefore **cannot** dispatch `scrum-master` programmatically. Lifting the block is a non-starter: the constraint is load-bearing for several documented reasons (real-time chat output, Chrome dashboard navigation, user channel of communication).

### 8.2 Recommended resolution — **two-track grading**

**Track A (automated): The harness grades Tier-2/Tier-3 agents.**

All 7 Deep tasks plus the 70 Broad-layer instances target dockerizable AUTs (sub-managers and micro-agents). This is sufficient because **the most common orchestrator-quality regressions show up downstream** — a bad scrum-master decomposition manifests as a sub-manager being asked to do too much, or a micro-agent being skipped. Several criteria already in the rubrics (T2-001 tier_discipline, T3-001 phase decomposition, T3-002 work plan structure) plus the `sub-manager-delegation` shape rubric probe orchestration-shaped behavior in the *artifacts* a downstream agent produces.

**Track B (semi-automated): `voltron-judge` reviews real scrum-master sessions from artifacts.**

For genuine orchestrator grading, the runner provides a second entry point:

```
node voltron-evals/runner.js grade-scrum-master \
  --log .voltron/logs/scrum-master-<ts>.log \
  --beads-pre <snapshot.json> \
  --beads-post <snapshot.json> \
  --journal <journal.json> \
  --rubric voltron-evals/rubrics/SCRUM-MASTER.md
```

This mode skips `dispatchAUT` entirely — the scrum-master already ran (in the main session, where it must) — and invokes `voltron-judge` against the captured artifacts: log file, beads snapshots, journal entries, the produced work plan markdown, and any `reflections/*.json` the scrum-master submitted.

A new rubric `voltron-evals/rubrics/SCRUM-MASTER.md` (Markdown only — no task YAML, because there is no programmatic dispatch) scores:
- Did `bd dep tree` get shown to the user?
- Did every queued bead get registered in `update_progress`?
- Did the work plan use the table format from `scrum-master.md:204-224`?
- Was anchor pre-computation evident before file-edit dispatches?
- Did reflection content match journal/log evidence (Autorubric-style)?

**Why this is the right call:**
- Preserves the design constraint that scrum-master runs in the main session (no carve-out, no fragile mock).
- Reuses the same judge agent and the same rubric/evidence machinery — no new infrastructure.
- Maintains the inspect-only judge property: `voltron-judge` never dispatches `scrum-master`; it only reads artifacts an *external* (human-initiated) run produced.
- Scales: every real scrum-master session is a free grading sample. The orchestrator grades itself by accumulating Track B samples over time, which is exactly the signal `harness-engineer` already uses.

### 8.3 What this explicitly does NOT do

- **No mock scrum-master.** The research considered this; rejected — a mock can't exercise the actual `mcp__project-voltron__*` integrations and would test the mock, not the agent.
- **No bypassing the Docker block.** Tampering with `src/index.js:1902` to allow `scrum-master` in Docker would compromise the documented orchestrator-runs-in-main-session contract.
- **No combined dispatch.** Track A and Track B are kept separate. A scorecard explicitly carries `mode: "automated"` (Track A) or `mode: "scrum-master-postmortem"` (Track B), so trends are not muddled.

### 8.4 Operational cadence

| Track | Frequency | Scope | Trigger |
|---|---|---|---|
| A (automated sweep) | Per PR (PR-tier — T1 + rotating 10-instance Broad sample); monthly 1st @ 06:00 UTC (full — 7 Deep + 70 Broad, `template_hash`-cached) | Tier-2/3 Deep tasks + all Broad-layer instances | CI (`.github/workflows/voltron-evals.yml`, §7.4) |
| B (scrum-master postmortem) | Opt-in after a notable session, or monthly batch | Real scrum-master sessions, graded from artifacts | Human runs `node runner.js grade-scrum-master --log ...` |

Build phase ships Track A first (this PR). Track B is a thin extension of the same runner and rubric machinery; ship in a follow-up PR.

---

## 9. Open Questions (for build phase only)

Not for human review — these are scoped to the build agent and resolvable with code.

- Exact JSON-RPC shape for the runner-→-MCP-server call (use the MCP SDK client vs spawn a stdio child). Recommend: import `@modelcontextprotocol/sdk` client, connect to the running Voltron MCP server by socket — same path the host Claude Code uses.
- Fixture minimality: T1-001 needs a tiny `server/src/index.ts` with a known anchor; build phase will write it and pin the anchor line numbers in the task YAML.
- Whether `runner.js` should pin `claude-code` CLI version explicitly. Recommend: rely on the Dockerfile-pinned version; record the value in `scorecard.json` for traceability.

---

## 10. Acceptance Criteria (for the build phase)

A build is "done" when:

1. `node voltron-evals/runner.js --task=T1-001` runs end-to-end, produces a scorecard JSON, mirrors a reflection, and exits 0/1 on rubric pass/fail.
2. `node voltron-evals/runner.js --instance=function-writer` runs the Broad-layer instance end-to-end (Revision 1).
3. `node voltron-evals/runner.js --doctor` exits 0 against a clean tree and exits 1 when any agent in `Object.keys(TEMPLATES)` lacks an `instances/<agent>.yaml` (excluding `voltron-judge`) — i.e. all 70 non-judge templates have a Broad-layer instance (Revision 1).
4. `voltron-judge` appears in `list_templates`; `getTemplatesForType("web")` does **not** include it; `getTemplatesForType()` (no arg) includes all agents per current behavior.
5. `src/index.js` blocks `run_agent_in_docker("scrum-master", …)` (unchanged); does **not** block `voltron-judge`.
6. `voltron-judge` cannot write files (tools list verified), cannot dispatch other agents (no `run_agent_in_docker` in tools), and its `model:` field is `"opus"` in `src/templates.js` (Revision 2).
7. `task.schema.json` and `instance.schema.json` both forbid a `model` / `model_override` field (`additionalProperties: false`). A test that loads a YAML with a `model` field exits 2 (Revision 2).
8. `runner.js` constructs the `run_agent_in_docker` argument object explicitly and contains an assertion that the constructed object lacks a `model` key. Verified by `git grep "model:" voltron-evals/runner.js` returning no matches inside the dispatch call site (Revision 2).
9. All 7 Deep-task YAMLs validate against `task.schema.json`; all 6 shape YAMLs validate against `shape.schema.json`; all 70 instance YAMLs validate against `instance.schema.json` (Revision 1).
10. `COMMON.md` defines the `alexandria_usage` dimension with the three criteria from §4.3; T2-003's rubric weights `alexandria_usage` at 0.35; the programmatic scorer `alexandria_calls` is implemented (Revision 3).
11. T2-003 runs end-to-end and produces a scorecard with a non-null `aggregates.alexandria_usage` value (Revision 3).
12. `harness-engineer` reflection pass consumes a mirrored eval reflection without modification to its template (validated by running `harness-engineer` after a sweep — should produce a normal template-improvement PR, not crash).
13. `.github/workflows/voltron-evals.yml` exists with the two jobs from §7.4.1 and passes a `act` dry-run (or equivalent yaml-lint + workflow validation) (Revision 4).
14. `.github/workflows/process-reflections.yml` cron is `'0 10 * * 1'` and the line-3 comment reads "1×/week" (Revision 5).
15. **`.github/workflows/voltron-evals.yml` cron is `'0 6 1 * *'`** (monthly, 1st of month, 06:00 UTC) (Revision 6).
16. **Broad-layer scoring path is programmatic only** by default: a unit-style assertion in `runner.js` confirms no `voltron-judge` dispatch occurs for any job with `kind: "shape-instance"` UNLESS that shape's rubric sets `subjective_judge: "haiku"`. A schema-validation check rejects any shape rubric with `subjective_judge: "opus" | "sonnet"` (Revision 6).
17. **`voltron-judge` is invoked only on Deep tasks** (programmatic check: across a full sweep, judge invocation count equals the count of `kind: "deep"` jobs that were NOT cache-hits, plus any `haiku-subjective` shape-instance jobs) (Revision 6).
18. **`template_hash` cache works end-to-end** (Revision 6): the runner computes a sha256 of each agent's `TEMPLATES["<agent>"]` entry; a second consecutive `--tier=all --cache=on` run with no template edits produces 70+7 cache-hit scorecards (zero LLM calls); editing one agent's template and re-running produces exactly one fresh run for that agent + one for any Deep task referencing it.
19. **Cache-hit scorecards are NOT mirrored to `reflections/`** (verified by counting `reflections/*-eval-*.json` produced before and after a no-change sweep — should be zero new files) (Revision 6).
20. `docs/index.html` and `README.md` mention the new internal agent, the eval harness, the two-layer model (Broad-programmatic / Deep-Opus split), the new CI workflow, the monthly cron, the `template_hash` cache, and the cadence change (CLAUDE.md doc rule).
21. Version bumped per CLAUDE.md: **minor** (adds new agent) — e.g. `3.8.4` → `3.9.0`.

---

## 11. DECISIONS FOR HUMAN REVIEW

These are judgment calls that depend on operator preference or carry meaningful trade-offs. Reviewer should confirm or override before build phase begins.

### 11.1 Two-layer task model — **ship both Deep and Broad layers in the first build** *(Revision 1)*

- **Recommended.** Deep layer = 7 hand-written end-to-end tasks. Broad layer = 6 shapes × 70 per-agent instances (`voltron-judge` excluded). Every template gets at least one eval; new agents must come with a Broad-layer instance or `--doctor` fails CI.
- **Alternative considered (rejected):** ship Deep-only first; add Broad later. Rejected — the user's explicit ask is per-agent coverage, and 70 lightweight instance YAMLs are cheap to author; deferring would just leave a known gap.
- **Alternative considered (rejected):** more shape variants (one per agent sub-category). Rejected — 6 shapes already cleanly partition the 70 templates and keep rubric maintenance bounded. Re-evaluate if a 72nd agent doesn't cleanly fit an existing shape.

### 11.2 Orchestrator-gap resolution — **two-track grading (Track A + Track B)**

- **Recommended.** Track A grades Tier-2/Tier-3 only (dockerizable AUTs) plus the Broad-layer instances; Track B uses `voltron-judge` to review real scrum-master sessions from artifacts after the fact. Same judge, same rubric machinery, no mock, no constraint violation.
- **Alternative considered (rejected):** mock scrum-master in Docker. Rejected — would test the mock, not the agent, and would silently diverge from real behavior.
- **Alternative considered (rejected):** carve out a `is_eval_run` flag in `src/index.js:1902` to allow scrum-master in Docker during eval mode. Rejected — load-bearing constraints should not be relaxed by environment flag.

### 11.3 Model pinning under test — **no model override; agents run on their pinned tier** *(Revision 2)*

- **Recommended.** Runner MUST NOT pass a `model` parameter to `run_agent_in_docker`. Every one of the 71 templates pins its own tier (55 haiku, 18 opus, 11 sonnet). Schema forbids any override field; runner asserts it; CI tests the assertion (§5.7).
- **Why:** the harness must measure the agent that ships, not the agent-on-a-different-model. Overriding silently invalidates the eval signal.
- **Alternative considered (rejected):** allow a global `--aut-model` flag for "comparative" runs. Rejected — comparative experiments belong in a separate ad-hoc tool, not the regression harness, because mixed-model results corrupt the longitudinal scorecard history harness-engineer consumes.

### 11.4 Judge model — **Opus on Deep layer ONLY; Broad layer is programmatic** *(Revision 6 — revised from Revision 2 "Opus everywhere")*

- **Recommended.** `voltron-judge.model: "opus"`, BUT the judge is invoked only for the 7 Deep tasks. The 70 Broad-layer instances are scored entirely by programmatic scorers (§6); shape rubrics MAY opt into a narrow Haiku call for a subjective criterion (§4.4) but the default is no LLM judge call at all.
- **Why this change from Revision 2's "Opus on every instance":** the original cost estimate (~$60–100/month at weekly cadence with 77 Opus calls per sweep) was an order of magnitude too high. The Broad shapes were designed so every criterion is programmatically checkable (file-set equality, line-cap, verdict-string match, expected-fact grep) — paying for Opus reasoning over those was buying nothing. The Deep tasks, by contrast, have rubric criteria that genuinely require evidence interpretation, so Opus stays there.
- **Self-preference bias on Deep tasks is still well-mitigated** by evidence-required scoring + the programmatic pre-pass + the anti-self-grading guard (§2.3, §2.4, §6). Of the 7 Deep AUTs, very few are Opus-tier — intra-family pairing is minimal.
- **Cost** — now bounded at **~$1–3 per typical monthly sweep** (cache + programmatic Broad combined) and **~$0.50–1.50 per PR**. Worst-case baseline sweep is ~$8–12 (§7.4).
- **Alternative considered (rejected):** keep Opus on Broad too "for safety." Rejected — programmatic scorers on the six shape rubrics produce binary, deterministic signals that an LLM judge can only agree with or contradict (and contradicting raw measurements is wrong). LLM cost without LLM signal is a bad trade.
- **Alternative considered (rejected):** Sonnet on Deep. Rejected — Deep tasks are where bad judgment compounds (multi-criteria, citation-required). The Deep call count is small (~7 per baseline sweep), so the Opus surcharge is in the noise versus the cost of a misleading scorecard influencing `harness-engineer`.
- **Alternative considered (accepted with discipline):** Haiku for narrow subjective Broad criteria. Allowed per-shape via `subjective_judge: "haiku"` (§4.4). Currently only the `sub-manager-delegation` shape opts in, for the `reflection_honesty.matches_log_evidence` criterion. Opt-in is by design: future shapes may add it, but the runner schema explicitly forbids `subjective_judge: "opus" | "sonnet"` on a shape rubric so cost can't drift back up by accident.
- The `--judge-model sonnet|haiku` CLI flag remains for local Deep-task spot-checks and bias diagnostics. Production default and CI default for Deep tasks is Opus.

### 11.5 `alexandria_usage` rubric dimension *(Revision 3)*

- **Recommended.** Add the dimension to `COMMON.md` with 3 criteria (consulted-before-writing, findings-applied, no-redundant-calls). Programmatic scorer greps `mcp__alexandria__*` calls; weighted nonzero only on tasks that opt in. T2-003 is the flagship test at 0.35 weight; other Deep tasks set it to `null` (NA, like `doc_hygiene`).
- **Why:** Alexandria use is a Voltron prime directive (called out in `harness-engineer` and `researcher` templates). It was previously assumed, not measured.
- **Alternative considered (rejected):** make `alexandria_usage` a global rubric criterion weighted nonzero on every task. Rejected — most tasks don't need Alexandria; forcing a weight on them would penalize correct behaviour.
- **Alternative considered (rejected):** measure only programmatically (no judge criterion). Rejected — the *findings-applied* criterion needs reasoning over whether a guide finding actually informed the implementation.

### 11.6 Reflection mirroring — **mirror every scorecard, with anti-loop guard**

- **Recommended.** Every scorecard is mirrored to `reflections/` so `harness-engineer`'s existing frequency-signal logic does the right thing. Anti-loop guard in §7.3 prevents eval reflections from modifying the `voltron-judge` template.

### 11.7 CI integration — **shipped in the first PR, monthly full-sweep cadence** *(Revision 6 — adjusted from Revision 4)*

- **Recommended.** New workflow `.github/workflows/voltron-evals.yml` runs `--tier=pr` on PRs that touch `src/templates.js` / `src/index.js` / `voltron-evals/**`, and `--tier=all` on **`'0 6 1 * *'` (monthly, 1st of month, 06:00 UTC)**. Scorecards are mirrored to `reflections/` — only fresh (non-cache-hit) ones, per §6.1 — where the existing `process-reflections.yml` consumes them on its independent weekly Monday 10:00 UTC schedule.
- **Why monthly (not weekly):** with the `template_hash` cache (§6.1) and programmatic Broad layer (§4.4, §11.4), weekly sweeps would mostly produce cache-hit scorecards while paying the GitHub-Actions runtime overhead unchanged. Monthly cadence is sufficient because:
  - PR-tier runs already cover any changed agent on a per-PR basis (the cache makes PR-tier fast).
  - Organic reflections from user sessions arrive continuously; weekly reflection processing keeps template improvement turnaround tight.
  - Catastrophic regressions show up in the next PR's PR-tier run, not on the monthly sweep.
- **Workflow relationship:** independent, chained through the filesystem only (no `workflow_run`). Eval and reflection workflows now have explicitly different cadences (monthly vs. weekly) but the same filesystem contract. Eval results *inform* the auto-improvement run via the existing 2-of-N frequency rule; they do not *gate* it. See §7.4.2.
- **Alternative considered (rejected):** stay on weekly cron after caching is added. Rejected — weekly + cache mostly produces zero-LLM cache-hit sweeps, which is GitHub-Actions runtime for no signal. Monthly cron drops the runtime cost too.
- **Alternative considered (rejected):** chain via `workflow_run`. Rejected — chaining means a flaky eval workflow blocks auto-improvement, which would also block organic reflections from being processed. Independence + filesystem chaining degrades gracefully.
- **Alternative considered (rejected, but flagged for future):** gate `process-reflections.yml` on the eval sweep's overall score (block if any agent < 0.5 on `correctness`). Could be added later if false-positive improvements become a problem. Out of scope for first build.

### 11.8 Reflection-processing cadence — **3×/week → 1×/week (Monday only)** *(Revision 5)*

- **Recommended.** Change `.github/workflows/process-reflections.yml` cron from `'0 10 * * 1,3,5'` to `'0 10 * * 1'` and update the line-3 comment from "3x/week" to "1×/week".
- **Why:** the new Voltron-evals sweep regenerates eval reflections once per week. Running auto-improvement 3× weekly mostly re-processes the same batch, producing redundant template churn. Weekly cadence + a bigger evidence batch strengthens the 2-of-N frequency signal the processor already uses.
- **Build-phase change item** (recorded explicitly): `.github/workflows/process-reflections.yml` lines 3 and 11 — see §7.5 for the exact diff.
- **`workflow_dispatch` trigger preserved** — humans can still kick off mid-week runs.

### 11.9 Task #3 (T2-002 WebGL) — **file-only slice in CI, manual validator slice tracked**

- **Recommended.** Run csharp-dev's file edit in Docker as part of the automated sweep; mark the `build-validator` slice as `skipped_in_ci: true` and surface in dashboard as a yellow flag.

### 11.10 Version bump — **minor (`3.8.4` → `3.9.0`)**

- **Recommended.** Adds a new agent (`voltron-judge`), a new top-level harness directory, and a new CI workflow. Per CLAUDE.md versioning: "New agent added → minor."

### 11.11 Where the runner runs

- **Recommended.** Inside the Voltron Docker container in CI; on the host for local dev. CI uses `Dockerfile.voltron` for reproducibility; local dev uses Node directly. Both paths reuse the in-container MCP server for AUT dispatches.

### 11.12 Content-hash incremental caching — **enabled by default, results dir is the cache** *(Revision 6)*

- **Recommended.** Every scorecard records a `template_hash` (sha256 of the AUT's `TEMPLATES[<agent>]` entry — content + description + tools + model + name; canonical-JSON-hashed). A scheduled sweep skips any agent whose current hash equals its last passing scorecard's hash (same `rubric_version`); the runner emits a tiny cache-hit scorecard pointing back to the cached result, and does NOT mirror it to `reflections/`. Cost scales with template churn, not template count.
- **Why this works:** the `voltron-evals/results/` directory is already committed to the repo (historical record). Reusing it as the cache means no new artifact store, no S3, no Actions cache — `git pull` brings the cache up to date for the next run.
- **Why the cache key excludes downstream templates:** for sub-managers (e.g. `fullstack-dev`) we deliberately hash only the sub-manager's own entry, not the micro-agents it dispatches. A change to `function-writer` invalidates `function-writer`'s Broad-layer cache; it does NOT auto-invalidate `fullstack-dev`'s. Cross-agent regressions show up in the Deep layer (T2-001, T3-001), where the orchestration flow is end-to-end. The Broad layer is intentionally scoped to the AUT's own contract.
- **What invalidates a cache entry:** any change to `TEMPLATES[<agent>]` content/description/tools/model/name, any bump to a rubric's `rubric_version`, or an explicit `--cache=off` operator override. New agents fail `--doctor` immediately (cache-agnostic check).
- **Alternative considered (rejected):** Actions cache (`actions/cache`). Rejected — the cache key would have to be derived from `src/templates.js` content anyway, and Actions cache has a 7-day eviction policy that would force unnecessary baseline sweeps. The committed `results/` directory has no eviction.
- **Alternative considered (rejected):** dedicated SQLite cache file. Rejected — adds a parsing layer + a new format for `harness-engineer` to ignore. Scorecards-as-cache is zero new surface area.
- **Alternative considered (rejected):** also hash dependent templates (e.g. include all micro-agents in a sub-manager's hash). Rejected — would invalidate massive chunks of the cache on any micro-agent edit, eroding most of the cost savings while adding little signal (downstream effects are exactly what Deep tasks measure).
- **`--cache=off` available for confidence sweeps** before a release or after a programmatic-scorer change that didn't bump a rubric version.

---

## Confirmation

- Plan saved to `/workspace/.voltron/voltron-evals-design.md`.
- Architecture: small `voltron-evals/` directory + thin Node runner + new internal `voltron-judge` agent that emits reflection-shaped scorecards consumed by the existing `harness-engineer` improvement loop. **Two-layer task model**: 7 Deep tasks + 6 shapes × 70 per-agent instances covering every template.
- Key decisions (this revision pass):
  1. Two-layer model with explicit per-agent coverage (Revision 1).
  2. Agents-under-test run on their pinned model tier — no override; judge model is **opus** for quality (Revision 2).
  3. New **`alexandria_usage`** rubric dimension + Alexandria-required Deep task **T2-003** (Revision 3).
  4. CI workflow `voltron-evals.yml` ships in the first PR and chains to `process-reflections.yml` through the filesystem (Revision 4).
  5. Reflection-processing cadence reduced **3×/week → 1×/week** (Monday only) (Revision 5).
  6. **Cost optimization pass (Revision 6):**
     - **Opus judge runs only on the 7 Deep tasks.** The 70 Broad-layer instances are scored entirely by programmatic scorers (§4.4, §6). A shape rubric MAY opt into a single narrow **Haiku** call for a subjective criterion (currently only `sub-manager-delegation` does so); Opus/Sonnet on Broad is schema-rejected.
     - **Content-hash incremental caching (§6.1, §7.6).** Every scorecard records a `template_hash` of the AUT's `TEMPLATES[<agent>]` entry. Scheduled sweeps skip any agent whose hash matches its last passing scorecard. `voltron-evals/results/` is the cache — no new store. `--doctor` is cache-agnostic.
     - **Full-sweep cadence: weekly → monthly.** `voltron-evals.yml` cron changes to `'0 6 1 * *'` (1st of month, 06:00 UTC). `process-reflections.yml` stays weekly (`'0 10 * * 1'`), unchanged from Revision 5 — the two workflows are now independent in cadence as well as in trigger.
- **Cost trajectory:**
  - Prior estimate: $15–25 per sweep, ~$60–100/month at weekly cadence with Opus on every instance.
  - Baseline full sweep (first-ever or `--cache=off`): **~$8–12 (one-time)**.
  - Typical post-baseline monthly sweep (only changed agents re-run): **~$1–3 per sweep**.
  - PR-tier: **~$0.50–1.50 per PR**.
- Open questions for the build phase are scoped to small implementation details; all blocking design questions are in §11 above for human sign-off.
- Invoke `@agent-scrum-master` with this plan to generate a work breakdown for the build phase.
