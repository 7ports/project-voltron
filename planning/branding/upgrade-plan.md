# Project Voltron — Branding & Documentation Upgrade Plan

**Author:** Voltron project-planner (design + architecture)
**Date:** 2026-06-18
**Status:** Plan — for `/scrum-master` decomposition. No site code in this document.
**Inputs consumed:** `.voltron/branding/viz-research.md` (researcher — library survey + 3-option centerpiece shortlist A/B/C), `.voltron/branding/engine-inventory.md` (code-analyst — 12-component engine inventory + coupling baseline B1–B5), current `README.md`, current `docs/index.html` (v3.15.1).

**Scope constraint (hard):** GitHub Pages, served from `/docs`, **no backend, no build step**. All interactivity is client-side, CDN/`<script>`-loaded. Every recommendation below respects this. Per the researcher's §4, this constraint eliminates React Flow / Svelte Flow and favors GSAP, force-graph, Cytoscape.js, anime.js, Three.js (lazy-loaded only).

**Baseline being replaced:** the current site is a single-column, 960px, GitHub-dark, documentation-voiced page (`docs/index.html`) — a flat stack of feature sections with no narrative arc, no hero moment, and no visual identity beyond the default blue→purple text gradient. It reads as reference docs, not as a portfolio piece. The README is accurate but dense and feature-list-shaped, not positioning-shaped.

---

## 1. Brand Direction

### 1.1 The core concept: "The Voltron Engine"

Today the project markets *a pile of agent templates*. That undersells it. The engine-inventory (Part A) shows the real product is a **self-modifying, self-evaluating orchestration engine** — agents are versioned markdown, an automated PR pipeline rewrites them from production feedback (component 6), an in-repo judge regression-grades them (component 11), and a cross-project memory accrues operational knowledge (component 10). That triad is the differentiator. The brand must name and elevate it.

**Decision:** Introduce **"The Voltron Engine"** as a named, capitalized concept — the machinery beneath the templates. The templates become *what the engine produces and maintains*; the engine is *the thing you're actually adopting*. This name is used identically on the site and in the README (see §5).

### 1.2 Positioning statement

> **The Voltron Engine** — the orchestration engine that drives Claude Code itself. One coordinator decomposes the work, sub-managers own each domain, and dozens of single-purpose micro-agents do the focused edits — each in its own real Docker container running the real `claude` CLI. Then the engine grades its own agents and rewrites them from what it learns in the field.

Three pillars (these recur as the site's spine):
1. **Compose, don't prompt.** A real tier hierarchy (1 → N → ~51), enforced by a runtime depth cap, not by convention (components 1, 4).
2. **Real isolation, real parallelism.** Throwaway Docker containers, the actual coding agent, batch fan-out tuned to prompt-cache economics (components 2, 3, 12).
3. **It improves itself.** Reflection loop → automated PR → eval-graded → cross-project memory (components 6, 10, 11). *No other orchestrator self-modifies its agents through a reviewed pipeline.*

### 1.3 Tagline candidates (pick one at build — see §8)

- **"Many agents. One engine."** ← recommended; cleanest expression of the combine metaphor, ties name to mechanism.
- "Agents that assemble. An engine that improves itself."
- "Form the team. The engine does the rest."
- "Orchestration that rewrites its own playbook." (leans on the self-improvement differentiator)
- "One coordinator. Fifty-one specialists. Zero glue code."

### 1.4 Voice / tone

A deliberate **two-register voice** that tracks the progressive-disclosure arc (§2):
- **Top of page (portfolio / visitors):** confident, cinematic, plain-English. Short declaratives. Metaphor-forward ("agents assemble into one engine"). Minimal jargon — a non-Claude-Code visitor must still feel the wow.
- **Mid page (end users):** practical, imperative, friendly. "Run this. Get that." Copy-paste-first.
- **Bottom (evaluators / developers):** precise, technical, evidence-backed. Component names, file references, honest trade-offs (including the Docker-socket security disclosure). This is where credibility is won.

Always: opinionated, never hype-without-proof. Every bold claim is followed by the mechanism that backs it. Drop the current doc-dump density in favor of layered reveals.

### 1.5 Color palette direction

Move off the default GitHub `#0d1117`/`#58a6ff` look (which reads "generic dev tool"). Keep a **dark, technical base** (developers expect it; preserves contrast for the animation) but introduce an owned accent system evoking *energy assembling*:

| Token | Direction | Use |
|---|---|---|
| `--bg` | Near-black with a cool blue undertone (deeper than `#0d1117`, e.g. `#080b14`) | Page base; lets the centerpiece glow |
| `--surface` | Slightly lifted slate | Cards, panels |
| `--engine-core` | **Electric cyan/azure** — the "power core" hue | Primary accent, hero glow, active edges |
| `--engine-forge` | **Warm amber/molten** — the "assembly/forge" hue | Secondary accent, energy pulses, CTAs |
| `--tier-1 / tier-2 / tier-3` | A 3-stop ramp (e.g. amber → magenta → cyan) | Encodes the tier hierarchy *consistently across every diagram* |
| `--text / --text-muted` | High-contrast off-white / muted slate | Body |

**Signature gradient:** cyan→amber (core meets forge) as the brand gradient, replacing the blue→purple. The cyan/amber duotone is the visual hook that should appear in the logo, the hero glow, and section accents. **The tier ramp is a brand asset** — the same three colors mean tier-1/2/3 in the hero, the dispatch graph, and the tier diagram, so the visual system teaches the architecture.

### 1.6 Typography direction

- **Display / headlines:** a geometric or semi-industrial sans with strong presence (e.g. *Space Grotesk*, *Sora*, or *Clash Display*) — gives the rebrand its own face vs. the current system-font stack. Loaded via a font CDN (`<link>`), respecting no-build.
- **Body:** a clean, highly legible sans (*Inter*) for the user/evaluator sections.
- **Code / technical:** a crisp mono (*JetBrains Mono* or *IBM Plex Mono*) — code samples and tool names are central to credibility; treat mono as a first-class brand voice, not an afterthought.
- Scale: large, confident hero type (clamp-based responsive); generous size step-down into reading sections.

### 1.7 Logo / iconography direction

- **Mark:** an abstract emblem reading as *units converging into a single core* — e.g. a hexagon/shield "core" formed from segmented pieces, with the cyan→amber duotone. It must read at favicon size and as a large hero mark, and must work as the **end-state of the assembly animation** (the centerpiece resolves into the logo — see §3).
- **Iconography:** a small consistent set for the three pillars and the engine components — tier nodes, the Docker/isolation motif, the reflection-loop cycle, the beads dependency graph. Line-style, single-weight, duotone-capable. Reuse these icons in both site and README (README via inline SVG or shields-style badges).
- **Tier glyphs:** coordinator / sub-manager / micro-agent each get a distinct, recurring glyph used everywhere agents are depicted.

---

## 2. Information Architecture

The page is **one long scroll** implementing the user's progressive-disclosure arc: **WOW (portfolio) → USERS (install/use) → EVALUATORS (architecture/positioning)**. Each section below lists *purpose · sub-audience · key message*. Order is the build order for content.

| # | Section | Purpose | Sub-audience | Key message |
|---|---|---|---|---|
| 0 | **Sticky nav / skip-links** | Orientation + a11y; anchor jumps; "GitHub" + "Install" CTAs always reachable | All | You can skip straight to what you need |
| 1 | **Hero + Animated Centerpiece** (§3) | The wow moment — agents assemble into the engine/logo; tagline; primary CTA | **Portfolio / visitors / employers** | "Many agents. One engine." This is something built with craft |
| 2 | **One-line "what is this"** | Immediately ground the spectacle in a plain sentence so non-experts aren't lost | Portfolio → users | An orchestration engine that drives Claude Code with isolated, self-improving agent teams |
| 3 | **Three Pillars** (§1.2) | The elevator pitch as three scannable claims, each with a one-glance mini-visual | Portfolio / evaluators | Compose-don't-prompt · Real isolation+parallelism · It improves itself |
| 4 | **"See it run" — Living Dispatch Graph** (§3 hand-off / §4) | Transition from emotional → honest: the actual 1→N→51 tier graph with dispatch pulses | Portfolio → evaluators | This is literally how work flows through the engine |
| 5 | **Quickstart / Install** | The user payoff: clone → setup → scaffold, copy-paste blocks, prerequisites (Docker, beads) | **End users** | Three commands from zero to a full agent team |
| 6 | **How you actually use it** (workflow) | The scaffold → plan → dispatch → reflect loop as a simple numbered flow + visual | End users | Scaffold, plan with `/scrum-master`, agents run in Docker, it reflects |
| 7 | **Meet the team** (agent roster) | The tiers made concrete — coordinator, sub-managers, micro-agents; refactor of current cards | End users → evaluators | A real org chart of specialists, each doing one job |
| 8 | **The Voltron Engine** (positioning deep-dive, §5) | The differentiator section — the 12 components distilled into marketing-grade messaging | **Developers evaluating orchestrators** | What makes this *not* LangGraph/CrewAI/AutoGen |
| 9 | **How it improves itself** (reflection loop + evals) | The novel triad as an animated cycle diagram; the credibility centerpiece for evaluators | Evaluators | Self-modifying + self-grading, via reviewed PRs — unique in the category |
| 10 | **Competitive positioning** | Honest comparison vs. graph/library orchestrators (their utilitarian canvas vs. our engine) | Evaluators | We augment the real coding agent; they're libraries you write apps against |
| 11 | **Architecture & internals** | Tier model, Docker/nested DooD, beads DAG, cost/cache optimizations; the security disclosure | Evaluators / contributors | Depth + honesty, including the Docker-socket trust boundary |
| 12 | **MCP tools / reference** | The tool surface table (corrected — see §5.3 drift fix) | Evaluators / users | The full, accurate API surface |
| 13 | **Footer** | License, links, repo, eval-harness badge | All | MIT, open, graded |

**Arc check:** sections 1–4 are spectacle and gist (visitor wow); 5–7 are use (end users); 8–13 are depth and proof (evaluators). The transition object is **section 4's living dispatch graph** — it is born from the hero animation (emotional) and becomes the literal explanatory diagram (honest), exactly the hand-off the researcher flagged as the ideal hybrid.

---

## 3. Animated Centerpiece

### 3.1 Recommendation: **Option A ("Voltron Assembles," GSAP + SVG/canvas choreography) as the hero, handing off to Option C (force-graph living dispatch graph) on scroll.**

This is a deliberate **A→C hybrid**, exactly the pairing the researcher flagged as "worth flagging to planner" (viz-research §5). I am **not** picking Option B (Three.js GPGPU particle morph) as the primary. Rationale, scored on the three required axes:

| Axis | Option A (GSAP assembly) | Option B (Three.js GPGPU) | Option C (force-graph) |
|---|---|---|---|
| **Wow-to-effort** | High wow, moderate effort — best ratio | Max wow, max effort (shader/GPGPU expertise, heaviest to get right) | Moderate wow (every AI tool has a node graph — viz §2), low effort |
| **Static-site fit** | Excellent — single GSAP `<script>`, all plugins now free, no build (viz §1, §4) | Workable but heaviest payload (~150KB+), must lazy-load + viewport-gate | Excellent — `<script src=…force-graph>`, `new ForceGraph(el)`, no build |
| **Accessibility / mobile** | Easiest reduced-motion fallback (snap to formed state); animates only `transform`/`opacity` (S/A-tier); mobile-friendly | Hardest — WebGL main-thread bound, needs robust low-power degradation + static poster | Graph is meaningful even with motion off; canvas-2D is light/mobile-friendly |

**Why A over B, given the user wants "highest wow":** Option B's spectacle is real but its cost lands almost entirely on the *hardest* constraints we have — accessibility, mobile, and no-build payload. The user's wow is best served by an animation that *actually plays smoothly for everyone* and lands the brand metaphor cleanly, then converts into something honest and reusable. Option A delivers the literal Voltron "lions → robot" assembly (directly on-brand for "many agents combine into one"), resolves into the **logo mark** (§1.7), and is the cheapest to make accessible. **Option B is documented as the future "max-spectacle" upgrade path (§8)** — the architecture (lazy-loaded centerpiece module behind a capability check) is built so B can later swap in for the hero on capable desktops without touching the rest of the page.

**Why add C:** it makes the hero *honest and reusable*. The assembled engine resolves into the real 1→N→51 dispatch graph, which then becomes the interactive explanatory diagram in section 4 — one asset, two jobs (hero payoff + system diagram), and the most truthful representation of what Voltron is (viz §5 Option C "most honest").

### 3.2 What it depicts

1. **Scatter:** ~51 small nodes (the micro-agents) drift in from the edges, tinted on the tier ramp (§1.5).
2. **Assemble (the payoff):** via a GSAP timeline, nodes slide/rotate/snap into the tier structure — one coordinator at top, sub-managers below, micro-agents fanning out — and edges light up (cyan core → amber forge) as the structure forms. Optionally MorphSVG (now free) morphs the settled cluster into the **logo mark**.
3. **Pulse:** message pulses travel coordinator→sub-manager→micro-agent along edges (GSAP `motionPath`, or force-graph's native directional link particles after hand-off) to signal "live dispatch."
4. **Hand-off to C:** as the user scrolls into section 4, the SVG assembly cross-fades into a force-graph canvas of the same topology that the visitor can hover/drag — the static formed state and the interactive graph are visually continuous.

### 3.3 Interaction model

- **Hero:** plays once on load (viewport-gated via IntersectionObserver), then idles with a subtle pulse loop. A **"Replay"** control re-runs the assembly (per viz §4 a11y note: prefer replay button over forced autoplay loops).
- **Section 4 graph:** hover a node → tooltip with that agent/tier's role; drag to perturb the force layout; edges animate dispatch direction. No zoom/pan complexity required for the hero; keep it legible.

### 3.4 Performance budget

- Animate **only `transform` / `opacity`** (S/A-tier per Motion tier list, viz §1). No layout-triggering props.
- Target **60fps / 16.7ms per frame**. Hero SVG node count capped (~51 desktop; reduce on mobile — §3.6).
- GSAP core ~23KB gzip + needed plugins, single CDN script. force-graph = small wrapper + d3-force, canvas-2D. **No WebGL on the critical path.** Total added JS budget for the centerpiece: keep under ~80KB gzip combined; lazy-load force-graph only when section 4 approaches the viewport.
- Hand-off uses one canvas; tear down the hero timeline once the graph is live to free the main thread.

### 3.5 Libraries / CDN

- **GSAP** (core + MorphSVG + MotionPathPlugin) — `cdn.jsdelivr.net/npm/gsap` / `gsap/dist/*`. Free incl. all plugins + commercial since 2025 (viz §1).
- **force-graph (vasturiano)** — `<script src="//cdn.jsdelivr.net/npm/force-graph"></script>`, then `new ForceGraph(el).graphData(...)` (viz §1, §4). Native directional link particles.
- (Stretch / §8) **Three.js** via ESM importmap, lazy-loaded, desktop-capable-only, for the Option-B upgrade.

### 3.6 Mobile + `prefers-reduced-motion` fallbacks (hard requirement)

- **`prefers-reduced-motion: reduce`** (detected via both CSS `@media` and `window.matchMedia` in JS, viz §4): **do not run the assembly**. Render the **final formed state immediately** — the fully-assembled tier graph + logo as a clean static image/SVG. The "Replay" button is hidden or becomes a no-op. Decorative pulses/parallax do not run.
- **Mobile / low-power:** reduce node count and timeline complexity, or ship a static poster frame of the formed engine; the section-4 force-graph degrades to a static rendered image on small/low-power devices. Detect and degrade (viz §4 mobile note).
- **No-JS / load failure:** a static SVG of the assembled engine + logo is the baseline DOM, so the page is never blank if the CDN/script fails — the animation enhances it progressively.

---

## 4. Supporting Visuals & Components

Secondary diagrams are **literal and legible** (accuracy over spectacle, per viz §3 hero-vs-explanatory split). Each reuses the tier color ramp (§1.5) for consistency.

| Visual | What it shows | Section | Library | Notes |
|---|---|---|---|---|
| **Living dispatch graph** | The real 1→N→51 tier topology with dispatch pulses (= hero hand-off target) | 4 | **force-graph** (canvas) | Native link particles; interactive; degrades to static image (viz §3 "tiered/radial dispatch graph", Option C) |
| **Tier model diagram** | Coordinator → sub-managers → micro-agents, with the "compose, never DIY" + depth-cap=3 rule (components 1, 4) | 7 / 11 | **SVG + GSAP** (scroll-reveal) | Hierarchical layout; annotate `nestable:false` bottom-out and `VOLTRON_DEPTH` cap |
| **Workflow / dispatch flow** | scaffold → plan → dispatch (Docker) → reflect; the parallel-batch fan-out (component 3) | 6 | **SVG + GSAP** or **anime.js** staggered reveal | Show batch fan-out + Docker isolation; staggered "many agents" motion (viz §1 anime.js strength) |
| **Reflection self-improvement loop** | submit_reflection → reflections/ → CI harness-engineer → templates.js edit → version bump → auto-update (component 6) | 9 | **SVG + GSAP** animated cycle | The credibility centerpiece for evaluators; a looping cycle diagram |
| **Eval harness flow** | AUT dispatched via live MCP → artifacts → programmatic scorers + voltron-judge → scorecard → reflection (component 11) | 9 | **SVG** (mostly static) + light GSAP | Emphasize "graded via the same dispatch path it runs in production" |
| **Beads dependency graph** | Task DAG — what blocks what; dependency-aware planning (component 5) | 11 | **force-graph** (reuse) or **Mermaid** for a static docs-style DAG | Mermaid CDN for a simple declarative version if interactivity isn't needed (viz §1, §3 "DAG/dependency tree") |
| **Parallel-batch timeline** (optional) | Concurrent agents over time + Docker isolation (components 2, 3) | 11 | **GSAP timeline → SVG/canvas bars** | Swimlane/Gantt style (viz §3); communicates parallelism; mark optional in §8 |
| **Cost/cache motif** (optional) | Shared prompt-prefix cache write, staggered fan-out (components 3, 12) | 11 | Small **SVG** infographic | Low priority; supports the "tuned to prompt-cache economics" claim |
| **Constellation backdrop** (optional, subtle) | Ambient connected-dots mesh behind hero/sections | 1 | **tsParticles** | Decorative only; must obey reduced-motion; keep very subtle (viz §3) |

**Library consolidation:** the whole site needs only **GSAP** (choreography everywhere) + **force-graph** (the two graph instances) + optionally **anime.js** (staggered reveals), **Mermaid** (static DAG), **tsParticles** (backdrop). All CDN/no-build (viz §4). React Flow/Svelte Flow explicitly excluded.

---

## 5. Voltron Engine — Positioning

### 5.1 The concept, articulated

Frame the product as **"The Voltron Engine"** (§1.1) on both site (section 8) and README (rewritten lead). The narrative: *most orchestrators are Python libraries you write an app against (LangGraph/CrewAI/AutoGen). Voltron is an **engine that drives Claude Code itself** — agents are declarative markdown, execution is real Docker containers running the real `claude` CLI, and the engine rewrites and regrades its own agents from production feedback.* (Engine-inventory Part A intro + Notes "novel triad.")

### 5.2 The 12 components → marketing-grade messaging

Distill the inventory's 12 components into evaluator-facing claims, each "headline → proof." Group into the three pillars (§1.2):

**Pillar 1 — Compose, don't prompt**
- *"A real org chart, enforced in code."* — 3-tier hierarchy (coordinator → sub-manager → micro-agent), depth-capped at 3 by the runtime, not by convention. 73 templates. (components 1, 4)
- *"Managers compose; they never DIY."* — sub-managers dispatch single-verb micro-agents; the STOP RULE is in every template. (component 1)

**Pillar 2 — Real isolation, real parallelism**
- *"Every agent gets its own container — running the real Claude CLI."* — throwaway Docker, repo bind-mount, creds read-only, full transcript captured. Not an in-process SDK call. (component 2)
- *"Fan out 8 agents in one call."* — parallel batch dispatch bypassing main-session serialization, with a head-start gate that shares one prompt-cache write. (components 3, 12)
- *"Containers that spawn containers."* — nested Docker-out-of-Docker so the tier hierarchy runs recursively in real containers. (component 4) — paired with the **honest security disclosure** (Docker socket = host root; trusted machines only).
- *"Tuned to prompt-cache economics."* — cacheable system-prompt prefix, de-duped context, staggered fan-out. (component 12)

**Pillar 3 — It improves itself** (the headline differentiator)
- *"Voltron rewrites its own agents."* — reflection loop: production feedback → CI harness-engineer edits `templates.js` → version bump → reviewed PR → auto-update into your repo. (components 6, 8)
- *"And grades them before they ship."* — voltron-evals runs agents through the *same* dispatch path they use in production, scored by deterministic signals + a Sonnet judge (self-preference-controlled). (component 11)
- *"With memory that crosses projects."* — Alexandria: tool/setup knowledge flows out of every session into a reusable store. (component 10)
- Supporting: dependency-aware planning on a versioned DB (beads/Dolt, component 5); MCP-as-delivery + scaffold/auto-update channel (components 7, 8); Stringer codebase baseline (component 9).

### 5.3 README positioning rewrite + drift fix

- **Rewrite the README lead** from a feature list into the engine positioning (§5.1) + three pillars (§1.2), mirroring the site's section 8 messaging so the two are consistent.
- **Fix the documented drift (engine-inventory Note + B2):** `README.md:162` advertises `start_agent_in_docker`, which **is not registered** in `src/index.js` (only `run_agent_in_docker` and `run_agent_in_docker_batch` exist). The current `docs/index.html` MCP-tools table and `get_agent_output` references must be reconciled against the actual registered tool set. The MCP-tools reference (site section 12) must list only real tools.
- Reuse the pillar icons (§1.7) as inline SVG/badges in the README so brand identity carries to GitHub.

---

## 6. Code Reorganization Assessment

**The user's question:** *Is there any advantage to reorganizing the **code** to separate the engine into a distinct module/package, and what is the expected value of that effort?* Grounded in the coupling baseline (engine-inventory Part B).

### 6.1 What the baseline actually shows

- The repo is **already two files by concern:** `src/index.js` (engine logic, 2,429 LOC) and `src/templates.js` (content, ~9,700 LOC of prose + ~430 LOC of mis-filed infra config). (B1)
- **Coupling is one-directional and narrow:** the engine imports a *named set* from content; content imports **nothing** back. The only real binding is the **implicit `TEMPLATES` object-shape contract** (`.content/.category/.model/.nestable/.tags/...`), which is **unschematized**. (B2, B3.2)
- **Existing seams already look module-like:** `voltron-evals/` talks to the engine over the **MCP protocol boundary**, not internal imports; `dispatchOneAgent()` is already an extracted dispatch core; `scripts/` already consume `templates.js` as a library; the infra constants at the tail of `templates.js` are a cohesive latent third module; `detectProjectRoot()` is a clean shared util. (B4)
- **The genuinely hard-to-split threads:** the **reflection self-improvement loop** deliberately couples engine + content + CI + versioning; the **shared single version number**; and **two filesystem-path regimes** (server-relative `reflections/` write-back vs. project-root-relative `.voltron/*`). (B3.3–B3.5)

### 6.2 Cost vs. value

**Costs / risks of a full extraction into separate modules/packages:**
- Must **formalize the `TEMPLATES` object-shape contract** (TS interface or JSON schema) to stop engine/content drift — net-new work that doesn't exist today. (B3.2)
- Must **split `templates.js`**, not just move it: the infra constants (`DOCKERFILE_CONTENT`, `VOLTRON_RUN_SCRIPT`, `VOLTRON_ALLOW/DENY`, `PROJECT_TYPE_TAGS`, `CLAUDE_MD_FOR_TYPE`, `getTemplatesForType`) are engine config co-located with prose. (B2, B4)
- Must **decide package ownership of the two fs-path regimes** and especially the **reflection write-back path**, which blurs "engine" and "this-repo's content." (B3.3)
- Must **untangle the shared version number** if engine and content become separately versioned — or deliberately keep them locked, which limits the benefit. (B3.5)
- **Risk:** the reflection loop (the #1 differentiator) is the most cross-cutting seam; a clumsy split could complicate or break the automated self-improvement PR pipeline that consumes `reflections/` and edits `templates.js`. High blast radius for the most valuable subsystem.
- All of this is **refactor effort with zero user-visible feature payoff** and real regression risk in CI/dispatch.

**Value of extraction:**
- **Clarity / contributor onboarding:** modest. The logic/data split already exists physically; the main clarity win is moving the mis-filed infra constants out of `templates.js` and documenting the `TEMPLATES` contract.
- **Reuse / packaging:** low-to-moderate *today*. `templates.js` is already importable as a library (scripts prove it); `voltron-evals` already consumes the engine via MCP. There is no current second consumer that needs an independently published engine package.
- **Marketing:** **this is the key insight — the marketing goal does NOT require a code split.** The user already stated they will do site + README positioning regardless. "The Voltron Engine" is a *naming and narrative* concept (§1, §5); it can be told compellingly against the current structure. Branding does not depend on a module boundary.

### 6.3 Recommendation: **DEFER a full package extraction. Do a small, low-risk "tidy" now.**

A full engine/content package separation is **not worth the effort or risk right now**, because (a) the codebase is already separated along the only axis that matters (logic vs. data) with narrow one-directional coupling, (b) the marketing payoff the user actually wants is achievable purely through naming + docs, and (c) the highest-value subsystem (the reflection loop) is also the most cross-cutting and riskiest seam to disturb.

**Do now (cheap, de-risking, independently useful) — fold into the roadmap as a small track:**
1. **Lift the infra constants** out of `templates.js` into a dedicated `src/infra.js` (Dockerfile, run-script, allow/deny, gitignore, type tags, `getTemplatesForType`). Pure move; clarifies that `templates.js` is *only* agent prose. (Addresses B2's "mis-filed" finding.)
2. **Document the `TEMPLATES` object-shape contract** — a short JSON-schema or JSDoc/TS-style interface comment — so engine and content can't silently drift. (B3.2)
3. **Fix the `start_agent_in_docker` doc drift** (§5.3). (B2 / Note)

**Defer until there is a concrete trigger** (e.g. a second consumer of the engine, an external partner wanting to embed it, or `index.js` growth making it unmaintainable): the full module/package extraction, separate versioning, and reflection-loop path re-homing. Revisit then with the contract from step 2 already in hand — which makes the eventual split far cheaper.

**Net:** the expected value of a full reorg today is **low and front-loaded with risk**; the expected value of the small tidy is **high-per-effort** and leaves the codebase better positioned for a future split if a trigger appears.

---

## 7. Phased Implementation Roadmap

Concrete, buildable tasks for `/docs` + README, ordered with dependencies. The scrum-master will decompose each task into agent assignments. All work respects the no-build/CDN constraint.

### Phase 0 — Foundations (design system + scaffolding)
*Goal: lock the brand primitives so every later phase composes cleanly.*
- **0.1** Author the design-token set (palette §1.5, tier ramp, type scale §1.6) as CSS custom properties in a single `docs/` stylesheet. *(design-token-writer / css-writer)*
- **0.2** Produce the logo mark + favicon + the pillar/tier icon set as SVG (§1.7). *(ui-designer)*
- **0.3** Wire web-font `<link>` loading (display + body + mono) with fallbacks. *(css-writer)*
- **0.4** Finalize tagline (from §1.3) and write the canonical positioning + three-pillar copy (§1.2, §5.2) as a content source both site and README draw from. *(doc-writer)*
- **Deps:** none. **Blocks:** all later phases (tokens + copy are inputs everywhere).

### Phase 1 — Information architecture skeleton
*Goal: the full single-page scroll exists with real (un-animated) content in the right order.*
- **1.1** Rebuild `docs/index.html` structure as the 13-section arc (§2): semantic sections, sticky nav, skip-links, anchors. Static content first, no animation. *(fullstack-dev / ui-designer)*
- **1.2** Migrate + rewrite existing content into the new sections with the two-register voice (§1.4); refactor the agent-roster cards into the "Meet the team" tier layout (§2 §7). *(doc-writer)*
- **1.3** Responsive layout pass (mobile-first; the page must be fully usable with zero JS). *(ui-designer)*
- **Deps:** Phase 0. **Blocks:** Phases 2–4 (they enhance this skeleton).

### Phase 2 — Animated centerpiece (hero) + dispatch-graph hand-off
*Goal: the §3 wow moment, accessible by construction.*
- **2.1** Build the static formed-state SVG of the assembled engine + logo (the reduced-motion / no-JS baseline). *(ui-designer)*
- **2.2** Implement the GSAP assembly timeline (scatter → assemble → pulse) over that SVG, viewport-gated, with Replay control (§3.2–3.3). *(fullstack-dev)*
- **2.3** Implement the force-graph living dispatch graph (section 4) and the scroll cross-fade hand-off from the hero (§3.2 step 4). *(fullstack-dev)*
- **2.4** Implement `prefers-reduced-motion`, mobile/low-power degradation, and CDN-failure fallback (§3.6); structure the centerpiece as a lazy-loaded module so Option B can later swap in (§8). *(fullstack-dev)*
- **2.5** Performance pass: verify transform/opacity-only, 60fps target, JS budget, teardown after hand-off (§3.4). *(qa-tester)*
- **Deps:** Phase 1 (skeleton + tokens). **Blocks:** none (other visuals are independent).

### Phase 3 — Supporting visuals
*Goal: the literal, legible explanatory diagrams (§4).*
- **3.1** Tier-model diagram (SVG + GSAP scroll-reveal). *(ui-designer / fullstack-dev)*
- **3.2** Workflow/dispatch-flow diagram with batch fan-out (anime.js/GSAP staggered). *(fullstack-dev)*
- **3.3** Reflection self-improvement loop animated cycle (the evaluator credibility piece). *(fullstack-dev)*
- **3.4** Eval-harness flow + beads dependency graph (Mermaid static or force-graph reuse). *(fullstack-dev)*
- **3.5** Optional: parallel-batch timeline, cost/cache motif, constellation backdrop (mark optional — §8). *(fullstack-dev)*
- Each visual must ship a reduced-motion/static fallback. *(qa-tester verifies)*
- **Deps:** Phase 0 (tokens), Phase 1 (sections exist). Can run parallel to Phase 2.

### Phase 4 — Positioning content + README sync
*Goal: the engine narrative lands on site and GitHub, accurately.*
- **4.1** Write site section 8 ("The Voltron Engine") + section 10 (competitive positioning) from §5.2. *(doc-writer)*
- **4.2** Rewrite README lead into engine positioning + three pillars; embed pillar icons (§5.3). *(doc-writer)*
- **4.3** **Doc-drift fix:** correct the MCP-tools tables (site §12 + README) — remove/repair `start_agent_in_docker`, reconcile against registered tools (§5.3). *(harness-engineer — owns Voltron repo edits)*
- **Deps:** Phase 0 copy. Can run parallel to Phases 2–3.

### Phase 5 — Code tidy (the §6.3 "do now" track, optional-but-recommended)
*Goal: cheap de-risking moves; not branding, but adjacent and low-cost.*
- **5.1** Lift infra constants from `templates.js` into `src/infra.js` (§6.3.1). *(harness-engineer)*
- **5.2** Document the `TEMPLATES` object-shape contract (schema/JSDoc) (§6.3.2). *(harness-engineer)*
- **Deps:** independent. **Note:** touches the Voltron repo, not `/docs`; per CLAUDE.md any code change needs same-commit doc updates — keep this isolated from the docs PRs. **Defer** the full extraction (§6.3).

### Phase 6 — QA, accessibility, polish, ship
*Goal: verified, accessible, fast, deployed.*
- **6.1** Accessibility audit: reduced-motion across all animations, contrast on the new palette, keyboard nav, skip-links, alt text on diagrams. *(qa-tester / ui-designer)*
- **6.2** Cross-device/perf audit (Lighthouse; mobile degradation paths; CDN-failure resilience). *(qa-tester)*
- **6.3** Final content proofread + version-badge/feature-section accuracy pass (CLAUDE.md Documentation Rule). *(doc-writer)*
- **6.4** Ship: GitHub Pages deploys from `/docs` on `main`. *(devops-engineer / committer)*
- **Deps:** Phases 1–4 (and 5 if included).

**Sequencing summary:** 0 → 1 → {2, 3, 4 in parallel} → (5 anytime, isolated) → 6. Phase 0 and 1 are the critical path; the visual and content tracks fan out after the skeleton exists; QA gates the ship.

---

## 8. Open Decisions for the User

1. **Tagline** — confirm one from §1.3 (recommended: *"Many agents. One engine."*). Drives hero + README.
2. **Centerpiece scope** — accept the **A→C hybrid** (recommended), or insist on **Option B (Three.js GPGPU)** as the primary hero despite its accessibility/mobile/effort costs? (Plan keeps B as a lazy-loaded future upgrade either way — §3.1.)
3. **Brand name string** — "The Voltron Engine" as the engine concept (recommended). Keep "Project Voltron" as the project/repo name, "Voltron Engine" as the product concept? Confirm the relationship.
4. **Typeface choices** — approve specific display/body/mono fonts (§1.6 lists candidates) or request a different direction.
5. **Palette specifics** — approve the cyan-core / amber-forge duotone direction + tier ramp (§1.5), or steer hue choices.
6. **Optional visuals** — include the parallel-batch timeline, cost/cache motif, and constellation backdrop (§4 / Phase 3.5), or cut for scope?
7. **Code tidy track (Phase 5)** — do the cheap `infra.js` lift + contract doc now (recommended), or leave code untouched and keep this a docs-only effort?
8. **Competitive comparison framing** — how direct to be vs. LangGraph/CrewAI/AutoGen by name in section 10 (honest-but-respectful recommended) vs. generic "library orchestrators" language?
9. **Surface the Docker-socket security disclosure prominently?** — recommended yes (it builds evaluator trust), but confirm placement (section 11 architecture vs. a callout).

---

*Plan grounded throughout in `viz-research.md` (options A/B/C, library/CDN feasibility §1/§4, hero-vs-explanatory split §3) and `engine-inventory.md` (components 1–12, coupling baseline B1–B5). No site code written — this is a design + architecture plan for `/scrum-master` to decompose.*
