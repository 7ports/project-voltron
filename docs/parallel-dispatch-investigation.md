# Parallel Dispatch Regression — Root-Cause Investigation

**Bead:** voltron-ufu
**Regression introduced:** commit `d84274d` (v3.11.0 — scrum-master subagent → slash command)
**Investigator:** code-analyst
**Date:** 2026-05-27

---

## TL;DR — Ranked Root Cause

1. **(MOST LIKELY) Claude Code main-session tool-call serialization.** The scrum-master moved from a *subagent* (isolated `Agent` context) to a *slash command* (main chat session) in `d84274d`. Empirically, the main session is emitting `run_agent_in_docker` calls in **separate assistant turns** rather than as parallel `tool_use` blocks within a single assistant message — confirmed by the exact 2-second gap between agent #1's `[exit]` and agent #2's `[entry]` timestamps (consistent with one tool-result round-trip, not parallel dispatch).
2. **(CONTRIBUTING, MINOR) `execSync` event-loop block** at `src/index.js:128`. Synchronous `docker image inspect` blocks the Node event loop, briefly serializing concurrent MCP tool calls — but only by ~100–500 ms per call, not 3 minutes.
3. **(RULED OUT) Voltron handler serialization.** No `currentlyBuilding` flag, no file lock, no shared mutex. Each `run_agent_in_docker` invocation owns its own temp file, container name, log path. The handler is structurally parallel-safe (line 2019 comment: *"Async spawn — allows multiple agents to run in parallel Docker containers"*).
4. **(RULED OUT) Docker daemon contention.** No evidence of build-cache lock; image rebuild is gated and fast-pathed when `LastTagTime > Dockerfile.mtime`.

---

## Evidence

### A. Log-timestamp delta (the smoking gun)

From `.voltron/logs/`:

| Log file | `[entry]` | `[exit]` | Duration |
|---|---|---|---|
| `harness-engineer-2026-05-26T01-39-04.log` | `01:39:04` | `01:42:07` | 3:03 |
| `code-analyst-2026-05-26T01-42-09.log`     | `01:42:09` | (later)    | — |

**Gap between harness `[exit]` and code-analyst `[entry]`: 2 seconds.**

That is precisely the time required for: (1) docker container teardown, (2) MCP tool result returned to model, (3) model emits next `tool_use`, (4) MCP server spawns new docker container that reaches `echo "[entry]"`. The pattern is unmistakably sequential at the *dispatcher* level, not at the executor level. If Claude Code had emitted both `tool_use` blocks in the same assistant message, code-analyst's `[entry]` would land within ~1–20 s of harness's, not 3 minutes later after harness fully exits.

Contrast — same session, 2026-05-27 batch (parallel WORKS):

| Log file | `[entry]` | `[exit]` |
|---|---|---|
| `code-analyst-2026-05-27T06-33-51.log` | `06:33:52` | `06:34:49` |
| `route-adder-2026-05-27T06-34-08.log`  | `06:34:09` | `06:34:49` |

These overlap — route-adder started 17 s after code-analyst (still inside code-analyst's runtime), confirming Voltron itself does NOT serialize. The difference is the dispatcher, not the runner.

### B. The d84274d diff

`git diff d84274d^ d84274d` covers 13 files. The two changes that matter:

- **`src/templates.js:740` — scrum-master template:**
  - `category: "agent"` → `category: "slash-command"`
  - `destination: ".claude/agents/scrum-master.md"` → `".claude/commands/scrum-master.md"`
  - Removed `tools:` frontmatter (subagent-only).
- **`src/index.js`:** Only two lines changed, both pure wording (lines 649 and 1906 — refusal text and onboarding step). **Zero behavioral changes to `run_agent_in_docker` or `ensureVoltronImage`.**

Because no behavioral code changed, the regression must be in the *caller* (Claude Code) rather than the *callee* (Voltron handler). The caller swap (subagent → slash command) is the only structural delta.

### C. `run_agent_in_docker` handler review

`src/index.js:1696–2150` — full audit:

- **Line 128** (`ensureVoltronImage`): `execSync(...)` synchronous call. Blocks the Node event loop while docker inspects the image. Concurrent MCP calls *will* queue here for ~100–500 ms. Real but minor; not 3 minutes.
- **Line 1837**: `await ensureVoltronImage(...)` — image gate is per-call but the *underlying* `execSync` blocks the loop.
- **Line 1814–1818**: temp file path includes `Date.now()` — no collision possible.
- **Line 1846**: container name includes ISO timestamp + safe agent name — no collision.
- **Line 1929–1941**: writes `container-mcp.json` to a shared path. Two concurrent calls would race on this write, but it's idempotent (identical content) and not a serialization point.
- **Line 2019–2103**: `await new Promise((resolve) => { spawn("docker", ...) })` — fully async. Each call gets its own child process.
- **Line 2095**: resolves on `proc.on("close")` — independent per call.

**Conclusion:** the handler has no serialization point capable of producing the observed 3-minute sequential gap.

### D. Slash-command vs subagent dispatch semantics

Subagents (Anthropic `Agent` tool) run in an *isolated inference context* whose system prompt expressly says **"When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently."** Subagent contexts are configured for aggressive tool-call batching.

Slash commands (`.claude/commands/*.md`) are not isolated contexts — they're prompt-prepend macros that execute inside the main Claude Code session. The main session honors the model's emission pattern: if the model emits two `tool_use` blocks in one assistant message, they parallel; if it emits them in separate turns, they serialize. There is no equivalent forcing-system-prompt for the main session.

Empirically (per the May 26 logs), the main-session model executing the scrum-master macro emitted the two MCP calls in **separate turns** — driven by the slash-command's "execution loop" structure (`bd ready` → run → close → repeat), which reads as a per-task loop, not a parallel batch.

---

## Confirmation Method (user-runnable)

To reproduce the regression and confirm root cause:

```bash
# 1. Get a clean session; ensure voltron-agent image is current
docker image inspect voltron-agent --format "{{.Metadata.LastTagTime}}"

# 2. In a fresh Claude Code main-session chat, ask the model to emit
#    EXACTLY two run_agent_in_docker calls in ONE assistant message.
#    Example prompt:
#
#      "In a single assistant message containing two parallel tool_use
#       blocks, dispatch both:
#         - run_agent_in_docker(agent_name='code-analyst', task='print pwd and exit')
#         - run_agent_in_docker(agent_name='harness-engineer', task='print pwd and exit')
#       Do not emit any other tools. Both blocks in one assistant turn."

# 3. After they finish, compare [entry] timestamps:
grep -oE '\[entry\] [0-9T:+-]+' .voltron/logs/code-analyst-*.log .voltron/logs/harness-engineer-*.log | tail -2
```

**Interpretation:**
- `[entry]` deltas of **< 30 seconds** → parallel dispatch is working (main session DID batch).
- `[entry]` delta equal to the first agent's full runtime → sequential dispatch (main session did NOT batch). This reproduces the regression.

Optional cross-check inside a subagent context (pre-d84274d behavior baseline):

```
@agent-project-planner "Emit two run_agent_in_docker calls in one message, both echoing pwd."
```

Subagent contexts typically batch; if their `[entry]` deltas are tight, the contrast confirms the main-session-vs-subagent dispatch difference.

---

## Recommended Fix Beads (drafts — do NOT implement yet)

### Draft 1 — Add explicit parallel-dispatch directive to slash command

```bash
bd create \
  --title="scrum-master slash command: enforce single-message parallel batching" \
  --description="Post-d84274d the scrum-master moved from subagent (Agent tool) to slash command (main Claude Code session). Subagent contexts batch tool calls aggressively; the main session does not unless explicitly instructed. Result: run_agent_in_docker calls that should run in parallel are emitted in sequential assistant turns, costing N * dispatch-duration instead of max(dispatch-durations). Action: in .claude/commands/scrum-master.md, restructure the Execution Loop (around line 455-461) to make 'collect all ready bead IDs, emit ALL run_agent_in_docker tool_use blocks in a single assistant message, then await all results before iterating' literally explicit, with an example showing two tool_use blocks in one message. Also tighten the same wording in src/templates.js (the scrum-master template content). Acceptance: a fresh session with two parallel-safe beads should show [entry] timestamps within 30s of each other in .voltron/logs/." \
  --type=bug \
  --priority=1
```

### Draft 2 — Replace `execSync` with async `execFile` in `ensureVoltronImage`

```bash
bd create \
  --title="src/index.js:128 — replace execSync with async execFile in ensureVoltronImage" \
  --description="ensureVoltronImage uses execSync to call 'docker image inspect', which blocks the Node event loop for the duration of the docker call. While the regression's main cause is dispatcher serialization, this is a secondary serialization point: concurrent MCP tool calls queue on this sync call. Replace with util.promisify(execFile) + await, so concurrent calls truly run in parallel through the handler. File: src/index.js, function ensureVoltronImage (lines 126-163). Acceptance: two simultaneous run_agent_in_docker invocations from the same session show overlapping docker inspect calls in 'docker events' trace, and Node CPU profile shows no synchronous block longer than 5ms in the handler entry path." \
  --type=task \
  --priority=2
```

### Draft 3 — Document parallel-dispatch semantics in CLAUDE.md / scrum-master command

```bash
bd create \
  --title="Document slash-command vs subagent parallel-dispatch contract" \
  --description="Add a 'Parallel dispatch contract' section to .claude/commands/scrum-master.md (and the mirrored src/templates.js entry) explaining: (1) the main session does NOT batch tool calls by default; (2) the scrum-master must explicitly emit multiple tool_use blocks in a single assistant message to parallelize; (3) the test for 'did this actually parallelize?' is grep '[entry]' in .voltron/logs/ and check delta. Add a 'How to verify parallel dispatch' subsection citing the confirmation procedure in docs/parallel-dispatch-investigation.md. Acceptance: doc section exists; example shows correct vs. incorrect emission pattern side by side." \
  --type=task \
  --priority=3
```

---

## Files / Lines Cited

- `src/index.js:126-163` — `ensureVoltronImage` (sync execSync hotspot at line 128)
- `src/index.js:1696-1719` — `run_agent_in_docker` tool registration
- `src/index.js:1814-1818` — per-call temp file (collision-safe)
- `src/index.js:1837` — `await ensureVoltronImage(...)`
- `src/index.js:1929-1941` — shared `container-mcp.json` write (idempotent)
- `src/index.js:2019-2103` — async docker spawn (structurally parallel)
- `.claude/commands/scrum-master.md:451-461` — Execution Loop (the dispatch pattern that produces sequential calls)
- `.claude/commands/scrum-master.md:141` — "Parallel execution" claim (currently asserts what isn't happening)
- `src/templates.js:~740` — scrum-master template (category swap that triggered the regression)
- `.voltron/logs/harness-engineer-2026-05-26T01-39-04.log` — entry 01:39:04, exit 01:42:07
- `.voltron/logs/code-analyst-2026-05-26T01-42-09.log` — entry 01:42:09 (2 s after harness exit)

## What Was NOT Investigated (gaps)

- Did not verify by re-running parallel calls in this session — task said "do not re-confirm the WHAT."
- Did not patch `docker info` to check daemon-level concurrency settings — see Draft 2 acceptance for the real check.
- Did not read Anthropic Claude Code release notes; conclusion (1) above is inferred from log evidence + the d84274d diff alone. Direct doc citation would harden the claim but is not required to act on the fix beads.
