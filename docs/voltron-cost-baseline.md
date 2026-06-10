# Voltron Cost Baseline — Token/$ Hotspot Map

> **Scope:** Read-only audit of where token/$ cost is incurred in Project Voltron (`main`, v3.14.0).
> **Purpose:** Precise hotspot map to feed a cost-optimization plan. **Not** a solutions document.
> **Method:** `wc -c`/`wc -l` on `src/templates.js` entries, line-level read of `dispatchOneAgent` in `src/index.js`, `bd prime` output measured live. Token estimates use ~4 chars/token. Date: 2026-06-10.

---

## 1. How a dispatch is billed (per-container anatomy)

Every agent runs as a **fresh `claude -p` cold start inside its own Docker container** (`src/index.js:1922`). There is no shared process and no shared cache between dispatches. Each container re-bills its entire static input from scratch.

The `-p` prompt is assembled in `dispatchOneAgent` at **`src/index.js:1766-1778`**:

```js
const prompt = [
  agentInstructions,            // template.content minus YAML frontmatter
  PROGRESS_REPORTING_DIRECTIVE, // src/index.js:42  (~150 chars / ~38 tok)
  "## Project Context (from CLAUDE.md)",
  claudeMd,                     // FULL CLAUDE.md, read at index.js:2097 / 2204
  "## Your Task", task,
].join("\n")
```

On top of that `-p` payload, each container **also** loads, before the task even starts:

| Static input loaded every container | Source | ~chars | ~tokens |
|---|---|---|---|
| Claude Code base system prompt + tool schemas | Claude Code runtime | — | ~2,000–4,000 |
| project-voltron MCP tool schemas (nestable agents only — 18 tools) | `src/index.js` `server.tool(...)` ×18 | ~1,675 desc + zod params | ~400–900 |
| **CLAUDE.md auto-loaded as project memory** (WORKDIR `/workspace`, file mounted there) | `Dockerfile.voltron:93` + mount `index.js:1895` | 7,467 | ~1,867 |
| **CLAUDE.md embedded again in the `-p` prompt** | `index.js:1773` | 7,467 | ~1,867 |
| `bd prime` SessionStart hook output | `.claude/settings.json` SessionStart | 5,458 | ~1,365 |
| PROGRESS_REPORTING_DIRECTIVE | `index.js:42` | 150 | ~38 |
| Agent role template (varies by tier) | `src/templates.js` | 2,700–20,400 | ~680–5,100 |

**Static boilerplate that is identical on every single dispatch** (CLAUDE.md ×2 + bd prime + directive + base system) ≈ **~7,000–9,000 tokens of input re-billed per container, uncached.** In an 8-agent batch fan-out this duplicated boilerplate alone is **~56K–72K input tokens per batch** before any task work happens.

---

## 2. Template sizes (measured `wc -c` via `src/templates.js`)

Largest role templates, with their model tier and how often injected:

| Template | Category | Model | chars | ~tok | Injection frequency |
|---|---|---|---|---|---|
| scrum-master | slash-command | opus | 60,096 | 15,024 | Main session only (NOT dockerized — `index.js:1753`); loaded once per orchestration session |
| csharp-dev | agent | opus | 20,396 | 5,099 | Every csharp-dev dispatch |
| fullstack-dev | agent | opus | 19,554 | 4,889 | Every fullstack-dev dispatch |
| qa-tester | agent | opus | 18,767 | 4,692 | Every qa-tester dispatch (typically max_turns 40) |
| devops-engineer | agent | opus | 17,287 | 4,322 | Every dispatch |
| scene-architect | agent | opus | 16,602 | 4,151 | Every dispatch |
| asset-manager | agent | sonnet | 14,316 | 3,579 | Every dispatch |
| build-validator | agent | sonnet | 12,954 | 3,239 | Every dispatch |
| harness-engineer | agent | opus | 11,603 | 2,901 | Every Voltron-edit dispatch |
| researcher | agent | opus | 11,186 | 2,797 | Every dispatch |
| project-planner | agent | opus | 10,127 | 2,532 | Every dispatch |
| voltron-judge | agent | opus | 9,330 | 2,333 | Every eval-scoring dispatch |
| code-analyst | agent | opus | 6,073 | 1,518 | Every analysis-coordination dispatch |
| ~50 micro-agents (haiku) | agent | haiku | 2,700–3,800 | 680–950 | Every dispatch |

Aggregate by model tier (content chars only):

| Tier | # templates | sum chars | ~tok |
|---|---|---|---|
| opus | 14 | 229,207 | 57,302 |
| sonnet | 5 | 56,166 | 14,042 |
| haiku | 55 | 160,369 | 40,092 |

---

## 3. Model assignment (the dominant $ lever)

opus is roughly **~5× sonnet** and **~12–15× haiku** per token. The micro-agents (≈50 templates) are correctly on **haiku** — mechanical edit/inspect work, ~700–950 tok templates. The cost concentration is the **opus-default tier** (`model: "opus"` field in `src/templates.js`):

Dockerizable opus agents: `project-planner`, `scene-architect`, `csharp-dev`, `fullstack-dev`, `devops-engineer`, `qa-tester`, `harness-engineer`, `voltron-judge`, `researcher`, `code-analyst`.

Flags for the optimization plan (mechanical/coordination work that may not need opus reasoning):
- **`code-analyst` (opus, this agent):** a Tier-1 *coordinator* that mostly dispatches micro-agents and synthesizes their text — little first-party reasoning. Strong sonnet candidate.
- **`voltron-judge` (opus):** eval scoring against a rubric; runs on every eval row → high frequency. Candidate for sonnet.
- **`researcher` (opus):** web fetch + summarize is largely extraction. Candidate for sonnet.
- The **dev agents** (`csharp-dev`/`fullstack-dev`/`devops-engineer`) pair the *largest templates* (4,300–5,100 tok) **with** opus **and** 30+ turns — the worst per-run cost combination in the system (see §5).

Model resolution: explicit param > `template.model` > session default (`index.js:1760`). So the `model:` field is the default that fires unless a caller overrides it.

---

## 4. bd prime / SessionStart hook (re-injected every container)

- `.claude/settings.json` registers `bd prime` on **both** `SessionStart` **and** `PreCompact`.
- Measured live: **`bd prime` = 5,458 chars / 113 lines / ~1,365 tokens.**
- Injected into **every** container's context at session start (the mount carries `.claude/settings.json` into `/workspace`).
- **Overlap waste:** CLAUDE.md already contains a full "Beads Issue Tracker" + "Session Completion" section (the `BEGIN BEADS INTEGRATION` block). That content is injected via CLAUDE.md (twice — §1) *and* re-stated by the `bd prime` hook → three overlapping copies of beads guidance per container.

---

## 5. max_turns and turn-burn

- Default `max_turns = 30` everywhere (`index.js:1744`, `1783`, `2074`, `2165`).
- Cost grows super-linearly: each turn re-sends the accumulated transcript, so a 30-turn opus session bills the growing context 30 times. A single opus dev agent (≈11.5K-token cold prompt + accumulating tool output over 30 turns) can plausibly consume **~200K–500K+ tokens per run** at opus rates.
- Templates that routinely exhaust the budget:
  - **qa-tester** — its own template (`templates.js:4616`) says default 30 is *insufficient* and requests **max_turns 40**.
  - Commit/PR stages — `templates.js:4862-4864` warns agents "frequently hit max_turns immediately after completing edits, leaving the commit undone" → wasted full-budget runs that produce nothing.
  - **pr-opener** — `templates.js:7737` notes long inline PR bodies exhaust an 8-turn budget on cold start.

---

## 6. stream-json verbosity & MCP return path

- Containers run `claude … --output-format stream-json --verbose` and `tee` the full transcript to `.voltron/logs/<file>` (`index.js:1922`). stream-json emits full JSON messages (content/thinking/signatures) — log files are large on **disk** but this is formatting of already-generated output, **not** extra token billing.
- **MCP return path is bounded — confirmed.** `MAX_TAIL_CHARS = 4000` (`index.js:1731`); `boundTailChars()` (`index.js:1735`) caps the Output Tail returned to the orchestrator, with the full transcript persisted to the log. Comment at `index.js:1725-1730` documents the prior overflow (observed 54k–2.3M chars) this fixed. **No longer a token hotspot.** Residual cost: unbounded disk log growth (operational, not token).

---

## 7. Prompt-caching readiness

**Not cache-structured today; effectively zero cache hits.**
- Each dispatch is a separate `claude -p` process in a throwaway `--rm` container → no Anthropic prompt cache persists across dispatches. The most-static content (system prompt, tool schemas, CLAUDE.md, role template) is re-sent and re-billed cold every container.
- Within the `-p` payload the variable `task` is correctly placed **last** (`index.js:1777`) and static content first — the right *order* for caching — but no `cache_control` breakpoints are set and there is no cross-container cache to hit, so the favorable ordering is currently unused.
- Opportunity surface: the (template + directive + CLAUDE.md) prefix is byte-identical across same-agent dispatches and would be the natural cache prefix if a caching path existed.

---

## Ranked Hotspot Table

| # | Surface | Est. tokens | Frequency | Why costly | Optimization opportunity (one line) |
|---|---|---|---|---|---|
| 1 | **Opus-tier dev/coordinator agents** (`templates.js` `model:"opus"`) | ~200K–500K+ tok / run (opus rate, 30 turns growing context) | Every dev/judge/analyst/researcher dispatch | opus ≈5× sonnet / ≈12–15× haiku; largest templates + most turns; some are coordination/extraction work | Demote mechanical/coordination opus agents (code-analyst, voltron-judge, researcher) to sonnet; reserve opus for genuine reasoning |
| 2 | **No cross-dispatch prompt caching** (`index.js:1766`, cold `-p` per container) | ~7K–9K static input × every container; ~56K–72K / 8-agent batch | Every dispatch, multiplied by batch fan-out | Full system+tools+CLAUDE.md+template re-billed cold each container, zero cache reuse | Introduce a cacheable static prefix / persistent cache path for the identical boilerplate |
| 3 | **CLAUDE.md double injection** | ~1,867 ×2 = ~3,734 tok | Every dispatch | Embedded in `-p` prompt (`index.js:1773`) **and** auto-loaded by Claude Code from `/workspace/CLAUDE.md` (WORKDIR, `Dockerfile.voltron:93`) | Drop the in-prompt copy and rely on Claude Code's native CLAUDE.md load (or vice-versa) |
| 4 | **Large opus role templates** (csharp-dev 5,099 / fullstack-dev 4,889 / qa-tester 4,692 tok) | ~4,300–5,100 tok | Every dispatch of that agent | Big static template re-sent uncached at opus rate | Trim/segment dev templates; load only task-relevant sections |
| 5 | **bd prime SessionStart hook** (`.claude/settings.json`) | ~1,365 tok | Every container start | Re-injected per container; triple-overlaps CLAUDE.md's beads section | De-dupe beads guidance across CLAUDE.md + hook; gate hook to orchestration sessions |
| 6 | **max_turns default 30 + turn-burn** (`index.js:1744`) | accumulating transcript × up to 30–40 turns | Every dispatch | Each turn re-bills growing context; qa-tester/commit/pr stages routinely exhaust budget, sometimes producing nothing | Right-size max_turns per task class; reserve commit turns; split >50-turn tasks |
| 7 | **MCP tool schemas for nestable agents** (18 `server.tool` defs) | ~400–900 tok | Every nestable (14) dispatch | Full tool schema set injected even when agent uses few tools | Scope MCP tool exposure to what each agent actually calls |
| 8 | **stream-json `--verbose` logs** (`index.js:1922`) | Disk only — **not** token-billed | Every dispatch | Large transcript files on disk | (Operational) rotate/prune `.voltron/logs`; MCP return already bounded |

---

## Validation

- Per-dispatch prompt assembly: `src/index.js:1766-1778`; CLAUDE.md read at `2097`/`2204`.
- `MAX_TAIL_CHARS=4000` bounded return confirmed: `src/index.js:1731-1741`.
- `bd prime` size measured live: 5,458 chars / ~1,365 tok.
- Template sizes measured via `node` over `require("./src/templates.js")` `TEMPLATES`.
- CLAUDE.md double-load confirmed: `Dockerfile.voltron:93` (WORKDIR /workspace) + mount `index.js:1895` + in-prompt embed `index.js:1773`.
