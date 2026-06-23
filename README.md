# Project Voltron

**V for all and All for one**

*Project Voltron* is the repository; **the Voltron Engine** is what it ships. The engine is an orchestration layer that drives Claude Code itself with a real three-tier agent team, each specialist running in its own Docker container, and then grades and rewrites those agents from what it learns in the field.

Install it as an MCP server and scaffold any project with battle-tested subagent definitions for Unity game dev, web/fullstack development, and general software work, plus a scrum-master coordinator, 51 micro-agents, and a self-improvement loop.

The engine stands on three pillars:

- **Compose, don't prompt.** A real org chart enforced in code: a depth-bounded hierarchy of coordinator, sub-manager, and micro-agent, capped at depth 3 by the runtime rather than by convention. Sub-managers compose single-verb micro-agents and never improvise a monolith.
- **Real isolation, real parallelism.** Every agent runs in its own throwaway Docker container running the real `claude` CLI, not an in-process SDK call. The image ships a full toolchain — Node, Python, Ruby, the GitHub CLI, and a headless Chromium via Playwright so web and front-end agents can actually render and test pages. Fan out up to eight agents in a single batch call, with a head-start gate that shares one prompt-cache write across the whole fleet. The host Docker socket is default-deny: it is bind-mounted only into agents that can actually dispatch (their `tools:` grant `run_agent_in_docker`), so research, design, and validation roles never receive host-root-equivalent access.
- **It improves itself.** After each session, agents submit structured reflections. CI runs the harness-engineer agent to edit the templates and open a PR, and the voltron-evals harness regression-grades every change through the same live MCP path it uses in production before it ships.

## Agent Teams

### Orchestrator (slash command, runs in your main Claude Code session)

| Command | Purpose |
|---|---|
| **`/scrum-master`** | Reads backlogs, breaks work into agent-sized tasks, assigns to specialists. Never implements. Slash command (not subagent) so it can stream agent output and channel communication directly in your chat. |

### Specialist subagents (core, all projects)

| Agent | Purpose |
|---|---|
| **project-planner** | Researches tech stacks, designs architecture, defines data models and API contracts, produces comprehensive project plans for the scrum-master to decompose. |
| **researcher** | Deep research specialist. Finds any information (technical docs, APIs, pricing, competitors, legal text, community consensus) using web search, live page navigation, and structured extraction. |

### Unity

`run_agent_in_docker` is the **primary dispatch path** for Unity work: C# scripts, shader/material file edits, manifest changes, and folder/asset structure all run in Docker. A narrow exception covers four Editor-bound managers that need a live Unity Editor with Coplay MCP; the scrum-master dispatches those via the built-in `Agent` tool from the host.

| Agent | Purpose | Dispatch |
|---|---|---|
| **scene-architect** | GameObject hierarchy, prefabs, scene composition, transforms, and components | `Agent` tool (Editor exception) |
| **csharp-dev** | MonoBehaviours, ScriptableObjects, gameplay systems, editor tools, composes `csharp-script-writer` / `csharp-member-adder` micro-agents, never DIY | `run_agent_in_docker` (file edit) |
| **shader-artist** | Shaders, materials, VFX Graph, render pipeline features (URP/HDRP/Built-in), composes file-writing micro-agents for code, uses Coplay for Editor preview | `run_agent_in_docker` (file) / `Agent` tool (Editor preview) |
| **build-validator** | Console monitoring, compile checks, Play Mode smoke tests | `Agent` tool (Editor exception) |
| **asset-manager** | Folder structure, import settings, naming conventions, composes `unity-manifest-editor` and other micro-agents for files, uses Coplay for import settings | `run_agent_in_docker` (folders) / `Agent` tool (import settings) |

### Web / Fullstack

| Agent | Purpose |
|---|---|
| **fullstack-dev** | React/TypeScript frontend + Node.js/Express backend |
| **devops-engineer** | Terraform, CI/CD, Docker, Fly.io, AWS |
| **ui-designer** | CSS, responsive layout, theming, PWA, accessibility |
| **qa-tester** | Testing (Vitest/Playwright), Lighthouse audits, bundle analysis |

### Micro-Agents (Haiku tier, 51 focused workers)

Dispatched by sub-managers for single-verb, single-file tasks. Each does one thing.

**Web**

| Agent | Purpose |
|---|---|
| **function-writer** | Write a single function or utility to a specified file |
| **middleware-writer** | Add Express/Koa/Hono middleware to the server stack |
| **store-slice-writer** | Write a Zustand/Redux slice or context module |
| **css-writer** | Write scoped CSS, Tailwind utilities, or CSS-in-JS styles |
| **design-token-writer** | Write design token files (colors, spacing, typography) |

**Unity**

| Agent | Purpose |
|---|---|
| **csharp-script-writer** | Write a new C# MonoBehaviour or ScriptableObject script |
| **csharp-member-adder** | Add fields, properties, or methods to an existing C# class |
| **unity-manifest-editor** | Edit `Packages/manifest.json` or `ProjectSettings` files |

**DevOps**

| Agent | Purpose |
|---|---|
| **ci-workflow-writer** | Write or update a GitHub Actions / GitLab CI workflow file |
| **docker-compose-editor** | Add or modify services in `docker-compose.yml` |

**QA**

| Agent | Purpose |
|---|---|
| **coverage-runner** | Run the coverage reporter and surface uncovered lines |
| **test-config-writer** | Write or update Vitest/Jest/Playwright config files |
| **mock-writer** | Write mock modules or fixtures for unit tests |

**Cross**

| Agent | Purpose |
|---|---|
| **file-patch-runner** | Apply a targeted patch to any file when no specialist fits |

### Internal (not scaffolded into projects)

| Agent | Purpose |
|---|---|
| **harness-engineer** | Owns all modifications to Project Voltron itself, agent templates, Dockerfile, MCP server code, docs, and scripts. Invoked by scrum-master for any Voltron change, and by CI to process session reflections into targeted template improvements. |
| **voltron-judge** | Agent-as-a-Judge for the `voltron-evals` harness. Inspects a single agent run's artifacts (log, git diff, beads snapshot, journal, reflection) against a pinned rubric and emits a per-criterion, evidence-cited scorecard JSON. Inspect-only: no Write/Edit/`run_agent_in_docker` in its tools list. Runs on Sonnet to mitigate self-preference when grading Opus-tier agents. |

## Installation

### One-command setup

```bash
git clone https://github.com/7ports/project-voltron.git
cd project-voltron
node scripts/setup.js
```

The setup script:
- Installs npm dependencies
- Registers the `project-voltron` MCP server in Claude Code (global scope)
- Adds the recommended allowlist to `~/.claude/settings.json` so agents don't require manual approval for common commands
- Verifies Docker is available

**Restart Claude Code** after running setup to load the new MCP server and allowlist.

### Required: beads dependency tracker

The scrum-master uses [beads](https://github.com/gastownhall/beads) for dependency-aware task orchestration. **This is mandatory** as of v3.4.0, agents will refuse to dispatch work plans without a working `bd` CLI:

```bash
npm install -g @beads/bd
```

Without beads, the scrum-master falls back to manual dependency reasoning.

**Auto-recovery (v3.7.0+):** The scrum-master's pre-flight check now detects when the shared dolt-server (configured by `dolt.shared-server: true` in `.beads/config.yaml`) has been orphaned by a reboot and runs `bd dolt start` to auto-restart it before planning. This eliminates the most common Windows post-reboot failure mode where bd commands error out with "Dolt server unreachable on port 3308". For a permanent fix, the agent's **Beads Recovery** section provides a `Register-ScheduledTask` PowerShell snippet that auto-starts `bd dolt` at every logon.

### Re-verify installation

From within any Claude Code session:
```
Call mcp__project-voltron__setup_voltron
```

This checks and repairs the allowlist without requiring a terminal.

## Alexandria Integration

Voltron agents are designed to work with **Project Alexandria**: a companion MCP server that maintains a shared library of tooling setup guides. When both are installed, agents consult Alexandria **before** any tool installation, this is mandatory, not optional.

**What this enables:**
- All specialist agents call `quick_setup` before installing any tool, library, or service, and `search_guides` if no exact guide exists
- `scrum-master` calls `get_project_setup_recommendations` when planning a new project and requires specialist agents to check Alexandria in every tool-setup task
- After completing a setup, agents call `update_guide` to record findings (platform quirks, version notes, working commands)
- Tool knowledge from sessions flows back into Alexandria, not just into Voltron's reflection pipeline

**Content boundary:** Alexandria is for non-project-specific, reusable documentation only, tool setup guides, platform quirks, version notes, API patterns. Project-specific knowledge (business logic, custom architecture, team conventions) belongs in `CLAUDE.md` and local project docs, not Alexandria.

**Setup:** Install both MCP servers globally in `~/.claude.json`. No additional configuration is needed, agent templates already include the relevant `mcp__alexandria__*` tools.

See [Project Alexandria](https://github.com/7ports/project-alexandria) for setup instructions.

## MCP Tools

| Tool | Description |
|---|---|
| `list_templates` | List all templates, optionally filtered by project type |
| `get_template` | Get the full content of a specific template |
| `scaffold_project` | Writes agent templates and Dockerfile directly to disk for unity, web, fullstack, mobile, or general projects. Smart merge: skips existing agent files, appends to existing CLAUDE.md, preserves custom Dockerfiles. Auto-detects project root via filesystem walk when project_root not specified (looks for .git, CLAUDE.md, .mcp.json, etc.); restart Claude Code required after scaffolding. |
| `setup_voltron` | Verify and repair Voltron installation from within Claude Code, updates the global allowlist and reports MCP/Docker status |
| `get_auto_update_hook` | Get the `.claude/settings.json` hook for existing projects |
| `get_agent_usage_guide` | Usage guide for invoking and coordinating agents |
| `check_for_updates` | Check if installed agent files are outdated vs. current templates |
| `update_agent` | Get the latest content for a specific agent |
| `submit_reflection` | Submit a post-session reflection on agent performance |
| `list_reflections` | List stored reflections (for reviewing pending improvements) |
| `run_agent_in_docker` | Launch a specialist agent in a Docker container with full permissions (called by scrum-master) |
| `run_agent_in_docker_batch` | Launch 2–8 specialist agents in parallel containers, one MCP call, N parallel executions. Use for any dispatch wave of dependency-free agents; bypasses main-session tool-call serialization. |
| `update_progress` | Update agent task progress (called by scrum-master before/after each agent invocation) |
| `get_progress` | View current agent task progress in the chat window |

## Usage

Once installed, ask Claude Code:

- *"Scaffold this Unity project with Voltron agents"* → `scaffold_project` with `project_type: "unity"`
- *"Scaffold this web project with Voltron agents"* → `scaffold_project` with `project_type: "web"`
- *"How do I use the Voltron agents?"* → `get_agent_usage_guide`
- *"Check if my agents are up to date"* → `check_for_updates`
- *"Add the auto-update hook to this project"* → `get_auto_update_hook`

## Workflow

1. **Scaffold**: run `scaffold_project` in your project root with your project type
2. **Configure**: fill in `CLAUDE.md` with your project specifics and set up Docker execution (see scaffold output)
3. **Research**: for new projects, invoke `@agent-project-planner` to research tech stack and design architecture
4. **Plan**: invoke `/scrum-master` (slash command, runs in your main session) with the project plan to get a structured work breakdown
5. **Develop**: invoke specialist agents per the plan; they consult Alexandria for tool setup
6. **Reflect**: scrum-master automatically submits reflections at phase completion, blockers, and session end; also syncs tool findings to Alexandria

## Agent Auto-Update

`scaffold_project` outputs a `.claude/settings.json` containing a `UserPromptSubmit` hook. This hook runs `scripts/auto-update-agents.js` at the start of every Claude Code session. If the installed version differs from your local Voltron installation, all outdated files are silently updated in place.

**What gets auto-updated:**
- All agent `.md` files in `.claude/agents/`
- Slash-command `.md` files in `.claude/commands/` (e.g. `scrum-master.md`)
- `Dockerfile.voltron` (if it exists, only projects using Docker)
- `scripts/voltron-run.sh` (if it exists)
- **v3.11 migration:** projects scaffolded before v3.11 will have `.claude/agents/scrum-master.md` automatically moved to `.claude/commands/scrum-master.md` on next session, then the legacy subagent file is deleted. No manual action required.
- **v3.12.1 scaffold fix:** `scaffold_project` now writes `.claude/commands/scrum-master.md` for **every** project type (previously dropped for typed scaffolds), and the auto-update hook self-heals a missing command file on already-scaffolded projects, so existing checkouts pick up `/scrum-master` on their next session.

**What is NOT auto-updated** (user-customized files):
- `CLAUDE.md`, contains project-specific context you've filled in
- `.claude/settings.json`, hook config that you may have customized

A `[VOLTRON] Auto-updated N file(s)` message appears in context when an update occurs. For projects scaffolded before this feature was added, run `get_auto_update_hook` to get the settings entry to add manually.

## Self-Improvement

Agents submit post-session reflections via `submit_reflection`. The scrum-master now submits reflections automatically at phase completion, after significant blockers, and at session end. Reflections accumulate in the `reflections/` directory and are automatically processed by a GitHub Actions workflow that runs **every Monday at 10:00 UTC**:

**Write-only reflection submission (v3.13.1):** `submit_reflection` now only writes `reflections/<file>.json` locally and returns a saved-but-not-committed status, it no longer auto git add/commit/pushes. Reflections are gathered and submitted later via a dedicated reflections sweep / PR, so they no longer strand commits on protected `main` or pollute unrelated feature PRs.

1. The `harness-engineer` agent reads all unprocessed reflections
2. Groups feedback by agent and prioritizes by frequency
3. Applies targeted improvements to `src/templates.js`
4. Bumps the patch version and commits
5. Opens a PR for human review before changes reach `main`

Once merged, projects with the auto-update hook installed will automatically receive the new templates at the start of their next session. Projects without the hook can pull improvements manually via `check_for_updates`. The workflow can also be triggered manually from the Actions tab. Requires `ANTHROPIC_API_KEY` set as a repository secret.

A second workflow, `.github/workflows/voltron-evals.yml`, runs the **voltron-evals** harness on a monthly cadence (1st of each month at 12:00 UTC) plus on manual `workflow_dispatch`. It executes the full Deep + Broad eval sweep against every agent template, with Opus judging Deep tasks and Haiku/programmatic scoring on Broad instances. A content-hash cache keyed on `src/templates.js` and `voltron-evals/lib/template-hash.js` reuses prior scorecards so that only agents whose templates changed since the last sweep pay the LLM cost. Scorecards are uploaded as a CI artifact.

## Docker Execution

The scrum-master launches each specialist agent inside a Docker container automatically via the `run_agent_in_docker` MCP tool. You run Claude Code normally on your desktop, Docker is handled behind the scenes.

When the scrum-master invokes an agent, `run_agent_in_docker`:
1. Loads the agent's template and CLAUDE.md for project context
2. Builds the Docker image from `Dockerfile.voltron` (cached after first build)
3. Mounts the project directory and OAuth credentials into the container
4. Runs the agent with `--dangerously-skip-permissions` for fully autonomous execution
5. Returns the agent's output when it completes

**Prerequisites:** Docker must be installed and running. `Dockerfile.voltron` and `scripts/voltron-run.sh` are generated by `scaffold_project`. The launch script can also be used manually for standalone agent sessions.

**Parallel dispatch (v3.12.1):** When multiple agents can run in parallel, Voltron exposes `run_agent_in_docker_batch`, a single MCP tool that accepts an array of dispatches and runs them in concurrent containers. This is the recommended path for any dependency-free fan-out (e.g. processing multiple bd-ready tasks at once), and sidesteps the per-MCP-server tool-call serialization that the Claude Code main session applies.

**Bounded agent-result output (v3.13.1):** `run_agent_in_docker` and `run_agent_in_docker_batch` now return a size-bounded result, the returned output tail is capped at ~4000 characters (`MAX_TAIL_CHARS`) so results no longer overflow the tool-result limit. The full, untruncated transcript is still written to `.voltron/logs/` for inspection.

**Authentication (v3.4.1):** The Docker tools mount `~/.claude/.credentials.json:ro` into the container so Claude Max OAuth login is reused for agent sessions. They deliberately do **not** mount `~/.claude` or `~/.claude.json`, the latter contains host-pathed MCP server registrations that hang the Linux container at startup (60–90s+). Auth resolution order:

1. `~/.claude/.credentials.json` (mounted if present)
2. `CLAUDE_CODE_OAUTH_TOKEN` env var (passed through if set)
3. `ANTHROPIC_API_KEY` env var (passed through if set; reserved for CI)

On Windows, OAuth is stored in the Credential Manager by default and `~/.claude/.credentials.json` does not exist. Run `claude setup-token` once in a normal terminal to materialize a long-lived token at that path, then Voltron Docker agents will pick it up automatically.

**Auth model (v3.13.0):** Claude auth inside agent containers is resolved exclusively from the mounted `~/.claude/.credentials.json`, pre-flight no longer checks the `CLAUDE_CODE_OAUTH_TOKEN` env var. On Unix run `claude setup-token` once to materialize the file; on Windows update `~/.claude/.credentials.json` manually if it's missing or stale.

**Git push from inside containers (v3.13.0):** The `committer` and `pr-opener` agents can now push commits and open PRs from inside the Docker container. To enable this, set `GH_TOKEN` on your host **once** before launching Claude Code so Voltron passes it into agent containers (a fine-grained PAT with `repo` scope also works; Voltron falls back to `GITHUB_TOKEN` if set):

```bash
# Unix / WSL
export GH_TOKEN="$(gh auth token)"
```

```powershell
# Windows PowerShell
$env:GH_TOKEN = (gh auth token)
```

The container entrypoint runs `gh auth setup-git` so HTTPS pushes and PR creation work without further configuration.

**Zero-setup GitHub auth (v3.14.0):** Manual `GH_TOKEN` export is no longer required. After a one-time host `gh auth login`, Voltron derives a token from the host's `gh auth token` at dispatch and injects it into each agent container, so `committer` and `pr-opener` can push commits and open PRs with no manual `GH_TOKEN` and no relaunch. An explicit `GH_TOKEN`/`GITHUB_TOKEN` env override still takes precedence; set `VOLTRON_DISABLE_GH_AUTOTOKEN` to disable the auto-token entirely. See [`docs/voltron-gh-credentials-automount-plan.md`](docs/voltron-gh-credentials-automount-plan.md) for design details.

**Cost optimizations (v3.15.0):** Behavior-preserving improvements to `run_agent_in_docker` and `run_agent_in_docker_batch`, prompt-cache reuse of the static role-template prefix (system-prompt relocation for Haiku/Sonnet agents), de-duplicated CLAUDE.md and bd-prime context, staggered batch fan-out to reduce cold-start spikes, and raised per-agent `max_turns`. No change to agent behavior or outputs; take effect after an MCP-server restart. See [`docs/voltron-cost-optimization-plan.md`](docs/voltron-cost-optimization-plan.md) for details.

**Reflection-driven template improvements (v3.15.1):** Docker host-credential boundary documented in committer/pr-opener/deploy-trigger (commit-only in-container; the host handles push/publish/`bd` writes), budget-aware `[DONE]` exit across committer/test-writer/fullstack-dev/qa-tester, git identity is pre-configured (no `git config` writes), plus fullstack-dev (run tsc before claiming a clean typecheck, thread generics through return types, populate the beads graph on decomposition), qa-tester (~10-min wall-clock sizing), css-writer (JS style objects), config-editor (vitest `--config` for excluded suites), and test-writer (hermetic IO), derived from session reflections.

**Reflection-driven template improvements (v3.14.1):** fullstack-dev commit-budget rule, committer over-validation cap, and pr-opener GH_TOKEN pre-flight, derived from session reflections.

### Nested 3-tier dispatch (v3.8.0)

A containerized sub-manager or `harness-engineer` can now dispatch its own Tier-3 micro-agents via `run_agent_in_docker`, end to end, from inside a container. The scrum-master no longer has to flatten work plans to a single tier: Tier-2 sub-managers running in Docker drive the Tier-3 micro-agents that do the file edits, and the chain bottoms out cleanly because every Tier-3 template is tagged `nestable: false`.

**How it works:**
- `run_agent_in_docker` resolves host paths via `VOLTRON_HOST_ROOT` / `VOLTRON_HOST_HOME` / `VOLTRON_HOST_TMPDIR` so the inner `docker run` sees the real host filesystem (not the container's view of it).
- `/var/run/docker.sock` is mounted into the agent container so the nested Claude Code can talk to the host Docker daemon.
- A `container-mcp.json` is generated at launch and mounted into the inner container so the nested Claude Code has its own `project-voltron` MCP available.
- A depth-cap guard refuses any 4th-tier launch, micro-agents cannot dispatch further.

> **⚠️ Security disclosure, trusted dev machines only.** To make nested dispatch work, the Docker socket is mounted into every agent container. Inside a container, having `/var/run/docker.sock` is **equivalent to root on the host**: an agent can launch privileged containers, mount any host path, and read/write anything the Docker daemon can. **Only run Voltron on a trusted developer machine, and only with prompts you trust.** Do not point this at untrusted user input, public webhooks, or shared CI without a hardened sandbox in front.

### Unity Editor exception: auto-orchestration via Agent tool

`run_agent_in_docker` is the **primary dispatch path** (Docker, isolated, parallel-safe) for >95% of work across all project types. Unity projects have one narrow exception: four Editor-bound managers need a live Unity Editor with Coplay MCP, which Docker cannot provide. The scrum-master dispatches those managers from the host via the built-in `Agent` tool instead.

- **Editor-exception managers (Unity only):** `scene-architect` (scene hierarchy, prefabs, components), `build-validator` (Play Mode, console, compile state), and the Editor-preview slices of `shader-artist` (visual material/shader preview) and `asset-manager` (texture/audio/mesh import settings). All four run on the host via the `Agent` tool and use Coplay MCP to drive the live Editor.
- **File-only Unity work still goes through Docker:** C# script writing/refactoring (`csharp-dev`), shader code edits (`.shader`/`.hlsl`/`.shadergraph`), `Packages/manifest.json` updates, `asmdef` edits, and folder/asset structure changes are all dispatched via `run_agent_in_docker`. If a task can be expressed as file edits without live Editor feedback, it is Docker work.
- **Web/general projects: no exception.** Every agent in a web, fullstack, or general-purpose project goes through `run_agent_in_docker`. The Editor exception is Unity-only.

### Managers compose micro-agents, they never write files directly

Sub-managers like `csharp-dev`, `fullstack-dev`, `qa-tester`, `devops-engineer`, `scene-architect`, `shader-artist`, `build-validator`, and `asset-manager` are orchestrators. For every file change, they dispatch the matching Tier-3 micro-agent (e.g. `csharp-script-writer`, `route-adder`, `test-writer`, `config-editor`) via `run_agent_in_docker`. This is the STOP RULE in every sub-manager template, managers never DIY.

> **Future enhancement:** Separate per-agent containers for blast-radius isolation between specialist agents.

## Dynamic Model Selection

Voltron assigns each agent a default model tier based on its role. Sub-managers and coordinators can override this per-invocation when a micro-agent fails or produces low-quality output.

| Tier | Model | Agents | Role |
|---|---|---|---|
| Opus | `claude-opus-4-*` | 5 | Coordinators & planners (scrum-master, project-planner, code-analyst, doc-writer, harness-engineer) |
| Sonnet | `claude-sonnet-4-*` | 16 | Sub-managers & domain specialists (fullstack-dev, devops-engineer, csharp-dev, qa-tester, etc.) |
| Haiku | `claude-haiku-4-*` | 53 | Micro-agents, Inspect, Write, Validate, Publish layer workers |

**Override:** Pass `model: "sonnet"` or `model: "opus"` to `run_agent_in_docker` / `run_agent_in_docker_batch` to retry a micro-agent at a higher tier. Sub-managers are instructed to do this automatically when output is unsatisfactory. The `list_templates` tool shows each agent's default model tier.

## Progress Tracking

The scrum-master tracks agent task progress using built-in MCP tools. When a work plan is created, the scrum-master immediately registers all tasks as "queued" and then updates their status as agents are dispatched and finish.

- `update_progress`, logs task status changes (queued, in_progress, completed, failed, blocked)
- `get_progress`, returns a formatted progress summary or detailed task table in the chat window

Progress data is persisted in `.voltron/progress.json`.

## Eval Harness (`voltron-evals/`)

Voltron grades itself. The `voltron-evals/` directory contains a small Node harness that runs benchmark tasks against any dispatchable agent, captures the run artifacts, and dispatches a new internal `voltron-judge` agent to score the run against a pinned, versioned rubric.

**Two-layer design:**

- **Deep**: hand-authored T1/T2/T3 tasks that exercise a specific agent end-to-end against a fixture. Each task has a paired rubric and a `voltron-judge` scorecard with quoted file:line evidence.
- **Broad**: agent-template-driven coverage. Each agent declares a "shape" (input contract + dispatch expectation + acceptance signal); the runner enumerates one instance per shape × agent and judges with a mix of programmatic signals and a Haiku judge. Currently 70 generated Broad instances.

**Run it locally:**

```bash
node voltron-evals/runner.js --tier=pr           # PR-tier: all Tier-1 Deep + 10-instance Broad sample (fast)
node voltron-evals/runner.js --tier=all          # full Deep + Broad sweep
node voltron-evals/runner.js --tier=deep         # Deep only
node voltron-evals/runner.js --tier=broad        # Broad only
node voltron-evals/runner.js --task=T1-001       # one specific task
node voltron-evals/runner.js --doctor            # validate schemas, rubrics, shapes, instance enumeration (no LLM)
```

**Full design spec:** [`voltron-evals/DESIGN.md`](voltron-evals/DESIGN.md), covers the two-layer architecture, shape contract, judge routing (Opus for Deep, Haiku for Broad), content-hash caching keyed on `src/templates.js`, and the rubric-pinning protocol.

**CI cadence:** `.github/workflows/voltron-evals.yml` runs the full sweep on the **1st of each month at 12:00 UTC**, plus on manual `workflow_dispatch`. The content-hash cache means only agents whose templates changed since the last sweep pay the LLM cost; scorecards are uploaded as a CI artifact.

**Layout:**

```
voltron-evals/
  DESIGN.md                       - full design spec (architecture, shapes, caching, judge routing)
  README.md                       - quick-start
  schemas/task.schema.json        - JSON Schema for task YAMLs
  shapes/                         - Broad-layer shape definitions (input / dispatch / acceptance)
  tasks/                          - hand-authored Deep task definitions
  instances/                      - generated Broad instances (one per agent × shape)
  rubrics/                        - pinned, versioned rubrics (rubric_version frontmatter)
  lib/artifacts.js                - capture helpers (git diff, bd list, log tail)
  lib/programmatic-scorers.js     - deterministic no-LLM signals (turns, [DONE], dispatch grep, …)
  lib/template-hash.js            - content-hash key for scorecard caching
  lib/fixtures/                   - per-task fixtures the AUT operates on
  runner.js                       - orchestrator (loads YAML, dispatches AUT + judge, merges scorecard)
  results/<task>/<ts>/            - per-run artifact bundles + scorecard.json
```

**How a run works:**

1. Runner loads the task YAML and validates against `schemas/task.schema.json`.
2. Runner snapshots pre-state (`git rev-parse HEAD`, `bd list --json`, `reflections/` listing).
3. Runner dispatches the AUT via `run_agent_in_docker` with the task prompt and `max_turns` budget.
4. Runner snapshots post-state, tails the AUT's log, captures any new reflection.
5. Programmatic scorers run first, turn count, `[DONE]` presence, budget utilization, files changed, sub-dispatch grep, beads diff. These are injected into the judge prompt as raw measurements the judge cannot disagree with.
6. Runner dispatches `voltron-judge` (model: Sonnet by default) with the rubric and artifact paths. The judge emits a fenced ```json``` scorecard block with per-criterion verdicts (`MET` / `UNMET` / `PARTIAL` / `CANNOT_ASSESS`) and quoted file:line evidence.
7. Runner parses the fenced JSON, merges with programmatic signals, and writes `voltron-evals/results/<task>/<ts>/scorecard.json`.
8. Scorecard is mirrored into `reflections/<ts>-eval-<task>.json` wrapped in the standard reflection envelope, so the existing `harness-engineer` self-improvement loop picks up failing criteria as actionable template-edit suggestions.

**Rubric pinning:** each task YAML names a rubric path and a `rubric_version_expected` (semver). The runner refuses to grade if the rubric's `rubric_version` frontmatter does not match, this prevents silent drift between catalog edits and the rubric weights used to score.

**Anti-loop guard:** reflections produced by this harness (`project_name: voltron-eval-harness`) must NOT be used by `harness-engineer` to modify the `voltron-judge` template. That would let the judge tune itself out of detecting failures. Human change-control only on `voltron-judge`.

**Adding a task:** drop a YAML in `tasks/`, write a rubric Markdown with `rubric_version: 1.0.0` frontmatter, optionally add fixtures under `lib/fixtures/<task-id>/`, and run `node voltron-evals/runner.js --task=<id>`.

## License

MIT
