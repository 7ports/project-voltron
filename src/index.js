#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import {
  TEMPLATES,
  AGENT_NAMES,
  ALL_NAMES,
  TEMPLATE_ALIASES,
  getTemplatesForType,
  VALID_PROJECT_TYPES,
  CLAUDE_MD_FOR_TYPE,
} from "./templates.js";

// ─── Version ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8")
);
const VERSION = pkg.version;

const server = new McpServer({
  name: "project-voltron",
  version: VERSION,
  description:
    "Agent templates for Claude Code. Provides teams of specialized subagents for Unity game development, web development, and general software projects, plus CLAUDE.md project templates and a scrum-master coordinator.",
});

// ─── Workflow text constants ────────────────────────────────────────────────

const UNITY_WORKFLOW = `## Recommended Workflow

1. **Start with CLAUDE.md** — Fill in your project details so agents have context
2. **For new projects, run \`project-planner\` first** — It researches tech stack and architecture, producing a plan document in \`docs/project-plan.md\` for scrum-master to decompose
3. **Use \`scrum-master\` to plan work** — Give it your backlog or feature list and let it break work into agent-sized tasks
4. **For new features:**
   - \`csharp-dev\` writes the scripts
   - \`scene-architect\` sets up the scene/prefab structure
   - \`shader-artist\` handles any visual work
   - \`build-validator\` checks everything compiles and runs
5. **For asset imports:**
   - \`asset-manager\` organizes and configures import settings
   - \`build-validator\` verifies nothing broke
6. **Before committing:**
   - Always run \`build-validator\` for a validation pass
`;

const WEB_WORKFLOW = `## Recommended Workflow

1. **Start with CLAUDE.md** — Fill in your project details so agents have context
2. **For new projects, run \`project-planner\` first** — It researches tech stack and architecture, producing a plan document in \`docs/project-plan.md\` for scrum-master to decompose
3. **Use \`scrum-master\` to plan work** — Give it your project plan or feature list and let it break work into agent-sized tasks
4. **For new features:**
   - \`fullstack-dev\` implements the frontend + backend code
   - \`ui-designer\` handles CSS, responsive layout, and visual polish
   - \`devops-engineer\` configures deployment and infrastructure
   - \`qa-tester\` validates quality and runs audits
5. **For deployments:**
   - \`devops-engineer\` writes IaC and CI/CD pipelines
   - \`qa-tester\` runs Lighthouse and bundle audits
6. **Before merging:**
   - Always run \`qa-tester\` for a quality pass
`;

const GENERAL_WORKFLOW = `## Recommended Workflow

1. **Start with CLAUDE.md** — Fill in your project details so agents have context
2. **For new projects, run \`project-planner\` first** — It researches tech stack and architecture, producing a plan document in \`docs/project-plan.md\` for scrum-master to decompose
3. **Use \`scrum-master\` to plan work** — Give it your backlog or requirements and let it decompose into agent-sized tasks
4. **Invoke specialist agents** for each task in the plan
5. **Use \`scrum-master\` again** to review progress and plan next steps
`;

const KEY_RULES = `## Key Rules

- Agents respect boundaries — each agent has a clear responsibility and defers to others outside that scope
- \`scrum-master\` never implements — it only plans and delegates
- All agents read CLAUDE.md for project context — keep it updated
- Agents coordinate via the task list — chain them for multi-step work
- Use \`check_for_updates\` periodically to ensure your agent templates are current
- \`project-planner\` creates architectural blueprints — use it for new projects before \`scrum-master\` decomposes the plan into tasks

## CLAUDE.md Setup

The CLAUDE.md template is the foundation. Fill in these critical fields before using agents:
- **Project Name** and **Tech Stack**
- **Repository Layout** (so agents know where to find and place files)
- **Code Conventions** (so agents write consistent code)
- **Agent Team Roles** (so agents know who else is available)
`;

// ─── Tool: list_templates ───────────────────────────────────────────────────

server.tool(
  "list_templates",
  "List all available agent templates and project configs. Returns name, description, category, tags, and destination path for each template. Optionally filter by project type.",
  {
    project_type: z
      .enum(VALID_PROJECT_TYPES)
      .optional()
      .describe(
        'Filter templates by project type: "unity", "web", "fullstack", or "general". Omit to list all.'
      ),
  },
  async ({ project_type }) => {
    let keys;
    if (project_type) {
      keys = getTemplatesForType(project_type);
    } else {
      keys = ALL_NAMES;
    }

    const listing = keys.map((key) => {
      const t = TEMPLATES[key];
      return {
        key,
        name: t.name,
        description: t.description,
        category: t.category,
        tags: t.tags,
        filename: t.filename,
        destination: t.destination,
      };
    });

    const text = listing
      .map(
        (t) =>
          `**${t.name}** (${t.category}) [${t.tags.join(", ")}]\n  ${t.description}\n  Destination: \`${t.destination}\``
      )
      .join("\n\n");

    const heading = project_type
      ? `Project Voltron — ${project_type} Templates`
      : "Project Voltron — All Agent Templates";

    return {
      content: [
        {
          type: "text",
          text:
            `# ${heading}\n\n` +
            `**Version:** ${VERSION}\n` +
            `${listing.length} templates available. Use \`get_template\` to retrieve any template, or \`scaffold_project\` to write the right set for your project type.\n\n` +
            text,
        },
      ],
    };
  }
);

// ─── Tool: get_template ─────────────────────────────────────────────────────

server.tool(
  "get_template",
  "Get the full content of a specific agent template or project config by name.",
  {
    name: z
      .string()
      .describe(
        `Template name to retrieve. Valid names: ${ALL_NAMES.join(", ")}. Legacy alias "claude-md" also accepted.`
      ),
  },
  async ({ name: rawName }) => {
    const name = TEMPLATE_ALIASES[rawName] || rawName;
    const t = TEMPLATES[name];
    if (!t) {
      return {
        content: [
          {
            type: "text",
            text: `Template "${rawName}" not found. Valid names: ${ALL_NAMES.join(", ")}`,
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
            `**Version:** ${VERSION}\n` +
            `**Category:** ${t.category}\n` +
            `**Tags:** ${t.tags.join(", ")}\n` +
            `**Destination:** \`${t.destination}\`\n` +
            `**Description:** ${t.description}\n\n` +
            `---\n\n` +
            `${t.content}`,
        },
      ],
    };
  }
);

// ─── Tool: scaffold_project ─────────────────────────────────────────────────

server.tool(
  "scaffold_project",
  'Returns the full set of files needed to scaffold a project with Project Voltron agent templates. Automatically selects the right agents based on project type. Always includes the scrum-master agent. Use project_type to pick a preset ("unity", "web", "fullstack", "general") or omit to include ALL agents.',
  {
    project_type: z
      .enum(VALID_PROJECT_TYPES)
      .optional()
      .describe(
        'Project type to scaffold for. "unity" = Unity game dev agents, "web"/"fullstack" = web dev agents (React/TS + Node + DevOps), "general" = scrum-master + generic CLAUDE.md. Omit to include ALL agents.'
      ),
  },
  async ({ project_type }) => {
    const templateKeys = getTemplatesForType(project_type);

    const files = templateKeys.map((key) => {
      const t = TEMPLATES[key];
      return {
        path: t.destination,
        content: t.content,
      };
    });

    // Add Docker execution files
    files.push({
      path: "Dockerfile.voltron",
      content:
        "FROM node:20-slim\n" +
        "RUN npm install -g @anthropic-ai/claude-code\n" +
        "RUN useradd -m -s /bin/bash voltron\n" +
        "USER voltron\n" +
        "WORKDIR /workspace\n" +
        'ENTRYPOINT ["claude"]',
    });

    files.push({
      path: "scripts/voltron-run.sh",
      content:
        "#!/bin/bash\n" +
        "# Voltron Docker launcher — starts Claude Code with full agent autonomy\n" +
        "# Usage: ./scripts/voltron-run.sh\n" +
        '#        ./scripts/voltron-run.sh -p "invoke @agent-scrum-master to plan the backlog"\n' +
        "\n" +
        "docker build -t voltron-agent -f Dockerfile.voltron . 2>/dev/null\n" +
        "docker run --rm -it \\\n" +
        '  -v "$(pwd):/workspace" \\\n' +
        '  -v "$HOME/.claude:/home/voltron/.claude" \\\n' +
        '  -v "$HOME/.claude.json:/home/voltron/.claude.json:ro" \\\n' +
        "  voltron-agent \\\n" +
        "  --dangerously-skip-permissions \\\n" +
        '  "$@"',
    });

    // Build the auto-update hook settings file
    // Use the voltron root (parent of __dirname which is src/)
    const voltronRoot = join(__dirname, "..").replace(/\\/g, "/");
    const autoUpdateScript = `${voltronRoot}/scripts/auto-update-agents.js`;

    const settingsContent = JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: `node "${autoUpdateScript}"`,
                },
              ],
            },
          ],
        },
      },
      null,
      2
    );

    const settingsFile = {
      path: ".claude/settings.json",
      content: settingsContent,
      note: "Auto-update hook — merge with existing .claude/settings.json if one already exists",
    };

    const typeLabel = project_type
      ? `${project_type} project`
      : "all available agents";

    const agentFileInstructions = files
      .map(
        (f, i) =>
          `## File ${i + 1}: \`${f.path}\`\n\n\`\`\`markdown\n${f.content}\n\`\`\``
      )
      .join("\n\n---\n\n");

    const instructions =
      `# Scaffold Instructions — ${typeLabel}\n\n` +
      `**Project Voltron v${VERSION}**\n\n` +
      `Write the following ${files.length} files to the project root:\n\n` +
      agentFileInstructions +
      `\n\n---\n\n` +
      `## Auto-Update Hook: \`.claude/settings.json\`\n\n` +
      `> **Important:** If \`.claude/settings.json\` already exists in this project, merge the \`hooks.UserPromptSubmit\` entry below into it rather than overwriting.\n\n` +
      `\`\`\`json\n${settingsContent}\n\`\`\`\n\n` +
      `This hook runs \`auto-update-agents.js\` at the start of each Claude Code session. If your installed agent templates are outdated, they are silently updated in place. You will see a \`[VOLTRON]\` message in context when an update occurs.` +
      `\n\n---\n\n## Docker Execution (Required)\n\n` +
      `The scaffold includes \`Dockerfile.voltron\` and \`scripts/voltron-run.sh\` above. After writing all files, make the launch script executable:\n\n` +
      "```bash\nchmod +x scripts/voltron-run.sh\n```\n\n" +
      `**Start every Voltron session via Docker:**\n\n` +
      "```bash\n# Interactive session with full agent autonomy\n./scripts/voltron-run.sh\n\n# Direct prompt execution\n./scripts/voltron-run.sh -p \"invoke @agent-scrum-master to plan the backlog\"\n```\n\n" +
      `> **Important:** Do not start Voltron sessions with bare \`claude\` on the host. Without Docker, every tool call requires manual approval, breaking multi-step agent tasks. ` +
      `The scrum-master will detect if it is not running inside Docker and warn the user to restart via \`./scripts/voltron-run.sh\`.`;

    return {
      content: [{ type: "text", text: instructions }],
    };
  }
);

// ─── Tool: scaffold_unity_project (deprecated alias) ────────────────────────

server.tool(
  "scaffold_unity_project",
  '[DEPRECATED — use scaffold_project with project_type="unity"] Returns Unity project scaffold files.',
  {},
  async () => {
    const templateKeys = getTemplatesForType("unity");

    const files = templateKeys.map((key) => {
      const t = TEMPLATES[key];
      return { path: t.destination, content: t.content };
    });

    const instructions =
      `# Scaffold Instructions — Unity project\n\n` +
      `**Project Voltron v${VERSION}**\n` +
      `> Note: This tool is deprecated. Use \`scaffold_project\` with \`project_type: "unity"\` instead.\n\n` +
      `Write the following ${files.length} files to the Unity project root:\n\n` +
      files
        .map(
          (f, i) =>
            `## File ${i + 1}: \`${f.path}\`\n\n\`\`\`markdown\n${f.content}\n\`\`\``
        )
        .join("\n\n---\n\n");

    return {
      content: [{ type: "text", text: instructions }],
    };
  }
);

// ─── Tool: get_auto_update_hook ────────────────────────────────────────────

server.tool(
  "get_auto_update_hook",
  "Returns the .claude/settings.json hook configuration that enables automatic agent updates at session start. Add this to your project's .claude/settings.json to keep Voltron agents current without manual check_for_updates calls.",
  {},
  async () => {
    const voltronRoot = join(__dirname, "..").replace(/\\/g, "/");
    const autoUpdateScript = `${voltronRoot}/scripts/auto-update-agents.js`;

    const settingsContent = JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: `node "${autoUpdateScript}"`,
                },
              ],
            },
          ],
        },
      },
      null,
      2
    );

    const text =
      `# Auto-Update Hook for Voltron Agents\n\n` +
      `Add the following to your project's \`.claude/settings.json\` to enable automatic agent updates.\n\n` +
      `If \`.claude/settings.json\` already exists, merge the \`hooks.UserPromptSubmit\` entry into it.\n\n` +
      `\`\`\`json\n${settingsContent}\n\`\`\`\n\n` +
      `**How it works:** At the start of each Claude Code session (on each \`UserPromptSubmit\`), this hook runs \`auto-update-agents.js\`. If the installed agent version differs from your local Voltron installation, all installed agents are silently updated in place. A \`[VOLTRON] Auto-updated N agent(s)\` message appears in context when an update occurs.\n\n` +
      `**Requirements:** Node.js must be available in the shell PATH used by Claude Code hooks.`;

    return {
      content: [{ type: "text", text }],
    };
  }
);

// ─── Tool: get_agent_usage_guide ────────────────────────────────────────────

server.tool(
  "get_agent_usage_guide",
  "Returns a usage guide explaining how to invoke and coordinate the agent team. Covers when to use each agent, invocation syntax, and the recommended workflow order. Optionally filter by project type.",
  {
    project_type: z
      .enum(VALID_PROJECT_TYPES)
      .optional()
      .describe(
        "Show guide for a specific project type. Omit to show the full guide for all agents."
      ),
  },
  async ({ project_type }) => {
    const relevantKeys = project_type
      ? getTemplatesForType(project_type).filter(
          (k) => TEMPLATES[k]?.category === "agent"
        )
      : AGENT_NAMES;

    const agentTable = relevantKeys
      .map((key) => {
        const t = TEMPLATES[key];
        return `| **${t.name}** | \`@agent-${key}\` | ${t.description.split(".")[0]} |`;
      })
      .join("\n");

    let workflowSection;
    if (project_type === "unity") {
      workflowSection = UNITY_WORKFLOW;
    } else if (project_type === "web" || project_type === "fullstack") {
      workflowSection = WEB_WORKFLOW;
    } else {
      workflowSection = GENERAL_WORKFLOW;
    }

    const title = project_type
      ? `Project Voltron — Agent Usage Guide (${project_type})`
      : "Project Voltron — Agent Usage Guide";

    const guide =
      `# ${title}\n\n` +
      `**Version:** ${VERSION}\n\n` +
      `## The Agent Team\n\n` +
      `| Agent | Invoke With | Use When |\n|---|---|---|\n${agentTable}\n\n` +
      workflowSection +
      "\n" +
      KEY_RULES;

    return {
      content: [{ type: "text", text: guide }],
    };
  }
);

// ─── Tool: check_for_updates ────────────────────────────────────────────────

server.tool(
  "check_for_updates",
  "Check if any Project Voltron agent templates have been updated since they were scaffolded. Compares the installed version embedded in agent files against the current server version. Returns a list of outdated agents and their updated content. Run this periodically or before using an agent to ensure templates are current.",
  {
    project_root: z
      .string()
      .describe(
        "Absolute path to the project root directory where CLAUDE.md and .claude/agents/ are located."
      ),
  },
  async ({ project_root }) => {
    // Normalize path separator
    const root = project_root.replace(/\\/g, "/").replace(/\/$/, "");

    // We can't read files directly from the MCP server (no filesystem access
    // guaranteed), so we return a script the caller can run + the current
    // version and all template content for diffing.

    const agentKeys = AGENT_NAMES;
    const agentInfo = agentKeys.map((key) => {
      const t = TEMPLATES[key];
      return {
        name: key,
        destination: t.destination,
        fullPath: `${root}/${t.destination}`,
        currentContent: t.content,
      };
    });

    // Also include all CLAUDE.md variants so the caller can check which one is installed
    const configKeys = Object.keys(TEMPLATES).filter(
      (k) => TEMPLATES[k].category === "project-config"
    );
    const configInfo = configKeys.map((key) => {
      const t = TEMPLATES[key];
      return {
        name: key,
        destination: t.destination,
        fullPath: `${root}/${t.destination}`,
        currentContent: t.content,
      };
    });

    const instructions =
      `# Project Voltron Update Check\n\n` +
      `**Server version:** ${VERSION}\n\n` +
      `## How to check for updates\n\n` +
      `Compare the content of each installed agent file against the current template content below.\n` +
      `If the installed file differs from the current template, it can be updated.\n\n` +
      `**Installed agent files to check:**\n` +
      agentInfo
        .map((a) => `- \`${a.fullPath}\``)
        .join("\n") +
      `\n\n**Installed project config:**\n` +
      `- \`${root}/CLAUDE.md\`\n\n` +
      `## Current Template Content\n\n` +
      `Use the Read tool to read each installed file, then compare against the content below.\n` +
      `Only update files that were originally scaffolded by Project Voltron (look for agent frontmatter).\n` +
      `Preserve any user customizations in CLAUDE.md — only update the structural template sections.\n\n` +
      agentInfo
        .map(
          (a) =>
            `### ${a.name} — \`${a.destination}\`\n\n\`\`\`markdown\n${a.currentContent}\n\`\`\``
        )
        .join("\n\n---\n\n");

    return {
      content: [{ type: "text", text: instructions }],
    };
  }
);

// ─── Tool: update_agent ─────────────────────────────────────────────────────

server.tool(
  "update_agent",
  "Get the latest content for a specific agent template so it can be written to disk, replacing the outdated version. Use after check_for_updates identifies outdated agents.",
  {
    name: z
      .string()
      .describe(
        `Agent template name to get the latest version of. Valid names: ${AGENT_NAMES.join(", ")}`
      ),
  },
  async ({ name: rawName }) => {
    const name = TEMPLATE_ALIASES[rawName] || rawName;
    const t = TEMPLATES[name];
    if (!t) {
      return {
        content: [
          {
            type: "text",
            text: `Template "${rawName}" not found. Valid agent names: ${AGENT_NAMES.join(", ")}`,
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
            `# Update: ${t.name}\n\n` +
            `**Version:** ${VERSION}\n` +
            `**Destination:** \`${t.destination}\`\n\n` +
            `Write the following content to \`${t.destination}\`:\n\n` +
            `\`\`\`markdown\n${t.content}\n\`\`\``,
        },
      ],
    };
  }
);

// ─── Tool: submit_reflection ────────────────────────────────────────────────

server.tool(
  "submit_reflection",
  "Submit a post-session reflection on agent performance. Called by scrum-master (or the main Claude orchestrator) at the end of each session to capture what worked, what didn't, and suggested improvements to agent templates. Reflections accumulate in the project-voltron repo and are reviewed to drive template improvements.",
  {
    project_name: z.string().describe("Name of the project this session was for."),
    project_type: z
      .enum([...VALID_PROJECT_TYPES, "unknown"])
      .optional()
      .describe("Type of project (unity, web, fullstack, general, unknown)."),
    session_summary: z
      .string()
      .describe("Brief summary of what was accomplished this session."),
    agents_used: z
      .array(z.string())
      .describe("Names of agents that were invoked this session."),
    agent_feedback: z
      .array(
        z.object({
          agent: z.string().describe("Agent name (e.g. 'csharp-dev')"),
          worked_well: z
            .string()
            .optional()
            .describe("What worked well about this agent's instructions"),
          needs_improvement: z
            .string()
            .optional()
            .describe("What was unclear, missing, or ineffective"),
          suggested_change: z
            .string()
            .optional()
            .describe("Specific suggested change to the agent template"),
        })
      )
      .optional()
      .describe("Per-agent feedback entries"),
    overall_notes: z
      .string()
      .optional()
      .describe("Any other observations about agent workflow or coordination"),
  },
  async ({
    project_name,
    project_type,
    session_summary,
    agents_used,
    agent_feedback,
    overall_notes,
  }) => {
    const reflectionsDir = join(__dirname, "..", "reflections");
    mkdirSync(reflectionsDir, { recursive: true });

    const now = new Date();
    const timestamp = now
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const slug = (project_type || "general").replace(/[^a-z0-9]/gi, "-");
    const filename = `${timestamp}-${slug}.json`;
    const filepath = join(reflectionsDir, filename);

    const reflection = {
      timestamp: now.toISOString(),
      project_name,
      project_type: project_type || "unknown",
      session_summary,
      agents_used,
      agent_feedback: agent_feedback || [],
      overall_notes: overall_notes || "",
      processed: false,
    };

    writeFileSync(filepath, JSON.stringify(reflection, null, 2), "utf-8");

    let gitStatus = "";
    try {
      const repoRoot = join(__dirname, "..");
      execSync(`git add "reflections/${filename}"`, { cwd: repoRoot });
      execSync(
        `git commit -m "Add reflection: ${filename}"`,
        { cwd: repoRoot }
      );
      execSync("git push", { cwd: repoRoot });
      gitStatus = "\n\nCommitted and pushed to remote.";
    } catch (err) {
      gitStatus = `\n\n> Warning: reflection saved locally but git commit/push failed: ${err.message}`;
    }

    return {
      content: [
        {
          type: "text",
          text:
            `# Reflection Saved\n\n` +
            `Saved to \`reflections/${filename}\`.${gitStatus}\n\n` +
            `This feedback will be reviewed and applied to improve Project Voltron agent templates.`,
        },
      ],
    };
  }
);

// ─── Tool: list_reflections ─────────────────────────────────────────────────

server.tool(
  "list_reflections",
  "List all stored post-session reflections. Returns structured feedback submitted via submit_reflection. Use this when working in the project-voltron context to review pending improvements and decide what to apply to agent templates.",
  {
    unprocessed_only: z
      .boolean()
      .optional()
      .describe(
        "If true, only return reflections not yet marked processed. Defaults to false (return all)."
      ),
  },
  async ({ unprocessed_only }) => {
    const reflectionsDir = join(__dirname, "..", "reflections");

    let files;
    try {
      files = readdirSync(reflectionsDir).filter((f) => f.endsWith(".json"));
    } catch {
      return {
        content: [
          {
            type: "text",
            text:
              `# No Reflections Found\n\n` +
              `No reflections have been submitted yet. ` +
              `Reflections are submitted by \`scrum-master\` or the main Claude orchestrator at the end of each session via \`submit_reflection\`.`,
          },
        ],
      };
    }

    if (files.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `# No Reflections Found\n\nNo reflections have been submitted yet.`,
          },
        ],
      };
    }

    const reflections = files
      .map((f) => {
        try {
          const data = JSON.parse(
            readFileSync(join(reflectionsDir, f), "utf-8")
          );
          return { filename: f, ...data };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((r) => !unprocessed_only || !r.processed)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    if (reflections.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `# All Reflections Processed\n\nNo pending reflections. All feedback has been applied.`,
          },
        ],
      };
    }

    const text = reflections
      .map((r) => {
        const status = r.processed ? "Processed" : "Pending";
        const agentLines =
          r.agent_feedback?.length > 0
            ? r.agent_feedback
                .map((af) => {
                  const parts = [];
                  if (af.needs_improvement)
                    parts.push(`Issue: ${af.needs_improvement}`);
                  if (af.suggested_change)
                    parts.push(`Suggestion: ${af.suggested_change}`);
                  if (af.worked_well) parts.push(`Worked well: ${af.worked_well}`);
                  return `  - **${af.agent}**: ${parts.join(" | ")}`;
                })
                .join("\n")
            : "  (no per-agent feedback)";

        return (
          `## ${r.project_name} (${r.project_type}) — ${r.timestamp.slice(0, 10)}\n` +
          `**Status:** ${status}\n` +
          `**Summary:** ${r.session_summary}\n` +
          `**Agents used:** ${r.agents_used?.join(", ") || "unknown"}\n` +
          `**Agent feedback:**\n${agentLines}\n` +
          (r.overall_notes ? `**Notes:** ${r.overall_notes}\n` : "") +
          `*(File: \`reflections/${r.filename}\`)*`
        );
      })
      .join("\n\n---\n\n");

    const pendingCount = reflections.filter((r) => !r.processed).length;

    return {
      content: [
        {
          type: "text",
          text:
            `# Project Voltron — Stored Reflections\n\n` +
            `${reflections.length} reflection(s) found. ${pendingCount} pending.\n\n` +
            `To apply improvements: read the pending feedback, update \`src/templates.js\`, ` +
            `mark each reflection as processed (\`"processed": true\`), then bump \`package.json\` version.\n\n` +
            text,
        },
      ],
    };
  }
);

// ─── Tool: update_progress ─────────────────────────────────────────────────

server.tool(
  "update_progress",
  "Update agent task progress. Call before/after each agent invocation to track work.",
  {
    task_id: z.string().describe("Unique task identifier (e.g., '1', '2a', 'phase1-setup')"),
    agent: z.string().describe("Agent name (e.g., 'fullstack-dev', 'csharp-dev')"),
    status: z.enum(["queued", "in_progress", "completed", "failed", "blocked"]).describe("Current task status"),
    description: z.string().describe("Task description"),
    phase: z.string().optional().describe("Phase name (e.g., 'Phase 1: Scaffolding')"),
    notes: z.string().optional().describe("Additional notes or error details"),
  },
  async ({ task_id, agent, status, description, phase, notes }) => {
    const progressDir = path.join(process.cwd(), ".voltron");
    const progressFile = path.join(progressDir, "progress.json");

    await fs.mkdir(progressDir, { recursive: true });

    let progress = { tasks: [], updated_at: null };
    try {
      progress = JSON.parse(await fs.readFile(progressFile, "utf-8"));
    } catch {
      // File doesn't exist yet
    }

    const now = new Date().toISOString();
    const existing = progress.tasks.find((t) => t.task_id === task_id);

    if (existing) {
      existing.status = status;
      existing.agent = agent || existing.agent;
      existing.description = description || existing.description;
      if (phase) existing.phase = phase;
      if (notes) existing.notes = notes;
      if (status === "in_progress" && !existing.started_at) existing.started_at = now;
      if (status === "completed" || status === "failed") existing.completed_at = now;
      existing.updated_at = now;
    } else {
      progress.tasks.push({
        task_id,
        agent,
        status,
        description,
        phase: phase || "",
        notes: notes || "",
        created_at: now,
        started_at: status === "in_progress" ? now : null,
        completed_at: status === "completed" || status === "failed" ? now : null,
        updated_at: now,
      });
    }

    progress.updated_at = now;
    await fs.writeFile(progressFile, JSON.stringify(progress, null, 2));

    // Auto-regenerate dashboard after every progress update
    await regenerateDashboard();

    // Auto-open dashboard in browser on the first update_progress call
    const dashboardFile = path.join(progressDir, "dashboard.html");
    if (!globalThis.__voltronDashboardOpened) {
      globalThis.__voltronDashboardOpened = true;
      try {
        const openCmd = process.platform === "win32" ? "start" :
                        process.platform === "darwin" ? "open" : "xdg-open";
        execSync(`${openCmd} "${dashboardFile}"`, { stdio: "ignore" });
      } catch {
        // Browser open failed — user can open manually
      }
    }

    return {
      content: [{ type: "text", text: `Progress updated: task ${task_id} (${agent}) → ${status}` }],
    };
  }
);

// ─── Tool: get_progress ────────────────────────────────────────────────────

server.tool(
  "get_progress",
  "View current agent task progress as a formatted dashboard.",
  {
    format: z.enum(["summary", "detailed"]).optional().describe("Output format (default: summary)"),
  },
  async ({ format }) => {
    const progressFile = path.join(process.cwd(), ".voltron", "progress.json");

    let progress;
    try {
      progress = JSON.parse(await fs.readFile(progressFile, "utf-8"));
    } catch {
      return { content: [{ type: "text", text: "No progress data found. Use update_progress to start tracking." }] };
    }

    const tasks = progress.tasks || [];
    const byStatus = { queued: [], in_progress: [], completed: [], failed: [], blocked: [] };
    for (const t of tasks) {
      (byStatus[t.status] || []).push(t);
    }

    const phases = [...new Set(tasks.map((t) => t.phase).filter(Boolean))];

    let output = `# Voltron Progress Dashboard\n\n`;
    output += `**Last updated:** ${progress.updated_at || "never"}\n\n`;
    output += `## Summary\n\n`;
    output += `| Status | Count |\n|--------|-------|\n`;
    for (const [s, arr] of Object.entries(byStatus)) {
      if (arr.length > 0) output += `| ${s} | ${arr.length} |\n`;
    }
    output += `\n**Total:** ${tasks.length} tasks\n\n`;

    if (byStatus.in_progress.length > 0) {
      output += `## Currently Active\n\n`;
      for (const t of byStatus.in_progress) {
        output += `- **${t.agent}**: ${t.description} (task ${t.task_id})\n`;
      }
      output += `\n`;
    }

    if (byStatus.blocked.length > 0) {
      output += `## Blocked\n\n`;
      for (const t of byStatus.blocked) {
        output += `- **${t.agent}**: ${t.description} — ${t.notes || "no details"}\n`;
      }
      output += `\n`;
    }

    if (format === "detailed" || !format) {
      for (const phase of phases) {
        const phaseTasks = tasks.filter((t) => t.phase === phase);
        output += `## ${phase}\n\n`;
        output += `| # | Task | Agent | Status | Started | Completed |\n`;
        output += `|---|------|-------|--------|---------|----------|\n`;
        for (const t of phaseTasks) {
          const started = t.started_at ? t.started_at.split("T")[1]?.slice(0, 5) : "—";
          const completed = t.completed_at ? t.completed_at.split("T")[1]?.slice(0, 5) : "—";
          output += `| ${t.task_id} | ${t.description} | ${t.agent} | ${t.status} | ${started} | ${completed} |\n`;
        }
        output += `\n`;
      }

      // Tasks without a phase
      const unphased = tasks.filter((t) => !t.phase);
      if (unphased.length > 0) {
        output += `## Unphased Tasks\n\n`;
        for (const t of unphased) {
          output += `- [${t.status}] **${t.agent}**: ${t.description}\n`;
        }
      }
    }

    return { content: [{ type: "text", text: output }] };
  }
);

// ─── Dashboard HTML generator (shared by update_progress and generate_dashboard)

function buildDashboardHtml(progress) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="5">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Voltron Progress Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e1e4e8; padding: 2rem; }
  h1 { color: #58a6ff; margin-bottom: 0.5rem; }
  .updated { color: #8b949e; font-size: 0.85rem; margin-bottom: 2rem; }
  .stats { display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem 1.5rem; min-width: 120px; }
  .stat-value { font-size: 2rem; font-weight: 700; }
  .stat-label { color: #8b949e; font-size: 0.85rem; }
  .stat.in_progress .stat-value { color: #d29922; }
  .stat.completed .stat-value { color: #3fb950; }
  .stat.failed .stat-value { color: #f85149; }
  .stat.blocked .stat-value { color: #f85149; }
  .stat.queued .stat-value { color: #8b949e; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 2rem; }
  th { text-align: left; padding: 0.75rem; border-bottom: 2px solid #30363d; color: #8b949e; font-size: 0.85rem; text-transform: uppercase; }
  td { padding: 0.75rem; border-bottom: 1px solid #21262d; }
  .badge { padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600; }
  .badge.queued { background: #30363d; color: #8b949e; }
  .badge.in_progress { background: #3d2e00; color: #d29922; }
  .badge.completed { background: #0d2818; color: #3fb950; }
  .badge.failed { background: #3d1114; color: #f85149; }
  .badge.blocked { background: #3d1114; color: #f85149; }
  .phase-header { color: #58a6ff; font-size: 1.1rem; margin: 1.5rem 0 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid #30363d; }
</style>
</head>
<body>
<h1>Voltron Progress Dashboard</h1>
<div class="updated">Last updated: ${progress.updated_at || "never"} (auto-refreshes every 5s)</div>
<div class="stats" id="stats"></div>
<div id="phases"></div>
<script>
const data = ${JSON.stringify(progress)};
const tasks = data.tasks || [];
const counts = { queued: 0, in_progress: 0, completed: 0, failed: 0, blocked: 0 };
tasks.forEach(t => counts[t.status] = (counts[t.status] || 0) + 1);
const statsEl = document.getElementById('stats');
for (const [s, c] of Object.entries(counts)) {
  if (c > 0) statsEl.innerHTML += '<div class="stat ' + s + '"><div class="stat-value">' + c + '</div><div class="stat-label">' + s.replace('_', ' ') + '</div></div>';
}
const phases = [...new Set(tasks.map(t => t.phase).filter(Boolean))];
const phasesEl = document.getElementById('phases');
phases.forEach(phase => {
  const pTasks = tasks.filter(t => t.phase === phase);
  let html = '<div class="phase-header">' + phase + '</div><table><tr><th>#</th><th>Task</th><th>Agent</th><th>Status</th></tr>';
  pTasks.forEach(t => { html += '<tr><td>' + t.task_id + '</td><td>' + t.description + '</td><td>' + t.agent + '</td><td><span class="badge ' + t.status + '">' + t.status.replace('_', ' ') + '</span></td></tr>'; });
  html += '</table>';
  phasesEl.innerHTML += html;
});
</script>
</body>
</html>`;
}

async function regenerateDashboard() {
  const progressFile = path.join(process.cwd(), ".voltron", "progress.json");
  const outFile = path.join(process.cwd(), ".voltron", "dashboard.html");
  try {
    const progress = JSON.parse(await fs.readFile(progressFile, "utf-8"));
    await fs.writeFile(outFile, buildDashboardHtml(progress));
  } catch {
    // No progress data yet — skip silently
  }
}

// ─── Tool: generate_dashboard ──────────────────────────────────────────────

server.tool(
  "generate_dashboard",
  "Generate a standalone HTML dashboard from progress data.",
  {
    output_path: z.string().optional().describe("Output file path (default: .voltron/dashboard.html)"),
  },
  async ({ output_path }) => {
    const progressFile = path.join(process.cwd(), ".voltron", "progress.json");
    const outFile = output_path || path.join(process.cwd(), ".voltron", "dashboard.html");

    let progress;
    try {
      progress = JSON.parse(await fs.readFile(progressFile, "utf-8"));
    } catch {
      return { content: [{ type: "text", text: "No progress data found. Use update_progress first." }] };
    }

    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, buildDashboardHtml(progress));

    return {
      content: [{ type: "text", text: `Dashboard generated at ${outFile}\nAuto-refreshes every 5 seconds. Open in a browser to monitor agent progress live.` }],
    };
  }
);

// ─── Start server ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
