#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TEMPLATES, AGENT_NAMES, ALL_NAMES } from "./templates.js";

const server = new McpServer({
  name: "project-voltron",
  version: "1.0.0",
  description:
    "Unity subagent templates for Claude Code. Provides a team of specialized agents (scene-architect, csharp-dev, shader-artist, build-validator, asset-manager) and a CLAUDE.md project template for Unity development.",
});

// --- Tool: list_templates ---------------------------------------------------

server.tool(
  "list_templates",
  "List all available Unity subagent templates and the CLAUDE.md project config. Returns name, description, category, and destination path for each template.",
  {},
  async () => {
    const listing = ALL_NAMES.map((key) => {
      const t = TEMPLATES[key];
      return {
        key,
        name: t.name,
        description: t.description,
        category: t.category,
        filename: t.filename,
        destination: t.destination,
      };
    });

    const text = listing
      .map(
        (t) =>
          `**${t.name}** (${t.category})\n  ${t.description}\n  Destination: \`${t.destination}\``
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text:
            `# Project Voltron — Unity Agent Templates\n\n` +
            `${listing.length} templates available. Use \`get_template\` to retrieve any template, or \`scaffold_unity_project\` to write all of them at once.\n\n` +
            text,
        },
      ],
    };
  }
);

// --- Tool: get_template -----------------------------------------------------

server.tool(
  "get_template",
  "Get the full content of a specific Unity subagent template or the CLAUDE.md config. Valid names: claude-md, scene-architect, csharp-dev, shader-artist, build-validator, asset-manager.",
  {
    name: z
      .enum([
        "claude-md",
        "scene-architect",
        "csharp-dev",
        "shader-artist",
        "build-validator",
        "asset-manager",
      ])
      .describe("Template name to retrieve"),
  },
  async ({ name }) => {
    const t = TEMPLATES[name];
    if (!t) {
      return {
        content: [
          {
            type: "text",
            text: `Template "${name}" not found. Valid names: ${ALL_NAMES.join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text:
            `# ${t.name}\n\n` +
            `**Category:** ${t.category}\n` +
            `**Destination:** \`${t.destination}\`\n` +
            `**Description:** ${t.description}\n\n` +
            `---\n\n` +
            `${t.content}`,
        },
      ],
    };
  }
);

// --- Tool: get_scaffold_instructions ----------------------------------------

server.tool(
  "scaffold_unity_project",
  "Returns the full set of files and their contents needed to scaffold a Unity project with all Project Voltron agent templates. Creates CLAUDE.md at the project root and all agent definitions in .claude/agents/. Use this when setting up a new Unity project for Claude Code.",
  {},
  async () => {
    const files = ALL_NAMES.map((key) => {
      const t = TEMPLATES[key];
      return {
        path: t.destination,
        content: t.content,
      };
    });

    const instructions =
      `# Scaffold Instructions\n\n` +
      `Write the following ${files.length} files to the Unity project root:\n\n` +
      files
        .map(
          (f, i) =>
            `## File ${i + 1}: \`${f.path}\`\n\n\`\`\`markdown\n${f.content}\n\`\`\``
        )
        .join("\n\n---\n\n");

    return {
      content: [
        {
          type: "text",
          text: instructions,
        },
      ],
    };
  }
);

// --- Tool: get_agent_usage_guide --------------------------------------------

server.tool(
  "get_agent_usage_guide",
  "Returns a usage guide explaining how to invoke and coordinate the Unity subagent team. Covers when to use each agent, invocation syntax, and the recommended workflow order.",
  {},
  async () => {
    const guide = `# Project Voltron — Agent Usage Guide

## The Agent Team

Project Voltron provides 5 specialized subagents for Unity development:

| Agent | Invoke With | Use When |
|---|---|---|
| **scene-architect** | \`@agent-scene-architect\` | Creating/modifying GameObjects, prefabs, scene hierarchy, transforms, components |
| **csharp-dev** | \`@agent-csharp-dev\` | Writing/editing C# scripts, MonoBehaviours, ScriptableObjects, gameplay systems |
| **shader-artist** | \`@agent-shader-artist\` | Creating shaders, materials, VFX, post-processing, render features |
| **build-validator** | \`@agent-build-validator\` | Checking compile errors, console output, Play Mode smoke tests, pre-commit validation |
| **asset-manager** | \`@agent-asset-manager\` | Organizing folders, setting import settings, naming conventions, asset audits |

## Recommended Workflow

1. **Start with CLAUDE.md** — Fill in your project details so agents have context
2. **For new features:**
   - \`csharp-dev\` writes the scripts
   - \`scene-architect\` sets up the scene/prefab structure
   - \`shader-artist\` handles any visual work
   - \`build-validator\` checks everything compiles and runs
3. **For asset imports:**
   - \`asset-manager\` organizes and configures import settings
   - \`build-validator\` verifies nothing broke
4. **Before committing:**
   - Always run \`build-validator\` for a validation pass

## Key Rules

- Agents respect boundaries — \`csharp-dev\` won't touch scene hierarchy, \`scene-architect\` won't write scripts
- \`build-validator\` is read-only — it reports problems but doesn't fix them
- All agents read CLAUDE.md for project context — keep it updated
- Agents coordinate via the task list — chain them for multi-step work

## CLAUDE.md Setup

The CLAUDE.md template is the foundation. Fill in these critical fields before using agents:
- **Project Name** and **Unity Version**
- **Render Pipeline** (agents need this for shader/material compatibility)
- **Namespace root** (csharp-dev uses this for all scripts)
- **Key Packages** (so agents know what's available)
`;

    return {
      content: [
        {
          type: "text",
          text: guide,
        },
      ],
    };
  }
);

// --- Start server -----------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
