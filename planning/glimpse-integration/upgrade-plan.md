# Glimpse Integration — Upgrade Plan

> **Status:** Backlog design (planner output). Not yet decomposed into tasks.
> **Author:** project-planner · **Date:** 2026-06-19 · **Voltron version at design time:** v3.15.1 (`package.json`)
> **Companion repo:** [`7ports/voltron-glimpse`](https://github.com/7ports/voltron-glimpse) (PUBLIC, separate repo; impl branch `feat/glimpse-implementation`)
> **Next step:** hand to `/scrum-master` for work-breakdown.

This plan turns **voltron-glimpse** from an optional, best-effort companion visualizer into a **mandatory, deeply-wired component of Project Voltron** — on the same footing as beads, stringer, and alexandria. It does that by (a) closing the four honest limitations Glimpse's own README documents, all of which are rooted in *Voltron not writing things to disk*, and (b) making Glimpse a scaffolded, version-pinned, pre-flighted, auto-launchable dependency that the orchestrator requires.

---

## Background — what Glimpse is and why it's currently limited

Glimpse (`voltron-glimpse`, Node 20+, CommonJS, no build step) is a **strictly read-only** real-time visualizer. Run at a Voltron project root it:

- polls the Docker daemon every `--poll` ms (default `1000`) for containers named `voltron-*`;
- tails `<root>/.voltron/logs` read-only for `[STEP N]` / `[DONE]` lines;
- sizes graph nodes by **agent tier** from a **baked-in frozen tier snapshot** shipped inside Glimpse;
- draws **dashed "inferred dispatch"** edges (marching-ants while the target is active);
- serves an HTTP + WebSocket UI bound strictly to `127.0.0.1:7424` (`--port` overridable, auto-increments up to +50), with `--no-open`, `--root <path>`, `--docker`/`--no-docker`, `--poll <ms>`, `--verbose` flags.

Its four documented limitations all trace back to one root cause — **Voltron never persists its orchestration graph to disk**:

| # | Glimpse limitation (from its README) | Root cause in Voltron |
|---|--------------------------------------|------------------------|
| L1 | Dispatch edges are **inferred from timing**, not authoritative | `dispatchOneAgent` (`src/index.js:1758-2130`) never records parent→child parentage to disk |
| L2 | Tier map is a **baked-in snapshot** that drifts; unknown agents default to Tier 3 | Tiers live only in template *prose* (`src/templates.js` scrum-master table ~`:1074-1078`); no machine-readable tier field, no exported registry |
| L3 | **Present-tense only** — no history/replay | Voltron emits live `[STEP]` log lines but no append-only dispatch event stream |
| L4 | Glimpse is a **separate repo, not installed/managed by Voltron** | No scaffold entry, no version pin, no pre-flight, no launcher, no docs |

The integration is therefore **mostly a Voltron-side "emit authoritative state to disk" project**, plus thin Glimpse-side "read the authoritative files instead of guessing" changes, plus the mandatory-dependency wiring that mirrors the beads/stringer/alexandria pattern already in the codebase.

---

## Goals & Scope

### Goals

1. **Make dispatch edges authoritative (fixes L1).** Voltron writes a parent→child dispatch record to disk at spawn and updates it at exit. Glimpse reads it and draws solid, real edges instead of timing-inferred dashed ones.
2. **Make the tier map authoritative (fixes L2).** Voltron becomes the single source of truth for the agent→tier map, exported both as an MCP tool and as a scaffolded on-disk file. Glimpse reads it; nothing is baked in or drifts.
3. **Enable run history (fixes L3).** The dispatch record is an append-only event log, giving Glimpse the substrate for a history/replay view.
4. **Make Glimpse mandatory & managed (fixes L4).** Version-pinned, scaffolded, pre-flight-checked (`setup_voltron` + scrum-master), auto-launchable, and documented in `CLAUDE.md` / `README.md` / `docs/index.html` — exactly like beads/stringer/alexandria.

### In scope

- New on-disk artifacts under `.voltron/`: a dispatch event log and an exported agent registry (incl. tiers).
- A machine-readable `tier` (and `nestable`) field on every template object, plus an exporter.
- Engine changes in `dispatchOneAgent` and the batch tool to emit parentage + lifecycle events.
- Parent-identity propagation into containers so **nested** dispatch parentage is correct, not inferred.
- A new MCP tool to expose the registry, and an optional `launch_glimpse` tool / launcher script.
- `scaffold_project`, `setup_voltron`, gitignore, allowlist, and scrum-master pre-flight wiring.
- Docs: `CLAUDE.md`, `README.md`, `docs/index.html`.
- **Cross-repo (flagged):** the Glimpse-side reads of the new files (registry, dispatch log, history mode).

### Out of scope

- Replacing Glimpse's Docker-poll liveness detection (it stays; the dispatch log *augments* it, edges become authoritative but node liveness still comes from `docker ps`).
- Any write access from Glimpse into `.voltron/` — **Glimpse stays strictly read-only** (hard contract; see Risks).
- Auth / remote exposure of the Glimpse server (stays `127.0.0.1`-only).
- Bundling/forking Glimpse into the project-voltron repo (it remains a separate, version-pinned dependency).
- A general metrics/telemetry pipeline — the dispatch log is for visualization, not billing.

---

## Integration Architecture

The unifying idea: **Voltron already knows the full orchestration graph at dispatch time; it simply throws that knowledge away.** Every seam below is about persisting what Voltron already computes, into the `.voltron/` directory Glimpse already watches.

### (a) Authoritative dispatch parentage — the dispatch event log

**The seam.** Every container is created in `dispatchOneAgent` (`src/index.js:1758-2130`):
- container name is computed at `src/index.js:1840` — `voltron-${safeAgentName}-${ts}-${uniqSuffix}`;
- tier/depth is already known via `VOLTRON_DEPTH` (set for the child at `src/index.js:1947`, read at `:2161`/`:2252`);
- the process spawns at `src/index.js:1995` and resolves/closes at `:2080`;
- the batch tool groups dispatches under a `batchId` (`src/index.js:2248`).

**What's missing — the parent's own identity.** For top-level dispatches the parent is the main session (scrum-master). For **nested** dispatches the parent is the container that called `run_agent_in_docker`; today that container only knows itself via `os.hostname()` (`src/index.js:1953`, the Docker-assigned container *ID*), which is **not** the `voltron-*` *name* Glimpse keys on. So we must propagate the assigned name inward.

**Design:**

1. **Propagate parent identity into every container.** In the `voltronEnvArgs` block (`src/index.js:1943-1948`) add `-e VOLTRON_CONTAINER_NAME=${containerName}`. The agent's in-container MCP server reads this as `process.env.VOLTRON_CONTAINER_NAME` and uses it as the **parent** field when *it* dispatches a nested child. Top-level dispatches (no such env var) record parent as a stable sentinel, e.g. `"main-session"` / `"scrum-master"`.

2. **Write an append-only event log** at `.voltron/dispatches.jsonl` (JSON Lines; append-only is concurrency-safe under the parallel batch fan-out — each line is one `fs.appendFile`). Emit two events per dispatch from `dispatchOneAgent`:
   - **`dispatch_start`** — written just before/after spawn (`src/index.js:~1992`):
     ```jsonc
     { "event": "dispatch_start", "ts": "2026-06-19T...Z",
       "container": "voltron-fullstack-dev-2026-...-ab12cd",   // == --name, the key Glimpse uses
       "agent": "fullstack-dev", "tier": 2, "depth": 1,
       "parent": "voltron-scrum-...|main-session",              // from VOLTRON_CONTAINER_NAME
       "batchId": "lz1-9f3a|null", "model": "sonnet",
       "log": ".voltron/logs/fullstack-dev-2026-...-ab12cd.log" }
     ```
   - **`dispatch_end`** — written in the `proc.on("close")` path (`src/index.js:2080-2084`):
     ```jsonc
     { "event": "dispatch_end", "ts": "...", "container": "voltron-fullstack-dev-...",
       "status": 0, "ok": true, "aborted": false, "durationMs": 41200 }
     ```
   Join key is `container` (identical to Docker `--name`), so Glimpse correlates the log line, the `docker ps` node, and the dispatch edge with zero inference.

3. **Glimpse-side (cross-repo):** replace timing-inference with a tail of `.voltron/dispatches.jsonl`. `parent → container` becomes a **solid authoritative edge**; keep the dashed style only as a fallback when the file is absent (older Voltron). Node liveness still comes from `docker ps`; the dispatch log supplies the *edges* and *tier/agent labels*.

**Why JSONL, why `.voltron/`:** Glimpse already watches `.voltron/logs` read-only; `.voltron/` is the natural, already-bind-mounted (`/workspace`, `src/index.js:1958`) location, reachable identically for nested (`--volumes-from`, `:1954`) and top-level dispatch. Append-only sidesteps multi-writer races from `run_agent_in_docker_batch`'s `Promise.all` fan-out (`src/index.js:2345`).

### (b) Authoritative tier map — exported agent registry

**The seam.** Tiers exist only as prose today (scrum-master template table, `src/templates.js` ~`:1074-1078`; tier discipline throughout templates). The engine reads `t.content/.category/.model/.nestable/.tags/.destination/.name` off each template (`src/index.js:1768-1790`) but **there is no `tier` field**. Glimpse compensates with a baked-in snapshot (L2).

**Design:**

1. **Add a machine-readable `tier` field to every `agent` template** in `src/templates.js` (`1` = coordinator: scrum-master, code-analyst, doc-writer; `2` = sub-manager: fullstack-dev, csharp-dev, devops-engineer, qa-tester, scene-architect…; `3` = micro-agent: the ~51 single-verb agents). This is data entry guided by the existing tier table — it makes the prose contract executable. (Optionally also surface the existing `nestable` flag.)
2. **Export the registry two ways:**
   - **New MCP tool `get_agent_registry`** (sibling of `list_templates`, register near `src/index.js:300`) returning `{ version, agents: [{ name, tier, model, nestable, category, tags }] }`. Lets a live consumer pull the current map over MCP.
   - **Scaffold/refresh an on-disk file `.voltron/agent-registry.json`** so Glimpse can read it with zero MCP dependency. Write it in `scaffold_project` (`src/index.js:407-674`) and refresh opportunistically at dispatch time (cheap: derived from `TEMPLATES`, write-if-changed). Stamp it with `VERSION` (`src/index.js:38`) so Glimpse can detect drift.
3. **Glimpse-side (cross-repo):** read `.voltron/agent-registry.json` for node sizing; fall back to the baked-in snapshot only when the file is missing. Unknown-agent-defaults-to-Tier-3 behavior is retained as the last-resort fallback.

### (c) Optional run history

The `.voltron/dispatches.jsonl` event log from (a) **is** the history substrate — append-only, timestamped start/end events keyed by container. No extra Voltron work is required beyond (a) for a minimal history; this section is about the *consuming* feature.

**Design (mostly Glimpse-side, cross-repo):**
- Glimpse gains a `--history` / replay mode that reconstructs the graph timeline from `.voltron/dispatches.jsonl` (and the matching `.voltron/logs/*.log` step lines) without requiring live containers.
- **Voltron-side (optional, low-priority):** add lightweight rotation/size-capping for `dispatches.jsonl` (e.g. roll at N MB to `dispatches.<date>.jsonl`) to bound disk usage on long-lived repos. Mirror the existing tail/size guards philosophy (`MAX_TAIL_CHARS`, 10 MB stdout cap at `src/index.js:2068`).

### (d) How Voltron launches & manages Glimpse

Glimpse is a host-side Node process (it talks to the host Docker daemon and binds `127.0.0.1`); it does **not** run inside the agent containers. So Voltron manages it from the orchestrator/host side:

1. **Launcher script** `scripts/voltron-glimpse.sh` (scaffolded like `scripts/voltron-run.sh`, `src/index.js:436`): runs the version-pinned Glimpse (`npx github:7ports/voltron-glimpse#<pinned-ref>`) at the detected project root, honoring `--root`, `--no-open` (for headless/CI), and a port arg.
2. **Optional MCP tool `launch_glimpse`** (register near the other tools in `src/index.js`): spawns the launcher **detached** (non-blocking — unlike the blocking `run_agent_in_docker`), returns the resolved URL (`http://127.0.0.1:<port>`), and is idempotent (detects an already-listening port, auto-increment behavior matches Glimpse's own +50). This gives the scrum-master a one-call "bring up the dashboard" affordance.
3. **Version pinning:** pin a specific Glimpse git ref (tag or commit SHA) in **one** place that both the launcher and the pre-flight read — see Making Glimpse Mandatory. Pinning protects against the documented moving target (`#feat/glimpse-implementation` today → `main` post-merge).

---

## Making Glimpse Mandatory

This section mirrors, line-for-line, the existing **beads / stringer / alexandria** mandatory-dependency pattern so Glimpse becomes a first-class required dependency rather than an optional companion.

### 1. Version pin (single source of truth)
- Define one constant, e.g. `GLIMPSE_PINNED_REF` (a tag/SHA on `7ports/voltron-glimpse`) co-located with the other infra constants at the tail of `src/templates.js` (`~:9909-10107`, beside `DOCKERFILE_CONTENT` / `VOLTRON_RUN_SCRIPT`). Both the launcher script content and the `setup_voltron`/scrum-master checks reference it. Record the pin and its bump policy in `CLAUDE.md`.

### 2. `setup_voltron` pre-flight (mirror beads/stringer/alexandria)
- In `setup_voltron` (`src/index.js:1424-1708`), add a Glimpse block alongside the existing `blockingFailures` checks (`src/index.js:1533-1635`):
  - probe availability (e.g. `npx --yes github:7ports/voltron-glimpse#<ref> --version`, or check a globally-installed `voltron-glimpse`);
  - on success: `glimpseStatus = "✓ Installed (pinned <ref>)"`; on failure push a `blockingFailures` entry with `why` / `install` / `alt` exactly like beads (`:1549-1554`):
    - **install:** `npm install -g github:7ports/voltron-glimpse#<pinned-ref>`
    - **alt:** `npx github:7ports/voltron-glimpse` (no global install)
  - add a `- **Glimpse (mandatory):** ${glimpseStatus}` row to the health-check report (`src/index.js:1682-1704`).
- Node-version note: Glimpse needs Node 20+; `setup_voltron` already reports Claude/Docker — add a Node-version note in the Glimpse row if below 20.

### 3. `scaffold_project` changes (`src/index.js:407-674`)
- **Write `scripts/voltron-glimpse.sh`** (add to the `files.push(...)` block at `src/index.js:435-436`; `chmod 0o755` like `voltron-run.sh` at `:538-543`).
- **Write `.voltron/agent-registry.json`** (the exported tier map from Integration §b).
- **gitignore (`src/templates.js` `voltronGitignoreBlock`, current entries listed in `.gitignore:12-26`):** add `.voltron/dispatches.jsonl` and `.voltron/agent-registry.json` and any `dispatches.*.jsonl` rotations to the Voltron-managed block so the new artifacts aren't accidentally committed (matching the existing `.voltron/logs/`, `.voltron/progress.json` treatment).
- **Allowlist (`VOLTRON_ALLOW`, applied in `setup_voltron` at `src/index.js:1450/1499`):** add the npx/glimpse launch command and `scripts/voltron-glimpse.sh` so the orchestrator can launch it without a permission prompt.
- **Next Steps output (`src/index.js:656-665`):** add a "Launch the dashboard: `bash scripts/voltron-glimpse.sh` (or call `launch_glimpse`)" step.

### 4. scrum-master pre-flight (require + launch)
- The scrum-master mandatory-deps STOP block lives in the template (`src/templates.js` ~`:1300-1312`, the beads/stringer "STOP and install if missing" prose) and the slash-command mirror (`.claude/commands/scrum-master.md`, session-start preflight ~lines 92+). Add a **Glimpse** bullet to both:
  - On session start, after the beads/stringer/alexandria checks, verify Glimpse is installed (pinned ref). If missing → STOP with the same wording pattern: *"voltron-glimpse is mandatory and not installed. Run `npm install -g github:7ports/voltron-glimpse#<ref>` and retry."*
  - If installed → **auto-launch** it (call `launch_glimpse` / run the launcher detached with `--no-open` when headless) and surface the URL in the session-start summary and a `append_journal` `session_start` entry.
- This makes the live dashboard a default part of every orchestrated session, not an opt-in.

### 5. Documentation (CLAUDE.md "Documentation Rule" — same-commit updates)
- **`CLAUDE.md`:** the "three external tools" framing (the mandatory-deps language echoed in templates at `src/templates.js:28/303/572`) becomes **four** — add Glimpse to the mandatory-dependency list and document `GLIMPSE_PINNED_REF` + bump policy.
- **`README.md`:** add Glimpse to the mandatory-dependencies table (beside beads/stringer rows, `src/templates.js:32-33` style), document `launch_glimpse`, `get_agent_registry`, `.voltron/dispatches.jsonl`, and `.voltron/agent-registry.json`. (While here, fix the known `start_agent_in_docker` doc drift flagged in `engine-inventory.md` Part A notes.)
- **`docs/index.html`:** bump the MCP-tool count (currently "18 MCP tools" per engine-inventory; +`get_agent_registry` +optional `launch_glimpse`), add a Glimpse feature/section and version badge.

---

## Sequencing & Dependencies

Work splits across **two repos**. ⚠ **Cross-repo items are flagged** — they require a coordinated change in `7ports/voltron-glimpse` and cannot be validated solely from project-voltron.

### Phase 0 — Foundations (Voltron, no behavior change yet)
- Add `tier` (+ optionally `nestable`) field to every `agent` template in `src/templates.js`.
- Define `GLIMPSE_PINNED_REF` infra constant.
- **Parallelizable:** tier-field data entry can be split across template groups; pin constant is independent.
- **No dependencies.** Lands first; everything else builds on the tier data.

### Phase 1 — Authoritative state emission (Voltron)
- Implement `.voltron/dispatches.jsonl` start/end events in `dispatchOneAgent` (Integration §a).
- Propagate `VOLTRON_CONTAINER_NAME` into containers (`src/index.js:1943-1948`) for correct nested parentage.
- Implement `get_agent_registry` MCP tool + `.voltron/agent-registry.json` writer (Integration §b).
- **Depends on Phase 0** (needs the `tier` field).
- The dispatch-log work and the registry-export work are **parallelizable** with each other.

### Phase 2 — Mandatory wiring & launch (Voltron)
- `scaffold_project`: write launcher + registry, update gitignore + allowlist + Next Steps.
- `setup_voltron`: add Glimpse blocking-failure check + report row.
- `launch_glimpse` MCP tool + `scripts/voltron-glimpse.sh`.
- scrum-master template + `.claude/commands/scrum-master.md` pre-flight + auto-launch.
- **Depends on Phase 1** (launcher/registry artifacts must exist; pre-flight references the pin).

### Phase 3 — Docs & version bump (Voltron)
- `CLAUDE.md`, `README.md`, `docs/index.html` updates; fix `start_agent_in_docker` drift; bump `package.json` (minor — new MCP tool + new mandatory dep per the versioning table in `CLAUDE.md`).
- **Depends on Phases 1–2** (documents the shipped behavior). Per the "Documentation Rule", docs ideally land **in the same commits** as the code they describe rather than as a trailing phase — scrum-master should fold doc edits into each phase's tasks.

### Phase G — Glimpse-side consumption ⚠ CROSS-REPO (`7ports/voltron-glimpse`)
- Read `.voltron/dispatches.jsonl` → solid authoritative edges (fixes L1); dashed style demoted to fallback.
- Read `.voltron/agent-registry.json` → tier sizing (fixes L2); baked-in snapshot demoted to fallback.
- `--history`/replay mode over the event log (fixes L3).
- **Depends on Phase 1's on-disk file shapes being frozen.** Can proceed in parallel with Voltron Phases 2–3 **once the JSONL/registry schemas are agreed.** ⚠ Requires a Glimpse maintainer / a separate PR in that repo; flag for scrum-master that this is not closeable within project-voltron.

**Critical path:** Phase 0 → Phase 1 (freeze file schemas) → {Phase 2 + Phase 3 + Phase G in parallel}. The **file-schema freeze at the end of Phase 1 is the key coordination point** between the two repos.

---

## Risks & Open Decisions

Flagged for the user / scrum-master — these are choices a human should confirm before or during decomposition.

1. **Auto-launch vs. opt-in (DECISION).** Should the scrum-master auto-launch Glimpse on every session start (default-on dashboard), or only when explicitly asked? Auto-launch maximizes the "deeply integrated" intent but spawns a host process and opens a browser tab each session. *Planner recommendation:* auto-launch with `--no-open` (no browser pop), print the URL; let the user open it. Headless/CI must use `--no-open`.

2. **Read-only contract (CONSTRAINT, not negotiable).** Glimpse must remain strictly read-only over `.voltron/`. The architecture honors this: **Voltron writes** `dispatches.jsonl` + `agent-registry.json`; **Glimpse only reads** them. Any proposal to have Glimpse write state must be rejected — it would break its core invariant and risk corrupting orchestration data.

3. **Performance of writing parentage (RISK).** Each dispatch adds two `fs.appendFile` calls. Under an 8-wide `run_agent_in_docker_batch` fan-out that's ≤16 tiny appends — negligible vs. multi-minute container runtimes, and append-only avoids lock contention. *Open:* confirm no measurable added latency in an eval run; cap/rotate the JSONL (Integration §c) to bound disk on long-lived repos.

4. **Cross-repo coordination (RISK).** Phase G lives in a separate public repo on an unmerged feature branch (`feat/glimpse-implementation`). The integration's user-visible payoff (real edges, real tiers) is only realized when *both* repos ship. *Open:* who owns the Glimpse PR? Is there a maintainer, or does Voltron's team also own Glimpse? scrum-master should treat Phase G as externally-blocked and verify the file-schema contract is frozen first.

5. **Version-pin source & bump policy (DECISION).** Pin to a Glimpse **tag** (needs Glimpse to cut releases) or a **commit SHA** (works today, less readable)? *Planner recommendation:* SHA now (branch is unmerged), migrate to a semver tag once Glimpse merges to `main`. Document the bump trigger in `CLAUDE.md`.

6. **`launch_glimpse` ownership (DECISION).** Should launching be an MCP tool (`launch_glimpse`, callable by scrum-master), a plain script only, or both? *Planner recommendation:* both — script for humans/CI, MCP tool for the orchestrator's auto-launch. The tool must spawn **detached/non-blocking** (contrast `run_agent_in_docker`, which blocks until container exit).

7. **Tier field as a hard contract (RISK).** Adding `tier` to 73 templates introduces a new implicit shape contract (engine-inventory B3.2 already warns the template object-shape contract is unguarded). *Open:* add a tiny validation (a test or a `setup_voltron` self-check) asserting every `agent` template has a valid `tier ∈ {1,2,3}` so the registry can't silently regress.

8. **Degraded-mode coherence (MINOR).** Glimpse's `--no-docker` mode infers liveness from log mtime. With authoritative edges from `dispatches.jsonl`, `--no-docker` actually gets *better* (edges no longer guessed). Confirm Glimpse uses the dispatch log in both `--docker` and `--no-docker` modes.

---

## Acceptance / Definition of Done

Each integration point has a concrete, verifiable check. ⚠ marks checks that require the Glimpse repo and cannot be closed from project-voltron alone.

### (a) Authoritative dispatch parentage
- After a `run_agent_in_docker` call, `.voltron/dispatches.jsonl` contains a `dispatch_start` **and** a matching `dispatch_end` line for the run, keyed by the exact container `--name` (`grep` the container name in both the log filename and the JSONL).
- After a `run_agent_in_docker_batch` of N agents, the JSONL contains N start + N end events sharing one `batchId`; no torn/interleaved lines (each line parses as valid JSON).
- A **nested** dispatch (Tier-2 → Tier-3) records the parent container's `voltron-*` name (not a Docker ID, not `main-session`) in the child's `parent` field — verified by inspecting a depth-1→depth-2 run's events.
- ⚠ Glimpse renders a **solid** edge for a recorded parentage and falls back to dashed only when `dispatches.jsonl` is absent.

### (b) Authoritative tier map
- Every `agent` template in `src/templates.js` has `tier ∈ {1,2,3}`; a validation/test fails if any is missing or out of range.
- `get_agent_registry` returns one entry per agent with `{name, tier, model, nestable, category}` and a `version` stamp matching `package.json`.
- `scaffold_project` writes `.voltron/agent-registry.json` whose contents equal the `get_agent_registry` payload.
- ⚠ Glimpse sizes nodes from `.voltron/agent-registry.json` and only uses its baked-in snapshot when the file is absent.

### (c) Run history
- `.voltron/dispatches.jsonl` survives across sessions (append-only) and a sequence of dispatches reconstructs a correct start/end timeline by `ts`.
- Optional rotation (if implemented) rolls the file at the configured cap without losing events.
- ⚠ Glimpse `--history` mode reconstructs a past run's graph from the JSONL with no live containers.

### (d) Launch & management
- `bash scripts/voltron-glimpse.sh` starts Glimpse at the detected root, pinned ref, on `127.0.0.1`, honoring `--no-open`.
- `launch_glimpse` (if built) returns a reachable `http://127.0.0.1:<port>` URL, is idempotent against an already-running instance, and returns **without blocking** the session.

### Mandatory wiring
- `setup_voltron` reports a `Glimpse (mandatory)` row; with Glimpse uninstalled it appears in the `MANDATORY DEPENDENCIES MISSING` section with correct install/alt commands; reinstalling clears it.
- A fresh `scaffold_project` run produces `scripts/voltron-glimpse.sh` (executable), `.voltron/agent-registry.json`, gitignore entries for the new artifacts, and the allowlist additions.
- The scrum-master session-start pre-flight STOPs when Glimpse is missing and auto-launches (URL surfaced + journaled) when present.

### Docs & version
- `CLAUDE.md`, `README.md`, `docs/index.html` list Glimpse as a mandatory dependency, document the new tool(s) and on-disk files, and the MCP-tool count is updated; the stale `start_agent_in_docker` reference is fixed.
- `package.json` version is bumped (minor) and matches the version stamped into `get_agent_registry` / the registry file.

---

## Concrete file-touch index (for scrum-master decomposition)

| Concern | File(s) & anchor |
|---------|------------------|
| Dispatch event log + parent env | `src/index.js:1758-2130` (esp. `:1840` name, `:1943-1948` env, `:1992-2084` spawn/close); batch `:2233-2421` (`batchId` `:2248`) |
| Tier field on templates | `src/templates.js` (every `agent` entry; tier prose ~`:1074-1078`) |
| Registry exporter (MCP tool) | `src/index.js` near `:300` (`server.tool(...)` registrations) |
| Registry/launcher scaffolding | `src/index.js:407-674` (esp. `files.push` `:435-436`, chmod `:538-543`, Next Steps `:656-665`) |
| Mandatory pre-flight | `src/index.js:1533-1635` (`setup_voltron` blocking-failures); report `:1682-1704` |
| Allowlist / gitignore | `VOLTRON_ALLOW` (applied `src/index.js:1450/1499`); `voltronGitignoreBlock` (entries seen in `.gitignore:12-26`); both defined at `src/templates.js` infra tail `~:9909-10107` |
| Version pin constant | `src/templates.js` infra tail `~:9909-10107` |
| scrum-master pre-flight/auto-launch | `src/templates.js` ~`:1300-1312`; `.claude/commands/scrum-master.md` (session-start ~92+) |
| Docs | `CLAUDE.md`; `README.md`; `docs/index.html` |
| ⚠ Glimpse consumption | `7ports/voltron-glimpse` (separate repo) — edges, tier read, `--history` |

---

_Handoff: plan ready for `/scrum-master` to decompose into beads. Phase 0 → Phase 1 (freeze `.voltron/dispatches.jsonl` + `.voltron/agent-registry.json` schemas) is the critical path; Phase G is cross-repo and externally-blocked._
