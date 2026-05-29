# `run_agent_in_docker_batch` — Design Document

**Bead:** voltron-0in (P1)
**Author:** project-planner
**Date:** 2026-05-29
**Status:** Plan only — no implementation in this doc.
**Scope authority:** user-approved 2026-05-29 — *"the run agents in batches option is by far the most acceptable. the tool should be available for all orchestration layers that would launch agents and orchestrators should be encouraged to use batch dispatch anytime there is parallel work."*

---

## 0. Why this tool exists

Verified by `docs/parallel-dispatch-test-design.md` (Tier-A PASS, Tier-B FAIL on 2026-05-28):

- Voltron's downstream stack — MCP SDK Server, `run_agent_in_docker` handler, `ensureVoltronImage`, Docker daemon — is **parallel-safe** when N tool calls arrive concurrently via `Promise.all` through a single `StdioClientTransport`.
- The Claude Code **main session** (the scrum-master slash-command host) **does not** emit multiple `tool_use` blocks against the same MCP server concurrently. Even with strong prompt-engineering directives ("emit ALL dispatches in ONE assistant message"), the empirical signature in `.voltron/logs/` is `A.exit → B.entry` ≈ 2 s — the unmistakable single-round-trip + container respawn pattern. Tier-B reproduced this on a controlled prompt; prompt-only fixes are unreliable.
- **Workaround that bypasses the failure mode entirely:** the orchestrator emits **one** `tool_use` block; the MCP server itself fans out to N parallel containers internally. The client-side serializer never sees more than one outstanding call. Because Voltron's own stack is parallel-safe (Tier-A), the fan-out runs concurrently as intended.

`run_agent_in_docker_batch` is that workaround, productized. It is **additive**: the existing `run_agent_in_docker` (singleton) remains unchanged for genuine single-dispatch cases.

---

## 1. Tool registration + JSON schema

### Tool name

**Chosen:** `run_agent_in_docker_batch`.

Considered:
- `run_agents_in_docker` — shorter, but the singular/plural distinction is easy to mis-read in chat; `_batch` suffix is loud and unmistakable in tool-search output and `list_templates`-style listings.
- `dispatch_batch` — too generic; loses the "what does this actually do?" hint that the `run_agent_in_docker_*` family carries.

The `_batch` suffix also makes the family relationship explicit: the batch tool is the same operation as the singleton, fanned out. Orchestrators that already know one tool can predict the other.

### One-line description (visible to orchestrators in tool listings)

> *Launch 2–8 specialist agents concurrently inside parallel Docker containers — one MCP call, N parallel executions. Prefer this over multiple `run_agent_in_docker` calls when dispatching dependency-free agents; bypasses main-session tool-call serialization.*

### Top-level parameters

```jsonc
{
  "dispatches": [ /* array of dispatch objects, see schema below */ ],
  "fail_fast": false   // optional; default false
}
```

`dispatches` is the load-bearing parameter. `fail_fast` is the only top-level flag. We deliberately do not expose:
- `max_concurrency` — the array length **is** the concurrency. Adding a knob invites pathological inputs (`100 dispatches with concurrency=1`) that contradict the tool's purpose.
- `batch_label` / `tags` — out of scope; orchestrators can prefix the per-dispatch `task` strings themselves.

### Literal JSON Schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["dispatches"],
  "properties": {
    "dispatches": {
      "type": "array",
      "description": "Two to eight independent agent dispatches. Each runs in its own parallel Docker container under the same MCP call. Use this whenever a single tool call would otherwise be followed by another in a separate assistant turn — that emission pattern serializes on the Claude Code main session.",
      "minItems": 2,
      "maxItems": 8,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["agent_name", "task"],
        "properties": {
          "agent_name": {
            "type": "string",
            "description": "The agent template name (e.g., 'fullstack-dev', 'csharp-dev', 'qa-tester'). Must exist in TEMPLATES with category=='agent'."
          },
          "task": {
            "type": "string",
            "description": "Complete task description for this dispatch, including context, file paths, acceptance criteria, and any outputs from prior tasks."
          },
          "max_turns": {
            "type": "number",
            "description": "Maximum agent turns for this dispatch. Default: 30.",
            "minimum": 1
          },
          "model": {
            "type": "string",
            "enum": ["opus", "sonnet", "haiku"],
            "description": "Model tier override for this dispatch. Priority: explicit > template.model > session default."
          }
        }
      }
    },
    "fail_fast": {
      "type": "boolean",
      "description": "When true, on the first failed dispatch attempt to terminate pending containers and short-circuit the batch. When false (default), all dispatches run to completion and each result is reported independently.",
      "default": false
    }
  }
}
```

### Bounds rationale

| Bound | Value | Rationale |
|---|---|---|
| `minItems` | 2 | A batch of 1 is just `run_agent_in_docker` with extra overhead and confused orchestrator semantics. Refuse it at the schema layer rather than silently fall through. The handler also validates this (defense in depth). |
| `maxItems` | 8 | Each container starts a full `claude` CLI + Docker overhead. Local observations during voltron-9yw and parallel-dispatch testing show four concurrent containers stay well within a developer laptop's CPU/RAM budget; eight is the upper bound before Docker daemon contention (`docker info` shows `concurrent-containers` defaults around `max` only on server-class hosts). 8 is conservative for laptops, generous for what scrum-master decompositions actually produce (most waves are 2–4). |
| `max_turns.minimum` | 1 | The existing singleton has no lower bound but accepts arbitrary numbers. Adding `minimum: 1` is cheap defense against `0` / negative inputs. |

If a future caller needs > 8, the answer is **two batches**, not a larger schema cap. That keeps the failure surface tractable and aligns with the empirically-tested concurrency band.

---

## 2. Return shape

### Decision: single MCP `content` block, markdown-formatted, with per-dispatch sections

The MCP `tools/call` response must follow `{ content: [{ type: "text", text: "..." }] }`. We do **not** return one `content` element per dispatch:
- The MCP SDK does not guarantee that consumers (Claude Code main session) preserve element ordering across MCP content blocks.
- Existing tool consumers expect a single markdown text body. Mirroring that shape avoids client-side surprises.

We emit a single markdown body that the model reads as one tool result, with N clearly-labelled sections.

### Shape

```text
## Batch dispatch — N agents (batch_id: <id>)

| # | agent | status | log |
|---|---|---|---|
| 1 | fullstack-dev | ✅ ok (exit 0) | `.voltron/logs/fullstack-dev-<TS>.log` |
| 2 | csharp-dev    | ❌ FAILED (exit 1) | `.voltron/logs/csharp-dev-<TS>.log` |
| 3 | qa-tester     | ✅ ok (exit 0) | `.voltron/logs/qa-tester-<TS>.log` |

Wall time: 142s. Cancelled: 0. fail_fast: false.

---

### [1] Agent fullstack-dev completed ✅
#### Progress Trail
```
[entry] 2026-05-29T...
[STEP 1] ...
[DONE] ...
[exit] 2026-05-29T... code=0
```
#### Output Tail (last 40 lines — full output in log)
```
<bounded tail>
```
Log: `.voltron/logs/fullstack-dev-<TS>.log`

---

### [2] Agent csharp-dev FAILED (exit 1)
#### Progress Trail
```
...
```
#### Output Tail (last 40 lines)
```
<bounded tail>
```
#### Stderr
```
<bounded stderr — last 20 lines>
```
**Error:** <short>
Log: `.voltron/logs/csharp-dev-<TS>.log`

---

### [3] Agent qa-tester completed ✅
... same shape as [1] ...
```

### Bounded output (token-budget hygiene)

The singleton's success/failure return already truncates at last-80-lines (after `voltron-3y0`). For a batch:

| Element | Per-dispatch bound | Why tighter than singleton |
|---|---|---|
| `Output Tail` | last **40 lines** | The model gets N tails in one tool result; budgeting 80 each + summary table + headers explodes context. |
| `Progress Trail` | unchanged (all `[STEP N]` + `[DONE]` + wrapper breadcrumbs) | Trail is already filtered to short structured lines; multiplying it by N stays within budget. |
| `Stderr` | last **20 lines**, failure cases only | Stderr is suppressed on success. On failure, 20 lines is enough to surface the first proximate cause; full stderr lives in the log file. |

Per-dispatch budget target: **≤ 800 tokens of tail/stderr text**, **≤ 200 tokens of trail/header**. Eight dispatches × 1000 tokens ≈ 8000 tokens — well under the ~25k single-tool-result budget Anthropic's SDK trims at, with substantial headroom for the summary table and result framing.

### Top-of-body summary table

Required. It is the single most-scanned region of a batch result. Must contain at minimum:
- Dispatch index (matches `dispatches[i]` order in the request)
- `agent_name`
- Success/failure marker + exit code
- Log path (clickable in Claude Code chat)

Wall time and `fail_fast` flag follow the table so orchestrators can immediately see whether early termination ran.

### No separate `batch_id` field for now

A `batch_id` is included in the markdown header (`Date.now().toString(36)` + 4 random hex bytes — same scheme as the test harness run-id). It is **not** parsed out into a structured top-level field. If a future caller needs programmatic access, we add it as a JSON code fence at the end of the body — same pattern as the harness-engineer handoff JSON.

---

## 3. Error semantics

### Default behavior: `fail_fast: false`

Every dispatch runs to completion. Each is reported with its own `status` (ok / failed / cancelled / spawn-error). The batch tool itself never throws to the orchestrator unless the entire MCP call fails (e.g. validation, image build, no Dockerfile) — those are surfaced as a `content` block that begins with `❌` and contains a clear error message, no per-dispatch sections.

**Aggregate exit semantics for the MCP response:**
- All dispatches succeeded → success-shaped body (no leading ❌).
- At least one dispatch failed but the rest succeeded → success-shaped body (the response IS a successful batch result); the table marks failures with ❌ and each failed section carries its own error block. Rationale: the MCP call itself didn't fail — N agents ran, N results came back, and the orchestrator decides what to do.
- The batch tool itself failed pre-fan-out (image build, no Dockerfile, schema validation passed but `agent_name` unknown for one entry — see below) → leading `❌` and no per-dispatch sections.

### Per-dispatch failure isolation

Each dispatch's failure must not affect the others. Concretely:
- Per-dispatch temp-file paths already collision-safe (`Date.now()` + agent_name — `src/index.js:1814–1820`).
- Per-dispatch container names already collision-safe (`Date.now()` + safe agent name — `src/index.js:1846–1850`).
- Per-dispatch log filenames already collision-safe — same mechanism.
- The shared `container-mcp.json` write (`src/index.js:1929–1941`) is idempotent and writes identical content per `voltron-9yw` notes; concurrent writers are safe.

These guarantees come for free by reusing the existing per-call infrastructure inside the fan-out.

### `fail_fast: true` semantics

When set:
1. The batch handler keeps a list of `AbortController`s, one per dispatch.
2. On the first dispatch resolving with `status !== 0`, the handler:
   - Calls `controller.abort()` on every still-pending dispatch.
   - Each spawned process catches the abort signal and calls `proc.kill('SIGTERM')` (matching the existing 10-minute-timeout `proc.kill()` path at `src/index.js:2087, 2094`).
   - Pending containers receive a SIGTERM; their `proc.on("close")` fires; they return with `status: "cancelled"` (a new status value, NOT the `1` that real failures use, so the orchestrator can distinguish them).
3. The summary table marks cancelled rows: `🟡 cancelled (sibling failed)`. The per-section body shows partial output up to cancellation.

`fail_fast` is opt-in because the default expectation for scrum-master-style dispatch is "run all the parallel work; failure of one task should not waste the others' progress." `fail_fast: true` is for tightly-coupled batches where one failure invalidates the others (e.g. a multi-file refactor coordinated across files — `committer` shouldn't commit when typecheck-runner reports errors on a sibling task).

### Unknown agent / template validation

The handler validates each dispatch's `agent_name` against `TEMPLATES` **before** spawning anything:
- If all are valid → fan-out proceeds.
- If any are invalid → return one `❌` content block listing the invalid entries; do not spawn any containers. This is the same posture as the singleton (refuses on unknown agent) — applied at the batch boundary.

Pre-spawn validation also covers: `agent_name === "scrum-master"` refusal (the singleton already refuses this at line 1765), nesting-depth cap (line 1726, `VOLTRON_DEPTH >= 3`), and missing `VOLTRON_HOST_ROOT` on nested batches (line 1740). These are batch-level refusals because they would fire identically for every dispatch anyway; failing the whole batch upfront is cleaner.

### Per-dispatch progress notifications (`[STEP N]` lines)

The MCP server already multiplexes `sendLoggingMessage` per dispatch with `[<agent_name>] ` prefixing at `src/index.js:2048, 2080`. The batch tool preserves this — each dispatch's stdout stream produces its own prefixed lines, interleaved naturally in the orchestrator's live notification stream. Orchestrators see:

```
[fullstack-dev] [STEP 1] reading routes
[csharp-dev]    [STEP 1] scanning compile errors
[qa-tester]     [STEP 1] enumerating test files
[csharp-dev]    [STEP 2] dispatching type-error-reader
[fullstack-dev] [STEP 2] dispatching route-adder
...
```

No additional plumbing required. The fan-out is *literally* N invocations of the existing per-dispatch logic.

---

## 4. Implementation hooks in `src/index.js`

> This section is read by the harness-engineer at implementation time. It does **not** prescribe a code patch; it identifies the anchors and the refactor shape so the implementer can plan a clean change.

### 4a. The refactor that enables the fan-out

Today, `src/index.js:1722–2162` is one monolithic async handler. To reuse its logic from a batch tool, the per-dispatch body needs to be hoistable into a named function. The clean factoring:

```
async function runSingleDispatch({ agent_name, task, max_turns, model }, opts) {
  // exactly the body of the current handler, parameterized on:
  //   - cwd (resolved once at batch entry)
  //   - imageResult (passed in — image already ensured by caller)
  //   - opts.abortSignal (new; respected by the spawn() call's signal option)
  //   - opts.depthEnv (currentDepth + isNested, computed once at batch entry)
  // returns { ok: boolean, status: number, content: string, logPath: string,
  //           agent_name, agent_index } — pre-formatted markdown for one section
}
```

The existing single-dispatch tool wraps `runSingleDispatch` with the validation it already does (image ensure, cwd detection, depth check) and the per-dispatch fan-out is the same wrap minus the duplicated validation.

Key existing anchors that move into `runSingleDispatch`:
- `src/index.js:1749` — `detectProjectRoot` (move to caller; pass cwd in).
- `src/index.js:1752–1762` — template lookup. Stay inside per-dispatch (each has its own `agent_name`).
- `src/index.js:1765–1772` — scrum-master refusal. Stay inside per-dispatch (same reason).
- `src/index.js:1777–1782` — model resolution. Stay inside per-dispatch.
- `src/index.js:1785–1790` — `CLAUDE.md` read. Move to caller; read **once** per batch and pass the string in (it's identical for all dispatches in the batch).
- `src/index.js:1797–1811` — prompt composition. Stay inside per-dispatch (each composes its own).
- `src/index.js:1814–1821` — temp file write. Stay inside per-dispatch.
- `src/index.js:1824–1844` — Docker checks + `ensureVoltronImage`. **Move to caller; do once per batch.**
- `src/index.js:1846–1852` — log infrastructure. Stay inside per-dispatch.
- `src/index.js:1854 onwards` — docker spawn + result construction. Stay inside per-dispatch.

### 4b. Batch handler outline (pseudocode, not implementation)

```
server.tool("run_agent_in_docker_batch", description, schema, async ({ dispatches, fail_fast }) => {
  // 0. Pre-fan-out validation (depth cap, host-root, etc.)
  // 1. Resolve cwd once
  // 2. Read CLAUDE.md once
  // 3. Check Docker availability once
  // 4. ensureVoltronImage once
  // 5. Validate every agent_name against TEMPLATES; if any invalid, return ❌
  // 6. Validate fail_fast type if present (already covered by schema)
  // 7. const controllers = dispatches.map(() => new AbortController())
  // 8. Fan-out:
  //      const results = await Promise.all(dispatches.map((d, i) =>
  //        runSingleDispatch(d, { cwd, claudeMd, imageResult, ... },
  //                              { abortSignal: controllers[i].signal,
  //                                onResult: (status) => {
  //                                  if (fail_fast && status !== 0) {
  //                                    controllers.forEach((c, j) => { if (j !== i) c.abort(); });
  //                                  }
  //                                } })
  //      ));
  // 9. Assemble batch content body (summary table + N per-dispatch sections)
  // 10. Return { content: [{ type: "text", text: body }] }
});
```

Notes:
- `ensureVoltronImage` is called once at step 4. Voltron 9yw has already made it async (`execFileAsync` at line 129), so there is no longer an event-loop block — even a one-shot image-build path inside a batch is safe to await.
- The image-result is passed into each `runSingleDispatch`, which **skips** its own image check. This eliminates N redundant `docker image inspect` calls during the fan-out.
- `Promise.all` is the right primitive. The Voltron handler is structurally parallel-safe (verified Tier-A 2026-05-28). The MCP server's request-handling loop services exactly one tool call here (the batch one) so the FIFO at the client layer is bypassed.
- `proc.spawn` already supports `signal: controller.signal` (Node 16+). When the signal fires, Node SIGTERMs the child process and the existing `proc.on("close")` resolver catches the exit. The cancellation path therefore inherits all the existing cleanup (timer clear, stdout buffer flush, log line written). No new resolver logic needed beyond mapping `signal: SIGTERM` to a `cancelled` status.

### 4c. Tool registration anchor

Register the new tool **immediately after** the existing `run_agent_in_docker` registration (after line 2163). Keeps the family visually adjacent in source and in any generated tool-table doc.

### 4d. Side-effect: do not break the singleton

The singleton's handler stays. The refactor extracts `runSingleDispatch` and the singleton calls it. The behavioral contract on the singleton's return remains identical (same `## Agent <name> completed ✅` framing, same 80-line tail, same `Log: \`.voltron/logs/...\`` footer). Tests that pattern-match on the singleton's output keep passing.

---

## 5. Template updates (which agents, what changes)

The user's directive: *"the tool should be available for all orchestration layers that would launch agents and orchestrators should be encouraged to use batch dispatch anytime there is parallel work."*

Below: which templates need updating, the exact section to add or modify, and literal example text the harness-engineer should drop into each.

### 5a. `scrum-master` slash-command + template — `src/templates.js:741` (template) + `.claude/commands/scrum-master.md` (deployed mirror)

**Edit target 1:** `src/templates.js:890–894` — the "Parallel execution — MANDATORY emission rule:" paragraph.

Replace the **primary instruction** so the new tool is the first-class path. Old multi-block emission becomes the fallback for environments without the batch tool.

Literal replacement text (paste verbatim into the template content):

```
**Parallel execution — MANDATORY rule:**

Whenever \`bd ready --json\` returns more than one ready ID (and the IDs are dependency-free), dispatch them via a SINGLE \`run_agent_in_docker_batch\` call — one batch entry per ready ID. The batch tool fans out internally to N parallel Docker containers and bypasses the main-session tool-call serializer (root cause: \`docs/parallel-dispatch-investigation.md\`; mitigation: \`docs/run-agents-batch-design.md\`).

**Decision rule:**
- 1 ready ID → \`run_agent_in_docker\` (singleton).
- 2–8 ready IDs → \`run_agent_in_docker_batch\` with one entry per ID.
- 9+ ready IDs → multiple sequential \`run_agent_in_docker_batch\` calls, batching up to 8 per call (the schema cap). Do not emit nine single-call \`tool_use\` blocks in one message — that recreates the regression.

The pre-batch multi-\`tool_use\` emission pattern is the FALLBACK ONLY. Use it only if \`run_agent_in_docker_batch\` is unavailable (e.g. on an older voltron-agent image). Confirm availability with \`list_templates\`-style inspection at session start if uncertain.
```

**Edit target 2:** `src/templates.js:898–915` — the Correct/Incorrect example block.

Replace with a batch-first example:

```
✅ CORRECT — one assistant message, one \`run_agent_in_docker_batch\` tool_use:
\`\`\`
Assistant turn:
  tool_use: run_agent_in_docker_batch({
    dispatches: [
      { agent_name: "csharp-dev",    task: "..." },
      { agent_name: "shader-artist", task: "..." },
      { agent_name: "asset-manager", task: "..." }
    ]
  })
→ all three containers start within ~1 second of each other; one tool result returns when all three exit.
\`\`\`

❌ INCORRECT — N tool_use blocks emitted across separate assistant turns (sequential):
\`\`\`
Assistant turn 1: tool_use: run_agent_in_docker(agent="csharp-dev", ...)
   ← waits for tool_result before next turn
Assistant turn 2: tool_use: run_agent_in_docker(agent="shader-artist", ...)
   ← waits for tool_result before next turn
Assistant turn 3: tool_use: run_agent_in_docker(agent="asset-manager", ...)
→ each agent's [entry] lags the previous [exit] by ~2 seconds. Wall time = sum of individual durations.
\`\`\`

⚠ ACCEPTABLE FALLBACK — when run_agent_in_docker_batch is unavailable: one assistant message, N \`run_agent_in_docker\` tool_use blocks. The main-session serializer empirically delivers SEQUENTIAL behavior here too (see voltron-ufu lineage); use only as last resort.
```

**Edit target 3:** `src/templates.js:921–979` — the "Parallel Dispatch Contract" section.

Update the subhead to reflect that the contract is now satisfied by the batch tool, with the multi-block emission as the secondary path. Specifically rewrite §"The single-message emission pattern (the contract)" (lines 930–939) to:

```
#### The batch-dispatch contract (current — preferred)

When \`bd ready --json\` returns 2 or more dependency-free IDs:

1. Collect ALL ready bead IDs into a local list (do not iterate yet)
2. In your very next assistant message, emit ONE \`run_agent_in_docker_batch\` tool_use with one entry in \`dispatches\` per bead
3. Wait for the single batch tool_result; parse the per-dispatch summary table to find failures
4. Close successes, mark failures blocked, loop back to step 1

The batch tool is the primary path because it is empirically immune to the main-session serializer (verified Tier-B 2026-05-28 — multi-block emission still serialized despite explicit prompting).

#### Multi-block emission (fallback — historical contract)

[keep the existing multi-block example as the fallback documentation, with a leading note: "Use only when run_agent_in_docker_batch is unavailable."]
```

**Edit target 4:** `src/templates.js:1289–1297` — the Execution Loop (also mirrored in `.claude/commands/scrum-master.md`).

Update step 2 to call out the batch tool first. Replacement text:

```
2. **Emit ONE \`run_agent_in_docker_batch\` tool_use covering ALL ready IDs in your very next assistant message — batch = parallel, automatic.** Each entry in \`dispatches\` maps to one bead. If only one ID came back, use the singleton \`run_agent_in_docker\` for that one. (Companion \`update_progress(in_progress)\` calls may be batched into the same outgoing message or the one just before.) If \`run_agent_in_docker_batch\` is unavailable on this Voltron version, fall back to one \`run_agent_in_docker\` tool_use per ID in a single message — and verify post-hoc that they actually parallelized.
```

### 5b. `csharp-dev` — `src/templates.js:2002`

**Edit target:** add a "Parallel sub-chain dispatch" subsection between "Composition Recipes" (line 2092) and the bold paragraph at line 2108. The Composition Recipes table itself stays unchanged — recipes are sequential by design (their arrows mean data flow). The new section explains how to dispatch **independent chains** in parallel.

Literal text to insert:

```
### Parallel Sub-Chain Dispatch

When you need to run multiple independent recipes in the same wave (e.g., the user asks for "three new MonoBehaviours: PlayerMover, EnemySpawner, ScoreManager"), dispatch all three writers in ONE \`run_agent_in_docker_batch\` call rather than serially. The chains' validators (build-runner, test-runner) come after as a separate batch once all writers complete.

Literal example for the three-MonoBehaviour case:

\`\`\`
tool_use: run_agent_in_docker_batch({
  dispatches: [
    { agent_name: "csharp-script-writer", task: "Create Assets/Scripts/Gameplay/PlayerMover.cs with anchor namespace AcmeCo.Gameplay; class implements IMovable; SerializeField _speed = 5f. Acceptance: file at exact path, namespace matches CLAUDE.md, compiles in next build pass." },
    { agent_name: "csharp-script-writer", task: "Create Assets/Scripts/Gameplay/EnemySpawner.cs with anchor namespace AcmeCo.Gameplay; ScriptableObject reference _enemyConfig; spawns from object pool. Acceptance: file at exact path, ScriptableObject ref via SerializeField." },
    { agent_name: "csharp-script-writer", task: "Create Assets/Scripts/Gameplay/ScoreManager.cs with anchor namespace AcmeCo.Gameplay; static event OnScoreChanged(int). Acceptance: file at exact path, event uses Action pattern not UnityEvent." }
  ]
})
\`\`\`

After all three resolve, dispatch the validation wave:

\`\`\`
tool_use: run_agent_in_docker_batch({
  dispatches: [
    { agent_name: "build-runner", task: "dotnet build the Unity project — report any new compile errors in the three files created in the prior wave." },
    { agent_name: "test-runner",  task: "Run the test suite; flag any regressions introduced by the new scripts." }
  ]
})
\`\`\`

**Rule of thumb:** if your sub-chain has 2+ steps that do not consume each other's output, batch them. The Composition Recipes table tells you which steps are sequential (arrows = data flow); everything else is a candidate for parallelization.
```

### 5c. `fullstack-dev` — `src/templates.js:3123`

**Edit target:** add the same "Parallel Sub-Chain Dispatch" subsection between "Composition Recipes" (line 3211) and the bold paragraph at line 3229.

Literal text:

```
### Parallel Sub-Chain Dispatch

When the task decomposes into multiple independent writer chains in the same wave (e.g., "add three API routes: /api/users, /api/teams, /api/projects"), dispatch all writers in ONE \`run_agent_in_docker_batch\` call. Validators (typecheck-runner, lint-runner, test-runner) come after as a separate batch once all writers complete.

Literal example:

\`\`\`
tool_use: run_agent_in_docker_batch({
  dispatches: [
    { agent_name: "route-adder", task: "Add GET/POST /api/users handlers to server/src/routes/users.ts at anchor 'export const usersRouter ='. Request/response types in server/src/types/user.ts. Acceptance: tsc clean, route registered in index.ts." },
    { agent_name: "route-adder", task: "Add GET/POST /api/teams handlers to server/src/routes/teams.ts at anchor 'export const teamsRouter ='. Types in server/src/types/team.ts. Acceptance: tsc clean, route registered in index.ts." },
    { agent_name: "route-adder", task: "Add GET/POST /api/projects handlers to server/src/routes/projects.ts at anchor 'export const projectsRouter ='. Types in server/src/types/project.ts. Acceptance: tsc clean, route registered in index.ts." }
  ]
})
\`\`\`

Then dispatch the validation batch:

\`\`\`
tool_use: run_agent_in_docker_batch({
  dispatches: [
    { agent_name: "typecheck-runner", task: "Run npm run typecheck; report errors. Acceptance: zero TypeScript errors." },
    { agent_name: "test-runner",      task: "Run npm test for server/; report failures." },
    { agent_name: "url-route-matcher", task: "Verify each new route is reachable from the client hooks in src/hooks/." }
  ]
})
\`\`\`

**Rule of thumb:** if a sub-chain has 2+ steps with no data dependency, batch them. Arrows in the Composition Recipes table = data flow; everything else can run in parallel.
```

### 5d. `devops-engineer` — `src/templates.js:3421`

**Edit target:** insert a "Parallel Sub-Chain Dispatch" subsection after the "Composition Recipes" table at `src/templates.js:3524` (right before the "You are the sub-manager…" bold paragraph at line 3525).

Literal text:

```
### Parallel Sub-Chain Dispatch

When the task decomposes into independent config/yaml/dockerfile changes (e.g., "set up CI for three services"), dispatch the writers in ONE \`run_agent_in_docker_batch\` call. Validators (build-runner, security-scanner) come after.

Literal example:

\`\`\`
tool_use: run_agent_in_docker_batch({
  dispatches: [
    { agent_name: "ci-workflow-writer", task: "Create .github/workflows/api-ci.yml — jobs: build, test, deploy-staging. Trigger on push to main affecting services/api/**." },
    { agent_name: "ci-workflow-writer", task: "Create .github/workflows/web-ci.yml — jobs: build, lint, test, deploy. Trigger on push to main affecting services/web/**." },
    { agent_name: "dockerfile-editor",  task: "Update services/api/Dockerfile to multi-stage build; add npm prune --omit=dev in the runtime stage." }
  ]
})
\`\`\`

Then dispatch validators:

\`\`\`
tool_use: run_agent_in_docker_batch({
  dispatches: [
    { agent_name: "build-runner",     task: "docker build services/api/ — confirm new Dockerfile produces a working image." },
    { agent_name: "security-scanner", task: "Run security scan on the three changed files; report any new findings." }
  ]
})
\`\`\`

**Rule of thumb:** independent service configurations are the canonical batch case here. Always batch them.
```

### 5e. `qa-tester` — `src/templates.js:4031`

**Edit target:** insert a "Parallel Sub-Chain Dispatch" subsection between Composition Recipes (line 4119) and the "You are the sub-manager…" paragraph at line 4138. Note that the "Full QA pass" recipe in the existing table (`typecheck-runner + test-runner + lint-runner + security-scanner + accessibility-auditor`) is the natural example.

Literal text:

```
### Parallel Sub-Chain Dispatch — Full QA Pass

The "Full QA pass" recipe (above) is the canonical batch target. The five validators are mutually independent and should NEVER be run serially — they share no state, write no files, and can produce evidence in any order. Dispatch as a single batch:

\`\`\`
tool_use: run_agent_in_docker_batch({
  dispatches: [
    { agent_name: "typecheck-runner",       task: "Run tsc --noEmit on the project. Report any type errors. Acceptance: zero errors." },
    { agent_name: "test-runner",            task: "Run npm test. Report any failures with the relevant test file paths." },
    { agent_name: "lint-runner",            task: "Run npm run lint. Report errors (block) and warnings (review)." },
    { agent_name: "security-scanner",       task: "Run security scan. Report any new HIGH/CRITICAL findings." },
    { agent_name: "accessibility-auditor",  task: "Run accessibility audit on src/components/. Report any new WCAG violations." }
  ]
})
\`\`\`

Wall time for the full pass drops from sum-of-runtimes (typically 8–12 min sequentially) to max-of-runtimes (typically 2–3 min). This is the highest-leverage batch use case in the project.

**Rule of thumb:** any audit/validation wave is parallel by definition. If you find yourself dispatching test-runner and lint-runner in separate calls, stop — batch them.
```

### 5f. `scene-architect` — `src/templates.js:1772`

**Edit target:** insert a "Parallel Sub-Chain Dispatch" subsection after the existing Composition Recipes section at scene-architect line offset 78 (i.e. roughly `src/templates.js:~1850`; the implementer should locate by header text rather than absolute line because scene-architect's content is long).

Note: scene-architect's primary mode is Editor work (Coplay MCP), which already runs synchronously through the Agent tool — those calls cannot batch through `run_agent_in_docker_batch`. The batch opportunity here is the **Docker-side** sub-work (C# file edits, asset folder structure, manifest updates) that scene-architect dispatches to other sub-managers.

Literal text:

```
### Parallel Sub-Chain Dispatch (Docker side)

Editor operations (Coplay MCP calls) run synchronously through the Agent tool and CANNOT be batched. But the Docker-side work scene-architect delegates — C# edits, asset folder structure, manifest edits — is parallel-eligible.

When you need to dispatch multiple independent sub-manager tasks in the same wave (e.g., "csharp-dev adds a Controller, asset-manager scaffolds the textures folder, shader-artist patches the shader file"), batch them:

\`\`\`
tool_use: run_agent_in_docker_batch({
  dispatches: [
    { agent_name: "csharp-dev",       task: "[full task description for sub-manager, including the micro-agent chain to compose]" },
    { agent_name: "asset-manager",    task: "[task — scaffold Assets/Textures/Enemies/ with the four PNG slots described in the work plan]" },
    { agent_name: "shader-artist",    task: "[task — patch Shaders/Toon.shader to add the rim-light pass — file edits only, not Editor preview]" }
  ]
})
\`\`\`

**Rule of thumb:** Editor work goes through Agent tool, one at a time. File-only Docker work goes through \`run_agent_in_docker_batch\` whenever 2+ independent tasks are in flight.
```

### 5g. Other orchestration layers (no template change needed)

- `harness-engineer` is single-task by design (it owns the Voltron sources sequentially and edits monolithically). Adding a batch directive would invite parallel edits to overlapping files. **No change.**
- `project-planner` (this agent) does not dispatch. **No change.**
- `researcher` does not dispatch. **No change.**

If the user later asks for batch directives in other sub-managers (e.g. `data-modeler`, `cli-engineer`), apply the same template-update pattern: a "Parallel Sub-Chain Dispatch" subsection right after "Composition Recipes", with a stack-appropriate worked example.

---

## 6. Verification test addition

### Decision: a separate file `scripts/test-parallel-dispatch-batch.mjs`, modeled on `scripts/test-parallel-dispatch.mjs`

Considered: adding a `--batch` flag to the existing script. Rejected because:
- The existing script exists to verify the singleton's parallel-safety via `Promise.all`. Conflating it with the batch verification muddies what's being measured.
- A failing run of one script doesn't tell us whether the singleton OR the batch tool regressed.
- The two scripts share parsers — extract them to a small helper module (`scripts/lib/dispatch-parser.mjs`) and import from both rather than fold the test logic together.

### What the new script does

```text
1. Open StdioClientTransport to local src/index.js
2. Pre-warm voltron-agent image (call run_agent_in_docker once with a cheap probe)
3. Generate a unique run-id
4. Call run_agent_in_docker_batch ONCE with two probe dispatches:
     dispatches: [
       { agent_name: "dep-reader",       task: <PROBE A prompt with run-id>, max_turns: 8 },
       { agent_name: "git-state-reader", task: <PROBE B prompt with run-id>, max_turns: 8 }
     ]
5. Wait for the single tool result
6. Parse .voltron/logs/dep-reader-*.log and git-state-reader-*.log for run-id match
7. Classify with the same parser the singleton test uses (entry_skew < 5s, overlap >= 60s, etc.)
8. Exit 0=PASS, 1=FAIL_SEQUENTIAL, 2=INCONCLUSIVE
```

### Probe prompts: literally identical to the singleton test

The probe prompts are unchanged from `scripts/test-parallel-dispatch.mjs` (the `buildProbePrompt` function at lines 25–47). Reuse via a shared module so any future probe-prompt refinement applies to both tests.

### Classifier: literally identical

Use `scripts/lib/dispatch-parser.mjs` (newly extracted from the singleton test's `findLog`, `parseEntryExit`, `classify`). Same thresholds, same verdict semantics. A PASS from the batch test means: "the batch tool's internal fan-out is parallel-safe and produces the same timing signature as `Promise.all` over two singleton calls."

### What this test guards against (regression matrix)

| Regression | Detected by singleton test | Detected by batch test |
|---|---|---|
| `ensureVoltronImage` becomes sync again | YES (slow first call masks; pre-warm makes it visible on second) | YES (same path) |
| `run_agent_in_docker` handler grows a shared lock | YES | YES (handler is shared) |
| Batch tool serializes internally (e.g. `for…of await`) | NO | **YES — this is the unique guard** |
| Batch tool ignores `dispatches[i].max_turns` | NO | YES (probe asserts on completed `[exit]` line) |
| Batch tool returns malformed content | NO | YES (parser fails to find logs) |

The batch test is therefore both a regression guard AND the localization gate that `docs/parallel-dispatch-test-design.md` §5 called for: with the batch tool in place, a green Tier-A singleton + a green batch test confirms that the only remaining failure mode is the main-session emission layer, which the batch tool sidesteps entirely.

### `package.json` exposure

Add a script in the same PR as the test:

```json
"scripts": {
  "test:parallel-dispatch": "node scripts/test-parallel-dispatch.mjs",
  "test:parallel-dispatch-batch": "node scripts/test-parallel-dispatch-batch.mjs",
  "test:parallel": "npm run test:parallel-dispatch && npm run test:parallel-dispatch-batch"
}
```

CI runs `npm run test:parallel` on every PR that touches `src/index.js`.

### Acceptance for the new test (block on harness-engineer)

- `node scripts/test-parallel-dispatch-batch.mjs` exits 0 on a clean main with the batch tool deployed.
- It exits 1 (FAIL_SEQUENTIAL) if a deliberately-introduced serialization point (e.g. replace `Promise.all` with `for…of await`) is added to the batch handler — the test must be sensitive enough to flag this.
- It exits 2 (INCONCLUSIVE) if the voltron-agent image is missing or the dispatch never reaches `[entry]` — never produces a false PASS or false FAIL in those cases.

---

## 7. Backward compatibility + deprecation policy

### `run_agent_in_docker` (singleton) stays

The singleton is **not** deprecated. Reasons:
- The schema disallows `dispatches.length === 1`. If the singleton went away, every single-call site would be forced through a 2-min-length batch (impossible) or a maxItems-relaxed batch (defeats the bound rationale).
- Existing direct callers (the singleton test, any external callers of the MCP server, all current template guidance not yet migrated) continue to work unchanged.
- The singleton is the natural form for single-task dispatch from sub-managers — a `csharp-dev` dispatching one `csharp-script-writer` should use the singleton, not wrap it in a batch.

### The two coexist; template guidance picks which based on N

| N independent ready/dispatch tasks | Tool to use |
|---|---|
| 1 | `run_agent_in_docker` (singleton) |
| 2–8 | `run_agent_in_docker_batch` |
| 9+ | multiple sequential `run_agent_in_docker_batch` calls, ≤8 each |

This is the contract every orchestrator template (§5) now teaches.

### Why not mutually exclusive

A "batch-only" world would force the singleton to disappear, which:
- Breaks the existing test harness and CI.
- Forces single-call sites to either fake a 2-batch (impossible) or accept slower schema validation.
- Forces sub-managers that dispatch one micro-agent at a time to go through the batch tool — adding cognitive overhead for no parallelism benefit.

Mutual exclusion would be the wrong call. They coexist, the schema enforces the boundary (`minItems: 2`), and each tool's description in the MCP-listing makes the distinction obvious to the orchestrator at call time.

### Long-term

If empirical evidence later shows that the singleton is exclusively misused (orchestrators always have ≥ 2 tasks), we can revisit. That decision belongs to a future bead, not this design. For now, both ship.

---

## 8. Open questions for human input

These need user decision before the harness-engineer can implement. The defaults below are the planner's recommendation if the user prefers no decision.

1. **Tool name confirmation.** `run_agent_in_docker_batch` vs `run_agents_in_docker` vs `dispatch_agents`. **Default: `run_agent_in_docker_batch`** (rationale in §1). If the user prefers `run_agents_in_docker` for terseness, all template examples in §5 swap trivially.
2. **Max batch size.** `maxItems: 8` is conservative for laptops and generous for actual dispatch waves. **Default: 8.** If the user runs on a server-class host and expects 12-agent QA passes, they may want 16.
3. **Default `fail_fast` value.** Default `false` (per §3 — scrum-master-style "don't waste work" semantics). **Default: false.** If the user prefers tighter-coupled semantics, set `true`.
4. **`fail_fast` field at all?** Skipping it ships a simpler tool. The cost is real for QA-style "all-or-nothing" batches that the orchestrator currently has to model as N separate try/catches. **Recommend: ship with `fail_fast`.**
5. **Per-dispatch tail size.** §2 sets 40 lines. If users hit token-budget warnings on 8-agent batches, drop to 30. **Default: 40.**
6. **Feature-flag the new tool initially?** No. The tool is additive, schema-safe, and the singleton continues to work. **Default: ship unflagged at v3.13.0** (minor bump per CLAUDE.md "new agent or tool" rule — though this is a new tool, not a new agent; if the rule wants tighter mapping, treat as a patch).
7. **Singleton deprecation timeline?** §7 says they coexist permanently. **Default: no deprecation.** Revisit only if usage data later shows the singleton becomes legacy.
8. **Cancellation semantics: SIGTERM vs SIGKILL?** §3 specifies SIGTERM (graceful, matches the existing 10-minute-timeout `proc.kill()` path). If the user wants harder kills on fail_fast, they can set the signal to `SIGKILL`. **Default: SIGTERM.**

---

## Acceptance checklist for THIS design document

A reviewer can mark this design "complete" when:

- [x] §1 — tool name chosen with rationale; literal JSON Schema with min/max array bounds and per-item schema.
- [x] §2 — return shape decided (single content block, markdown body with summary table + N per-dispatch sections); per-dispatch tail bound specified (40 lines) with token-budget rationale.
- [x] §3 — `fail_fast` default specified (false); per-dispatch failure isolation explained; pre-fan-out validation defined; per-dispatch `[STEP N]` notification path preserved.
- [x] §4 — implementation anchors in `src/index.js` cited by line; refactor shape sketched (`runSingleDispatch` extraction); pseudocode given; image-build-once call site identified.
- [x] §5 — every orchestration template needing an update is named with its source line; literal text to insert is provided for each.
- [x] §6 — verification test file named, modeled on the existing harness, parser-reuse strategy explained, sensitivity criteria specified.
- [x] §7 — backward-compat posture decided (coexistence, no deprecation).
- [x] §8 — open questions enumerated with planner-default recommendations.

## DO NOT (binding on the harness-engineer)

- DO NOT implement during this design phase. The only artifact this design produces is `docs/run-agents-batch-design.md` itself.
- DO NOT bump `package.json` from this PR. The implementation bead bumps the version once the tool ships.
- DO NOT edit `src/index.js` or `src/templates.js` from this PR. The anchors and replacement text are for the implementation PR.
- DO NOT relax the `minItems: 2` schema bound to accept singleton batches. Use the singleton tool for that case.
- DO NOT change the per-dispatch return shape to differ from the singleton's framing. Each section should read like a self-contained singleton result so the orchestrator can apply existing pattern-matching.
- DO NOT cache `imageResult` across batch invocations. Build is per-batch, not process-global — the singleton's per-call check already handles cross-invocation correctness.

---

## Summary for handoff

This design specifies a new MCP tool, `run_agent_in_docker_batch`, that takes an array of 2–8 dispatch objects, fans out internally to N parallel Docker containers via `Promise.all`, and returns one consolidated markdown result with a summary table and N per-dispatch sections (40-line tail bound for token-budget hygiene). It bypasses the Claude Code main-session tool-call serializer empirically reproduced in `docs/parallel-dispatch-test-design.md` (Tier-B FAIL on 2026-05-28) while remaining additive — the existing singleton tool stays unchanged.

Architecture is summarized in this decision table:

| Decision | Choice | Rationale | Alternatives |
|---|---|---|---|
| Tool name | `run_agent_in_docker_batch` | Family-discoverable; loud `_batch` suffix | `run_agents_in_docker` (terser, easier to mis-read) |
| Schema | `dispatches: [N]` + optional `fail_fast` | One load-bearing param; minimal surface | Add `max_concurrency` (rejected — array length IS concurrency) |
| `minItems` | 2 | Singleton handles N=1; refuse confused inputs | 1 (collapses to singleton; confusing) |
| `maxItems` | 8 | Laptop-safe upper bound; matches observed wave sizes | 4 (too low for full QA passes); 16 (Docker contention) |
| Return shape | Single markdown content block | Mirrors singleton; client-safe | N content blocks (ordering not guaranteed) |
| Per-dispatch tail | 40 lines | Token budget for 8-way batches | 80 (matches singleton; explodes for N=8) |
| `fail_fast` default | `false` | Don't waste work; scrum-master semantics | `true` (forces orchestrator to opt-out) |
| Cancellation | SIGTERM via AbortController | Graceful; reuses existing kill paths | SIGKILL (harder; no cleanup) |
| Image build | Once per batch | One `ensureVoltronImage` call before fan-out | Per dispatch (N redundant inspects) |
| Singleton fate | Coexists permanently | Singleton case still valid | Deprecate (breaks N=1 callers) |

Plan saved to `docs/run-agents-batch-design.md`. Invoke `/scrum-master` with this plan to generate the implementation work breakdown (the harness-engineer is the natural implementer per CLAUDE.md §"Agent Team Roles").

[DONE] Wrote docs/run-agents-batch-design.md covering all 8 required sections: tool name + literal JSON Schema, return shape with 40-line tail bound, fail_fast/cancellation semantics, src/index.js refactor anchors with line numbers, template-update text for scrum-master + 5 sub-managers, verification test at scripts/test-parallel-dispatch-batch.mjs, coexistence policy with the singleton, and 8 open questions with planner-default recommendations.
