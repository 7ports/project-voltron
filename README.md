# Project Voltron

An MCP server that provides teams of specialized agent templates for Claude Code. Scaffold any project with battle-tested subagent definitions for Unity game dev, web/fullstack development, and general software projects — plus a scrum-master coordinator and a self-improvement loop.

## Agent Teams

### Core (all projects)

| Agent | Purpose |
|---|---|
| **scrum-master** | Reads backlogs, breaks work into agent-sized tasks, assigns to specialists. Never implements. |

### Unity

| Agent | Purpose |
|---|---|
| **scene-architect** | GameObject hierarchy, prefabs, scene composition, transforms, and components |
| **csharp-dev** | MonoBehaviours, ScriptableObjects, gameplay systems, editor tools |
| **shader-artist** | Shaders, materials, VFX Graph, render pipeline features (URP/HDRP/Built-in) |
| **build-validator** | Console monitoring, compile checks, Play Mode smoke tests |
| **asset-manager** | Folder structure, import settings, naming conventions |

### Web / Fullstack

| Agent | Purpose |
|---|---|
| **fullstack-dev** | React/TypeScript frontend + Node.js/Express backend |
| **devops-engineer** | Terraform, CI/CD, Docker, Fly.io, AWS |
| **ui-designer** | CSS, responsive layout, theming, PWA, accessibility |
| **qa-tester** | Testing (Vitest/Playwright), Lighthouse audits, bundle analysis |

## Installation

### From source

```bash
git clone https://github.com/7ports/project-voltron.git
cd project-voltron
npm install
```

### Register as a global MCP server

```bash
claude mcp add --scope user \
  project-voltron -- \
  node /path/to/project-voltron/src/index.js
```

Or add manually to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "project-voltron": {
      "command": "node",
      "args": ["/path/to/project-voltron/src/index.js"]
    }
  }
}
```

## Alexandria Integration

Voltron agents are designed to work with **Project Alexandria** — a companion MCP server that maintains a shared library of tooling setup guides. When both are installed, agents can look up setup procedures before attempting tool installations and write back discoveries afterward.

**What this enables:**
- `devops-engineer` and `fullstack-dev` consult Alexandria before setting up Docker, CI/CD, cloud services, or libraries
- `scrum-master` calls `get_project_setup_recommendations` when planning a new project
- After completing a setup, agents call `update_guide` to record findings (platform quirks, version notes, working commands)
- Tool knowledge from sessions flows back into Alexandria — not just into Voltron's reflection pipeline

**Setup:** Install both MCP servers globally in `~/.claude.json`. No additional configuration is needed — agent templates already include the relevant `mcp__alexandria__*` tools.

See [Project Alexandria](https://github.com/7ports/project-alexandria) for setup instructions.

## MCP Tools

| Tool | Description |
|---|---|
| `list_templates` | List all templates, optionally filtered by project type |
| `get_template` | Get the full content of a specific template |
| `scaffold_project` | Scaffold agents + auto-update hook for a given project type |
| `get_auto_update_hook` | Get the `.claude/settings.json` hook for existing projects |
| `get_agent_usage_guide` | Usage guide for invoking and coordinating agents |
| `check_for_updates` | Check if installed agent files are outdated vs. current templates |
| `update_agent` | Get the latest content for a specific agent |
| `submit_reflection` | Submit a post-session reflection on agent performance |
| `list_reflections` | List stored reflections (for reviewing pending improvements) |

## Usage

Once installed, ask Claude Code:

- *"Scaffold this Unity project with Voltron agents"* → `scaffold_project` with `project_type: "unity"`
- *"Scaffold this web project with Voltron agents"* → `scaffold_project` with `project_type: "web"`
- *"How do I use the Voltron agents?"* → `get_agent_usage_guide`
- *"Check if my agents are up to date"* → `check_for_updates`
- *"Add the auto-update hook to this project"* → `get_auto_update_hook`

## Workflow

1. **Scaffold** — run `scaffold_project` in your project root with your project type
2. **Configure** — fill in `CLAUDE.md` with your project specifics
3. **Plan** — invoke `@agent-scrum-master` with your backlog to get a structured work plan
4. **Develop** — invoke specialist agents per the plan; they consult Alexandria for tool setup
5. **Reflect** — at session end, submit a reflection to feed improvements back; scrum-master also syncs tool findings to Alexandria

## Agent Auto-Update

`scaffold_project` now outputs a `.claude/settings.json` containing a `UserPromptSubmit` hook. This hook runs `scripts/auto-update-agents.js` at the start of every Claude Code session in the project. If the installed agent version differs from your local Voltron installation, all installed agent files are silently updated in place. A `[VOLTRON] Auto-updated N agent(s)` message appears in context when an update occurs.

For projects scaffolded before this feature was added, run `get_auto_update_hook` to get the settings entry to add manually.

## Self-Improvement

Agents submit post-session reflections via `submit_reflection`. Reflections accumulate in the `reflections/` directory and are automatically processed by a GitHub Actions workflow that runs **Mon/Wed/Fri at 10:00 UTC**:

1. A Claude Code agent reads all unprocessed reflections
2. Applies targeted improvements to `src/templates.js`
3. Bumps the patch version and commits
4. Opens a PR for human review before changes reach `main`

Once merged, projects with the auto-update hook installed will automatically receive the new templates at the start of their next session. Projects without the hook can pull improvements manually via `check_for_updates`. The workflow can also be triggered manually from the Actions tab. Requires `ANTHROPIC_API_KEY` set as a repository secret.

## License

MIT
