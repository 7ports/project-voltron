# Parallel Dispatch Test — Design Document

**Bead (this design):** voltron-6h4 (P1)
**Bead (implementation, blocked on this):** voltron-0in
**Author:** project-planner
**Date:** 2026-05-28
**Status:** Plan only — no implementation in this doc.

## Run results

Empirical Tier-A / Tier-B observations recorded against this design:

| Date | Tier | Branch | Verdict | entrySkew | overlap | Notes |
|---|---|---|---|---|---|---|
| 2026-05-28 | A (automated) | chore/parallel-dispatch-test | **PARALLEL** | 0 ms | 100 000 ms | Headless `StdioClientTransport` + `Promise.all` against local `src/index.js`. |
| 2026-05-28 17:19–21 | B (manual main session) | chore/parallel-dispatch-test | **SEQUENTIAL** | — | 0 ms | A.exit→B.entry gap = 2 s — classic single round-trip + container respawn. |

**Conclusion:** the regression is localized to the **Claude Code main-session MCP client** (layer (a)). Voltron's own stack — MCP SDK Server, `run_agent_in_docker` handler, Docker daemon, and `ensureVoltronImage` — is parallel-safe.

---

## 0. Why this document exists

Two prior probes appeared to confirm parallel dispatch but actually showed the same sequential-dispatch signature:

| Date | Agents (A → B) | A duration | A.exit → B.entry gap | A.entry → B.entry delta | Conclusion drawn | Actual signal |
|---|---|---|---|---|---|---|
| 2026-05-28 17:16 | `dep-reader` → `git-state-reader` | 11 s | **2 s** | 13 s | "Parallel — under 30 s threshold" | **SEQUENTIAL** (B started right after A finished) |
| 2026-05-28 17:19 | `code-analyst` → `harness-engineer` | 56 s | **2 s** | 58 s | "Sequential" | SEQUENTIAL (unambiguous) |

The recurring `~2 s gap between A.exit and B.entry` is the unmistakable fingerprint of serial dispatch: it is the wall time of *one* MCP tool-result round-trip plus one Docker container teardown/spawn cycle. Parallel dispatch would instead show **B.entry land within seconds of A.entry**, both processes running concurrently, and A.exit and B.exit roughly together near the end of the wall window.

The earlier investigation at `docs/parallel-dispatch-investigation.md` reached its conclusion (Voltron handler is parallel-safe; root cause is the Claude Code main session) from code-reading alone — it never empirically verified. This design produces the verification harness that investigation lacked.

---

## 1. Test invocation surface

### Candidates (with coverage of the suspect layers)

| Layer suspected | (a) Claude Code main session | (b) MCP SDK | (c) Voltron handler | (d) Docker daemon | (e) `ensureVoltronImage` blocking |
|---|---|---|---|---|---|
| **Option X** — headless Node script (uses `StdioClientTransport`, calls `client.callTool` twice inside `Promise.all`) | ✗ bypasses | ✓ exercises | ✓ exercises | ✓ exercises | ✓ exercises |
| **Option Y** — fully manual: human types into a Claude Code session, post-hoc log script analyses the output | ✓ exercises | ✓ exercises | ✓ exercises | ✓ exercises | ✓ exercises |
| **Option Z** — headless `claude --print -p` CLI invocation that asks the model to emit two `tool_use` blocks in one message | partial — same harness binary as the interactive main session, but the harness may behave differently in `--print` mode (unverified) | ✓ | ✓ | ✓ | ✓ |
| **Option W** — multiple complementary tests (one per layer) | depends on the layer-specific tests selected | depends | depends | depends | depends |

Single-option drawbacks:
- **X alone** is fast and CI-friendly but cannot distinguish "main session is the bug" (a) from "everything works": both yield a green X.
- **Y alone** covers everything but takes a human in the loop on every run, so it cannot run in CI and cannot be looped while iterating on a fix.
- **Z alone** has the closest fidelity to the real path *and* is automatable, but Anthropic does not currently document whether `claude --print` and the interactive harness share the same tool-emission scheduler. Until verified, a green Z does not prove a green interactive session.

### Chosen surface: **Hybrid (Option W) built around Tier-A (X) and Tier-B (Y), with Tier-C (Z) as an optional bridge**

| Tier | What it is | What it catches | When to run |
|---|---|---|---|
| **A — Headless Node, automated** | A standalone Node script (modeled on `voltron-evals/runner.js`) that opens an MCP `StdioClientTransport` to a local `src/index.js`, fires two `run_agent_in_docker` calls via `Promise.all` with distinct probe agents, then parses the resulting logs. | (b) MCP SDK serialization, (c) Voltron handler serialization, (d) Docker daemon contention, (e) `ensureVoltronImage` event-loop block | CI on every PR; locally any time the handler/MCP server is edited. |
| **B — Manual Claude Code main session** | Human pastes a single prompt into a real Claude Code chat. Prompt instructs the model to emit **two parallel `tool_use` blocks** for `run_agent_in_docker` in one assistant message. A *separate* analyzer script reads the produced logs. | Adds (a) Claude Code main-session tool-call batching. | Run ad hoc when Tier-A passes but production sessions still look sequential. |
| **C — Headless `claude --print`** *(optional)* | A shell wrapper around `claude --dangerously-skip-permissions --print -p <prompt>` that emits the same dispatch instruction Tier-B uses. Same analyzer reads the same log files. | Same as Tier-B *if* Anthropic confirms `--print` shares the interactive harness scheduler. | Used as a research probe in the localization protocol — never as a primary gate. |

### Why hybrid, explicitly

- Tier-A makes the test cheap enough to run on every commit. A PR that breaks handler concurrency fails immediately.
- Tier-B makes the test *honest* about the real failure mode under investigation (the d84274d regression is fundamentally a main-session emission problem; only Tier-B can reproduce it).
- Tier-C is a research arm — it lets us cheaply A/B the headless CLI vs the interactive harness once we have a Tier-B baseline.

### Explicit coverage statement

| Suspect layer | Covered by Tier-A | Covered by Tier-B | Covered by Tier-C |
|---|---|---|---|
| (a) Claude Code main session | NO | YES | partial (research only) |
| (b) MCP SDK Server | YES | YES | YES |
| (c) Voltron `run_agent_in_docker` handler | YES | YES | YES |
| (d) Docker daemon contention | YES | YES | YES |
| (e) `ensureVoltronImage` event-loop block | YES (with pre-warm variant in §5) | YES | YES |

> Tier-A is the load-bearing gate. Tier-B is the truth check. Tier-C is the cheap research follow-up.

---

## 2. Probe agent design

### Constraints

- **Long enough runtime** that sequential dispatch is unambiguous. Target: each probe occupies **75 ± 5 seconds** of wall time. With B.entry placed at A.entry + 2 s under parallel dispatch versus B.entry placed at A.exit + 2 s under sequential, the two regimes are separated by ~73 s — easy to read.
- **No file edits.** Probes must be idempotent and leave the repository unchanged so the test can run many times back-to-back.
- **Deterministic `[entry]` / `[exit]`.** Both are produced by the bash wrapper in `src/index.js:2019` regardless of what the agent does — so any task that simply consumes time inside the container is sufficient.
- **No image rebuild.** Calling `mcp__project-voltron__run_agent_in_docker` will hit `ensureVoltronImage` (src/index.js:127). A first call with a stale image will rebuild and add ~30–120 s; that pollutes timing. The test runner must pre-warm the image (see §5, sub-test (e)) and confirm `built === false` before measuring.
- **Distinct agent names.** Picking two different agent names guarantees the two log filenames cannot collide even if dispatched in the same calendar second.

### Choice of probe agents

Use two existing read-only inspector agents whose templates won't refuse an ad-hoc "execute one Bash command" instruction:

- **Probe A: `dep-reader`** — short-lived, read-only, no side effects.
- **Probe B: `git-state-reader`** — short-lived, read-only, no side effects.

Either could be substituted with another inspector agent (`route-lister`, `log-tailer`, etc.). What matters is: two *different* agents (distinct log filenames), each happy to run a single Bash call.

### Literal probe prompts

Both probes receive the same body, with the agent name and the unique run-id substituted in. `<RUN_ID>` is generated fresh per test run (see §4).

**Probe A — passed as the `task` parameter to `run_agent_in_docker(agent_name="dep-reader", ...)`:**

```
PARALLEL-DISPATCH PROBE — agent=A run-id=<RUN_ID>

This task is a timing probe for the Voltron parallel-dispatch test harness.
Do NOTHING beyond the two steps below. Do not read files, do not analyze
dependencies, do not call any other tools. Your only job is to consume
approximately 75 seconds of wall time inside this container so that the
[entry] and [exit] timestamps in your log file can be compared to a peer
agent's.

Step 1 — execute exactly ONE Bash tool call, verbatim:

    sleep 75 && echo "[probe-marker] role=A run-id=<RUN_ID> agent=dep-reader"

Step 2 — emit exactly ONE final assistant line, verbatim:

    [DONE] probe A complete run-id=<RUN_ID>

Acceptance:
- Total wall time between [entry] and [exit] ≥ 70s and ≤ 95s.
- The string "run-id=<RUN_ID>" appears at least once in the log file
  (.voltron/logs/dep-reader-<TS>.log).
- No file modifications, no git operations, no other tool calls.
```

**Probe B — passed as the `task` parameter to `run_agent_in_docker(agent_name="git-state-reader", ...)`:**

```
PARALLEL-DISPATCH PROBE — agent=B run-id=<RUN_ID>

Same contract as probe A, with role=B and agent=git-state-reader.

Step 1 — execute exactly ONE Bash tool call, verbatim:

    sleep 75 && echo "[probe-marker] role=B run-id=<RUN_ID> agent=git-state-reader"

Step 2 — emit exactly ONE final assistant line, verbatim:

    [DONE] probe B complete run-id=<RUN_ID>

Acceptance:
- Total wall time between [entry] and [exit] ≥ 70s and ≤ 95s.
- The string "run-id=<RUN_ID>" appears at least once in the log file
  (.voltron/logs/git-state-reader-<TS>.log).
- No file modifications, no git operations, no other tool calls.
```

### Why `sleep` inside `Bash`, not a model-internal stall

A `sleep 75` inside a single `Bash` tool call is deterministic (POSIX guarantees ≥ 75 s) and adds no model variability. Asking the model to "wait 75 seconds" without a system call would be non-deterministic — the model might decide to "think for a while" or refuse. A single bash invocation cleanly anchors the timing.

### What `max_turns` to use

`max_turns: 4` is sufficient (one initial assistant turn, one tool call, one tool result, one final assistant turn). This keeps the probe cheap and bounds catastrophic-failure recovery time.

---

## 3. Timestamp parser + decision rule

### Where to find the timestamps

The bash wrapper at `src/index.js:2019` emits four breadcrumb lines into the container's stdout, which is teed to `/workspace/.voltron/logs/<safeAgentName>-<isoTimestamp>.log`. The two we need:

```
[entry] <ISO-8601 timestamp> host=<container-id> user=voltron
[exit]  <ISO-8601 timestamp> code=<exit-code>
```

`safeAgentName` is `agent_name.replace(/[^a-z0-9]/g, '-')` (src/index.js:1848). `isoTimestamp` is `new Date().toISOString().replace(/[:.]/g, '-').slice(0,19)` (src/index.js:1847), so log filenames look like `dep-reader-2026-05-28T17-16-29.log`.

### Identifying the right pair of logs

A naïve `ls -t` glob may pick stale logs left over from prior runs. The parser must use the run-id (§4) to pin down the exact pair:

```
candidate_A_paths = glob(".voltron/logs/dep-reader-*.log")
                    filtered to files whose content contains "run-id=<RUN_ID>"
candidate_B_paths = glob(".voltron/logs/git-state-reader-*.log")
                    filtered to files whose content contains "run-id=<RUN_ID>"
```

Both filtered sets must contain exactly one file. If 0, the probe never emitted its marker — INCONCLUSIVE (probe failed). If >1, two test runs collided on the same run-id (numerically improbable, but error out and ask the runner to re-generate the id).

### Decision rule (concrete thresholds)

Variables:
- `A_entry`, `A_exit` — `[entry]` / `[exit]` timestamps from probe-A's log
- `B_entry`, `B_exit` — same for probe-B
- `RUN_DURATION` — `max(A_exit, B_exit) − min(A_entry, B_entry)`
- `entry_skew` = `|A_entry − B_entry|`
- `gap_after_A` = `B_entry − A_exit` (only meaningful when positive)
- `overlap` = `max(0, min(A_exit, B_exit) − max(A_entry, B_entry))`

**PASS — confirmed parallel dispatch.** All of:
1. `entry_skew < 5 s` (both Docker spawns reached `[entry]` within five seconds of each other), AND
2. `min(A_entry, B_entry) ≤ max(A_entry, B_entry) ≤ min(A_exit, B_exit)` — the later-starting probe entered no later than either probe exited (the two were alive simultaneously for at least one moment). The `≤` (rather than strict `<`) accommodates second-resolution `[entry]`/`[exit]` timestamps that can tie at the same calendar second on truly-parallel runs; the load-bearing simultaneity proof is condition 3, AND
3. `overlap ≥ 60 s` — they ran concurrently for substantially most of a 75-second window (proves it wasn't a one-second flicker of overlap that happens to satisfy condition 2 by accident).

**FAIL — sequential dispatch.** Both of:
1. `B_entry > A_exit` (treating "A" as whichever probe entered first; rename if needed) — the later probe started only after the earlier one finished, AND
2. `gap_after_A < 10 s` — the second probe entered within ten seconds of the first one exiting, the unmistakable signature of one tool-result round-trip + container teardown/spawn.

**INCONCLUSIVE.** Anything else. The most common ways to land here:
- `B_entry > A_exit` but `gap_after_A > 10 s` — something added latency beyond a simple roundtrip. Suspect: image rebuild was triggered (check stderr for `docker build` output), or the Docker daemon stalled. Re-run after pre-warming and inspecting `docker info`.
- `entry_skew < 5 s` but `overlap < 60 s` — one of the two probes exited early. Suspect: agent did not actually sleep (refused the task, hit `max_turns`, or `sleep` returned early due to signal). Inspect the log body for the `[probe-marker]` line and the `[DONE]` line.
- Either probe missing entirely. Suspect: dispatch errored out before reaching `[entry]`. Inspect the `run_agent_in_docker` tool result for an error string.

### Parser sketch (Node, pseudo-code)

```javascript
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function findLog(agentSlug, runId, logsDir = ".voltron/logs") {
  const files = readdirSync(logsDir).filter(f => f.startsWith(`${agentSlug}-`) && f.endsWith(".log"));
  const matches = files
    .map(f => join(logsDir, f))
    .filter(p => readFileSync(p, "utf-8").includes(`run-id=${runId}`));
  if (matches.length === 0) throw new Error(`no log for ${agentSlug} containing run-id=${runId}`);
  if (matches.length > 1)  throw new Error(`multiple logs for ${agentSlug} containing run-id=${runId} — regenerate run-id`);
  return matches[0];
}

function parseEntryExit(logPath) {
  const lines = readFileSync(logPath, "utf-8").split("\n");
  const entry = lines.find(l => l.startsWith("[entry] "));
  const exit  = lines.find(l => l.startsWith("[exit] "));
  if (!entry || !exit) throw new Error(`log ${logPath} missing [entry] or [exit]`);
  return {
    entry: new Date(entry.match(/\[entry\] (\S+)/)[1]).getTime(),
    exit:  new Date(exit.match(/\[exit\] (\S+)/)[1]).getTime(),
  };
}

function classifyDispatch(runId, agentSlugA = "dep-reader", agentSlugB = "git-state-reader") {
  const logA = findLog(agentSlugA, runId);
  const logB = findLog(agentSlugB, runId);
  const a = parseEntryExit(logA);
  const b = parseEntryExit(logB);

  // Normalize: relabel so "first" is whichever entered earlier.
  const [first, second] = a.entry <= b.entry ? [a, b] : [b, a];

  const entrySkewMs   = Math.abs(a.entry - b.entry);
  const gapAfterFirst = second.entry - first.exit;          // positive if second started after first ended
  const overlapMs     = Math.max(0, Math.min(a.exit, b.exit) - Math.max(a.entry, b.entry));

  const SEC = 1000;
  if (entrySkewMs < 5 * SEC
      && first.entry <= second.entry
      && second.entry <= first.exit
      && overlapMs >= 60 * SEC) {
    return { verdict: "PASS", entrySkewMs, overlapMs, gapAfterFirst, logA, logB };
  }
  if (gapAfterFirst > 0 && gapAfterFirst < 10 * SEC) {
    return { verdict: "FAIL_SEQUENTIAL", entrySkewMs, overlapMs, gapAfterFirst, logA, logB };
  }
  return { verdict: "INCONCLUSIVE", entrySkewMs, overlapMs, gapAfterFirst, logA, logB };
}
```

The test runner exits 0 on PASS, 1 on FAIL_SEQUENTIAL, 2 on INCONCLUSIVE. The classifier is the same function for Tier-A, Tier-B, and Tier-C — only the dispatch trigger differs.

---

## 4. Run-id contamination guard

### The risk

`.voltron/logs/` is a long-lived directory. A naïve "latest two logs by mtime" picker would, in any of these realistic conditions, pull the wrong files:
- Two test runs in the same minute (CI parallelism or human + CI overlap).
- A real (non-test) dispatch happening to use the same probe agent name in the same window.
- Re-running the test after a previous run failed and left orphan logs.

### The guard

Generate a unique 16-character run-id before dispatch. UUIDv4 (`crypto.randomUUID()`) is more than enough; a shorter `Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex")` is also fine and easier to eyeball.

```javascript
const RUN_ID = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
// e.g. "kr3p1x6m-7af4d12c"
```

The run-id is:
1. Inlined into both probe prompts (the `<RUN_ID>` token in §2).
2. Written into the `[probe-marker]` line via `echo` inside the `sleep && echo` Bash invocation — so it lands in the container stdout and therefore in the log file under `/workspace/.voltron/logs/`.
3. Echoed in the `[DONE]` line, so it is also captured in the `extractedText` channel.

The parser filters the log glob to files whose content contains `run-id=<RUN_ID>`. Stale logs and concurrent real-agent dispatches cannot match the freshly-generated id, so the parser is safe even if other agents are running.

### Defense in depth

- The dispatcher records the `Date.now()` instant just before each `client.callTool` and again just after each resolves. If the parser-picked log's `[entry]` timestamp is more than 60 s outside the dispatcher-recorded window, error with `log/dispatch window mismatch — possible run-id collision`. This is paranoia, but cheap.
- The runner deletes its own log files after a successful PASS run (keep last 5) so the directory does not fill with `dep-reader-*.log` over months.

---

## 5. Localization protocol

Once Tier-A is implemented (per voltron-0in), this section gives the **decision tree** for narrowing the failure to a specific layer.

### Step 1 — Run Tier-A. Pre-warm first.

```
1. Call run_agent_in_docker once with any cheap probe (e.g. dep-reader "echo hello, exit"),
   discard the result. This guarantees ensureVoltronImage returns built=false on the next call.
2. Run the Tier-A test.
3. Branch on its verdict.
```

### Step 2 — Branch on Tier-A verdict

#### Branch A: Tier-A returns **PASS**

The Voltron stack ((b)+(c)+(d)+(e)) is parallel-safe. The remaining suspect is **(a) Claude Code main session emission**.

- Run Tier-B. Same probes, same parser, same run-id discipline; only the dispatch is now a real human-in-the-loop Claude Code session.
- If Tier-B is **PASS** → no regression: prior misreadings were the bug, not the dispatcher. Update `docs/parallel-dispatch-investigation.md` with the empirical evidence and close voltron-0in as "no fix needed; documentation only."
- If Tier-B is **FAIL_SEQUENTIAL** → (a) is the culprit. The fix is *outside* Voltron source: it's either Anthropic harness behavior or scrum-master prompt engineering. Localize further by running Tier-C (`claude --print`). If Tier-C is **PASS** but Tier-B is **FAIL_SEQUENTIAL**, the interactive harness specifically is at fault; if both fail, the model itself is not emitting parallel `tool_use` blocks regardless of harness mode and the fix belongs entirely in the slash-command prompt.

#### Branch B: Tier-A returns **FAIL_SEQUENTIAL**

The bug is **inside** the Voltron stack. Localize by running the sub-tests in order, stopping at the first one that flips the verdict:

| Sub-test | What changes vs Tier-A | If this sub-test is **PASS** while Tier-A is **FAIL** |
|---|---|---|
| **(e) Pre-warm probe** — call `run_agent_in_docker` once to settle image, then run Tier-A again | only the warm state | (e) `ensureVoltronImage` event-loop block is the culprit (cold-path only) |
| **(d) Raw-docker probe** — shell-only test: `time docker run --rm voltron-agent sleep 75 & docker run --rm voltron-agent sleep 75 & wait` | bypasses all Node/MCP code | If raw docker still serializes, (d) Docker daemon contention is real — escalate to `docker info` / daemon config. (Expected outcome: parallel.) |
| **(c) Direct-handler probe** — import the run_agent_in_docker handler function directly into a Node script and invoke twice with `Promise.all`, bypassing the MCP SDK transport | bypasses the SDK | If this is PASS while Tier-A FAILs, (b) MCP SDK is the culprit. If this also FAILs, (c) handler is the culprit |
| **(b) MCP-only probe** — register a temporary `noop_sleep` tool in `src/index.js` that just `await new Promise(r => setTimeout(r, 75000))`, dispatch two via `Promise.all` through `StdioClientTransport` | exercises only the MCP request-handling loop — no Docker | If this serializes, (b) MCP SDK Server is the culprit. (Remove the temporary tool after the test.) |

The expected resolution map:
- PASS for all four sub-tests, FAIL for Tier-A → contradiction; re-investigate.
- Pre-warm flips to PASS → (e).
- Raw docker is the only serializer → (d).
- Direct-handler PASSes, Tier-A FAILs → (b).
- Direct-handler FAILs → (c).
- noop_sleep MCP-only FAILs → (b) confirmed without needing the handler.

#### Branch C: Tier-A returns **INCONCLUSIVE**

Read the failure mode field in the parser output, address it, and re-run. The common causes are listed at the end of §3.

### Localization output

The runner records the Tier-A result, the sub-test path it descended through, and the final localization verdict to `.voltron/parallel-dispatch-test-result.json`:

```json
{
  "run_id": "kr3p1x6m-7af4d12c",
  "started_at": "2026-05-28T19:42:01Z",
  "tier_a_verdict": "FAIL_SEQUENTIAL",
  "subtests": [
    { "name": "pre-warm",       "verdict": "FAIL_SEQUENTIAL" },
    { "name": "raw-docker",     "verdict": "PASS" },
    { "name": "direct-handler", "verdict": "FAIL_SEQUENTIAL" }
  ],
  "localized_to": "(c) Voltron run_agent_in_docker handler",
  "evidence": {
    "tier_a_logs": [".voltron/logs/dep-reader-...log", ".voltron/logs/git-state-reader-...log"],
    "subtest_logs": [".voltron/parallel-dispatch-test-result.subtest-1.json", "..."]
  }
}
```

This is the JSON contract the implementation (voltron-0in) will produce.

---

## 6. Acceptance + DO NOT

### Acceptance — for THIS design document

A reviewer can mark this design "complete" when:

- [x] §1 covers all four invocation-surface candidates and picks one with explicit rationale.
- [x] §1 includes a coverage matrix mapping the chosen surface to each suspect layer (a)–(e).
- [x] §2 specifies probe agents, runtime budget, and the **literal task prompt** for each probe.
- [x] §3 specifies where logs live, how to identify the right pair, and the **literal decision rule with concrete thresholds**, plus parser pseudocode.
- [x] §4 specifies the run-id contamination guard with a concrete id-generation scheme and parser filter.
- [x] §5 specifies a localization protocol with a decision tree branching on Tier-A's verdict and at least four follow-up sub-tests, each mapped to a specific suspect layer.
- [x] §6 (this section) restates the boundaries and lists the DO NOTs.

### What the implementation bead (voltron-0in) will produce

For reference — *not part of this design's deliverable*:
- `scripts/parallel-dispatch-test.mjs` — Tier-A runner (Node + MCP SDK + parser)
- `scripts/parallel-dispatch-test-tier-b.md` — human-runnable Tier-B instructions
- Updates to `package.json` to expose `npm run test:parallel-dispatch`
- A CI job that runs Tier-A on every PR
- An updated `docs/parallel-dispatch-investigation.md` once an empirical result is in hand

### DO NOT (binding on the implementer and on any future revision of this design)

- **DO NOT propose a fix in this document.** Fixes belong on voltron-0in (or whichever bead replaces it). If new evidence demands a design change, edit *this* document; do not edit code from a design-doc PR.
- **DO NOT implement scripts during the design phase.** This document is plan-only. The only file the design-phase author writes is `docs/parallel-dispatch-test-design.md` itself.
- **DO NOT shorten the probe sleep to "save CI time."** A 75-second runtime is what makes parallel and sequential easy to tell apart. A 10-second probe will recreate the exact misreading that triggered this design (see §0).
- **DO NOT use the same agent for probe A and probe B.** Distinct log filenames are part of the contamination guard.
- **DO NOT rely on `ls -t .voltron/logs | head -2` to identify the test logs.** Use the run-id filter from §4.
- **DO NOT skip the pre-warm step.** A cold-path `ensureVoltronImage` rebuild will swamp the timing and the parser will return INCONCLUSIVE for the wrong reason.
- **DO NOT change the §3 thresholds without empirical justification.** They are calibrated to a 75-second probe; if probe duration changes, recalibrate explicitly in §3 and bump the design version.
- **DO NOT remove Tier-B from the harness.** Tier-A is fast and cheap, but Tier-A alone cannot detect the d84274d-style main-session regression. CI alone cannot replace the human-in-the-loop verification.

---

## Open questions (require human input before voltron-0in starts)

1. **CI cost budget.** Tier-A consumes ~90 s wall + 1 image-warming dispatch + 2 short claude-CLI startups per run. Acceptable on every PR? On main only? Nightly?
2. **`claude --print` parity research.** Is Tier-C worth wiring as an automated test, or strictly a research probe? Needs a short investigation (~30 min) to determine whether `claude --print` and the interactive harness share the same scheduling code.
3. **Probe agent stability.** `dep-reader` and `git-state-reader` are existing inspector agents. If either is renamed or removed, the test will break. Should the test ship its own dedicated `dispatch-probe-a` / `dispatch-probe-b` agents (one-time template additions, no behavioral change)? Trade-off: adds 2 templates the project must maintain forever.
4. **Where the test runner lives.** Options: `scripts/parallel-dispatch-test.mjs` (simple), `voltron-evals/parallel-dispatch.js` (reuses MCP wiring from `runner.js`), or a new top-level `tests/` directory (mirrors mainstream JS layout). Recommendation: `scripts/` to keep it visible and independent of the eval harness, but voltron-0in's planner should confirm.
