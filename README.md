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

## MCP Tools

| Tool | Description |
|---|---|
| `list_templates` | List all templates, optionally filtered by project type |
| `get_template` | Get the full content of a specific template |
| `scaffold_project` | Scaffold the right agent set for a given project type |
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

## Workflow

1. **Scaffold** — run `scaffold_project` in your project root with your project type
2. **Configure** — fill in `CLAUDE.md` with your project specifics
3. **Plan** — invoke `@agent-scrum-master` with your backlog to get a structured work plan
4. **Develop** — invoke specialist agents per the plan
5. **Reflect** — at session end, submit a reflection via `submit_reflection` to feed improvements back

## Self-Improvement

Agents submit post-session reflections via `submit_reflection`. Reflections accumulate in the `reflections/` directory and are periodically reviewed and applied to improve the agent templates. This is how Voltron gets better over time.

## License

MIT
