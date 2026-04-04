# Project Voltron

An MCP server that provides a team of specialized Unity subagent templates for Claude Code. Scaffold any Unity project with battle-tested agent definitions for scene architecture, C# development, shader work, build validation, and asset management.

## Agents

| Agent | Purpose |
|---|---|
| **scene-architect** | GameObject hierarchy, prefabs, scene composition |
| **csharp-dev** | C# scripts, MonoBehaviours, ScriptableObjects, gameplay systems |
| **shader-artist** | Shaders, materials, VFX Graph, render pipeline features |
| **build-validator** | Console monitoring, compile checks, Play Mode smoke tests |
| **asset-manager** | Folder structure, import settings, naming conventions |

Plus a comprehensive **CLAUDE.md** template that gives Claude Code full project context.

## Installation

### Claude Code (global for all Unity projects)

Add to your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "project-voltron": {
      "command": "node",
      "args": ["C:/path/to/project-voltron/src/index.js"]
    }
  }
}
```

### From source

```bash
git clone https://github.com/7ports/project-voltron.git
cd project-voltron
npm install
```

## MCP Tools

| Tool | Description |
|---|---|
| `list_templates` | List all available templates with descriptions |
| `get_template` | Get the full content of a specific template |
| `scaffold_unity_project` | Get all files needed to scaffold a Unity project |
| `get_agent_usage_guide` | Usage guide for invoking and coordinating agents |

## Usage

Once installed, ask Claude Code:

- *"List the Voltron templates"* — see what's available
- *"Scaffold this Unity project with Voltron agents"* — writes CLAUDE.md + all agent files
- *"How do I use the Voltron agents?"* — get the usage guide
- *"Get the csharp-dev template"* — retrieve a specific template

## Workflow

1. **Scaffold** — run `scaffold_unity_project` in your Unity project root
2. **Configure** — fill in CLAUDE.md with your project specifics
3. **Develop** — invoke agents as needed:
   - `@agent-csharp-dev` for scripts
   - `@agent-scene-architect` for scene/prefab work
   - `@agent-shader-artist` for visuals
   - `@agent-build-validator` before committing
   - `@agent-asset-manager` for organization

## License

MIT
