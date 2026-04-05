#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
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
2. **Use \`scrum-master\` to plan work** — Give it your backlog or feature list and let it break work into agent-sized tasks
3. **For new features:**
   - \`csharp-dev\` writes the scripts
   - \`scene-architect\` sets up the scene/prefab structure
   - \`shader-artist\` handles any visual work
   - \`build-validator\` checks everything compiles and runs
4. **For asset imports:**
   - \`asset-manager\` organizes and configures import settings
   - \`build-validator\` verifies nothing broke
5. **Before committing:**
   - Always run \`build-validator\` for a validation pass
`;

const WEB_WORKFLOW = `## Recommended Workflow

1. **Start with CLAUDE.md** — Fill in your project details so agents have context
2. **Use \`scrum-master\` to plan work** — Give it your project plan or feature list and let it break work into agent-sized tasks
3. **For new features:**
   - \`fullstack-dev\` implements the frontend + backend code
   - \`ui-designer\` handles CSS, responsive layout, and visual polish
   - \`devops-engineer\` configures deployment and infrastructure
   - \`qa-tester\` validates quality and runs audits
4. **For deployments:**
   - \`devops-engineer\` writes IaC and CI/CD pipelines
   - \`qa-tester\` runs Lighthouse and bundle audits
5. **Before merging:**
   - Always run \`qa-tester\` for a quality pass
`;

const GENERAL_WORKFLOW = `## Recommended Workflow

1. **Start with CLAUDE.md** — Fill in your project details so agents have context
2. **Use \`scrum-master\` to plan work** — Give it your backlog or requirements and let it decompose into agent-sized tasks
3. **Invoke specialist agents** for each task in the plan
4. **Use \`scrum-master\` again** to review progress and plan next steps
`;

const KEY_RULES = `## Key Rules

- Agents respect boundaries — each agent has a clear responsibility and defers to others outside that scope
- \`scrum-master\` never implements — it only plans and delegates
- All agents read CLAUDE.md for project context — keep it updated
- Agents coordinate via the task list — chain them for multi-step work
- Use \`check_for_updates\` periodically to ensure your agent templates are current

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

    const typeLabel = project_type
      ? `${project_type} project`
      : "all available agents";

    const instructions =
      `# Scaffold Instructions — ${typeLabel}\n\n` +
      `**Project Voltron v${VERSION}**\n\n` +
      `Write the following ${files.length} files to the project root:\n\n` +
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

// ─── Start server ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
