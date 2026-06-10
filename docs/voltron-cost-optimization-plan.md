# Voltron Cost-Optimization Plan — Ranked, Implementation-Ready

> **Scope:** Project Voltron, `main`, v3.14.0. Design-only plan (no source edits).
> **Inputs:** `docs/cost-optimization-principles.md` (Anthropic pricing/caching/tiering principles, verified 2026-06-10) + `docs/voltron-cost-baseline.md` (measured hotspot map).
> **HARD CONSTRAINT (non-negotiable):** Every change here reduces **cost only**. It must NOT change orchestration flow, agent capability, tier semantics, outputs, or any user-facing behavior. Identical tokens reach the model; we change only *where they sit* (cacheable vs not), *whether they are duplicated*, and *how the loop is bounded against waste*. Anything that could alter behavior is quarantined in **Tier C** and requires explicit human approval.
> **Headline:** Restructure the per-dispatch prompt so the large static prefix (role template + CLAUDE.md) lives in the **cacheable system-prompt region** and stops being double-injected — turning ~7–9K of cold-billed boilerplate per container into a ~0.1× cache read on reuse. **Pure cost win, zero behavior change.**

---

## How dispatch is billed today (the surfaces we are attacking)

Every agent is a fresh `claude -p … --output-format stream-json` **cold start in its own `--rm` Docker container** (`src/index.js:1912-1923`). No shared process, no warm cache. Each container re-bills, at full input rate:

1. Claude Code base system prompt + tool schemas (runtime; ~2–4K tok)
2. project-voltron MCP tool schemas for nestable agents (~400–900 tok)
3. **CLAUDE.md auto-loaded as project memory** (WORKDIR `/workspace`, `Dockerfile.voltron:93`; ~1,867 tok)
4. **CLAUDE.md embedded *again*** inside the `-p` prompt (`src/index.js:1773`; ~1,867 tok) ← duplicate
5. **`bd prime` SessionStart hook** (`.claude/settings.json:14-24`; ~1,365 tok) — overlaps CLAUDE.md's BEADS block
6. `PROGRESS_REPORTING_DIRECTIVE` (`src/index.js:42`; ~38 tok)
7. Agent role template (`src/templates.js`; 680–5,100 tok)

The `-p` payload is assembled at **`src/index.js:1766-1778`** with static content first and the variable `task` last (good *ordering* for caching) — but it is sent as the **user message**, no `cache_control` is set, and there is no cross-container cache to hit, so the favorable ordering is currently unused (`baseline §7`).

**Decisive enabling fact (verified against the in-container CLI, `claude --help`):** the `claude` binary already exposes the exact flags needed, so Tier A requires *only* changes to how `dispatchOneAgent` invokes the CLI — no new infrastructure:

| Flag | What it does | Why it matters here |
|---|---|---|
| `--append-system-prompt <str>` / `--append-system-prompt-file <f>` | Appends text to the **default** system prompt (keeps Claude Code's auto-applied `cache_control`) | Moves the static role template into the cacheable system region instead of the un-cached `-p` user message |
| `--exclude-dynamic-system-prompt-sections` | "Move per-machine sections (cwd, env info, memory paths, git status) from the system prompt into the first user message. **Improves cross-user prompt-cache reuse.**" Only applies with the default system prompt (so it composes with `--append-system-prompt`, *not* `--system-prompt`). | Strips the per-container volatile bytes (container hostname, cwd, git status) that would otherwise sit in the prefix and silently bust the cache (`principles §1` invariant) |
| `--settings <file-or-json>` / `--setting-sources <user,project,local>` | Choose which settings layers load | Lets a disposable container skip the `bd prime` SessionStart hook (redundant with CLAUDE.md's BEADS block) without touching the main session |

---

## Tier summary (what's in each, and why)

| Tier | Definition | Items | Behavior risk |
|---|---|---|---|
| **A — Safe / zero-behavior-risk** | Pure cost: relocate, de-duplicate, or cache identical content. Same tokens reach the model. | A1 caching via system-prompt relocation · A2 eliminate CLAUDE.md double-injection · A3 de-dupe bd-prime hook in containers · A4 stabilize the cacheable prefix · A5 sequence batch fan-out to share one cache write | **None** — verifiable byte-for-byte |
| **B — Low-risk, needs judgment** | Bounds *waste* (truncation/retry, runaway loops) or right-sizes a budget so it *cannot* truncate legitimate work. | B1 raise under-provisioned `max_turns` (qa-tester) · B2 reserve commit/PR turns · B3 `task_budget` countdown on long loops | **Low** — can only *prevent* wasted runs; validated against eval suite |
| **C — Excluded / needs human approval** | Anything that could change behavior, capability, or output. | C1 opus→sonnet/haiku tier demotions · C2 lowering `max_turns` · C3 scoping MCP tool exposure · C4 trimming/segmenting template content · C5 batch-API 50% offline path · C6 effort/terse-output tuning | **Real** — listed with reasons; do not implement without sign-off |

---

# TIER A — Safe, zero-behavior-risk (implement first)

> These attack baseline hotspots **#2 (no cross-dispatch caching)**, **#3 (CLAUDE.md double-injection)**, and **#5 (bd-prime overlap)**. They reduce the **static input** surface only; they do not touch output tokens, turn count, model tier, or any instruction content the model sees.

## A1 — Cache the static prefix by relocating the role template into the system prompt *(headline)*

**(1) What changes + locus.** In `dispatchOneAgent` (`src/index.js:1766-1778`, and the corresponding CLI assembly at `src/index.js:1922`):
- Stop concatenating `agentInstructions` (the role template) + `PROGRESS_REPORTING_DIRECTIVE` + CLAUDE.md into the `-p` user string.
- Instead write them to a file and pass `--append-system-prompt-file /workspace/.voltron/tmp/<agent>-sysprompt.md` (analogous to the existing `container-mcp.json` write at `:1862-1874`).
- Keep **only the per-dispatch `task`** in `-p`. The `-p` user message becomes purely volatile; the role template becomes part of the Claude Code default system prompt, which the CLI already marks with `cache_control`.
- Order the appended block **shared-first**: `PROGRESS_REPORTING_DIRECTIVE` (identical for all agents) → then `agentInstructions` (per-agent). CLAUDE.md is handled by A2 (native auto-load). Shared-first ordering lets the boilerplate cache region be reused across *different* agents, with the per-agent template as the cached suffix for same-agent repeats.

**(2) Estimated savings.** Cache reads are **0.1× input** (`principles` pricing table). The cacheable static prefix per dispatch is ~7–12.5K tok (base system + directive + template). On any reuse within the 5-min TTL — the common case in a batch fan-out or a busy orchestration window — that prefix bills at ~10% instead of 100%, i.e. **~90% off the repeated static-input portion**. For an 8-dispatch same-agent fan-out the static-input cost drops from 8.0 → ~1.95 units (1 write @1.25× + 7 reads @0.1×) ≈ **~75% off that surface** (`principles §5`). Caching does **not** touch output tokens, so on a long 30-turn opus run (output-dominated) the *total*-run effect is smaller than on short/batch runs — be honest about workload dependence.

**(3) Risk level.** **Very low.** A role/instructions template is canonically a *system* prompt; moving it from user→system role does not change capability or output. Failure mode is "cache doesn't hit" (cost stays at status quo), never "behavior changes."

**(4) Behavior-preservation justification.** The model receives the **exact same instruction bytes**, only in the system role instead of the user role. The task still arrives in `-p`. No instruction is added, removed, or reworded. Tier semantics, tool access, and outputs are untouched.

**(5) Validation.** Run two back-to-back dispatches of the same agent within 5 min; confirm `usage.cache_read_input_tokens > 0` on the second (the stream-json transcript in `.voltron/logs/` carries usage). Diff the assembled system-prompt file against the old `-p` body to prove byte-identical instruction content (modulo CLAUDE.md, see A2). Run the eval suite (`voltron-evals/`) for representative agents and confirm identical pass/score vs the v3.14.0 baseline results already on disk.

## A2 — Eliminate the CLAUDE.md double-injection

**(1) What changes + locus.** `src/index.js:1771-1773` embeds the **full CLAUDE.md** into the `-p` prompt, while Claude Code *also* auto-loads `/workspace/CLAUDE.md` as project memory (because WORKDIR is `/workspace`, `Dockerfile.voltron:93`, and the repo is bind-mounted there, `:1895`). Remove the in-prompt copy (the `"## Project Context (from CLAUDE.md)"` + `claudeMd` lines) and rely on the native auto-load. Keep the `claudeMd` read (`:2098`/`:2205`) only if still needed for the orchestrator-side fallback message; for the dispatch path it is no longer concatenated.

**(2) Estimated savings.** **−1,867 tok per dispatch**, flat, every container (baseline hotspot #3: ~1,867 ×2 today). For an 8-agent batch that is **~15K tok/batch** removed before any work. Compounds with A1: the surviving (auto-loaded) CLAUDE.md lands in the cacheable system region, so its cost also drops ~90% on reuse.

**(3) Risk level.** **Very low.** Requires confirming the container actually auto-loads `/workspace/CLAUDE.md` (it does today — that is *why* it's a double-injection). Guard: if auto-load were ever disabled, fall back to `--add-dir`/append.

**(4) Behavior-preservation justification.** CLAUDE.md content still reaches the agent — via the native memory path instead of the duplicated in-prompt copy. The agent reads the *same* project context; we delete only the redundant second copy.

**(5) Validation.** In a test dispatch, grep the stream-json transcript / system-prompt for the CLAUDE.md heading and confirm it appears **once**, not twice. Confirm an agent still answers a CLAUDE.md-specific question (e.g. "where does template content live?" → `src/templates.js`). Eval-suite parity check as in A1.

## A3 — De-duplicate the `bd prime` hook inside disposable containers

**(1) What changes + locus.** `.claude/settings.json:14-24` registers `bd prime` on `SessionStart`; the mounted settings file makes it fire in **every** container (~1,365 tok), and its content **triple-overlaps** CLAUDE.md's `BEGIN BEADS INTEGRATION` block (baseline §4). Suppress the hook for the disposable dispatch path **without touching the main orchestration session's settings**: have `dispatchOneAgent` write a container-scoped settings file (e.g. `.voltron/container-settings.json` with `{"hooks": {}}`) and pass `--settings /workspace/.voltron/container-settings.json` (mirroring the existing `container-mcp.json` pattern), or restrict layers with `--setting-sources user,local`. Do **not** edit the project `.claude/settings.json` (the main session legitimately wants `bd prime`).

**(2) Estimated savings.** **−1,365 tok per container** (baseline hotspot #5). ~11K tok/8-agent batch. Removes the triple-copy of beads guidance down to the single canonical copy in CLAUDE.md.

**(3) Risk level.** **Low.** The only judgment call: confirm the hook adds nothing the container needs beyond what CLAUDE.md's BEADS block already states. It does not — the hook output is the same close-protocol/commands text.

**(4) Behavior-preservation justification.** Beads guidance still reaches the agent through CLAUDE.md's `BEADS INTEGRATION` section (auto-loaded, A2). We remove a redundant *copy*, not the guidance. Prefer the targeted `--settings` override over `--bare` precisely because `--bare` would *also* drop LSP/plugins (a capability change → would belong in Tier C); the targeted override changes only the hook layer.

**(5) Validation.** Dispatch a test agent and confirm the bd-prime banner is absent from the transcript while CLAUDE.md's beads section is still present; confirm a publish agent (e.g. committer) still follows the session-close/commit protocol (proves the guidance survived via CLAUDE.md). Eval-suite parity.

## A4 — Stabilize the cacheable prefix (kill silent cache invalidators)

**(1) What changes + locus.** A cache prefix is a **byte-for-byte** match (`principles §1` invariant). Per-container volatile bytes that currently sit in or near the front of the prompt context will silently bust A1's cache: the container hostname, cwd, git status, memory paths, and the `[entry] $(date -Is) host=$(hostname)` preamble (`src/index.js:1922`). Two changes: (a) add `--exclude-dynamic-system-prompt-sections` to the CLI invocation so Claude Code relocates cwd/env/git-status/memory-paths out of the cached system prefix into the first user message; (b) ensure nothing dynamic (timestamps, `uniqSuffix`, container name) is interpolated into the **appended system prompt** — those already live in filenames/logging, not the prompt body, so keep it that way.

**(2) Estimated savings.** This is the **multiplier that makes A1 actually pay**. Without it, `cache_read_input_tokens` stays at 0 (the documented failure mode) and A1 yields nothing on reuse. With it, A1's ~75–90% prefix savings are realized.

**(3) Risk level.** **Very low.** `--exclude-dynamic-system-prompt-sections` is purpose-built by Anthropic for "cross-user prompt-cache reuse"; the relocated sections still reach the model (in the first user message), so the agent still knows its cwd/env/git state.

**(4) Behavior-preservation justification.** No information is removed — cwd/env/git-status simply move from the system region to the first user message. The model sees the same facts; only their *position* changes, which is the whole point (volatile-after-stable).

**(5) Validation.** This is the acceptance test for A1: confirm `cache_read_input_tokens > 0` on a second same-prefix dispatch. If it's 0, a volatile byte remains in the prefix — bisect by diffing two containers' system prompts.

## A5 — Sequence batch fan-out so N dispatches share one cache write

**(1) What changes + locus.** `run_agent_in_docker_batch` (`src/index.js:2157+`) currently `Promise.all`s all dispatches. A cache entry is readable only **after the first response begins streaming** (`principles §5`); firing N identical-prefix containers in parallel makes all N pay a full cache *write*, capturing none of A1's read discount. For same-agent (or shared-boilerplate) batches, launch **one** dispatch, await its first streamed token (or a short head-start), **then** fan out the remaining N−1 so they read the just-written cache.

**(2) Estimated savings.** Turns N×(1.25× write) into 1×(1.25×) + (N−1)×(0.1×) on the shared prefix — for N=8 that's the difference between ~10× and ~2× on that surface (`principles §5`). This is the difference between A1 helping the *next* batch vs helping *within* the batch.

**(3) Risk level.** **Low.** Adds a small head-start latency to the first container only; does not change which agents run, their inputs, or their outputs. Keep `fail_fast` semantics intact.

**(4) Behavior-preservation justification.** Same agents, same tasks, same parallelism *result* — only the *launch timing* of the fan-out changes (staggered by one short head-start). No output or capability difference.

**(5) Validation.** Compare `cache_creation_input_tokens` across the batch: expect ~1 writer and N−1 readers, vs N writers today. Confirm batch wall-clock and per-agent outputs are unchanged (modulo the small head-start).

### Tier A aggregate savings

- **Flat removals (A2+A3), every dispatch, zero reuse needed:** ≈ **−3,230 tok/dispatch** (1,867 + 1,365). On the baseline's 8-agent batch boilerplate (~56–72K tok), that's **≈ −26K tok/batch (~35–45% of the boilerplate surface) before any caching.**
- **Caching (A1+A4+A5), on reuse within TTL:** ~75–90% off the *remaining* static prefix (template + base system + surviving CLAUDE.md).
- **Combined Tier A on the static-input surface:** roughly **50–70% reduction of the per-batch static-input bill**, behavior-identical.
- **As a share of total $:** caching/dedup touch **input** only. For **batch-heavy / short-run** workloads (evals, micro-agent fan-outs, coordination) Tier A plausibly cuts **~15–30% of total spend**. For **long single-agent opus runs** (output- and turn-dominated, baseline #1/#6) the total-run effect is smaller — those are addressed by Tier B (waste) and the Tier-C levers (tiering/output), which are gated by the hard constraint. *(All percentages are unit-economics-accurate but reuse-rate dependent; measure on real dispatches before quoting a single number — see `principles` Gaps.)*

---

# TIER B — Low-risk, requires judgment (implement after A, with eval gating)

> These bound **waste**, not capability. They reduce cost by *avoiding* truncated/retried runs and runaway loops. None lowers a budget below what legitimate work needs.

## B1 — Raise under-provisioned `max_turns` where the default truncates work

**(1) What changes + locus.** Default `max_turns = 30` everywhere (`src/index.js:1744`). qa-tester's own template (`templates.js:~4616`) states 30 is *insufficient* and requests **40**. Give per-task-class defaults (or set qa-tester's dispatch `max_turns` to 40) so a run that needs 40 turns doesn't truncate at 30, fail validation, and get **re-dispatched** (paying the full cold prompt + turns twice).

**(2) Estimated savings.** Eliminates wasted truncated runs. A truncated 30-turn opus run that must be re-dispatched costs ~2× a single right-sized run; preventing it on the agents that *routinely* truncate (qa-tester) is a net saving despite the higher ceiling.

**(3) Risk level.** **Low.** Raising a ceiling cannot truncate work; the only downside is a runaway loop using more turns — bounded by B3.

**(4) Behavior-preservation justification.** Raising `max_turns` lets work *complete* that the template already says needs more turns — it makes behavior *more* correct, never less. It does not change what the agent does, only that it isn't cut off mid-task.

**(5) Validation.** Re-run qa-tester eval rows; confirm fewer `stop_reason: max_turns` truncations and no increase in average turns for runs that already finished under 30. Compare total tokens incl. avoided re-dispatches.

## B2 — Reserve turns for the commit/PR stage

**(1) What changes + locus.** `templates.js:~4862-4864` warns agents "frequently hit max_turns immediately after completing edits, leaving the commit undone" → a full-budget run that produces *nothing committed* (pure waste). And `pr-opener` (`templates.js:~7737`) notes long inline PR bodies exhaust an 8-turn budget on cold start. Right-size these specific publish stages' `max_turns` so the commit/PR step is reachable.

**(2) Estimated savings.** Avoids the worst waste mode: a run that spends the whole budget and ships no artifact, forcing a re-dispatch. Directly targets baseline #6.

**(3) Risk level.** **Low** (raising a ceiling, same reasoning as B1).

**(4) Behavior-preservation justification.** Ensures the *already-intended* commit/PR completes; adds no new behavior.

**(5) Validation.** Confirm committer/pr-opener dispatches reach the commit/PR step without truncation; confirm artifact (commit/PR) is produced in runs that previously truncated.

## B3 — Add a `task_budget` countdown on long agentic loops

**(1) What changes + locus.** Use `output_config: {task_budget: {type: "tokens", total: N}}` (beta `task-budgets-2026-03-13`, Opus 4.7/4.8; min 20,000) for long-horizon dev agents, if/when exposed through the CLI invocation in `dispatchOneAgent`. Unlike `max_turns` (an unseen per-response ceiling), the model *sees* the countdown and wraps up gracefully instead of being cut off (`principles §6`).

**(2) Estimated savings.** Caps *cumulative* loop spend and reduces abrupt truncations that trigger re-dispatch. Workload-dependent; the saving is in avoided runaway turns.

**(3) Risk level.** **Low-to-medium.** A too-tight budget makes the model complete tasks less thoroughly (it cites the budget) — so set generously (≥ the agent's observed p90 token use), never below B1/B2's needs. Pending confirmation the in-container CLI exposes `output_config`/`--betas` for this; if not, this is deferred, not dropped.

**(4) Behavior-preservation justification.** Set above real task needs, it changes nothing on normal runs — it only catches pathological runaways that would otherwise burn budget and produce nothing. The countdown changes *pacing*, not capability.

**(5) Validation.** Confirm normal eval runs finish well under the budget (no behavior change); confirm a deliberately looping case wraps up gracefully instead of truncating. A/B token comparison.

### Tier B aggregate savings
Workload-dependent and concentrated on the **avoided-rework** axis: each prevented truncate-and-re-dispatch saves ~1× a full cold run (cold prompt + up to 30–40 turns at opus rate). On agents that routinely truncate (qa-tester, commit/PR stages) this is a meaningful recurring saving with no capability change. Does not stack additively with Tier A's input savings — different cost axes (waste/turns vs static input).

---

# TIER C — Excluded; require explicit human approval

> Each of these could change behavior, capability, or output. The user's hard constraint forbids shipping them silently. Listed with the reason excluded and the proof that would be required to promote them.

## C1 — Model-tier demotions (opus → sonnet / haiku) — **biggest theoretical $ lever, deliberately excluded**

Baseline #1 flags `code-analyst`, `voltron-judge`, and `researcher` as sonnet candidates (coordination/extraction work), and opus is ~5× sonnet / ~12–15× haiku. **Excluded because** a tier change is by definition a capability change: it can alter reasoning depth, judgment, and output quality on edge cases. The user explicitly said *do not change how Voltron works*. Demotion is only promotable to Tier B **after** proving identical capability for that agent's task class — i.e. eval-suite parity (`voltron-evals/`) showing same scores on the demoted tier across a representative sample, plus a quality gate / escalation path so a low-confidence cheap run re-runs on opus (cascading, `principles §2`). Until that proof exists, **no tier field in `src/templates.js` changes.** *(Also note: the `principles` tokenizer caveat — Opus 4.7+ count up to +35% tokens vs 4.6 — means cross-generation cost math must be re-baselined with `count_tokens` before quoting demotion savings.)*

## C2 — Lowering `max_turns` below 30
Could truncate legitimate work → forced re-dispatch (net *more* cost) or dropped deliverables (behavior change). Excluded. Only the *raising* direction (B1/B2) is safe.

## C3 — Scoping MCP tool exposure per agent
Baseline #7: nestable agents receive all 18 tool schemas (~400–900 tok) even if they call few. Trimming the exposed set removes a capability the agent *could* have used → behavior risk. Excluded unless a per-agent audit proves a given agent provably never calls the removed tools across the eval suite. *(`tool search` — append-don't-swap — is the cache-preserving way to do this if ever pursued, `principles §7`.)*

## C4 — Trimming / segmenting large opus templates
Baseline #4: csharp-dev (5,099 tok), fullstack-dev (4,889), qa-tester (4,692). Cutting or lazy-loading template sections changes the instructions the agent sees → behavior risk (the `right altitude` failure mode: too terse → under-specified, `principles §3`). Excluded. *Note:* A1 makes these templates **cheap to keep whole** (cached at 0.1× on reuse), which substantially reduces the incentive to trim them at all — a point in favor of doing A1 *instead of* C4.

## C5 — Batch-API 50%-off path for offline work (reflections, evals)
The Batch API is **50% off** input+output for non-interactive work (`principles §5`) — attractive for reflection processing and eval runs. **Excluded from "no-behavior-change"** because it changes the *execution model*: no streaming, no live tool loop, async (up to 24h), and **not available for Managed Agents sessions / Fast mode**. That is an operational/behavioral change to how evals and reflections run, even if outputs are equivalent. Promote only with explicit approval and only for genuinely offline surfaces.

## C6 — Output-token / effort / terse-mode tuning
Output is 5× input and dominates long runs (baseline #1/#6); `effort: low`, terse-mode "default to silence between tool calls", structured outputs, and adaptive-thinking scoping (`principles §4`) would cut it. **Excluded** because each measurably changes the agent's *output* — narration, structure, thoroughness — i.e. exactly the user-facing behavior the constraint protects. (The mandatory `[STEP N]` progress lines are also output the orchestrator parses — terse-mode must not suppress them.) Promote only per-route with eval proof of unchanged deliverables.

---

## Recommended sequencing

1. **A2 + A3** first — pure deletions of duplicated content; immediate flat savings, trivially verifiable, no caching dependency.
2. **A1 + A4** together — relocation + prefix stabilization; A4 is the acceptance gate for A1 (`cache_read_input_tokens > 0`).
3. **A5** — once A1 caches, sequence batch fan-out to capture reads within the batch.
4. **B1 + B2** — raise the truncation-prone ceilings; eval-gate.
5. **B3** — if the in-container CLI exposes `task_budget`; otherwise file as follow-up.
6. **Tier C** — only on explicit human approval, each behind eval-parity proof.

## Open questions (need human input)
- **Cross-container cache reuse rate** in real traffic (drives A1's realized %). Measure `cache_read_input_tokens` on a live batch before committing to a savings figure.
- **CLI surface for `task_budget`/`--betas`** inside the `voltron-agent` image (gates B3).
- **Approval for any C1 tier demotion** and willingness to fund the eval-parity A/B run that would justify it (this is where the largest $ lever lives — but only if behavior parity is proven).
- **Whether the surviving CLAUDE.md auto-load (A2) is guaranteed** across the Claude Code versions the image may run — if ever uncertain, fall back to `--add-dir`/append (still cacheable).

---

> **Implementation note:** This is a design document. No source was edited. The Tier-A items touch only `dispatchOneAgent`'s CLI assembly (`src/index.js:1766-1778`, `:1862-1874`, `:1922`), the batch launcher (`src/index.js:2157+`), and a new container-scoped settings file — not template *content*, not `model:` fields, not orchestration flow. Per project policy, any code change implementing this must also update `docs/index.html` and `README.md` in the same commit and bump `package.json`.
