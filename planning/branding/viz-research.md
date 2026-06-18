# Research: Visualizing AI Agents & Orchestration for a Static GitHub Pages Hero

**Date:** 2026-06-18
**Author:** Voltron researcher
**Purpose:** Inform a bold redesign of Project Voltron's GitHub Pages site (`/docs`, no backend, all client-side). Goal is a rich animated centerpiece with high wow-factor that visualizes a three-tier multi-agent orchestrator (1 coordinator → sub-managers → ~51 micro-agents) and leans on the Voltron "many units combine into one" metaphor.

---

## Summary

For a static, build-step-free GitHub Pages site, the realistic candidates split into three families: **(a) creative animation engines** (GSAP, anime.js, Three.js, Rive, Lottie) for a choreographed "lions assemble into the robot" hero; **(b) graph/node-diagram libraries** (Cytoscape.js, force-graph, D3-force, React Flow/Svelte Flow, Mermaid) for showing the dispatch DAG and tier hierarchy; and **(c) hybrid approaches** that pair a graph engine for structure with an animation engine for motion. The single biggest 2025 development affecting this decision: **GSAP (incl. all formerly-paid plugins like MorphSVG/SplitText) is now 100% free for commercial use** after Webflow's acquisition ([Webflow blog](https://webflow.com/blog/gsap-becomes-free), [CSS-Tricks](https://css-tricks.com/gsap-is-now-completely-free-even-for-commercial-use/)). For an "assembling/forming" hero, the strongest wow-to-effort options are **Three.js GPGPU particle morph** (max wow, max effort) and **GSAP + SVG/canvas choreography** (high wow, moderate effort, accessible). For the explanatory orchestration diagram, **Cytoscape.js** or **force-graph** (both genuinely CDN/script-tag friendly) beat React Flow (which fights you without a build step). All recommendations below respect `prefers-reduced-motion` as a hard requirement.

---

## Findings

### 1. Client-side animation / graph / visualization libraries

Legend: ✓ confirmed · ~ estimated · ? unverified. Bundle sizes are gzipped approximations unless noted.

| Library | Best at | Animation power | Bundle (gzip) | Static/CDN friendly | License |
|---|---|---|---|---|---|
| **GSAP** | Timeline choreography, scroll-driven sequences, SVG morphing, text splitting | ★★★★★ — the reference standard for complex orchestrated motion | ~23 KB core + plugins | ✓ Excellent — single `<script>` from CDN, framework-agnostic | **Free incl. commercial + all plugins** (since 2025, Webflow) ✓ |
| **anime.js (v4)** | Lightweight property/timeline animation, SVG line drawing, staggered effects | ★★★★ — great for staggered "many elements" motion | <20 KB ✓ | ✓ Excellent — ESM/CDN, zero deps | MIT ✓ |
| **Three.js** | WebGL 3D, particle systems, GPGPU point clouds, shader effects | ★★★★★ — only real option for true particle "assembly" in 3D | ~150 KB+ core (~600 KB min uncompressed) | ✓ Good — ESM via CDN/importmap; heavy | MIT ✓ |
| **Rive** | Designer-authored *interactive* vector animation w/ state machines reacting to input/scroll | ★★★★★ for interactive vector; needs the Rive editor to author | Runtime ~ small; `@rive-app/canvas` / `canvas-lite` variants; `.riv` files tiny | ✓ Good — WASM runtime via CDN | **MIT runtimes** ✓ |
| **Lottie** | Playing pre-made After Effects animations (JSON) | ★★★ — play-only, no real runtime interactivity | lottie-web ~ heavy-ish; files vary | ✓ Good — CDN player / `<lottie-player>` web component | MIT ✓ |
| **D3 (d3-force, d3-hierarchy)** | Data-driven custom viz, force layouts, tree/DAG layouts | ★★★★ — total control, you build the rendering | Modular; import only needed packages | ✓ Good — ESM/CDN | ISC ✓ |
| **Cytoscape.js** | Graph/network analysis + rendering (topology, dependency maps) | ★★★ — animated layouts, pan/zoom, transitions | ~ moderate | ✓ **Excellent** — explicit UMD/ESM CDN builds, documented script-tag use | MIT ✓ |
| **force-graph (vasturiano)** | Force-directed graph on HTML5 canvas (d3-force physics) | ★★★★ — animated physics, particles-on-links, easy | small wrapper + d3-force | ✓ **Excellent** — `<script src="//cdn.jsdelivr.net/npm/force-graph">` then `new ForceGraph(el)` | MIT ✓ |
| **React Flow / Svelte Flow (xyflow)** | Node-based editors, custom interactive nodes as components | ★★★ — pan/zoom/drag; motion via CSS/Motion | needs React/Svelte + reactflow | ~ **Poor for no-build** — designed for bundlers; CDN use is awkward (open GitHub discussions, no first-class path) | MIT ✓ |
| **Mermaid** | Declarative diagrams (flowchart/graph/sequence) from text | ★ — static render, minimal animation | ~ large but CDN-loadable | ✓ Good — CDN `mermaid.initialize()`; great for docs diagrams | MIT ✓ |
| **Motion (ex-Framer Motion)** | Declarative React UI transitions, layout (FLIP) animations | ★★★★ — excellent for UI state, gestures, scroll | modular, small core | ~ Best with React/build; vanilla `motion` package exists | MIT ✓ |
| **tsParticles / particles.js** | Decorative particle backgrounds, link/constellation effects | ★★★ — config-driven particles, mouse interaction | moderate | ✓ Good — CDN bundle | MIT ✓ |

**Performance ranking context** (from [Motion's Web Animation Performance Tier List](https://motion.dev/magazine/web-animation-performance-tier-list)): the fastest animations are **S-tier compositor-thread** properties — `transform`, `opacity`, `filter`, `clip-path` — which stay smooth even when the main thread is busy. GSAP and Motion both run "A-tier" main-thread composite animations. CSS **custom properties are only C-tier** (changing one *always* triggers paint). WebGL/WebGPU shaders render extremely fast but are **main-thread dependent**, so they can't reach S-tier and need fallbacks on weak devices. Practical rule confirmed across sources: animate only `transform`/`opacity`, target 60fps (16.7ms/frame), avoid `top/left/width/height` (forces layout). Sources: [Motion tier list](https://motion.dev/magazine/web-animation-performance-tier-list), [web.dev motion](https://web.dev/learn/accessibility/motion).

**Sources:** [GSAP homepage](https://gsap.com/), [GSAP pricing](https://gsap.com/pricing/), [Webflow: GSAP is free](https://webflow.com/blog/gsap-becomes-free), [Cytoscape.js](https://js.cytoscape.org/), [force-graph](https://vasturiano.github.io/force-graph/), [force-graph npm](https://www.npmjs.com/package/force-graph), [Rive runtimes](https://rive.app/runtimes), [rive-wasm](https://github.com/rive-app/rive-wasm), [Motion tier list](https://motion.dev/magazine/web-animation-performance-tier-list).

---

### 2. How real AI-agent / orchestration projects visualize agents

| Project | Visualization technique | Reference URL |
|---|---|---|
| **LangGraph** | Agent logic modeled as a **directed graph of nodes (model/tool/conditional) and edges (transitions)**. The framework's native representation *is* a graph, which it renders directly. | [langchain.com/langgraph](https://www.langchain.com/langgraph), [docs.langchain.com](https://docs.langchain.com/oss/python/langgraph/overview) |
| **LangSmith** | **Execution-trace graph**: highlights which nodes executed, shows state received per node, token consumption per step, and supports replay from a checkpoint. Node-graph + step inspector pattern. | [langchain.com/langgraph](https://www.langchain.com/langgraph) |
| **CrewAI** | Role-based (not natively graph-first); ships an observability **dashboard** in enterprise tier, exports OpenTelemetry to Langfuse/Arize for trace visualization. | [pecollective comparison](https://pecollective.com/blog/ai-agent-frameworks-compared/) |
| **n8n** | **Flowchart-style canvas** (not pure dataflow). The visual workflow is a serialized JSON of nodes + connections + config; supports input/output structure visualization and "pin" to freeze step output. | [n8n workflows](https://datadrivenconstruction.io/workflows-and-automation/), [canvas UX face-off](https://rapidclaw.dev/blog/low-code-ai-agent-platforms-compared-2026) |
| **Flowise** | **Visual LangChain canvas** — node-based, makes agent architecture "visible and teachable"; nodes fully expand to show all config inline. | [Flowise vs Dify vs n8n](https://www.jahanzaib.ai/blog/flowise-vs-dify-vs-n8n-ai-agents) |
| **Dify** | Node-based workflow builder with guided/expandable nodes; emphasis on intuitive low-code assembly. | [Dify vs n8n vs Flowise](https://www.api2o.com/en/blog/lowcode-platform-compare-dify-n8n-flowise) |

**Pattern takeaway:** The entire category converges on **node-and-edge canvases**. LangGraph/LangSmith use the graph *as the data model*; n8n/Flowise/Dify use a drag-and-drop flowchart canvas. None of these are portfolio "hero" animations — they're functional editors/inspectors. That's an opportunity: Voltron's marketing hero can be far more cinematic than any competitor's utilitarian canvas, while still offering a familiar node-graph for the explanatory/deeper section.

**Sources:** [LangGraph](https://www.langchain.com/langgraph), [LangGraph docs](https://docs.langchain.com/oss/python/langgraph/overview), [framework comparison](https://pecollective.com/blog/ai-agent-frameworks-compared/), [n8n/Dify/Flowise comparison](https://www.api2o.com/en/blog/lowcode-platform-compare-dify-n8n-flowise), [canvas UX face-off 2026](https://rapidclaw.dev/blog/low-code-ai-agent-platforms-compared-2026).

---

### 3. Orchestration visualization patterns (and where they fit)

| Pattern | What it shows | Best fit | Implementation notes |
|---|---|---|---|
| **Tiered / radial dispatch graph** | Coordinator at center/top → sub-managers → micro-agents fanning out | **Hero** (matches Voltron's 1→N→51 model + "combine" metaphor) | Radial or hierarchical layout; animate edges lighting up as dispatch propagates. d3-hierarchy / Cytoscape concentric layout / force-graph |
| **DAG / dependency tree** | Beads dependency graph; what blocks what | **Deeper explanatory diagram** | Dagre or ELK layout (via D3/Cytoscape); Mermaid for a static version in docs |
| **Swimlane / timeline (Gantt-style)** | Parallel agents running concurrently over time (batch dispatch) | **Explanatory** — communicates parallelism + Docker isolation well | GSAP timeline driving SVG/canvas bars; or D3 |
| **Animated message-passing node-graph** | Packets/pulses traveling along edges between agents | **Hero or mid-page** — high motion, conveys "live system" | force-graph supports directional **particles on links** natively; or GSAP `motionPath` along SVG edges |
| **Particle "assembly/forming" hero** | Thousands of points converge/morph from scattered → a unified form (the Voltron metaphor) | **Hero** — highest wow | Three.js GPGPU particle morph (FBO/WebGLRenderTarget, XYZ in RGB channels); morph scattered cloud → robot/logo silhouette |
| **Constellation / network background** | Ambient connected-dots backdrop suggesting a mesh of agents | **Subtle hero backdrop / section bg** | tsParticles/particles.js — low effort, decorative only |

**Hero vs explanatory split (recommended framing):**
- **Hero** should be emotional and metaphor-driven: the "lions → robot" assembly. Particle morph or choreographed SVG assembly. One clear payoff moment.
- **Explanatory diagrams** (further down the page) should be literal and legible: the actual tier graph, the beads DAG, the parallel-batch timeline. Accuracy and readability over spectacle.

**The Voltron metaphor specifically** maps cleanly onto two techniques: (1) **particle convergence** — scattered particles representing the ~51 micro-agents fly in and assemble into a single robot/logo form; (2) **staggered SVG/object assembly** — discrete "lion" pieces slide/rotate into a combined whole via a GSAP timeline (think the literal Voltron forming sequence). The latter is more on-brand and far cheaper/more accessible than GPGPU.

**Sources:** [Three.js Journey: Particles Morphing Shader](https://threejs-journey.com/lessons/particles-morphing-shader), [Three.js Journey: GPGPU Flow Field Particles](https://threejs-journey.com/lessons/gpgpu-flow-field-particles-shaders), [Codrops: Dreamy GPGPU particle effect](https://tympanus.net/codrops/2024/12/19/crafting-a-dreamy-particle-effect-with-three-js-and-gpgpu/), [force-graph](https://vasturiano.github.io/force-graph/), [Codrops: GSAP free plugin demos (SplitText→MorphSVG)](https://tympanus.net/codrops/2025/05/14/from-splittext-to-morphsvg-5-creative-demos-using-free-gsap-plugins/).

---

### 4. Feasibility on static GitHub Pages (no build step, CDN-only)

**Works cleanly via CDN / `<script>` / importmap (no build):**
- ✓ **GSAP** — single script tag; all plugins now free and CDN-hosted. Ideal.
- ✓ **anime.js** — ESM or script tag, zero deps.
- ✓ **Three.js** — ESM via CDN + `<script type="importmap">`; works but it's the heaviest payload — lazy-load it and gate on viewport.
- ✓ **Rive** — WASM `@rive-app/canvas` runtime loadable from CDN; `.riv` asset is tiny. Requires authoring in the Rive editor up front.
- ✓ **Lottie** — `<lottie-player>` web component or lottie-web from CDN.
- ✓ **Cytoscape.js** — documented UMD/ESM CDN builds (cdnjs, jsDelivr, unpkg). First-class no-build support.
- ✓ **force-graph** — `<script src="//cdn.jsdelivr.net/npm/force-graph">`, then `new ForceGraph(el).graphData(...)`. First-class no-build support.
- ✓ **Mermaid / tsParticles** — both CDN-loadable.
- ~ **React Flow / Svelte Flow** — technically loadable from CDN but **designed for bundlers**; using it without a build is awkward (you'd need React + ReactDOM + Babel-in-browser or ESM gymnastics). **Not recommended** for this static, no-build constraint unless the team adds a lightweight build step.

**Performance considerations (confirmed across sources):**
- Animate only `transform` / `opacity` (GPU-friendly, compositor thread). Avoid layout-triggering props. ([Motion tier list](https://motion.dev/magazine/web-animation-performance-tier-list))
- Target 60fps / 16.7ms per frame; reduce particle counts / simplify effects on weak devices via device detection. ([zigpoll](https://www.zigpoll.com/content/how-do-you-approach-optimizing-load-times-and-performance-for-complex-animations-on-mobile-devices-in-a-way-that-balances-user-engagement-and-responsiveness))
- WebGL/shaders are fast but main-thread bound — **always ship a static-image or CSS fallback** for low-end/mobile.
- Lazy-load heavy libs (Three.js) and start animation only when the hero is in viewport (IntersectionObserver).

**Accessibility (hard requirement):**
- **`prefers-reduced-motion`** must be honored: detect via CSS `@media (prefers-reduced-motion: reduce)` for CSS animations *and* via `window.matchMedia('(prefers-reduced-motion: reduce)')` in JS to disable/replace JS-driven motion. Decorative effects (fades, parallax, particle drift) should simply not run. Replace the animated hero with a clean static end-state (the fully-formed Voltron + graph). ([MDN prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion), [web.dev](https://web.dev/learn/accessibility/motion), [Pope Tech](https://blog.pope.tech/2025/12/08/design-accessible-animation-and-movement/))
- Keep parallax subtle (20–30% speed delta) to avoid motion sickness; test on mobile. ([web animation guide](https://www.vawebseo.com/web-animation-in-modern-design-complete-2025-guide/))
- Provide non-motion meaning: the graph should be understandable as a static image; consider a "replay animation" button rather than autoplay loops.

**Mobile:**
- Ship a reduced particle count / simpler timeline or a static poster frame on small screens.
- Canvas/WebGL hero should detect low power and degrade. Prefer a 2D canvas (force-graph) or SVG/GSAP hero over WebGL if broad mobile reach matters more than maximum spectacle.

**Sources:** [Cytoscape getting started](https://github.com/cytoscape/cytoscape.js/blob/master/documentation/md/getting-started.md), [force-graph npm](https://www.npmjs.com/package/force-graph), [xyflow CDN discussion #2857](https://github.com/xyflow/xyflow/discussions/2857), [MDN prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion), [web.dev motion](https://web.dev/learn/accessibility/motion), [Motion tier list](https://motion.dev/magazine/web-animation-performance-tier-list).

---

### 5. Shortlist: 3 candidate approaches for the animated centerpiece

> Options laid out with trade-offs for the planner to choose from — no final pick made here.

#### Option A — "Voltron Assembles": GSAP + SVG/canvas choreography (RECOMMENDED for balance)
Discrete pieces (the "lions" / agent clusters) animate in via a **GSAP timeline** — slide, rotate, snap together into the unified Voltron form / logo, with edges lighting up to reveal the tier graph (coordinator → sub-managers → 51 micro-agents). Optionally use MorphSVG (now free) to morph scattered shapes into the final mark, and `motionPath` to send message pulses along edges.
- **Pros:** Best wow-to-effort ratio; directly literal to the Voltron metaphor; GSAP is free incl. all plugins and trivially CDN-loaded with no build; animates `transform`/`opacity` (S/A-tier perf); easy `prefers-reduced-motion` fallback to a static formed state; works on mobile.
- **Cons:** Not as jaw-dropping as a 3D particle cloud; requires hand-authoring the SVG/timeline choreography (design effort).
- **Refs:** [Codrops GSAP free-plugin demos](https://tympanus.net/codrops/2025/05/14/from-splittext-to-morphsvg-5-creative-demos-using-free-gsap-plugins/), [GSAP](https://gsap.com/).

#### Option B — "Particle Swarm → Form": Three.js GPGPU particle morph (MAX wow)
Thousands of GPU particles representing the swarm of micro-agents scatter, swirl, then **morph into a unified silhouette** (robot/logo). Uses GPGPU (WebGLRenderTarget/FBO, XYZ encoded in texture RGB) for performance at high particle counts.
- **Pros:** Highest spectacle; literally embodies "many units → one whole"; particle count can mirror the ~51 agents (or scale up for drama); MIT licensed.
- **Cons:** Heaviest bundle (~150 KB+ Three.js, lazy-load required); WebGL/shaders are main-thread bound and need robust low-end/mobile fallbacks; highest implementation complexity (shader/GPGPU expertise); must ship a static poster for reduced-motion and weak GPUs.
- **Refs:** [Three.js Journey particle morph](https://threejs-journey.com/lessons/particles-morphing-shader), [Three.js Journey GPGPU](https://threejs-journey.com/lessons/gpgpu-flow-field-particles-shaders), [Codrops GPGPU effect](https://tympanus.net/codrops/2024/12/19/crafting-a-dreamy-particle-effect-with-three-js-and-gpgpu/).

#### Option C — "Living Dispatch Graph": force-graph (or Cytoscape.js) with animated message-passing
A real node-graph of the orchestration: coordinator → sub-managers → micro-agents, with the force layout settling into the tier structure and **directional particles flowing along edges** to show live dispatch/message-passing. Doubles as both hero and the literal explanatory diagram.
- **Pros:** Most *honest* representation of what Voltron actually is; force-graph has built-in link particles and is trivially CDN-loaded with no build (`new ForceGraph(el)`); canvas 2D = far lighter and more mobile-friendly than WebGL; same component can power the deeper explanatory section; the graph is meaningful even when motion is disabled.
- **Cons:** Less "cinematic" than A or B; force layouts can look generic (every AI tool has a node graph — see §2); needs tuning to feel branded rather than utilitarian; doesn't directly evoke the "combine into one robot" metaphor without extra art direction.
- **Refs:** [force-graph](https://vasturiano.github.io/force-graph/), [force-graph npm](https://www.npmjs.com/package/force-graph), [Cytoscape.js](https://js.cytoscape.org/).

**Possible hybrid (worth flagging to planner):** Option A or B as the emotional hero "forming" moment, transitioning into Option C as the interactive, scroll-revealed explanatory graph. GSAP can drive the scroll choreography that hands off to a force-graph/Cytoscape canvas. This gives the wow moment *and* the honest system diagram.

---

## Key Decisions / Recommendations

- **No-build constraint eliminates React Flow/Svelte Flow** as practical hero tech here; favor GSAP, Three.js, Cytoscape.js, force-graph, anime.js, Rive — all genuinely CDN/script-tag friendly.
- **GSAP is now free for commercial use incl. all plugins** — removes the historical licensing barrier and makes Option A very attractive.
- For **maximum reach + accessibility + on-brand metaphor with reasonable effort → Option A**. For **maximum spectacle and budget for it → Option B**. For **honesty + reuse as the explanatory diagram → Option C**. A hybrid (A/B → C) is viable.
- **Hard requirements regardless of pick:** honor `prefers-reduced-motion` with a static formed-state fallback; lazy-load heavy libs; animate only `transform`/`opacity`; ship a mobile/low-power degradation path.

## Gaps / Uncertainties

- ~ Exact gzipped bundle sizes are approximate (not all measured against latest releases — planner/impl should verify current numbers via Bundlephobia/the libs' own builds).
- ? Underlying frontend rendering libraries used by n8n/Flowise/Dify weren't disclosed in sources (they're products, not documented as reusable techniques) — described by visual pattern instead.
- ? AutoGen's specific visualization/dashboard capabilities were not surfaced in current sources.
- Did not hands-on benchmark any library; performance claims are from authoritative secondary sources (Motion tier list, web.dev, MDN).

## Sources
- https://gsap.com/ — GSAP capabilities, CDN use
- https://gsap.com/pricing/ — license terms
- https://webflow.com/blog/gsap-becomes-free — GSAP now free incl. plugins/commercial
- https://css-tricks.com/gsap-is-now-completely-free-even-for-commercial-use/ — confirms GSAP free
- https://tympanus.net/codrops/2025/05/14/from-splittext-to-morphsvg-5-creative-demos-using-free-gsap-plugins/ — GSAP free-plugin creative demos (SplitText, MorphSVG)
- https://motion.dev/magazine/web-animation-performance-tier-list — animation performance tiers (transform/opacity = S-tier; shaders main-thread bound)
- https://js.cytoscape.org/ — Cytoscape.js, CDN/UMD/ESM builds
- https://github.com/cytoscape/cytoscape.js/blob/master/documentation/md/getting-started.md — Cytoscape no-build CDN usage
- https://vasturiano.github.io/force-graph/ — force-graph canvas, link particles
- https://www.npmjs.com/package/force-graph — force-graph CDN script-tag usage
- https://github.com/xyflow/xyflow/discussions/2857 — React Flow CDN/no-build difficulty
- https://rive.app/runtimes — Rive web runtimes
- https://github.com/rive-app/rive-wasm — Rive WASM/JS runtime, canvas variants, MIT
- https://threejs-journey.com/lessons/particles-morphing-shader — Three.js particle morph technique
- https://threejs-journey.com/lessons/gpgpu-flow-field-particles-shaders — Three.js GPGPU particles (FBO/WebGLRenderTarget)
- https://tympanus.net/codrops/2024/12/19/crafting-a-dreamy-particle-effect-with-three-js-and-gpgpu/ — GPGPU particle hero example
- https://www.langchain.com/langgraph — LangGraph directed-graph model + LangSmith trace viz
- https://docs.langchain.com/oss/python/langgraph/overview — LangGraph overview
- https://pecollective.com/blog/ai-agent-frameworks-compared/ — CrewAI observability/dashboard, framework comparison
- https://www.api2o.com/en/blog/lowcode-platform-compare-dify-n8n-flowise — n8n/Dify/Flowise canvas comparison
- https://rapidclaw.dev/blog/low-code-ai-agent-platforms-compared-2026 — canvas UX comparison
- https://www.jahanzaib.ai/blog/flowise-vs-dify-vs-n8n-ai-agents — Flowise visual LangChain canvas
- https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion — reduced-motion media feature
- https://web.dev/learn/accessibility/motion — accessible motion guidance
- https://blog.pope.tech/2025/12/08/design-accessible-animation-and-movement/ — accessible animation code examples
- https://www.vawebseo.com/web-animation-in-modern-design-complete-2025-guide/ — parallax/mobile best practices
