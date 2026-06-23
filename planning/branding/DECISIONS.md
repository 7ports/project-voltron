# Voltron Branding & Docs Upgrade — Locked Decisions (2026-06-18)

Decisions made by the user after reviewing the plan. The build sprint is PAUSED pending explicit go-ahead.

- **Animated centerpiece:** Option A->C hybrid — GSAP "Voltron Assembles" hero handing off to a force-graph living dispatch graph. Option B (Three.js GPGPU particle morph) is deferred as a future lazy-loaded upgrade.
- **Code reorganization:** DEFER full engine extraction (low assessed value vs front-loaded risk). Do the cheap "tidy now" instead: lift mis-filed infra constants into `src/infra.js`, document the `TEMPLATES` shape contract, and fix the `start_agent_in_docker` doc-drift in README.
- **Naming:** "Project Voltron" remains the primary/umbrella name; "the Voltron Engine" names the differentiating internal layer/concept (site + README positioning only — no code package split).
- **Next step:** Plan committed for review. BUILD SPRINT PAUSED — do not begin implementation until the user gives the go-ahead.

## Documents in this folder
- `upgrade-plan.md` — the comprehensive 8-section branding + documentation upgrade plan (the master plan).
- `viz-research.md` — researcher brief: client-side agent-visualization libraries, competitor approaches, centerpiece options A/B/C.
- `engine-inventory.md` — code-analyst: the 12-component "Voltron Engine" inventory + code-coupling baseline behind the reorg recommendation.

## Revisions (2026-06-19)

- Copy style: NO em-dashes anywhere in rebrand copy (site or README). Rewrite to avoid them.
- Scope: the competitive-comparison section is REMOVED from the site IA and all copy (no LangGraph/CrewAI/AutoGen comparison).
