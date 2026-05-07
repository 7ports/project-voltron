# Project Voltron

An MCP server that provides teams of specialized agent templates for Claude Code. Scaffold any project with battle-tested subagent definitions for Unity game dev, web/fullstack development, and general software projects — plus a scrum-master coordinator, 51 micro-agents, and a self-improvement loop.

## Agent Teams

### Core (all projects)

| Agent | Purpose |
|---|---|
| **scrum-master** | Reads backlogs, breaks work into agent-sized tasks, assigns to specialists. Never implements. |
| **project-planner** | Researches tech stacks, designs architecture, defines data models and API contracts, produces comprehensive project plans for scrum-master to decompose. |
| **researcher** | Deep research specialist. Finds any information — technical docs, APIs, pricing, competitors, legal text, community consensus — using web search, live page navigation, and structured extraction. |

### Unity

`run_agent_in_docker` is the **primary dispatch path** for Unity work — C# scripts, shader/material file edits, manifest changes, and folder/asset structure all run in Docker. A narrow exception covers four Editor-bound managers that need a live Unity Editor with Coplay MCP; the scrum-master dispatches those via the built-in `Agent` tool from the host.

| Agent | Purpose | Dispatch |
|---|---|---|
| **scene-architect** | GameObject hierarchy, prefabs, scene composition, transforms, and components | `Agent` tool (Editor exception) |
| **csharp-dev** | MonoBehaviours, ScriptableObjects, gameplay systems, editor tools — composes `csharp-script-writer` / `csharp-member-adder` micro-agents, never DIY | `run_agent_in_docker` (file edit) |
| **shader-artist** | Shaders, materials, VFX Graph, render pipeline features (URP/HDRP/Built-in) — composes file-writing micro-agents for code, uses Coplay for Editor preview | `run_agent_in_docker` (file) / `Agent` tool (Editor preview) |
| **build-validator** | Console monitoring, compile checks, Play Mode smoke tests | `Agent` tool (Editor exception) |
| **asset-manager** | Folder structure, import settings, naming conventions — composes `unity-manifest-editor` and other micro-agents for files, uses Coplay for import settings | `run_agent_in_docker` (folders) / `Agent` tool (import settings) |

### Web / Fullstack

| Agent | Purpose |
|---|---|
| **fullstack-dev** | React/TypeScript frontend + Node.js/Express backend |
| **devops-engineer** | Terraform, CI/CD, Docker, Fly.io, AWS |
| **ui-designer** | CSS, responsive layout, theming, PWA, accessibility |
| **qa-tester** | Testing (Vitest/Playwright), Lighthouse audits, bundle analysis |

### Micro-Agents (Haiku tier — 51 focused workers)

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
| **reflection-processor** | Processes session reflections in CI, applies targeted improvements to agent templates. Runs on Sonnet 4.6. |

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

The scrum-master uses [beads](https://github.com/gastownhall/beads) for dependency-aware task orchestration. **This is mandatory** as of v3.4.0 — agents will refuse to dispatch work plans without a working `bd` CLI:

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

Voltron agents are designed to work with **Project Alexandria** — a companion MCP server that maintains a shared library of tooling setup guides. When both are installed, agents consult Alexandria **before** any tool installation — this is mandatory, not optional.

**What this enables:**
- All specialist agents call `quick_setup` before installing any tool, library, or service — and `search_guides` if no exact guide exists
- `scrum-master` calls `get_project_setup_recommendations` when planning a new project and requires specialist agents to check Alexandria in every tool-setup task
- After completing a setup, agents call `update_guide` to record findings (platform quirks, version notes, working commands)
- Tool knowledge from sessions flows back into Alexandria — not just into Voltron's reflection pipeline

**Content boundary:** Alexandria is for non-project-specific, reusable documentation only — tool setup guides, platform quirks, version notes, API patterns. Project-specific knowledge (business logic, custom architecture, team conventions) belongs in `CLAUDE.md` and local project docs, not Alexandria.

**Setup:** Install both MCP servers globally in `~/.claude.json`. No additional configuration is needed — agent templates already include the relevant `mcp__alexandria__*` tools.

See [Project Alexandria](https://github.com/7ports/project-alexandria) for setup instructions.

## MCP Tools

| Tool | Description |
|---|---|
| `list_templates` | List all templates, optionally filtered by project type |
| `get_template` | Get the full content of a specific template |
| `scaffold_project` | Writes agent templates and Dockerfile directly to disk for unity, web, fullstack, mobile, or general projects. Smart merge: skips existing agent files, appends to existing CLAUDE.md, preserves custom Dockerfiles. Auto-detects project root via filesystem walk when project_root not specified (looks for .git, CLAUDE.md, .mcp.json, etc.); restart Claude Code required after scaffolding. |
| `setup_voltron` | Verify and repair Voltron installation from within Claude Code — updates the global allowlist and reports MCP/Docker status |
| `get_auto_update_hook` | Get the `.claude/settings.json` hook for existing projects |
| `get_agent_usage_guide` | Usage guide for invoking and coordinating agents |
| `check_for_updates` | Check if installed agent files are outdated vs. current templates |
| `update_agent` | Get the latest content for a specific agent |
| `submit_reflection` | Submit a post-session reflection on agent performance |
| `list_reflections` | List stored reflections (for reviewing pending improvements) |
| `run_agent_in_docker` | Launch a specialist agent in a Docker container with full permissions (called by scrum-master) |
| `start_agent_in_docker` | Non-blocking agent launch; returns container_name and log_path immediately for polling |
| `get_agent_output` | Poll a running agent container for live log output; shows last N lines in chat |
| `update_progress` | Update agent task progress (called by scrum-master before/after each agent invocation) |
| `get_progress` | View current agent task progress as a formatted dashboard |
| `generate_dashboard` | Generate a standalone HTML dashboard from progress data |

## Usage

Once installed, ask Claude Code:

- *"Scaffold this Unity project with Voltron agents"* → `scaffold_project` with `project_type: "unity"`
- *"Scaffold this web project with Voltron agents"* → `scaffold_project` with `project_type: "web"`
- *"How do I use the Voltron agents?"* → `get_agent_usage_guide`
- *"Check if my agents are up to date"* → `check_for_updates`
- *"Add the auto-update hook to this project"* → `get_auto_update_hook`

## Workflow

1. **Scaffold** — run `scaffold_project` in your project root with your project type
2. **Configure** — fill in `CLAUDE.md` with your project specifics and set up Docker execution (see scaffold output)
3. **Research** — for new projects, invoke `@agent-project-planner` to research tech stack and design architecture
4. **Plan** — invoke `@agent-scrum-master` with the project plan to get a structured work breakdown
5. **Develop** — invoke specialist agents per the plan; they consult Alexandria for tool setup
6. **Reflect** — scrum-master automatically submits reflections at phase completion, blockers, and session end; also syncs tool findings to Alexandria

## Agent Auto-Update

`scaffold_project` outputs a `.claude/settings.json` containing a `UserPromptSubmit` hook. This hook runs `scripts/auto-update-agents.js` at the start of every Claude Code session. If the installed version differs from your local Voltron installation, all outdated files are silently updated in place.

**What gets auto-updated:**
- All agent `.md` files in `.claude/agents/`
- `Dockerfile.voltron` (if it exists — only projects using Docker)
- `scripts/voltron-run.sh` (if it exists)

**What is NOT auto-updated** (user-customized files):
- `CLAUDE.md` — contains project-specific context you've filled in
- `.claude/settings.json` — hook config that you may have customized

A `[VOLTRON] Auto-updated N file(s)` message appears in context when an update occurs. For projects scaffolded before this feature was added, run `get_auto_update_hook` to get the settings entry to add manually.

## Self-Improvement

Agents submit post-session reflections via `submit_reflection`. The scrum-master now submits reflections automatically at phase completion, after significant blockers, and at session end. Reflections accumulate in the `reflections/` directory and are automatically processed by a GitHub Actions workflow that runs **Mon/Wed/Fri at 10:00 UTC**:

1. The `reflection-processor` agent (running on Sonnet 4.6) reads all unprocessed reflections
2. Groups feedback by agent and prioritizes by frequency
3. Applies targeted improvements to `src/templates.js`
4. Bumps the patch version and commits
5. Opens a PR for human review before changes reach `main`

Once merged, projects with the auto-update hook installed will automatically receive the new templates at the start of their next session. Projects without the hook can pull improvements manually via `check_for_updates`. The workflow can also be triggered manually from the Actions tab. Requires `ANTHROPIC_API_KEY` set as a repository secret.

## Docker Execution

The scrum-master launches each specialist agent inside a Docker container automatically via the `run_agent_in_docker` MCP tool. You run Claude Code normally on your desktop — Docker is handled behind the scenes.

When the scrum-master invokes an agent, `run_agent_in_docker`:
1. Loads the agent's template and CLAUDE.md for project context
2. Builds the Docker image from `Dockerfile.voltron` (cached after first build)
3. Mounts the project directory and OAuth credentials into the container
4. Runs the agent with `--dangerously-skip-permissions` for fully autonomous execution
5. Returns the agent's output when it completes

**Prerequisites:** Docker must be installed and running. `Dockerfile.voltron` and `scripts/voltron-run.sh` are generated by `scaffold_project`. The launch script can also be used manually for standalone agent sessions.

**Authentication (v3.4.1):** The Docker tools mount `~/.claude/.credentials.json:ro` into the container so Claude Max OAuth login is reused for agent sessions. They deliberately do **not** mount `~/.claude` or `~/.claude.json` — the latter contains host-pathed MCP server registrations that hang the Linux container at startup (60–90s+). Auth resolution order:

1. `~/.claude/.credentials.json` (mounted if present)
2. `CLAUDE_CODE_OAUTH_TOKEN` env var (passed through if set)
3. `ANTHROPIC_API_KEY` env var (passed through if set; reserved for CI)

On Windows, OAuth is stored in the Credential Manager by default and `~/.claude/.credentials.json` does not exist. Run `claude setup-token` once in a normal terminal to materialize a long-lived token at that path, then Voltron Docker agents will pick it up automatically.

### Unity Editor exception: auto-orchestration via Agent tool

`run_agent_in_docker` is the **primary dispatch path** — Docker, isolated, parallel-safe — for >95% of work across all project types. Unity projects have one narrow exception: four Editor-bound managers need a live Unity Editor with Coplay MCP, which Docker cannot provide. The scrum-master dispatches those managers from the host via the built-in `Agent` tool instead.

- **Editor-exception managers (Unity only):** `scene-architect` (scene hierarchy, prefabs, components), `build-validator` (Play Mode, console, compile state), and the Editor-preview slices of `shader-artist` (visual material/shader preview) and `asset-manager` (texture/audio/mesh import settings). All four run on the host via the `Agent` tool and use Coplay MCP to drive the live Editor.
- **File-only Unity work still goes through Docker:** C# script writing/refactoring (`csharp-dev`), shader code edits (`.shader`/`.hlsl`/`.shadergraph`), `Packages/manifest.json` updates, `asmdef` edits, and folder/asset structure changes are all dispatched via `run_agent_in_docker`. If a task can be expressed as file edits without live Editor feedback, it is Docker work.
- **Web/general projects: no exception.** Every agent in a web, fullstack, or general-purpose project goes through `run_agent_in_docker`. The Editor exception is Unity-only.

### Managers compose micro-agents — they never write files directly

Sub-managers like `csharp-dev`, `fullstack-dev`, `qa-tester`, `devops-engineer`, `scene-architect`, `shader-artist`, `build-validator`, and `asset-manager` are orchestrators. For every file change, they dispatch the matching Tier-3 micro-agent (e.g. `csharp-script-writer`, `route-adder`, `test-writer`, `config-editor`) via `run_agent_in_docker`. This is the STOP RULE in every sub-manager template — managers never DIY.

> **Future enhancement:** Separate per-agent containers for blast-radius isolation between specialist agents.

## Dynamic Model Selection

Voltron assigns each agent a default model tier based on its role. Sub-managers and coordinators can override this per-invocation when a micro-agent fails or produces low-quality output.

| Tier | Model | Agents | Role |
|---|---|---|---|
| Opus | `claude-opus-4-*` | 5 | Coordinators & planners (scrum-master, project-planner, code-analyst, doc-writer, reflection-processor) |
| Sonnet | `claude-sonnet-4-*` | 16 | Sub-managers & domain specialists (fullstack-dev, devops-engineer, csharp-dev, qa-tester, etc.) |
| Haiku | `claude-haiku-4-*` | 53 | Micro-agents — Inspect, Write, Validate, Publish layer workers |

**Override:** Pass `model: "sonnet"` or `model: "opus"` to `run_agent_in_docker` / `start_agent_in_docker` to retry a micro-agent at a higher tier. Sub-managers are instructed to do this automatically when output is unsatisfactory. The `list_templates` tool shows each agent's default model tier.

## Progress Visualization

The scrum-master tracks agent task progress using built-in MCP tools. When a work plan is created, the scrum-master immediately registers all tasks as "queued" — this triggers the **live dashboard** to auto-open in the user's browser.

- `update_progress` — logs task status changes (queued, in_progress, completed, failed, blocked); auto-regenerates the dashboard HTML on every call
- `get_progress` — returns a formatted dashboard in the chat window
- `generate_dashboard` — produces a standalone HTML file at `.voltron/dashboard.html` (auto-refreshes every 5 seconds)

Progress data is persisted in `.voltron/progress.json`.

## License

MIT
