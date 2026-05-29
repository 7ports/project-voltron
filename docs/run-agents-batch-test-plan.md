# `run_agent_in_docker_batch` — Comprehensive Test Plan

**Bead:** voltron-kzb
**Author:** project-planner
**Date:** 2026-05-29
**Status:** Plan only — no implementation in this doc. A separate harness-engineer dispatch implements `scripts/test-batch-tool-comprehensive.mjs` against the contract below.
**Companion:** `docs/run-agents-batch-design.md` (the architectural design this plan verifies).
**Existing baseline:** `scripts/test-parallel-dispatch-batch.mjs` (a one-case `overlap=97s` PASS smoke test). This plan extends that coverage from "fan-out is parallel" to "the batch tool obeys every contract clause in §1–§7 of the design doc."

---

## Scope and non-goals

In scope:

- Schema-layer rejections (Cases 1–3).
- Behavioral semantics of `fail_fast` (Cases 4–5).
- Per-dispatch parameter independence: `max_turns`, `model` (Cases 6–7).
- Concurrency correctness at the upper bound and across mixed runtimes (Cases 8–9).
- Collision-safety when the same `agent_name` appears twice in one batch (Case 10).
- One-shot `ensureVoltronImage` performance characteristic (Case 11).
- Bounded return-shape under verbose output (Case 12).

Out of scope (covered elsewhere or deferred):

- The Tier-B reproduction of main-session serialization (`docs/parallel-dispatch-test-design.md`).
- The two-probe parallel smoke test already in `scripts/test-parallel-dispatch-batch.mjs` — that script continues to run unchanged in CI; the new harness adds to it, never replaces it.
- Anything that requires a live Anthropic API quota beyond what voltron-agent normally consumes. Probes are designed to minimize token spend (single Bash tool call + a `[DONE]` line).
- Cross-batch state (the design doc forbids caching `imageResult` across batch invocations; verifying that needs a different harness — flag for future bead).

---

## 1. Test invocation surface

### 1.1 File and shape

A single Node script at `scripts/test-batch-tool-comprehensive.mjs`. ES module syntax (`.mjs`), identical import set to `scripts/test-parallel-dispatch-batch.mjs`, identical MCP `StdioClientTransport` connection pattern. **Reuse the existing `preflight`, `connectMcp`, `findLog`, `parseEntryExit`, and probe-prompt builder verbatim** — copy them or import from a shared `scripts/lib/dispatch-parser.mjs` if the implementer chooses to extract first. Do **not** rewrite them from scratch — divergence between the singleton test and the batch test in parser semantics has bitten this project before (see lessons in `docs/parallel-dispatch-investigation.md`).

### 1.2 Top-level flow

```text
main() {
  preflight()             // docker info + image inspect; abort on miss
  const runId = unique()  // Date.now-base36 + 4 random hex bytes
  const { client, transport } = await connectMcp()
  try {
    await prewarm(client) // ONE singleton dispatch to warm voltron-agent image
    const CASES = [case01, case02, ..., case12]
    const results = []
    for (const c of CASES) {                // sequential, NOT Promise.all
      results.push(await c({ client, runId }))
    }
    printSummaryTable(results)
    process.exit(results.every(r => r.verdict === "PASS") ? 0 : 1)
  } finally {
    await transport.close().catch(() => {})
  }
}
```

**Sequential execution is mandatory.** Running test cases in parallel would mean Case 8 (8-way batch) competes with Case 9 (mixed runtimes) for the local Docker daemon's container slots; their threshold-based verdicts would lose validity. Each case must own the Docker daemon for the duration of its dispatch.

### 1.3 Per-case contract

Each test case is `async function caseNN({ client, runId }) => { name, verdict, evidence }`:

| Field | Type | Purpose |
|---|---|---|
| `name` | string | Human-readable label, e.g. `"Case 8 — Max-size batch (8 agents)"`. |
| `verdict` | `"PASS"` \| `"FAIL"` \| `"INCONCLUSIVE"` | Decision per the case's own rule (§2). |
| `evidence` | object | Whatever the decision rule actually measured (e.g. `{ entrySkewMaxMs, overlapMinMs, aggregateWallMs }`). Logged on failure for debugging. |

The case **must not call `process.exit`**. It returns its verdict; only `main()` exits.

### 1.4 Probe-prompt construction

Probes use `node -e "setTimeout(() => console.log('marker'), N * 1000)"` for any wall-time consumption, **never raw `sleep N`** — per investigation notes in `voltron-0in`, the voltron-agent image's `bash` interprets `sleep` differently than the host shell in some nested-dispatch contexts and several earlier probe iterations stalled because of it. Every probe includes the `runId` literally in its assistant output so logs can be filtered (see §3).

### 1.5 Summary table format

End of run:

```text
=== run_agent_in_docker_batch — comprehensive test summary ===
run-id: <id>
| # | Case                                    | Verdict |
|---|-----------------------------------------|---------|
| 1 | Schema rejection: dispatches < 2        | PASS    |
| 2 | Schema rejection: dispatches > 8        | PASS    |
| 3 | Schema rejection: missing required      | PASS    |
| 4 | fail_fast=true terminates siblings      | PASS    |
| 5 | fail_fast=false: mixed status reported  | PASS    |
| 6 | Per-dispatch max_turns honored          | PASS    |
| 7 | Per-dispatch model override applied     | PASS    |
| 8 | 8-agent max-size batch parallel         | PASS    |
| 9 | Mixed runtime — no head-of-line block   | PASS    |
|10 | Same-agent twice — no log collisions    | PASS    |
|11 | Pre-warm shared across calls            | PASS    |
|12 | Bounded output under verbose dispatches | PASS    |

Overall: 12/12 PASS — exit 0
```

Exit 0 iff all PASS, else 1. An `INCONCLUSIVE` verdict counts as FAIL for the exit code (we treat "couldn't measure" as a regression of the test harness itself).

---

## 2. Test cases — detailed contracts

For each case below: **(a) what's verified**, **(b) test outline / pseudocode**, **(c) PASS/FAIL decision rule with concrete thresholds**, **(d) what failure indicates (which layer broke)**.

### Test case 1 — Schema rejection: `dispatches.length < 2`

**(a) What:** the MCP-level zod schema (`.min(2)` from `src/index.js:2102`) rejects a single-dispatch call. Crucially, the singleton `run_agent_in_docker` is **not** silently invoked instead.

**(b) Outline:**
```js
async function case01({ client }) {
  let threw = false, errText = "", singletonHits = 0;
  // Watch logging notifications for any dispatchOneAgent activity
  const watcher = client.setNotificationHandler?.(...) // or pass-through; if not available, post-check .voltron/logs/ count
  const before = countLogs(LOGS_DIR);
  try {
    await client.callTool({
      name: "run_agent_in_docker_batch",
      arguments: { dispatches: [{ agent_name: "dep-reader", task: "noop probe" }] }
    });
  } catch (err) {
    threw = true; errText = err.message;
  }
  const after = countLogs(LOGS_DIR);
  return verdict(threw && /dispatches/i.test(errText) && after === before
    ? "PASS" : "FAIL", { threw, errText, newLogs: after - before });
}
```

**(c) Decision rule:**
- PASS iff `threw === true` AND error message contains `"dispatches"` AND `newLogs === 0`.
- FAIL otherwise.

**(d) Failure indicates:** if `threw === false`, the zod `.min(2)` constraint was relaxed in the handler — design §1 rationale violated. If `newLogs > 0`, the handler accidentally fell through to a singleton fan-out path — `dispatchOneAgent` is being invoked despite a schema rejection.

---

### Test case 2 — Schema rejection: `dispatches.length > 8`

**(a) What:** the `.max(8)` upper bound is enforced. Design §1 "bounds rationale" — no nine-batch escape hatch.

**(b) Outline:**
```js
async function case02({ client }) {
  const nine = Array.from({ length: 9 }, (_, i) => ({
    agent_name: "dep-reader",
    task: `noop probe ${i}`,
  }));
  let threw = false, errText = "";
  try { await client.callTool({ name: "run_agent_in_docker_batch", arguments: { dispatches: nine } }); }
  catch (err) { threw = true; errText = err.message; }
  return verdict(threw && /(dispatches|max|8)/i.test(errText) ? "PASS" : "FAIL", { errText });
}
```

**(c) Decision rule:** PASS iff `threw === true` AND error message references the upper bound (one of `"dispatches"`, `"max"`, `"8"`).

**(d) Failure indicates:** `.max(8)` removed or weakened. If the call succeeds and 9 containers spawn, the host resource ceiling design assumed (§1 §1, Docker concurrent-containers band) is being violated.

---

### Test case 3 — Schema rejection: missing required fields

**(a) What:** `agent_name` and `task` are both `required` per the zod schema. A dispatch missing either is refused at the MCP layer.

**(b) Outline:**
```js
async function case03({ client }) {
  const checks = [
    { missing: "agent_name", arg: { dispatches: [{ task: "x" }, { agent_name: "dep-reader", task: "y" }] } },
    { missing: "task",       arg: { dispatches: [{ agent_name: "dep-reader" }, { agent_name: "dep-reader", task: "y" }] } },
  ];
  const failures = [];
  for (const c of checks) {
    let threw = false, errText = "";
    try { await client.callTool({ name: "run_agent_in_docker_batch", arguments: c.arg }); }
    catch (err) { threw = true; errText = err.message; }
    if (!threw || !new RegExp(c.missing, "i").test(errText)) {
      failures.push({ ...c, threw, errText });
    }
  }
  return verdict(failures.length === 0 ? "PASS" : "FAIL", { failures });
}
```

**(c) Decision rule:** PASS iff BOTH variants throw AND the thrown message references the missing field name (case-insensitive).

**(d) Failure indicates:** zod required-field enforcement weakened. A missing-field dispatch that reaches `dispatchOneAgent` would crash deeper, producing confusing log noise instead of a clean refusal.

---

### Test case 4 — `fail_fast=true` with one intentional failure

**(a) What:** when the first dispatch lands a real exit-non-zero, every still-pending sibling gets `AbortController.abort()`, the spawned `claude` process receives SIGTERM, and the result returns marked `cancelled` — NOT exit-1.

**(b) Outline:** the failure path must be one the handler validates AFTER `Promise.all` starts, not at pre-validation (pre-validation refuses the whole batch upfront per §3). The cleanest provocateur is a probe that exits with a non-zero status from inside the agent itself. Use a `dep-reader` probe that runs `node -e "process.exit(1)"` in its single Bash call. The sibling is a normal 60s wall-time probe.

```js
async function case04({ client, runId }) {
  const tFail   = buildFailureProbe("FAIL", "dep-reader",       runId);   // exit 1 fast
  const tProbe  = buildSlowProbe("PROBE", "git-state-reader", runId, 60); // 60s sleep
  const t0 = Date.now();
  const res = await client.callTool({
    name: "run_agent_in_docker_batch",
    arguments: {
      fail_fast: true,
      dispatches: [
        { agent_name: "dep-reader", task: tFail, max_turns: 6 },
        { agent_name: "git-state-reader", task: tProbe, max_turns: 6 },
      ],
    },
  });
  const wallMs = Date.now() - t0;
  const body = textOf(res);
  const cancelledMarker = /CANCELLED 🟡|sibling failed/.test(body);
  // Cancelled probe should NOT have hit its full 60s wall.
  const probeLog = findLog("git-state-reader", runId);
  const { entry, exit } = parseEntryExit(probeLog);
  const probeWallMs = exit - entry;
  return verdict(cancelledMarker && probeWallMs < 30_000 && wallMs < 45_000
    ? "PASS" : "FAIL", { wallMs, probeWallMs, body: body.slice(0, 400) });
}
```

**(c) Decision rule:**
- PASS iff response body contains `"CANCELLED"` (or `"cancelled (sibling failed)"`) AND `probeWallMs < 30_000` AND `wallMs < 45_000`.
- FAIL otherwise.

The probe was a 60s sleep; if it ran to completion, fail_fast did nothing. We give 30s slack (10s for SIGTERM propagation + 20s for `[exit]` flush from the docker bash trap).

**(d) Failure indicates:**
- `cancelledMarker === false`: the result formatter didn't apply the `🟡 cancelled` row; `aborted` flag isn't propagating from `dispatchOneAgent` to the body assembler.
- `probeWallMs >= 30_000`: `controllers[j].abort()` is not firing, OR `proc.kill('SIGTERM')` is not being delivered, OR the abort listener in `dispatchOneAgent` is registered but never invoked. Inspect `src/index.js:1875–1885`.
- `wallMs >= 45_000`: even if individual cancellations work, the top-level `Promise.all` may be waiting on a non-resolving promise (the SIGTERM'd container failed to close cleanly).

---

### Test case 5 — `fail_fast=false` (default) with mixed success/failure

**(a) What:** the same setup as Case 4 but with `fail_fast` omitted (defaults to false). The slow probe **runs to completion**; the failing probe surfaces as a per-dispatch failure; the batch tool's overall response is success-shaped (no leading ❌ on the body).

**(b) Outline:**
```js
async function case05({ client, runId }) {
  const tFail  = buildFailureProbe("FAIL", "dep-reader",       runId);
  const tProbe = buildSlowProbe("PROBE", "git-state-reader", runId, 60);
  const t0 = Date.now();
  const res = await client.callTool({
    name: "run_agent_in_docker_batch",
    arguments: {
      // fail_fast omitted — default false
      dispatches: [
        { agent_name: "dep-reader", task: tFail, max_turns: 6 },
        { agent_name: "git-state-reader", task: tProbe, max_turns: 6 },
      ],
    },
  });
  const wallMs = Date.now() - t0;
  const body = textOf(res);
  const failedRow  = /❌ FAILED/.test(body);
  const okRow      = /✅ ok/.test(body);
  const headerOk   = body.startsWith("## Batch dispatch");
  const probeLog = findLog("git-state-reader", runId);
  const { entry, exit } = parseEntryExit(probeLog);
  const probeWallMs = exit - entry;
  return verdict(headerOk && failedRow && okRow && probeWallMs >= 55_000 && wallMs >= 55_000
    ? "PASS" : "FAIL", { wallMs, probeWallMs, headerOk, failedRow, okRow });
}
```

**(c) Decision rule:** PASS iff body begins with `## Batch dispatch` (NOT `❌`), summary table contains both a `✅ ok` row and a `❌ FAILED` row, AND `probeWallMs >= 55_000`.

**(d) Failure indicates:**
- Body starts with `❌`: the batch tool is incorrectly bubbling per-dispatch failure to whole-batch failure — design §3 explicitly forbids this.
- No `✅ ok` row OR `probeWallMs < 55_000`: an unwanted cancellation occurred, meaning `fail_fast=false` is leaking the abort cascade. Check that the `if (fail_fast && ...)` guard at `src/index.js:2162` is exclusive.

---

### Test case 6 — Per-dispatch `max_turns` honored independently

**(a) What:** `max_turns` is per-entry, not per-batch. A small budget runs out where a larger one wouldn't; a generous budget completes normally in the same batch.

**(b) Outline:** use two probes that count turns explicitly. The "small" probe must demand more turns than its budget — it should exhaust and exit with the wrapper's `max_turns_reached` indicator. The "large" probe has a 25-turn budget and a trivial task: it should exit cleanly in ~1 turn.

```js
async function case06({ client, runId }) {
  const tSmall = buildMaxTurnsExhaustionProbe("SMALL", "dep-reader",       runId, /*requested-actions*/ 10);
  const tLarge = buildSimpleProbe("LARGE", "git-state-reader", runId);
  const res = await client.callTool({
    name: "run_agent_in_docker_batch",
    arguments: {
      dispatches: [
        { agent_name: "dep-reader",       task: tSmall, max_turns: 5  },
        { agent_name: "git-state-reader", task: tLarge, max_turns: 25 },
      ],
    },
  });
  const smallLog = findLog("dep-reader",       runId);
  const largeLog = findLog("git-state-reader", runId);
  const smallContent = readFileSync(smallLog, "utf-8");
  const largeContent = readFileSync(largeLog, "utf-8");
  // Look for max_turns markers in the streamed JSON or the wrapper's exit code.
  // The 'claude' CLI surfaces a non-zero exit on max-turns exhaustion.
  const smallExit = /\[exit\].*code=([1-9]\d*)/.exec(smallContent)?.[1];
  const largeExit = /\[exit\].*code=0/.test(largeContent);
  return verdict(smallExit && largeExit ? "PASS" : "FAIL", { smallExit, largeExit });
}
```

**(c) Decision rule:** PASS iff small probe's `[exit]` line shows a non-zero code AND large probe's `[exit]` shows code=0.

**(d) Failure indicates:** if both succeed, the small budget was not applied — probably a hardcoded `max_turns = 30` in `dispatchOneAgent` overriding the spec. Check `src/index.js:1713` destructuring. If both fail, the large budget was clipped — check whether `dispatches[i].max_turns` is being shadowed by a batch-level default.

---

### Test case 7 — Per-dispatch `model` override

**(a) What:** `model: "opus"` and `model: "haiku"` in the same batch result in two different `--model <id>` flags in the spawned docker bash command. Each container's log header reports the resolved model.

**(b) Outline:** the wrapper bash command at `src/index.js:1863` includes `${modelFlag}` literally in the `claude --dangerously-skip-permissions ...` invocation, but the wrapper logs only show `[claude-version]`, not `--model`. We have two viable signals:

1. **Preferred — read the `[claude-version]` line and the message stream:** the streamed JSON includes a `model` field on `assistant` events. Parse the first `assistant` event in each log and assert the `model` matches the expected ID. (Stream-json sample structure verified in `voltron-3y0` notes.)
2. **Fallback if #1 fails:** inject a `bd remember`-style sentinel into the prompt that asks the agent to echo `MODEL=<id>` in its first assistant turn — but this depends on agent compliance with prompt instructions which is fragile.

Use #1.

```js
async function case07({ client, runId }) {
  const tOpus  = buildSimpleProbe("OPUS",  "dep-reader",       runId);
  const tHaiku = buildSimpleProbe("HAIKU", "git-state-reader", runId);
  const res = await client.callTool({
    name: "run_agent_in_docker_batch",
    arguments: {
      dispatches: [
        { agent_name: "dep-reader",       task: tOpus,  max_turns: 6, model: "opus"  },
        { agent_name: "git-state-reader", task: tHaiku, max_turns: 6, model: "haiku" },
      ],
    },
  });
  const opusModel  = firstAssistantModel(findLog("dep-reader",       runId));
  const haikuModel = firstAssistantModel(findLog("git-state-reader", runId));
  return verdict(/opus/i.test(opusModel) && /haiku/i.test(haikuModel)
    ? "PASS" : "FAIL", { opusModel, haikuModel });
}

function firstAssistantModel(logPath) {
  for (const line of readFileSync(logPath, "utf-8").split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.type === "assistant" && ev.message?.model) return ev.message.model;
  }
  return null;
}
```

**(c) Decision rule:** PASS iff the OPUS probe's first `assistant` event reports a model name matching `/opus/i` AND HAIKU's matches `/haiku/i`.

**(d) Failure indicates:** model override is not threading into `dispatchOneAgent` per-call. Check `src/index.js:1729–1731` — the `model` argument should resolve uniquely per spec.

---

### Test case 8 — Max-size batch: 8 agents

**(a) What:** N=8 dispatches all enter their containers within a small skew window, all exit before the batch's wall time grows linearly. This catches handler-internal throttling (e.g. an `await` inside the `dispatches.map` instead of a parallel `Promise.all`).

**(b) Outline:** eight 30-second probes, spread across distinct agent_names to avoid the same-agent-twice path (Case 10 owns that). Pool of slugs: `dep-reader`, `git-state-reader`, `fixture-writer`, `env-var-setter`, `file-patch-runner`, `config-editor`, `mock-writer`, `function-writer`. (All are file-only or read-only templates — see `src/templates.js`.) Verify each exists at session start before running the case.

```js
async function case08({ client, runId }) {
  const slugs = ["dep-reader", "git-state-reader", "fixture-writer", "env-var-setter",
                 "file-patch-runner", "config-editor", "mock-writer", "function-writer"];
  const PROBE_SEC = 30;
  const dispatches = slugs.map((slug, i) => ({
    agent_name: slug,
    task: buildTimedProbe(`P${i}`, slug, runId, PROBE_SEC),
    max_turns: 6,
  }));
  const t0 = Date.now();
  await client.callTool({ name: "run_agent_in_docker_batch", arguments: { dispatches } });
  const wallMs = Date.now() - t0;
  const stamps = slugs.map(s => parseEntryExit(findLog(s, runId)));
  const entries = stamps.map(s => s.entry);
  const exits   = stamps.map(s => s.exit);
  const entrySkewMaxMs = Math.max(...entries) - Math.min(...entries);
  const firstExitAfterAllEnteredMs = Math.min(...exits) - Math.max(...entries);
  return verdict(
    entrySkewMaxMs < 5_000 && firstExitAfterAllEnteredMs > 25_000 && wallMs < 60_000
      ? "PASS" : "FAIL",
    { entrySkewMaxMs, firstExitAfterAllEnteredMs, wallMs },
  );
}
```

**(c) Decision rule (literal):** `entrySkewMaxMs < 5000` AND `firstExitAfterAllEnteredMs > 25000` (= clear overlap window — first exit happens at least 25s after the LAST entry) AND `wallMs < 60000`.

The 25s overlap threshold is conservative for a 30s probe — it leaves 5s slack for container start overhead. The 60s wall ceiling: a serialized 8×30s batch would be ≥240s; even modest throttling (3 parallel) would land near 80s. 60s is safely below any non-parallel regime.

**(d) Failure indicates:**
- `entrySkewMaxMs >= 5000`: the fan-out is starting containers in waves rather than concurrently. Most likely cause: an `await` was added inside the `.map()` callback before `dispatchOneAgent` returns its promise, or `Promise.all` was replaced by `for…of await`.
- `firstExitAfterAllEnteredMs <= 25000`: containers are not running concurrently; their exits are sequenced.
- `wallMs >= 60000`: any of the above, OR Docker daemon is throttling concurrent container starts on this host (preflight should warn).

---

### Test case 9 — Mixed-runtime batch

**(a) What:** a slow dispatch does not block a fast dispatch's `[exit]`. The aggregate wall time is the slowest probe, not the sum.

**(b) Outline:** three probes at 10s, 45s, and 90s.

```js
async function case09({ client, runId }) {
  const dispatches = [
    { agent_name: "dep-reader",       task: buildTimedProbe("FAST", "dep-reader",       runId, 10), max_turns: 6 },
    { agent_name: "git-state-reader", task: buildTimedProbe("MID",  "git-state-reader", runId, 45), max_turns: 6 },
    { agent_name: "fixture-writer",   task: buildTimedProbe("SLOW", "fixture-writer",   runId, 90), max_turns: 6 },
  ];
  const t0 = Date.now();
  await client.callTool({ name: "run_agent_in_docker_batch", arguments: { dispatches } });
  const wallMs = Date.now() - t0;
  const fast = parseEntryExit(findLog("dep-reader",       runId));
  const mid  = parseEntryExit(findLog("git-state-reader", runId));
  const slow = parseEntryExit(findLog("fixture-writer",   runId));
  const fastDurMs = fast.exit - fast.entry;
  const slowDurMs = slow.exit - slow.entry;
  // Fast must exit while slow still running:
  const fastExitedBeforeSlow = fast.exit < slow.exit - 30_000;
  return verdict(
    fastExitedBeforeSlow && fastDurMs < 25_000 && wallMs >= 80_000 && wallMs < 120_000
      ? "PASS" : "FAIL",
    { wallMs, fastDurMs, slowDurMs, fastExitedBeforeSlow },
  );
}
```

**(c) Decision rule:**
- `fast.exit < slow.exit - 30_000` (fast finishes at least 30s before slow does).
- `fastDurMs < 25_000` (fast probe wall time ≤ 25s — its target was 10s + container overhead).
- `wallMs` in `[80_000, 120_000)` — slowest probe is 90s + ~10s setup + ~10s assemble.

**(d) Failure indicates:**
- `fastExitedBeforeSlow === false`: the response assembly path is awaiting all dispatches at the wrong layer (e.g. holding fast's promise open until slow returns). The natural promise semantics should resolve each `dispatchOneAgent` independently; only the `Promise.all` join waits for all.
- `wallMs >= 120_000`: the slow probe is not really running concurrently with the others (3 × 90s = 270s would be full serialization; 120s is the slack ceiling).

---

### Test case 10 — Container collision impossibility (same agent twice)

**(a) What:** dispatching the **same** `agent_name` twice in one batch must produce two distinct containers, two distinct log files, two distinct `tmpFile` paths. The `uniqSuffix` mechanism (`src/index.js:1752`) is the guard; this case asserts it actually fires.

**(b) Outline:** two `dep-reader` probes, each with its own probe role tag. Verify two distinct logs match the runId. Each log must contain only its own role tag.

```js
async function case10({ client, runId }) {
  const tA = buildTimedProbe("ALPHA", "dep-reader", runId, 30);
  const tB = buildTimedProbe("BRAVO", "dep-reader", runId, 30);
  await client.callTool({
    name: "run_agent_in_docker_batch",
    arguments: {
      dispatches: [
        { agent_name: "dep-reader", task: tA, max_turns: 6 },
        { agent_name: "dep-reader", task: tB, max_turns: 6 },
      ],
    },
  });
  const allLogs = readdirSync(LOGS_DIR)
    .filter(f => f.startsWith("dep-reader-") && f.endsWith(".log"))
    .map(f => join(LOGS_DIR, f))
    .filter(p => readFileSync(p, "utf-8").includes(`run-id=${runId}`));
  if (allLogs.length !== 2) return verdict("FAIL", { logCount: allLogs.length });
  const [logA, logB] = allLogs;
  const aHasAlpha = readFileSync(logA, "utf-8").includes("role=ALPHA");
  const aHasBravo = readFileSync(logA, "utf-8").includes("role=BRAVO");
  const bHasAlpha = readFileSync(logB, "utf-8").includes("role=ALPHA");
  const bHasBravo = readFileSync(logB, "utf-8").includes("role=BRAVO");
  const cleanSplit = (aHasAlpha && !aHasBravo && !bHasAlpha && bHasBravo)
                  || (aHasBravo && !aHasAlpha && !bHasAlpha === false /* one of them */);
  // Simplified: exactly one log has ALPHA marker, exactly one has BRAVO.
  const alphaCount = [aHasAlpha, bHasAlpha].filter(Boolean).length;
  const bravoCount = [aHasBravo, bHasBravo].filter(Boolean).length;
  return verdict(allLogs.length === 2 && alphaCount === 1 && bravoCount === 1
    ? "PASS" : "FAIL", { logCount: allLogs.length, alphaCount, bravoCount });
}
```

**(c) Decision rule:** PASS iff `allLogs.length === 2` AND exactly one log contains `"role=ALPHA"` AND exactly one log contains `"role=BRAVO"`.

**(d) Failure indicates:**
- `allLogs.length === 1`: log filenames collided — `uniqSuffix` is not being applied or both dispatches got identical timestamps + suffix. Inspect `src/index.js:1763`.
- One log contains both `ALPHA` and `BRAVO`: the second container wrote into the first's log file (tee race). This is the canonical "fix the uniqSuffix" failure.
- Both logs same content: tmp prompt file collision — both containers read the same `tmpFile` because of identical `tmpFilename`. Check `src/index.js:1755`.

---

### Test case 11 — Pre-warm shared (image-build is one-shot per batch)

**(a) What:** within a batch, `ensureVoltronImage` is called exactly once (§4 of design doc). Across two batches in the same MCP session, the second batch is not faster than the first by orders of magnitude (image already cached at the Docker layer either way). This case is a **soft** perf check; the design contract is that the batch handler doesn't add per-dispatch image inspects.

**(b) Outline:** force a no-cache image build first by removing `voltron-agent` from local Docker registry (`docker rmi voltron-agent` — gated behind an explicit `--allow-rmi` CLI flag the implementer should add, so this case is opt-in for local-only runs). Skip on CI; record `INCONCLUSIVE` if image cannot be removed.

Then run TWO 2-probe batches in succession. Measure wall time of each.

```js
async function case11({ client, runId, opts }) {
  if (!opts.allowRmi) return verdict("INCONCLUSIVE", { reason: "case 11 requires --allow-rmi" });
  try { execSync("docker rmi voltron-agent", { stdio: "ignore" }); } catch { /* tolerate */ }
  const oneBatch = async (tag) => {
    const t0 = Date.now();
    await client.callTool({
      name: "run_agent_in_docker_batch",
      arguments: {
        dispatches: [
          { agent_name: "dep-reader",       task: buildTimedProbe(`${tag}-A`, "dep-reader",       runId, 10), max_turns: 6 },
          { agent_name: "git-state-reader", task: buildTimedProbe(`${tag}-B`, "git-state-reader", runId, 10), max_turns: 6 },
        ],
      },
    });
    return Date.now() - t0;
  };
  const first  = await oneBatch("FIRST");
  const second = await oneBatch("SECOND");
  const delta = first - second;
  // Image build is ~30s for voltron-agent on a typical laptop. If first - second < 5s,
  // either the image was not actually rebuilt OR ensureVoltronImage is skipping work.
  return verdict(delta >= 5_000 && delta <= 60_000 ? "PASS" : "INCONCLUSIVE",
    { first, second, delta });
}
```

**(c) Decision rule:** PASS iff `(first - second)` is in `[5_000, 60_000]` ms. INCONCLUSIVE if `--allow-rmi` was not passed.

**(d) Failure indicates:** if `delta < 5_000`, the docker layer cache short-circuited the rebuild (`docker rmi` may have only removed the tag, not the layer). This is not a batch-tool bug per se — record INCONCLUSIVE and ask the implementer to add a `docker builder prune` step before the `rmi`. If `delta > 60_000`, build is degenerately slow — investigate `Dockerfile.voltron`.

---

### Test case 12 — Output-size pressure (per-dispatch tail bound)

**(a) What:** three dispatches each producing a lot of stdout. The combined response body stays below the SDK's single-tool-result token budget. The per-dispatch tail bound of 40 lines (`src/index.js:2159`, design §2) is the operative limit; the test verifies the limit is observed and the body's size is reasonable.

**(b) Outline:** three probes that each write ~200 lines of marker text. Read the returned content body and assert:
1. Each per-dispatch section's `Output Tail` code fence contains ≤ 40 lines (the design's literal limit).
2. The total body byte size is below a soft ceiling (50 KB — well under the ~25k-token SDK trim point at ~4 bytes/token).

```js
async function case12({ client, runId }) {
  const verbose = (role, slug) => `OUTPUT-SIZE PROBE — role=${role} run-id=${runId}
Step 1 — execute exactly ONE Bash tool call, verbatim:

    node -e "for (let i = 0; i < 200; i++) console.log('LINE-${role}-' + i + '-run-id=${runId}')"

Step 2 — emit exactly ONE final assistant line, verbatim:

    [DONE] verbose probe ${role} run-id=${runId}`;
  const dispatches = [
    { agent_name: "dep-reader",       task: verbose("A", "dep-reader"),       max_turns: 6 },
    { agent_name: "git-state-reader", task: verbose("B", "git-state-reader"), max_turns: 6 },
    { agent_name: "fixture-writer",   task: verbose("C", "fixture-writer"),   max_turns: 6 },
  ];
  const res = await client.callTool({ name: "run_agent_in_docker_batch", arguments: { dispatches } });
  const body = textOf(res);
  const tailFences = [...body.matchAll(/#### Output Tail[^\n]*\n```\n([\s\S]*?)```/g)].map(m => m[1]);
  const tailLineCounts = tailFences.map(t => t.split("\n").filter(l => l.length).length);
  const maxTailLines = Math.max(...tailLineCounts);
  const bodyBytes = Buffer.byteLength(body, "utf-8");
  return verdict(maxTailLines <= 40 && tailFences.length === 3 && bodyBytes < 50_000
    ? "PASS" : "FAIL",
    { maxTailLines, tailLineCounts, bodyBytes });
}
```

**(c) Decision rule:**
- `tailFences.length === 3` (each of three sections has an `Output Tail` block).
- `maxTailLines <= 40` (no section exceeds the design's 40-line bound).
- `bodyBytes < 50_000`.

**(d) Failure indicates:**
- `maxTailLines > 40`: the singleton's 80-line bound (`src/index.js:2048, tailLines: 80`) is being applied to batch dispatches. Inspect the `tailLines: 40` argument at `src/index.js:2159`.
- `tailFences.length < 3`: per-dispatch section assembly is dropping sections when output is large — investigate the `sections.map` join in `src/index.js:2192–2228`.
- `bodyBytes >= 50_000`: even with bounded tails, headers/stderr blocks are over-budget. Inspect whether stderr is being truncated to 20 lines as design §2 prescribes.

---

## 3. Run-id contamination guard

Every probe in every case carries the literal token `run-id=<id>` inside its prompt. `findLog(agentSlug, runId)` scans `.voltron/logs/<agentSlug>-*.log` for files whose contents contain `run-id=<id>` and returns those whose content matches. This is the exact mechanism `scripts/test-parallel-dispatch.mjs` uses (lines 115–137).

**One run-id per script invocation.** All 12 cases share a single run-id, distinguished from each other by **role tags** embedded in the prompt (`role=ALPHA`, `role=FAIL`, `role=P0`, etc.). This means a single `runId` plus a probe-internal role tag uniquely identifies any log.

**Why one run-id and not one per case:** a per-case run-id rotation introduces 12 separate find-log windows; if one case leaks logs into another's parser window, debugging is hard. With one run-id, every log file for the run carries the same token, and case-specific filtering is by role tag inside the matched files.

**Multi-match guard:** `findLog` already throws on `matches.length > 1` (line 131–134 of the singleton test). Reuse that guard. Case 10 (same agent twice) is the **only** case that legitimately expects two matching logs for the same slug + runId; it bypasses `findLog` and reads directly from `readdirSync(LOGS_DIR)`.

**Cleanup posture:** no log deletion at end of run. The harness contributes to `.voltron/logs/` like every other dispatch; users and CI prune as they prefer. Test-run log artifacts are valuable evidence for failure debugging.

---

## 4. Acceptance criteria for the implementer

A harness-engineer dispatch implements `scripts/test-batch-tool-comprehensive.mjs`. Mechanical acceptance checks the implementer (and a downstream reviewer) can run:

| # | Criterion | Verification command |
|---|---|---|
| 1 | File exists at the specified path | `test -f scripts/test-batch-tool-comprehensive.mjs` |
| 2 | File parses as valid JS | `node --check scripts/test-batch-tool-comprehensive.mjs` (exit 0) |
| 3 | All 12 test cases implemented | `grep -c "Case [0-9]" scripts/test-batch-tool-comprehensive.mjs` ≥ 12 OR programmatic `CASES.length === 12` |
| 4 | Each case returns `{ name, verdict, evidence }` | code review |
| 5 | A summary table is printed at end of run | `node scripts/test-batch-tool-comprehensive.mjs --help` shows the format; an actual run prints `=== run_agent_in_docker_batch — comprehensive test summary ===` |
| 6 | Exit code is 0 iff all PASS, 1 if any FAIL | run twice: once on clean main (expect 0); once with `Promise.all` replaced by `for ... of await` in `run_agent_in_docker_batch` handler (expect 1 — Case 8 must FAIL) |
| 7 | Sequential case execution (not parallel) | code review — `await` inside a `for` loop, NOT `Promise.all(CASES.map(...))` |
| 8 | Run-id contamination guard active | code review — every probe prompt builder includes `run-id=${runId}` literally |
| 9 | No raw `sleep N` in probes | `grep -E "sleep [0-9]" scripts/test-batch-tool-comprehensive.mjs` returns no probe-shell matches |
| 10 | Script is documented | `--help` flag prints the case list with one-line descriptions |
| 11 | Pre-warm step before first measured case | code review — exactly one `await prewarm(client)` call before the case loop |
| 12 | Idempotent across reruns (no test pollution) | run the script twice in a row from a clean state; both runs PASS |

Additional sensitivity checks the implementer should manually demonstrate before reporting complete:

- **Case 4 sensitivity:** introduce a one-line patch that deletes the `for (let j = 0; j < controllers.length; j++) controllers[j].abort()` block; rerun; Case 4 must FAIL. Revert.
- **Case 8 sensitivity:** replace `Promise.all(promises)` with `for (const p of promises) await p` (i.e. force serial await); rerun; Case 8 must FAIL with `entrySkewMaxMs >> 5000`. Revert.
- **Case 12 sensitivity:** change `tailLines: 40` to `tailLines: 800` at `src/index.js:2159`; rerun; Case 12 must FAIL with `maxTailLines > 40`. Revert.

These three are the "tests test the tests" checks — they confirm the harness is sensitive enough to catch regressions in the dimensions the design doc cares about.

---

## 5. DO NOT (binding on the implementer)

- **DO NOT** modify the existing `scripts/test-parallel-dispatch.mjs` or `scripts/test-parallel-dispatch-batch.mjs`. Those are the green baselines; the new harness is additive.
- **DO NOT** change the singleton `run_agent_in_docker` tool's behavior. If a probe needs a singleton call, it uses the singleton as-is. If a Case requires a singleton-side change to be testable, file a new bead instead of modifying the singleton inline.
- **DO NOT** modify `src/index.js` or `src/templates.js` from this PR. The test plan is verification of behavior that already shipped (the batch tool registration + the `dispatchOneAgent` extraction). If a test case reveals a real bug, the fix is a separate PR.
- **DO NOT** introduce `process.exit` calls inside test-case functions. Only `main()` exits; cases return their verdicts.
- **DO NOT** weaken any decision rule's threshold to make a flaky case pass. If a threshold is wrong, either fix the threshold with documented rationale or mark the case INCONCLUSIVE and explain why. Silent threshold loosening is the surest way to ship a harness that never catches anything.
- **DO NOT** add `Promise.all` across test cases at the top level. Sequential execution is mandatory (see §1.2 rationale).
- **DO NOT** delete `.voltron/logs/` entries during or after a test run. Logs are evidence; users and CI prune them on their own schedule.
- **DO NOT** assume probe agents will follow instructions perfectly. Probes use the wrapper's machine-emitted `[entry]`, `[claude-version]`, `[exit]` lines for timing (those are bash-emitted in the docker `bash -c`, NOT model output — they cannot be forged or skipped by the agent). When you need agent compliance (e.g. role tag in stdout for Case 10), use defense in depth: also assert on bash-emitted markers when possible.
- **DO NOT** use `sleep N` in probes; use `node -e "setTimeout(() => console.log('marker'), N * 1000)"`. The reason is in `voltron-0in` post-mortems: `sleep` inside the `bash -c` wrapped invocation has interacted poorly with nested-dispatch contexts in past test iterations. `node -e setTimeout` is portable and verified.
- **DO NOT** treat INCONCLUSIVE as PASS for the script's exit code. INCONCLUSIVE means the harness could not measure — that is a harness-quality regression even if the underlying tool works. Exit 1 on any non-PASS verdict.
- **DO NOT** add a watch/`--reruns N` mode for flakiness mitigation. If a case is flaky, fix the threshold or the probe. A retry loop hides intermittent regressions.
- **DO NOT** rename or re-version the existing baseline scripts. The naming convention `test-parallel-dispatch.mjs` (singleton baseline), `test-parallel-dispatch-batch.mjs` (one-case batch smoke), `test-batch-tool-comprehensive.mjs` (this plan's deliverable) is stable; tooling and `package.json` scripts reference these by name.
- **DO NOT** push to remote during implementation without the user's explicit approval (per CLAUDE.md "Things Claude Should Never Do").
- **DO NOT** bump `package.json` version from this PR. The test harness is verification infrastructure, not a tool-surface change.

---

## Open questions for human input

These need user decision before the harness-engineer can implement.

1. **`package.json` script wiring.** Should the new harness wire into `npm run test:parallel` (already in design §6 of the companion doc) as a third step? **Planner recommendation:** yes — extend the script to `test:parallel-dispatch && test:parallel-dispatch-batch && test:batch-tool-comprehensive`. Failing CI early on any of the three preserves regression-guard semantics.
2. **CI runtime budget.** The full 12-case harness wall time is roughly: 30s prewarm + ~10s per schema rejection × 3 + ~60s per fail_fast case × 2 + ~30s for Case 6/7 + ~60s for Case 8 + ~120s for Case 9 + ~60s for Case 10 + ~30s for Case 12 = ~8 minutes. Case 11 (image rebuild) adds ~60s when `--allow-rmi` is passed. Acceptable for nightly CI; possibly slow for per-PR. **Planner recommendation:** run the new harness nightly; keep the existing 2-case batch test on every PR.
3. **Case 7 model-detection method.** Stream-JSON model field detection (preferred) vs sentinel-echo (fallback). **Planner recommendation:** stream-JSON. If `event.message.model` is unreliable on the current `claude` CLI version, fall back to wrapping each probe with `claude --version` output inspection. Implementer to confirm during build-out.
4. **Case 11 `--allow-rmi` default.** Off by default so accidental runs don't trigger 30+s rebuilds. Implementer to confirm gating logic.
5. **Probe agent_name selection.** Cases 8 and 9 use a pool of 8 templated agents. If any of those templates change drastically (e.g. become non-Bash-permissive), the probes break. **Planner recommendation:** include a startup check that all probe agent_names exist in TEMPLATES and have category=="agent"; abort with a clear error if not.

---

## Summary for handoff

This plan specifies 12 test cases that comprehensively verify `run_agent_in_docker_batch` against the §1–§7 contracts of `docs/run-agents-batch-design.md`. Cases 1–3 cover MCP-schema rejections; Cases 4–5 cover `fail_fast` semantics; Cases 6–7 cover per-dispatch independence of `max_turns` and `model`; Case 8 verifies max-size concurrency; Case 9 verifies head-of-line non-blocking under mixed runtimes; Case 10 verifies collision-safety with duplicate agent_names; Case 11 verifies image-build is one-shot per batch; Case 12 verifies bounded output under verbose dispatches. Each case has a concrete PASS/FAIL/INCONCLUSIVE decision rule with literal thresholds, a brief pseudocode outline anchored on existing parsers, and an explicit "which layer broke" failure interpretation. The implementer's mandate is in §4 (acceptance) and §5 (DO NOT).

Plan saved to `docs/run-agents-batch-test-plan.md`. Invoke `/scrum-master` with this plan to dispatch a `harness-engineer` implementation of `scripts/test-batch-tool-comprehensive.mjs`.

[DONE] Wrote docs/run-agents-batch-test-plan.md covering all 12 test cases with verification outlines, PASS/FAIL thresholds, layer-failure interpretation, acceptance criteria, DO NOT list, and open questions.
