# Cost-Optimization Principles for LLM-Agent / Harness Systems

> **Sourced brief** for Project Voltron's cost-optimization pass. Goal: reduce token/$ cost **without degrading capability**.
> Primary sources are Anthropic docs + engineering blog, dated inline. **Version/date-sensitive** — pricing and model IDs verified 2026-06-10; re-check the live pricing page before relying on exact dollar figures.

## Summary

The three highest-leverage levers, in order, are: **(1) prompt caching** (cache reads cost 0.1× input → up to ~90% off the repeated-prefix portion, which for a harness that re-injects large static role templates per turn is most of the input bill); **(2) model tiering / right-sizing** (Haiku is 5× cheaper than Opus on input, 5× on output — routing simple sub-tasks off Opus is a 3–5× saving on those calls); and **(3) context minimization** (just-in-time retrieval + code-execution-style tool offloading have shown ~98% token reductions on tool-heavy agent flows in Anthropic's own measurements). Output-token discipline, batching (50% off), and turn-budget control are meaningful secondary levers. Caching and tiering interact: **switching models mid-conversation invalidates the cache**, so tiering must be done via sub-agents, not mid-loop swaps.

Confidence legend: ✓ confirmed from primary source · ~ estimated/workload-dependent · ? unverified.

---

## Reference: current pricing (per million tokens, USD)

**Source:** [Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing.md) (fetched 2026-06-10). ✓

| Model | Input | 5m cache write | 1h cache write | Cache read (hit) | Output |
|---|---|---|---|---|---|
| Claude Opus 4.8 | $5.00 | $6.25 | $10.00 | **$0.50** | $25.00 |
| Claude Sonnet 4.6 | $3.00 | $3.75 | $6.00 | **$0.30** | $15.00 |
| Claude Haiku 4.5 | $1.00 | $1.25 | $2.00 | **$0.10** | $5.00 |

- **Cache read = 0.1× base input.** 5m cache write = 1.25× input; 1h write = 2× input. ✓
- **Batch API = 50% off** input and output (e.g. Opus input $2.50, output $12.50). ✓
- **Output is 5× input** at every tier — output tokens are the expensive ones. ✓
- Opus/Sonnet 4.6+ include the **full 1M context window at standard pricing** (no long-context premium). ✓
- ⚠️ **Tokenizer note:** Opus 4.7+ use a new tokenizer that can use **up to 35% more tokens** for the same fixed text than 4.6 and earlier. Re-baseline token counts with `count_tokens` when comparing across model generations — don't apply old per-token cost estimates. ✓

---

## 1. Prompt caching — the single biggest lever for a template-injecting harness

**Source:** [Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md), [Pricing §Prompt caching](https://platform.claude.com/docs/en/about-claude/pricing.md). ✓

**What it is.** Anthropic caches a *prefix* of your rendered prompt. A subsequent request whose prefix matches byte-for-byte reads the cached tokens at **0.1× input price** instead of reprocessing them at full price.

**The one invariant.** Caching is a **prefix match**: any byte change *anywhere* in the prefix invalidates everything after it. Render order is `tools` → `system` → `messages`. Stable content (frozen role template, deterministic tool list) must physically precede volatile content (timestamps, task IDs, the per-dispatch question).

**Mechanics that matter for a harness:**
- `cache_control: {type: "ephemeral"}` — default **5-minute TTL**; `{type: "ephemeral", ttl: "1h"}` for **1-hour TTL**. ✓
- Max **4** breakpoints per request. Top-level `cache_control` auto-places on the last cacheable block (simplest). ✓
- **Minimum cacheable prefix is model-specific** — prefixes below it silently don't cache (no error, `cache_creation_input_tokens: 0`): Opus 4.8 / Sonnet 4.6 / Sonnet 4.5 = **1,024 tokens**; Opus 4.7 = **2,048**; **Opus 4.6 / Opus 4.5 / Haiku 4.5 = 4,096 tokens**. ✓ (Note the asymmetry: Opus 4.6 needs 4× the prefix that Opus 4.8 does.)
- **20-block lookback window** per breakpoint — in agentic loops adding >20 content blocks per turn (many tool_use/tool_result pairs), place an intermediate breakpoint every ~15 blocks or the next turn silently misses. ✓
- **Cacheable:** tool definitions, system blocks, message text/images/documents, tool_use + tool_result blocks. **Not cacheable:** thinking blocks directly (they're cached as part of prior assistant turns), empty text blocks. ✓
- **Verify with `usage.cache_read_input_tokens`.** If it's 0 across repeated requests, a silent invalidator is present (`datetime.now()` / UUID in the prefix, unsorted JSON keys, a varying tool set). ✓

**Cost math (break-even).**
- 5m TTL: write 1.25× + read 0.1× = 1.35× vs 2× uncached → **pays off after the first reuse**. ✓
- 1h TTL: write 2× + read 0.1× = 2.1× vs 3× uncached → **needs ~2 reuses** to pay off; use only when traffic has gaps longer than 5 min. ✓
- Worked example (Opus 4.8, 50K-token session, 40K served from cache): cache reads drop that 40K from $0.20 → **$0.02**, cutting total session cost ~25%. ([Pricing worked example](https://platform.claude.com/docs/en/about-claude/pricing.md)) ✓

**Expected magnitude.** For a harness that injects a large static role template per dispatch, the repeated prefix is most of the input bill; caching it removes **~90% of that input cost** (0.1× read vs 1.0× uncached). ~ Exact savings depend on reuse rate within the TTL window.

**Risks / caveats.**
- **Don't interpolate dynamic values into the system prompt** (current date, mode, user/task ID) — it sits at the front of the prefix and invalidates everything downstream. Inject dynamic context later in `messages` (or via a mid-conversation `role:"system"` message, beta `mid-conversation-system-2026-04-07`). ✓
- **Switching models invalidates the cache** (caches are model-scoped) — see §2 for the sub-agent workaround. ✓
- **Cache isolation is workspace-level** on the Claude API as of 2026-02-05. ✓
- **Pre-warming** (`max_tokens: 0` request) eliminates first-request cache-miss latency — worth it only for user-visible first-request latency with a large shared prefix; skip when traffic is continuous (real requests keep it warm). ✓

---

## 2. Model tiering / right-sizing — match the model to the task

**Source:** [Pricing §Cost optimization](https://platform.claude.com/docs/en/about-claude/pricing.md); [Agent design — Caching for Agents](claude-api skill, `shared/agent-design.md`). ✓

**What it is.** Use the cheapest model that meets the quality bar for each task: **Haiku 4.5** for simple/mechanical tasks, **Sonnet 4.6** for most production workloads, **Opus 4.8** for the hardest reasoning and long-horizon agentic work.

**When it applies.** Tiered harnesses (opus/sonnet/haiku) should route by task difficulty, not run everything on the top tier. Concrete sub-tasks well-suited to Haiku: file search/grep summarization, classification, mechanical extraction, validation, short single-file edits, test scaffolding.

**Expected magnitude.**
- Haiku vs Opus: **5× cheaper input** ($1 vs $5), **5× cheaper output** ($5 vs $25). Moving a sub-task off Opus onto Haiku is a **~5× saving on that call**. ✓
- Sonnet vs Opus: **~1.7× cheaper input, 1.7× cheaper output**. ✓
- Cascading/routing (try cheap model first, escalate to Opus only on low-confidence/failed validation) captures most of the saving while preserving the quality ceiling for the hard cases. ~ Savings depend on the escalation rate; a 70/30 Haiku/Opus split on a workload roughly halves cost vs all-Opus.

**Effort as a sub-lever (within a tier).** `output_config: {effort: "low"|"medium"|"high"|"xhigh"|"max"}` controls thinking depth and total token spend. Lower effort → fewer/consolidated tool calls, less preamble, terser confirmations. For Opus 4.8, **default `high`** and sweep `medium`/`high`/`xhigh` per route — the relationship isn't monotonic: higher effort up front often *reduces* total turn count and cost on agentic work. Use `low` for subagents/simple tasks; reserve `max` for correctness-critical, latency-insensitive cases. ✓

**Risks / caveats.**
- **Switching models mid-conversation invalidates the prompt cache** (§1). The correct pattern is **NOT** swapping the main loop's model mid-task. Instead: **spawn a sub-agent on the cheaper model** for the sub-task and keep the main loop on one model. (This is how Claude Code's Explore subagents use Haiku.) ✓ — this makes tiering and caching *complementary* rather than mutually exclusive.
- Right-sizing requires a quality gate (tests, validation, confidence check) to catch cases where the cheap model under-delivers — otherwise you trade $ for rework, which is more expensive.
- Don't downgrade silently on correctness-sensitive paths; the model choice is a deliberate per-route decision.

---

## 3. Context minimization — stop re-paying for tokens the model doesn't need

**Source:** [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (2025-09-29); [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) (2025-11-04). ✓

**What it is.** Curate the minimal set of tokens needed at each inference step. Context is a **finite resource with diminishing returns** — beyond "cost," large contexts cause **context rot**: recall accuracy *drops* as token count rises, so trimming improves *quality* as well as cost.

**Techniques, with magnitudes:**

| Technique | Mechanism | Savings | Caveat |
|---|---|---|---|
| **Just-in-time retrieval** | Hold lightweight references (file paths, queries, links); load data into context only when needed, via tools — don't dump everything upfront | ~ Large on data-heavy tasks; avoids loading unused content | Runtime exploration is slower than pre-computed retrieval; needs good tool design |
| **Code execution / tool offloading (MCP)** | Agent loads only the tool definitions it needs and filters/transforms results *in the execution environment* before returning to the model | **~98.7%** in Anthropic's example (≈150K → ≈2K tokens) ✓ | Requires a code-execution sandbox; corroborated by Cloudflare "Code Mode" |
| **Avoid re-injecting large static prompts** | Inject big role templates **once** as a cached prefix (§1) rather than re-sending verbatim per turn | ~90% on the repeated portion (cache read) | Must keep the prefix byte-stable |
| **Tool-result clearing** | Drop raw tool outputs from deep message history ("why see the raw result again?") | ~ Proportional to tool-output volume; "safest, lightest-touch compaction" | Keep results still referenced downstream |
| **Compaction / summarization** | Distill history near the context limit, reinitialize with summary + recent turns | ~ Large on long sessions | Maximize recall first, then precision — over-aggressive compaction loses subtle context |
| **Sub-agent architectures** | Specialist sub-agents explore with clean context; lead agent receives **1–2K-token** condensed summaries | ~ Big for research/fan-out; isolates detail | Coordination overhead; summaries must capture what matters |
| **System-prompt "right altitude"** | Minimal prompt that fully outlines behavior — neither brittle hardcoded logic nor vague guidance; organize with XML/Markdown sections | ~ Smaller fixed prefix every request | Too terse → under-specified behavior |

**Risks / caveats.** Each trim is a recall risk — measure task success, not just token count. Compaction and tool-clearing are reversible-in-spirit only if the cleared content is genuinely no longer needed. Note these techniques **stack with caching**: a smaller, stable prefix is both cheaper to cache and faster to process.

---

## 4. Output-token reduction — the 5× multiplier

**Source:** [Pricing](https://platform.claude.com/docs/en/about-claude/pricing.md); [Tool use concepts](claude-api skill); [Migrating to Opus 4.8](claude-api skill, `shared/model-migration.md`). ✓

**What it is.** Output tokens cost **5× input** at every tier, so bounding verbosity is disproportionately valuable.

**Levers:**
- **Bound `max_tokens` appropriately** — it's a hard ceiling, but the real lever is prompting for brevity. (Don't lowball `max_tokens` to the point of mid-thought truncation, which forces a retry = *more* cost.) ✓
- **Structured outputs** (`output_config: {format: {json_schema}}`) — constrains output to a schema, eliminating preamble and freeform filler; also removes prefill hacks (which 400 on 4.6+). ✓
- **Effort: low** and terse-mode system instructions cut preamble, narration, and confirmations. ✓
- **Opus 4.8 narrates more than 4.7 by default** — add an explicit "default to silence between tool calls; one-sentence updates only" instruction for coding/agent loops to claw back output tokens. ✓
- **`thinking` disabled** for tasks that don't need reasoning saves thinking-token output — but on Opus 4.8, disabled thinking can leak verbose reasoning into the visible response; prefer adaptive thinking + a "final-answer-only" instruction, or scope it explicitly. ✓
- **Stop sequences** — terminate generation at a known boundary to avoid over-generation. ~

**Expected magnitude.** Workload-dependent, but because output is 5× input, a 30% cut in output tokens often saves more absolute $ than a 30% cut in input. ~

**Risks / caveats.** Over-constraining output (too-low `max_tokens`, over-terse prompts) causes truncation/retries or drops needed detail — net-negative. Structured outputs are incompatible with citations and message prefilling, and a too-low `max_tokens` yields `stop_reason: "max_tokens"` with incomplete JSON. ✓

---

## 5. Batching & parallelization economics

**Source:** [Batch processing](https://platform.claude.com/docs/en/about-claude/pricing.md#batch-processing); [Prompt caching §concurrent timing](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md). ✓

**Batch API.** **50% off both input and output** for asynchronous, non-latency-sensitive work (up to 100K requests / 256 MB per batch; most complete within 1 hour, max 24h). ✓
- **When it applies:** offline evals, bulk reflection processing, backfills, any "doesn't need to be live" workload. Stacks with prompt-caching discounts. ✓
- **Caveats:** not interactive (no streaming, no live tool loop); **not available for Managed Agents sessions** or Fast mode; results retained 29 days. ✓

**Parallelization & cache timing.** A cache entry is readable only **after the first response begins streaming**. N parallel requests with an identical prefix all pay full price — none can read what the others are still writing. **Fix:** send 1 request, await its first streamed token, *then* fan out the remaining N−1 so they read the just-written cache. ✓ Naively firing a fan-out in parallel pays N cache *writes* instead of 1 write + (N−1) reads.

**Expected magnitude.** Batch = flat **2× cost reduction** on eligible volume. Sequencing a fan-out to share one cache write turns N×(1.25× write) into 1×(1.25×) + (N−1)×(0.1×) — for N=10 that's ~10× → ~2.15× on the shared prefix. ~

---

## 6. Turn-budget discipline & agentic loop control

**Source:** [Migrating to Opus 4.7 — Task Budgets](claude-api skill, `shared/model-migration.md`); [Agent design](claude-api skill, `shared/agent-design.md`); [Building effective agents](https://www.anthropic.com/research/building-effective-agents). ✓

**What it is.** Agents are "LLMs using tools in a loop" — autonomy means **higher cost and compounding errors**. Bound how much a loop can spend.

**Levers:**
- **Task Budgets** (beta `task-budgets-2026-03-13`, Opus 4.7/4.8): `output_config: {task_budget: {type: "tokens", total: N}}` tells the model its token budget for a whole agentic loop; it sees a countdown and self-moderates / wraps up gracefully. Distinct from `max_tokens` (an enforced per-response ceiling the model can't see). Minimum 20,000 tokens. ✓ — the primary lever for capping *cumulative* loop spend.
- **Programmatic tool calling (PTC):** chain many tool calls in a script in the execution container; only the final output returns to the model's context, not every intermediate round trip. Cuts both latency and tokens when intermediate results are large/numerous. ✓
- **Specify the full task up front in one well-specified turn** for Opus 4.8 long-horizon work — clearer goals up front mean fewer correction turns (each turn re-processes context). ✓
- **Up-front goal + autonomy guidance** reduces ask-rate ping-pong (Opus 4.8 asks more by default; a "decide minor choices yourself" instruction cut ask-rate ~12 pts in Claude Code testing). ✓
- **Cap loop iterations** (e.g. `max_continuations`) and handle `pause_turn` deliberately to prevent runaway server-side tool loops. ✓

**Expected magnitude.** ~ Workload-dependent; the saving is in *avoided* turns and tool round-trips, which is often the dominant cost in long agentic runs. Each avoided turn saves re-processing the full (growing) context.

**Risks / caveats.** Too-tight a `task_budget` makes the model complete tasks less thoroughly (it'll cite the budget as the constraint). Iteration caps that are too low truncate legitimate work.

---

## 7. Claude-specific cost levers (current as of 2026-06)

| Lever | Effect | Source |
|---|---|---|
| **Cache reads at 0.1×** + 1M context at standard pricing on 4.6+ | Big static prefixes are cheap to reuse; no long-context premium | Pricing ✓ |
| **`effort` parameter** (low→max; xhigh on 4.7/4.8) | Direct token-spend dial within a tier; `low` for subagents | Effort docs ✓ |
| **Adaptive thinking** (`{type:"adaptive"}`) | Model self-regulates thinking depth — no fixed budget to over-provision | Migration guide ✓ |
| **Mid-conversation `role:"system"` messages** (beta) | Inject operator context without editing the cached system prefix → preserves cache | Prompt caching ✓ |
| **Tool search** | Load only relevant tool schemas; *appends* rather than swaps → preserves cache | Agent design ✓ |
| **Context editing** (beta) | Auto-clear stale tool results/thinking on thresholds — leaner transcript, no summarization | Tool-use concepts ✓ |
| **Compaction** (beta `compact-2026-01-12`) | Server-side summarization near context limit — keeps long sessions alive without 1M-token bills | Compaction docs ✓ |
| **Code execution free with web search/fetch** | No container charge when bundled with `web_search_20260209`/`web_fetch_20260209`; else 1,550 free hrs/mo then $0.05/hr | Pricing ✓ |
| **Web fetch = no surcharge**, web search = $10/1K | Prefer fetch when you have the URL; bound search count | Pricing ✓ |
| **Avoid Fast mode unless latency-critical** | Fast mode is 2× (Opus 4.8: $10 in / $50 out) — a latency premium, not a cost saver | Pricing ✓ |
| **Managed Agents: $0.08/session-hour runtime** | Billed only while `running`; idle/terminated is free → keep sessions idle, not spinning | Pricing ✓ |

---

## Key recommendations for Project Voltron's cost pass

1. **Cache the injected role templates.** They're large, static, re-sent per dispatch — the textbook caching win. Put a breakpoint at the end of the template; keep per-dispatch task text *after* it. Verify `cache_read_input_tokens > 0`. Watch the **4,096-token minimum on Opus 4.6/Haiku 4.5** — short templates won't cache there. **Est. ~90% off the template's input cost.** ✓
2. **Tier via sub-agents, never mid-loop model swaps** (swaps nuke the cache). Route mechanical sub-tasks (search, validate, single-file edit, test scaffolding — the micro-agents already in the eval suite) to **Haiku 4.5** = ~5× cheaper; reserve Opus 4.8 for coordination/hard reasoning. Gate with the existing validation step.
3. **Minimize re-injected context.** Don't re-send large static blocks per turn (cache them); clear stale tool results; use just-in-time retrieval and code-execution offloading for tool-heavy flows (**up to ~98%** token reduction in Anthropic's measurements). ✓
4. **Batch the offline work** (reflection processing, evals) for a flat **50% discount**. ✓
5. **Bound output and turns** — terse-mode instructions (Opus 4.8 over-narrates), structured outputs where applicable, and `task_budget` on long agentic loops.

---

## Gaps / uncertainties

- **Exact savings are workload-dependent.** The 90% (caching), 5× (Haiku/Opus), and 98% (code-execution offload) figures are accurate *unit* economics / single published examples — realized savings depend on reuse rate, escalation rate, and tool-output volume in Voltron's actual traffic. Measure on real dispatches before committing to numbers. ~
- **Tokenizer change (Opus 4.7+, up to +35% tokens vs 4.6)** means cross-generation cost comparisons need re-baselining via `count_tokens`; not yet measured for Voltron's templates. ?
- **Cascading/routing thresholds** (when to escalate Haiku→Opus) need empirical tuning against the eval suite — no published default. ?
- Pricing/min-cacheable-prefix/beta-header details are **date-sensitive** (verified 2026-06-10). Re-fetch the [pricing](https://platform.claude.com/docs/en/about-claude/pricing.md) and [prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md) pages before a pricing-dependent decision.

## Sources

- [Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing.md) — model/cache/batch/tool pricing, cost-optimization strategies (fetched 2026-06-10)
- [Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md) — breakpoints, TTL, minimums, invalidation, pre-warming, concurrency
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — just-in-time retrieval, compaction, tool clearing, sub-agents, context rot (2025-09-29)
- [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) — ~98.7% token reduction via tool offloading (2025-11-04)
- [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) — agent cost/error tradeoffs
- claude-api skill (`shared/agent-design.md`, `shared/model-migration.md`, `shared/tool-use-concepts.md`) — effort, Task Budgets, sub-agent caching workaround, adaptive thinking, structured outputs
