# Voltron Engine: Canonical Brand & Positioning Copy

> **Single source of truth.** All prose in `docs/index.html` and `README.md` that covers
> positioning, tagline, and pillars draws from this file.
> Edit here first; propagate to site and README in the same commit.

---

## 1. Tagline

**V for all and All for one**

> Typographic note: in the logo, the **V** and the capital **A** are the same glyph, one
> inverted, so the two sides of the tagline share a single letterform. The tagline text
> itself is always rendered as written above.

### Supporting sub-headlines

- *Many agents. One engine.*
- *Orchestration that rewrites its own playbook.*
- *One coordinator. Fifty-one specialists. Real containers.*

---

## 2. One-line "What is this"

Project Voltron is an orchestration engine that drives Claude Code with a real three-tier agent
team (each specialist running in its own Docker container) and then grades and rewrites those
agents from what it learns in the field.

---

## 3. Positioning Statement

**The Voltron Engine** is the orchestration engine that drives Claude Code itself. One coordinator
decomposes the work; sub-managers own each domain; dozens of single-purpose micro-agents execute
the focused edits, each inside its own real Docker container running the real `claude` CLI.
Then the engine grades its own agents against a regression suite and rewrites them from
production feedback, closing a loop no other orchestrator has: versioned markdown agents,
improved by an automated PR pipeline, regression-graded before they ship.

---

## 4. The Three Pillars

### Pillar 1: Compose, don't prompt

**A real org chart, enforced in code.**

A depth-bounded three-tier hierarchy (coordinator → sub-manager → micro-agent), capped at
depth 3 by the runtime, not by convention. Sub-managers compose single-verb micro-agents; the
"never DIY" rule is baked into every template and enforced by a hard runtime cap. 73 templates.
73 jobs. Zero improvised monoliths.

### Pillar 2: Real isolation, real parallelism

**Every agent gets its own container running the real Claude CLI.**

Throwaway Docker containers, the actual `claude` binary, the repo bind-mounted, OAuth credentials
mounted read-only. Not an in-process SDK call. Fan out eight agents in one batch call,
bypassing main-session serialization, with a head-start gate that shares one prompt-cache write
across the fleet. The tier hierarchy runs recursively through nested Docker-out-of-Docker so
Tier-2 sub-managers can themselves spawn Tier-3 containers. Tuned to Anthropic prompt-cache
economics at the dispatch layer.

### Pillar 3: It improves itself

**Voltron rewrites its own agents and grades them before they ship.**

After each production session, agents submit structured reflections. A scheduled CI job runs the
harness-engineer agent, which reads those reflections, edits `src/templates.js`, bumps the
version, and opens a PR. Before any updated agent reaches users, the voltron-evals harness
dispatches it through the same live MCP path it uses in production and scores the result with
deterministic signals plus a Sonnet judge (self-preference-controlled). Cross-project operational
knowledge accrues in Alexandria, a shared knowledge base that flows out of every session into a
reusable store. *No other orchestrator self-modifies its agent definitions through a reviewed,
regression-graded pipeline.*

---

## 5. The Voltron Engine

The Voltron Engine is the machinery beneath the templates and the reason "Project Voltron" is more
than a bundle of markdown files. It is a self-modifying, self-evaluating orchestration engine:
agents are versioned markdown, execution is real Docker containers running the real `claude` CLI,
and the system rewrites and regrades its own agent definitions from production feedback. The
templates are what the engine produces and maintains; the engine is what you are actually
adopting.

**Differentiating components (marketing-grade one-liners):**

- **Three-tier agent hierarchy (component 1).** A real org chart in code: coordinator decomposes, sub-managers own domains, micro-agents do one focused edit each. Depth-capped at 3 by the runtime; 73 templates.
- **Docker-isolated execution (component 2).** Each agent runs in a throwaway container with the actual `claude` CLI, not an in-process SDK call. Full transcript captured; auth minimal by design.
- **Parallel batch dispatch (component 3).** Fan out 2 to 8 agents in one MCP call, with a head-start gate that shares one prompt-cache write across the whole fleet.
- **Nested Docker-out-of-Docker (component 4).** Tier-2 agents inside containers can spawn Tier-3 siblings via the mounted host socket. The hierarchy is real containers all the way down.
- **Dependency-graph task tracking with beads (component 5).** Work is a real DAG on a versioned Dolt database, not a TODO list. Dependency-aware planning is a first-class substrate.
- **Post-session reflection loop (component 6).** Agents submit structured feedback; CI runs the harness-engineer to edit templates, bump the version, and open a PR. The product rewrites itself from field data.
- **MCP-as-delivery channel (component 7).** The engine ships as an MCP server that augments Claude Code directly. Install means scaffolding versioned templates into your repo with an auto-update channel.
- **Scaffold + auto-update (component 8).** `scaffold_project` writes the right agent set to `.claude/agents/` with merge strategies. A `UserPromptSubmit` hook silently refreshes agents when the server version changes.
- **Stringer codebase baseline (component 9).** A pinned static-analysis substrate auto-registered as a second MCP server gives analysis agents a real code map instead of ad-hoc grepping.
- **Alexandria cross-project memory (component 10).** Tool and setup knowledge flows out of every session into a shared, searchable guide store, a second self-improving substrate alongside the reflection loop.
- **voltron-evals regression harness (component 11).** Agents are graded through the live MCP dispatch path they run in production, scored by deterministic signals plus a Sonnet judge. Frameworks ship examples; Voltron ships a graded regression suite for its own prompts.
- **Cost/cache-aware dispatch (component 12).** Cacheable system-prompt prefix, staggered fan-out, 4 KB output cap, de-duped context. Tuned to Anthropic prompt-cache economics at the harness layer.

---

*Content grounded in `planning/branding/upgrade-plan.md` §1.2, §1.4, §5.2 and*
*`planning/branding/engine-inventory.md` Part A (components 1 through 12).*
*Locked brand decisions: tagline confirmed; naming convention (Project Voltron = repo umbrella,*
*Voltron Engine = product/framework concept) confirmed; two-register voice (cinematic/plain at*
*top, technical/evidence-backed for evaluators) confirmed.*
