#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { execSync, spawn, exec as execCb } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execCb);
import os from "node:os";
import {
  TEMPLATES,
  AGENT_NAMES,
  ALL_NAMES,
  TEMPLATE_ALIASES,
  getTemplatesForType,
  VALID_PROJECT_TYPES,
  CLAUDE_MD_FOR_TYPE,
  DOCKERFILE_CONTENT,
  VOLTRON_RUN_SCRIPT,
  VOLTRON_ALLOW,
  VOLTRON_DENY,
  voltronGitignoreBlock,
} from "./templates.js";

// ─── Version ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8")
);
const VERSION = pkg.version;

// ─── Claude Code version utilities ──────────────────────────────────────────

const CLAUDE_MIN_VERSION = { major: 1, minor: 8, patch: 0 }; // minimum for .claude/agents/ support

function parseClaudeVersion(versionStr) {
  const m = versionStr?.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: parseInt(m[1]), minor: parseInt(m[2]), patch: parseInt(m[3]) };
}

function meetsMinVersion(v, min) {
  if (!v) return false;
  if (v.major !== min.major) return v.major > min.major;
  if (v.minor !== min.minor) return v.minor > min.minor;
  return v.patch >= min.patch;
}

function getClaudeVersion() {
  try {
    const out = execSync("claude --version", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { raw: out, parsed: parseClaudeVersion(out) };
  } catch {
    try {
      const out = execSync("claude.cmd --version", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      return { raw: out, parsed: parseClaudeVersion(out) };
    } catch {
      return { raw: null, parsed: null };
    }
  }
}

/**
 * Detect the user's project root directory.
 * Fallback chain:
 *   1. Explicit rawRoot parameter (most reliable)
 *   2. Walk up from process.cwd() for project root markers
 *   3. Walk up from process.env.PWD if different from cwd
 *   4. process.cwd() as bare last resort
 *
 * @param {string|undefined} rawRoot - explicit path passed by the tool caller
 * @returns {{ root: string, source: string }}
 */
// Returns null if Docker is ready, or an error string describing why it isn't.
// Async — uses promisified exec so the MCP stdio transport stays alive during the check.
async function checkDockerAvailable() {
  try {
    await exec("docker --version");
  } catch {
    return "Docker CLI is not installed or not in PATH. Install Docker Desktop and ensure it is in your PATH.";
  }
  try {
    await exec("docker info", { timeout: 10000 });
  } catch {
    return "Docker is installed but the daemon is not running. Start Docker Desktop and wait for it to finish starting, then try again.";
  }
  return null;
}

function detectProjectRoot(rawRoot) {
  // 1. Explicit parameter always wins
  if (rawRoot) {
    return { root: path.resolve(rawRoot), source: 'explicit' };
  }

  // NOTE: process.env.CLAUDE_PROJECT_DIR is hooks-only — NOT available to MCP servers.
  // Confirmed by claude-code Issues #17565, #1520, official hooks docs. Do not use it.

  const PROJECT_MARKERS = [
    '.git',           // git repo root (strongest signal)
    'CLAUDE.md',      // explicit Claude Code project root
    '.mcp.json',      // Claude Code project MCP config
    'package.json',   // Node.js project
    'Cargo.toml',     // Rust
    'go.mod',         // Go
    'pyproject.toml', // Python
    'pom.xml',        // Java/Maven
  ];

  const cwd = process.cwd();
  const pwd = process.env.PWD;
  const startDirs = [cwd];
  if (pwd && path.resolve(pwd) !== path.resolve(cwd)) {
    startDirs.push(pwd);
  }

  for (const startDir of startDirs) {
    let dir = path.resolve(startDir);
    const visited = new Set();
    while (!visited.has(dir)) {
      visited.add(dir);
      for (const marker of PROJECT_MARKERS) {
        if (existsSync(path.join(dir, marker))) {
          return { root: dir, source: `walk-up:${marker}` };
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break; // filesystem root reached
      dir = parent;
    }
  }

  // Last resort — bare CWD, almost certainly wrong for global MCP servers
  return { root: cwd, source: 'cwd-fallback' };
}

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
  'Writes Project Voltron agent templates directly to disk for the given project type. Automatically selects the right agents and creates all necessary files. Use project_root to specify an explicit project path if files land in the wrong location. Use project_type to pick a preset ("unity", "web", "fullstack", "mobile", "general") or omit to include ALL agents.',
  {
    project_type: z
      .enum(VALID_PROJECT_TYPES)
      .optional()
      .describe(
        'Project type to scaffold for. "unity" = Unity game dev agents, "web"/"fullstack" = web dev agents, "mobile" = React Native + iOS + Android + QA + publishing agents, "general" = scrum-master + generic CLAUDE.md. Omit to include ALL agents.'
      ),
    project_root: z
      .string()
      .optional()
      .describe(
        "Absolute path of the project to scaffold into. Defaults to the current working directory. Pass this explicitly if files are being written to the wrong location."
      ),
  },
  async ({ project_type, project_root: rawRoot }) => {
    const templateKeys = getTemplatesForType(project_type);

    const { root: cwd, source: rootSource } = detectProjectRoot(rawRoot);
    const rootWasExplicit = rootSource === 'explicit';
    const files = templateKeys.map((key) => {
      const t = TEMPLATES[key];
      return { path: t.destination, content: t.content };
    });

    // Add Docker execution files
    files.push({ path: "Dockerfile.voltron", content: DOCKERFILE_CONTENT });
    files.push({ path: "scripts/voltron-run.sh", content: VOLTRON_RUN_SCRIPT });

    // Build the auto-update hook settings content
    const voltronRoot = join(__dirname, "..").replace(/\\/g, "/");
    const autoUpdateScript = `${voltronRoot}/scripts/auto-update-agents.js`;
    const hooksContent = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: `node "${autoUpdateScript}"` }] }],
      },
    };

    // Write files with per-file merge strategies
    const written = [];
    const merged = [];
    const skipped = [];
    const noted = [];
    const failed = [];

    for (const f of files) {
      try {
        const fullPath = path.join(cwd, f.path);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });

        // Strategy 1: CLAUDE.md — append Voltron sections if missing
        if (f.path.endsWith("CLAUDE.md") && !f.path.startsWith(".claude/")) {
          let existing = null;
          try { existing = await fs.readFile(fullPath, "utf-8"); } catch { /* not found */ }
          if (existing === null) {
            await fs.writeFile(fullPath, f.content, "utf-8");
            written.push(f.path);
          } else if (existing.includes("## Agent Team Roles")) {
            skipped.push({ path: f.path, reason: "already contains Voltron sections (auto-update maintains them)" });
          } else {
            // Append from "## Agent Team Roles" onwards
            const appendIdx = f.content.indexOf("## Agent Team Roles");
            if (appendIdx !== -1) {
              const toAppend = f.content.slice(appendIdx);
              await fs.writeFile(fullPath, existing + "\n\n---\n<!-- Project Voltron: agent team configuration -->\n" + toAppend, "utf-8");
              merged.push(f.path);
            } else {
              await fs.writeFile(fullPath, f.content, "utf-8");
              written.push(f.path);
            }
          }

        // Strategy 2: Agent .md files — skip if exists
        } else if (f.path.startsWith(".claude/agents/")) {
          let exists = false;
          try { await fs.access(fullPath); exists = true; } catch { /* not found */ }
          if (exists) {
            skipped.push({ path: f.path, reason: "auto-update hook maintains agent files" });
          } else {
            await fs.writeFile(fullPath, f.content, "utf-8");
            written.push(f.path);
          }

        // Strategy 3: Dockerfile.voltron — preserve custom, write .new if different
        } else if (f.path === "Dockerfile.voltron") {
          let existing = null;
          try { existing = await fs.readFile(fullPath, "utf-8"); } catch { /* not found */ }
          if (existing === null) {
            await fs.writeFile(fullPath, f.content, "utf-8");
            written.push(f.path);
          } else if (existing === f.content) {
            skipped.push({ path: f.path, reason: "already up to date" });
          } else {
            const newPath = path.join(cwd, "Dockerfile.voltron.new");
            await fs.writeFile(newPath, f.content, "utf-8");
            noted.push({ path: f.path, note: "existing Dockerfile.voltron preserved; new template written as Dockerfile.voltron.new" });
          }

        // Strategy 4: voltron-run.sh — always overwrite
        } else if (f.path === "scripts/voltron-run.sh") {
          await fs.writeFile(fullPath, f.content, "utf-8");
          written.push(f.path);

        // Strategy 5: .claude/settings.json — handled separately below
        } else if (f.path === ".claude/settings.json") {
          // handled after this loop

        // Strategy 6: all other files — write unconditionally
        } else {
          await fs.writeFile(fullPath, f.content, "utf-8");
          written.push(f.path);
        }
      } catch (err) {
        failed.push({ path: f.path, error: err.message });
      }
    }

    // Make the launch script executable on Unix/macOS
    if (process.platform !== "win32") {
      try {
        const runScriptPath = path.join(cwd, "scripts", "voltron-run.sh");
        await fs.chmod(runScriptPath, 0o755);
      } catch { /* non-fatal — user can chmod manually */ }
    }

    // Write .mcp.json — register project-voltron at project level for reliable MCP connection
    // This is the canonical way Claude Code discovers MCP servers per-project and avoids
    // the "user-scope registration not persisting" failure mode seen on new installs.
    const mcpJsonPath = path.join(cwd, ".mcp.json");
    let mcpJsonContent = {};
    try {
      mcpJsonContent = JSON.parse(await fs.readFile(mcpJsonPath, "utf-8"));
    } catch { /* not found or invalid — start fresh */ }

    if (!mcpJsonContent.mcpServers) mcpJsonContent.mcpServers = {};

    if (mcpJsonContent.mcpServers["project-voltron"]) {
      skipped.push({ path: ".mcp.json", reason: "project-voltron already registered" });
    } else {
      const voltronIndexPath = fileURLToPath(import.meta.url);
      mcpJsonContent.mcpServers["project-voltron"] = {
        type: "stdio",
        command: "node",
        args: [voltronIndexPath]
      };
      try {
        await fs.writeFile(mcpJsonPath, JSON.stringify(mcpJsonContent, null, 2) + "\n", "utf-8");
        written.push(".mcp.json");
      } catch (err) {
        noted.push({ path: ".mcp.json", note: `could not write: ${err.message} — run: claude mcp add project-voltron -- node "${fileURLToPath(import.meta.url)}"` });
      }
    }

    // Write/update .gitignore — add Voltron block if not already present
    const gitignorePath = path.join(cwd, ".gitignore");
    try {
      const gitignoreBlock = voltronGitignoreBlock();
      let gitignoreContent = "";
      try { gitignoreContent = await fs.readFile(gitignorePath, "utf-8"); } catch { /* new file */ }
      if (!gitignoreContent.includes("# ── Voltron managed")) {
        const separator = gitignoreContent.length > 0 && !gitignoreContent.endsWith("\n") ? "\n\n" : (gitignoreContent.length > 0 ? "\n" : "");
        await fs.writeFile(gitignorePath, gitignoreContent + separator + gitignoreBlock, "utf-8");
        written.push(".gitignore");
        // Stage it immediately so it's never left as an untracked file
        try { execSync("git add .gitignore", { cwd, stdio: "ignore" }); } catch { /* not a git repo yet, non-fatal */ }
      } else {
        skipped.push({ path: ".gitignore", reason: "Voltron block already present" });
      }
    } catch (err) {
      noted.push({ path: ".gitignore", note: `could not write: ${err.message}` });
    }

    // Merge auto-update hook into .claude/settings.json (don't overwrite existing hooks)
    const settingsPath = path.join(cwd, ".claude", "settings.json");
    let existingSettings = {};
    try {
      existingSettings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    } catch { /* no existing settings */ }

    // Skip if auto-update-agents hook already present
    if (JSON.stringify(existingSettings).includes("auto-update-agents")) {
      skipped.push({ path: ".claude/settings.json", reason: "auto-update-agents hook already present" });
    } else {
      if (!existingSettings.hooks) existingSettings.hooks = {};
      if (!Array.isArray(existingSettings.hooks.UserPromptSubmit)) {
        existingSettings.hooks.UserPromptSubmit = [];
      }
      existingSettings.hooks.UserPromptSubmit = hooksContent.hooks.UserPromptSubmit;
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify(existingSettings, null, 2));
      written.push(".claude/settings.json");
    }

    const typeLabel = project_type ? `${project_type} project` : "all agents";

    const formatList = (items) => items.map(i => typeof i === "string" ? `  - ${i}` : `  - ${i.path}${i.reason ? `: ${i.reason}` : ""}${i.note ? `: ${i.note}` : ""}${i.error ? `: ${i.error}` : ""}`).join("\n");

    const sections = [
      `# Scaffold Complete — ${typeLabel}`,
      ``,
      `**Location:** \`${cwd}\``,
      `**Project Voltron v${VERSION}**`,
    ];

    if (!rootWasExplicit) {
      sections.push(
        ``,
        `> ⚠️ **No \`project_root\` was specified.** Project root detected via \`${rootSource}\`: \`${cwd}\``,
        `> If this is NOT your project directory, re-run with an explicit path:`,
        `> \`\`\``,
        `> scaffold_project({ project_type: "${project_type || "general"}", project_root: "/absolute/path/to/your/project" })`,
        `> \`\`\``
      );
    }

    sections.push(
      ``,
      `**Written** (${written.length}):`,
      written.length ? formatList(written) : "  (none)",
      ``,
      `**Merged** (${merged.length}):`,
      merged.length ? formatList(merged) : "  (none)",
      ``,
      `**Skipped** (${skipped.length}):`,
      skipped.length ? formatList(skipped) : "  (none)",
      ``,
      `**Noted** (${noted.length}):`,
      noted.length ? formatList(noted) : "  (none)",
    );

    if (failed.length > 0) {
      sections.push(``, `**Failed** (${failed.length}):`, formatList(failed));
      sections.push(``, `If files are consistently landing in the wrong location, re-run with an explicit project path:`);
      sections.push(`\`scaffold_project({ project_type: "${project_type || "general"}", project_root: "/absolute/path/to/your/project" })\``);
    }

    sections.push(
      ``,
      `## Next Steps`,
      ``,
      `1. **Restart Claude Code** — agent files are not hot-reloaded. You must restart for agents to appear in \`@agent\` autocomplete.`,
      `2. **Fill in \`CLAUDE.md\`** with your project name, stack, and current work`,
      `3. **Ensure Docker is running** — agents execute inside Docker containers`,
      `4. **Invoke the scrum-master:** \`@agent-scrum-master\` to plan your sprint`,
      `5. **For mobile projects:** Note that iOS builds require macOS + Xcode (not Docker)`,
    );

    return {
      content: [{
        type: "text",
        text: sections.join("\n"),
      }],
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

// ─── Tool: append_journal ──────────────────────────────────────────────────

server.tool(
  "append_journal",
  "Append an entry to today's session journal (.voltron/journal/YYYY-MM-DD.md). Call at key moments: session start, task dispatch, task complete, validation pass/fail, handoff, session recap. Produces a human-readable narrative non-developers can follow.",
  {
    entry: z.string().describe("The journal entry text (1-3 sentences describing what happened)."),
    kind: z
      .enum(["session_start", "dispatch", "task_start", "task_complete", "validation_pass", "validation_fail", "handoff", "note", "session_recap"])
      .describe("Kind of event being journaled."),
    actor: z.string().describe("The agent or coordinator name logging this entry (e.g. 'scrum-master', 'typecheck-runner')."),
  },
  async ({ entry, kind, actor }) => {
    const projectRoot = detectProjectRoot(undefined).root;
    const journalDir = path.join(projectRoot, ".voltron", "journal");
    await fs.mkdir(journalDir, { recursive: true });

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 16);
    const journalFile = path.join(journalDir, `${dateStr}.md`);

    const kindIcon = {
      session_start: "🚀", dispatch: "→", task_start: "▶", task_complete: "✓",
      validation_pass: "✅", validation_fail: "❌", handoff: "↩", note: "📝", session_recap: "📋",
    }[kind] || "•";

    const line = `**${timeStr}** ${kindIcon} \`${actor}\` [${kind}] ${entry}\n`;
    await fs.appendFile(journalFile, line, "utf-8");

    return {
      content: [{ type: "text", text: `Journal entry appended to .voltron/journal/${dateStr}.md` }],
    };
  }
);

// ─── Tool: get_journal ──────────────────────────────────────────────────────

server.tool(
  "get_journal",
  "Read the session journal for a given date (default: today). Returns the full journal from .voltron/journal/YYYY-MM-DD.md.",
  {
    date: z.string().optional().describe("Date in YYYY-MM-DD format (default: today)."),
  },
  async ({ date }) => {
    const projectRoot = detectProjectRoot(undefined).root;
    const dateStr = date || new Date().toISOString().slice(0, 10);
    const journalFile = path.join(projectRoot, ".voltron", "journal", `${dateStr}.md`);
    try {
      const content = await fs.readFile(journalFile, "utf-8");
      return {
        content: [{ type: "text", text: `# Session Journal — ${dateStr}\n\n${content}` }],
      };
    } catch {
      return {
        content: [{ type: "text", text: `No journal found for ${dateStr}. Use append_journal to start logging.` }],
      };
    }
  }
);

// ─── Tool: submit_analysis ─────────────────────────────────────────────────

server.tool(
  "submit_analysis",
  "Persist a code analysis report to .voltron/analyses/<timestamp>-<topic>.md. Called by code-analyst after coordinating Inspect-layer micro-agents. Returns the relative path of the written report.",
  {
    topic: z
      .string()
      .describe(
        "Slug for the analysis topic (e.g. 'test-coverage-gaps', 'api-surface-audit')"
      ),
    summary: z
      .string()
      .describe("1-paragraph plain-English summary of findings"),
    findings: z
      .array(
        z.object({
          severity: z.enum(["info", "warn", "error"]),
          description: z.string(),
          file: z.string().optional(),
        })
      )
      .describe("Structured list of findings with severity, description, and optional file reference"),
  },
  async ({ topic, summary, findings }) => {
    const projectRoot = detectProjectRoot(undefined).root;
    const analysesDir = path.join(projectRoot, ".voltron", "analyses");
    await fs.mkdir(analysesDir, { recursive: true });

    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `${timestamp}-${topic}.md`;
    const filePath = path.join(analysesDir, filename);

    const iconMap = { error: "🔴", warn: "🟡", info: "🔵" };
    const findingLines =
      findings.length === 0
        ? ["_No findings._"]
        : findings.map((f) => {
            const icon = iconMap[f.severity] || "•";
            const fileRef = f.file ? ` \`${f.file}\`` : "";
            return `- ${icon} **${f.severity.toUpperCase()}**${fileRef}: ${f.description}`;
          });

    const reportLines = [
      `# Code Analysis: ${topic}`,
      ``,
      `**Generated:** ${now.toISOString()}`,
      ``,
      `## Summary`,
      ``,
      summary,
      ``,
      `## Findings`,
      ``,
      ...findingLines,
      ``,
      `---`,
      `_Generated by code-analyst via Project Voltron_`,
    ];

    await fs.writeFile(filePath, reportLines.join("\n"), "utf-8");

    return {
      content: [
        {
          type: "text",
          text: `.voltron/analyses/${filename}`,
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
    const progressDir = path.join(detectProjectRoot(undefined).root, ".voltron");
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

    // Regenerate dashboard HTML
    const dashPath = await regenerateDashboard();
    const dashHint = dashboardUrl(dashPath) ? `\nDashboard: ${dashboardUrl(dashPath)}` : "";

    return {
      content: [{ type: "text", text: `Progress updated: task ${task_id} (${agent}) → ${status}${dashHint}` }],
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
    const progressFile = path.join(detectProjectRoot(undefined).root, ".voltron", "progress.json");

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

function buildDashboardHtml(progress, journalContent = null) {
  const journalDate = new Date().toISOString().slice(0, 10);
  const journalHtml = journalContent
    ? `<h2 class="section-title">Session Journal — ${journalDate}</h2><div class="journal">${
        journalContent
          .split("\n")
          .filter(Boolean)
          .map(l => `<div class="journal-line">${l.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>").replace(/`(.+?)`/g,"<code>$1</code>")}</div>`)
          .join("")
      }</div>`
    : "";
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
  .section-title { color: #58a6ff; font-size: 1.1rem; margin: 1.5rem 0 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid #30363d; }
  .journal { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; margin-bottom: 2rem; font-size: 0.85rem; line-height: 1.6; max-height: 300px; overflow-y: auto; }
  .journal-line { padding: 0.15rem 0; border-bottom: 1px solid #21262d; }
  .journal-line:last-child { border-bottom: none; }
  .journal code { background: #161b22; padding: 0.1rem 0.3rem; border-radius: 4px; font-size: 0.8rem; }
</style>
</head>
<body>
<h1>Voltron Progress Dashboard</h1>
<div class="updated">Last updated: ${progress.updated_at || "never"} (auto-refreshes every 5s)</div>
${journalHtml}
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

// Regenerate the HTML dashboard. Returns the file path on success, null if no
// progress data exists. Browser opening is handled by the scrum-master agent
// via Chrome MCP tools — this function only writes the file.
async function regenerateDashboard() {
  const projectRoot = detectProjectRoot(undefined).root;
  const progressFile = path.join(projectRoot, ".voltron", "progress.json");
  const outFile = path.join(projectRoot, ".voltron", "dashboard.html");
  try {
    const progress = JSON.parse(await fs.readFile(progressFile, "utf-8"));
    const dateStr = new Date().toISOString().slice(0, 10);
    let journalContent = null;
    try { journalContent = await fs.readFile(path.join(projectRoot, ".voltron", "journal", `${dateStr}.md`), "utf-8"); } catch { /* no journal yet */ }
    await fs.writeFile(outFile, buildDashboardHtml(progress, journalContent));
    return outFile;
  } catch {
    return null;
  }
}

function dashboardUrl(filePath) {
  return filePath ? pathToFileURL(filePath).href : null;
}

// ─── Tool: generate_dashboard ──────────────────────────────────────────────

server.tool(
  "generate_dashboard",
  "Generate a standalone HTML dashboard from progress data.",
  {
    output_path: z.string().optional().describe("Output file path (default: .voltron/dashboard.html)"),
  },
  async ({ output_path }) => {
    const projectRoot = detectProjectRoot(undefined).root;
    const progressFile = path.join(projectRoot, ".voltron", "progress.json");
    const outFile = output_path || path.join(projectRoot, ".voltron", "dashboard.html");

    let progress;
    try {
      progress = JSON.parse(await fs.readFile(progressFile, "utf-8"));
    } catch {
      return { content: [{ type: "text", text: "No progress data found. Use update_progress first." }] };
    }

    await fs.mkdir(path.dirname(outFile), { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    let journalContent = null;
    try { journalContent = await fs.readFile(path.join(projectRoot, ".voltron", "journal", `${dateStr}.md`), "utf-8"); } catch { /* no journal yet */ }
    await fs.writeFile(outFile, buildDashboardHtml(progress, journalContent));

    const fileUrl = dashboardUrl(outFile);
    return {
      content: [{ type: "text", text: `Dashboard generated at ${outFile}\nDashboard: ${fileUrl}\nAuto-refreshes every 5 seconds. Open in Chrome or any browser to monitor agent progress live.` }],
    };
  }
);

// ─── Tool: setup_voltron ───────────────────────────────────────────────────

server.tool(
  "setup_voltron",
  "Verify and repair Project Voltron installation. Updates the global Claude Code allowlist with recommended permissions, confirms MCP registration, and reports Docker availability. Safe to call multiple times.",
  {
    dry_run: z.boolean().optional().describe("If true, report what would change without writing anything (default: false)"),
  },
  async ({ dry_run = false }) => {
    const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
    const settingsPath = path.join(homeDir, ".claude", "settings.json");
    const claudeJsonPath = path.join(homeDir, ".claude.json");

    // Read ~/.claude/settings.json (permissions only)
    let settings = {};
    try {
      settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    } catch { /* file doesn't exist yet */ }

    // Read ~/.claude.json (MCP server registrations)
    let claudeJson = {};
    try {
      claudeJson = JSON.parse(await fs.readFile(claudeJsonPath, "utf-8"));
    } catch { /* file doesn't exist yet */ }

    const currentAllow = settings?.permissions?.allow ?? [];
    const currentDeny = settings?.permissions?.deny ?? [];

    const missingAllow = VOLTRON_ALLOW.filter(e => !currentAllow.includes(e));
    const missingDeny = VOLTRON_DENY.filter(e => !currentDeny.includes(e));

    // Check MCP registration in ~/.claude.json (the correct file)
    const mcpRegistered = !!claudeJson?.mcpServers?.["project-voltron"];
    let mcpStatus = "";
    if (!mcpRegistered && !dry_run) {
      if (!claudeJson.mcpServers) claudeJson.mcpServers = {};
      claudeJson.mcpServers["project-voltron"] = {
        type: "stdio",
        command: "node",
        args: [__filename],
        env: {},
      };
      await fs.writeFile(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
      mcpStatus = "✓ Registered in ~/.claude.json (restart Claude Code to activate)";
    } else if (mcpRegistered) {
      mcpStatus = "✓ Registered in ~/.claude.json";
    } else {
      mcpStatus = "⚠ Not registered (run without dry_run to add)";
    }

    // Clean up stale mcpServers from settings.json (wrong file — written by v2.9.2)
    if (!dry_run && settings.mcpServers) {
      delete settings.mcpServers;
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    }

    // Check Docker (CLI + daemon)
    const dockerCheckErr = await checkDockerAvailable();
    const dockerStatus = dockerCheckErr === null ? "available"
      : dockerCheckErr.startsWith("Docker CLI") ? "not found"
      : "daemon not running";

    // Claude Code version check
    const claudeVer = getClaudeVersion();
    const versionOk = claudeVer.parsed ? meetsMinVersion(claudeVer.parsed, CLAUDE_MIN_VERSION) : false;
    const versionStatus = claudeVer.raw
      ? versionOk
        ? `✓ ${claudeVer.raw}`
        : `⚠ ${claudeVer.raw} — update recommended (minimum: ${CLAUDE_MIN_VERSION.major}.${CLAUDE_MIN_VERSION.minor}.${CLAUDE_MIN_VERSION.patch} for agent support)`
      : "⚠ Could not determine version (is claude in PATH?)";

    // Apply permissions changes to settings.json (unless dry_run)
    if (!dry_run && (missingAllow.length > 0 || missingDeny.length > 0)) {
      if (!settings.permissions) settings.permissions = {};
      if (!settings.permissions.allow) settings.permissions.allow = [];
      if (!settings.permissions.deny) settings.permissions.deny = [];
      settings.permissions.allow.push(...missingAllow);
      settings.permissions.deny.push(...missingDeny);
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    }

    // Check Trello MCP registration — also goes in ~/.claude.json
    const trelloRegistered = !!claudeJson?.mcpServers?.["trello"];
    let trelloStatus = "";
    if (!trelloRegistered && !dry_run) {
      // Add Trello MCP config stub to ~/.claude.json
      if (!claudeJson.mcpServers) claudeJson.mcpServers = {};
      claudeJson.mcpServers["trello"] = {
        type: "stdio",
        command: "npx",
        args: ["-y", "@delorenj/mcp-server-trello"],
        env: {
          TRELLO_API_KEY: "${TRELLO_API_KEY}",
          TRELLO_TOKEN: "${TRELLO_TOKEN}",
        },
      };
      await fs.writeFile(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
      trelloStatus = "✓ Registered in ~/.claude.json (set TRELLO_API_KEY and TRELLO_TOKEN in your environment to activate)";
    } else if (trelloRegistered) {
      const hasKey = !!process.env.TRELLO_API_KEY;
      const hasTok = !!process.env.TRELLO_TOKEN;
      trelloStatus = hasKey && hasTok
        ? "✓ Registered + credentials found"
        : `✓ Registered — ${!hasKey ? "TRELLO_API_KEY " : ""}${!hasTok ? "TRELLO_TOKEN " : ""}missing from environment`;
    } else {
      trelloStatus = "⚠ Not registered (run without dry_run to add)";
    }


    // Check Stringer (optional — codebase baseline analysis)
    let stringerStatus = "";
    let stringerInstalled = false;
    try {
      execSync("stringer --version", { stdio: "ignore", timeout: 5000 });
      stringerInstalled = true;
    } catch { /* not installed */ }

    if (stringerInstalled) {
      const stringerRegistered = !!claudeJson?.mcpServers?.["stringer"];
      if (!stringerRegistered && !dry_run) {
        if (!claudeJson.mcpServers) claudeJson.mcpServers = {};
        claudeJson.mcpServers["stringer"] = {
          type: "stdio",
          command: "stringer",
          args: ["mcp", "serve"],
          env: {},
        };
        await fs.writeFile(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
        stringerStatus = "✓ Installed + MCP registered (restart Claude Code to activate)";
      } else if (stringerRegistered) {
        stringerStatus = "✓ Installed + MCP registered";
      } else {
        stringerStatus = "✓ Installed (run without dry_run to register MCP)";
      }

      // Check for baseline in project root
      const projectRoot = detectProjectRoot(undefined).root;
      const baselinePath = path.join(projectRoot, ".voltron", "stringer", "baseline.json");
      const lastScanPath = path.join(projectRoot, ".voltron", "stringer", "last-scan.json");
      const hasBaseline = existsSync(baselinePath);
      const hasLastScan = existsSync(lastScanPath);

      if (!hasBaseline) {
        stringerStatus += " — no baseline yet (run @agent-stringer-baseline-builder to create one)";
      } else if (hasLastScan) {
        try {
          const lastScan = JSON.parse(await fs.readFile(lastScanPath, "utf-8"));
          const ageDays = Math.floor((Date.now() - new Date(lastScan.timestamp)) / 86400000);
          stringerStatus += ` — baseline ${ageDays}d old${ageDays > 14 ? " ⚠ stale — run @agent-stringer-baseline-builder to refresh" : ""}`;
        } catch { /* non-fatal */ }
      }
    } else {
      stringerStatus = "not installed (optional) — install stringer for codebase baseline analysis";
    }


    // Check APM (Agent Package Manager — optional, enhances install experience)
    let apmStatus = "";
    try {
      execSync("apm --version", { stdio: "ignore", timeout: 5000 });
      apmStatus = "✓ Installed — `apm install 7ports/project-voltron` reinstalls all agents + MCP";
    } catch {
      apmStatus = "not installed (optional) — `pip install apm-cli` for one-command agent deployment";
    }

    // Build report
    const allowStatus = missingAllow.length === 0
      ? `✓ All ${VOLTRON_ALLOW.length} entries present`
      : dry_run
        ? `⚠ ${missingAllow.length} entries missing (run without dry_run to add them)`
        : `✓ Added ${missingAllow.length} missing entries`;

    const denyStatus = missingDeny.length === 0
      ? `✓ All ${VOLTRON_DENY.length} safety rules present`
      : dry_run
        ? `⚠ ${missingDeny.length} rules missing`
        : `✓ Added ${missingDeny.length} missing rules`;

    const report = [
      "## Project Voltron Health Check",
      "",
      `- **MCP Server:** ${mcpStatus}`,
      `- **Allowlist:** ${allowStatus}`,
      `- **Deny rules:** ${denyStatus}`,
      `- **Trello MCP:** ${trelloStatus}`,
      `- **Stringer:** ${stringerStatus}`,
      `- **APM:** ${apmStatus}`,
      `- **Docker:** ${dockerStatus === "available" ? "✓ available (daemon running)" : dockerStatus === "daemon not running" ? "⚠ Docker installed but daemon not running — start Docker Desktop" : "⚠ Docker not found — install Docker Desktop"}`,
      `- **Claude Code:** ${versionStatus}`,
      "",
      dry_run
        ? "_Dry run — no changes were made. Call again without dry_run to apply fixes._"
        : missingAllow.length === 0 && missingDeny.length === 0
          ? "_Nothing to update — installation is fully configured._"
          : "**Allowlist updated.** Restart Claude Code to apply the new permissions.",
    ].join("\n");

    return { content: [{ type: "text", text: report }] };
  }
);

// ─── Tool: run_agent_in_docker ─────────────────────────────────────────────

server.tool(
  "run_agent_in_docker",
  "Launch a specialist agent inside a Docker container with --dangerously-skip-permissions for fully autonomous execution. The scrum-master calls this instead of the Agent tool to run specialists.",
  {
    agent_name: z
      .string()
      .describe(
        "The agent template name (e.g., 'fullstack-dev', 'csharp-dev', 'qa-tester')"
      ),
    task: z
      .string()
      .describe(
        "Complete task description including context, relevant file paths, acceptance criteria, and any outputs from prior tasks"
      ),
    max_turns: z
      .number()
      .optional()
      .describe("Maximum agent turns (default: 30)"),
  },
  async ({ agent_name, task, max_turns = 30 }) => {
    const { root: cwd } = detectProjectRoot(undefined);

    // 1. Look up the template
    const template = TEMPLATES[agent_name];
    if (!template || template.category !== "agent") {
      return {
        content: [
          {
            type: "text",
            text: `Error: Unknown agent '${agent_name}'. Run list_templates to see available agents.`,
          },
        ],
      };
    }

    // Scrum-master must run in the main Claude Code session, not in Docker
    if (agent_name === "scrum-master") {
      return {
        content: [{
          type: "text",
          text: "❌ The scrum-master is a dedicated orchestrator that runs in the main Claude Code session, not in Docker. Invoke it via @agent-scrum-master from the Claude Code chat window instead.",
        }],
      };
    }

    // 2. Read CLAUDE.md for project context
    let claudeMd = "";
    try {
      claudeMd = await fs.readFile(path.join(cwd, "CLAUDE.md"), "utf-8");
    } catch {
      // No CLAUDE.md — proceed without project context
    }

    // 3. Compose the full prompt
    // Strip YAML frontmatter from the template — it's for Claude Code's agent
    // discovery system (name, description, tools), not runtime instructions.
    // Including it causes claude CLI to interpret the prompt as an agent
    // definition file rather than a plain prompt, failing with a parse error.
    const agentInstructions = template.content.replace(/^---\n[\s\S]*?\n---\n*/, "");

    const prompt = [
      agentInstructions,
      "",
      "## Project Context (from CLAUDE.md)",
      "",
      claudeMd || "(No CLAUDE.md found — work without project context)",
      "",
      "## Your Task",
      "",
      task,
    ].join("\n");

    // 4. Write prompt to temp file (avoids shell escaping issues)
    const tmpFile = path.join(
      os.tmpdir(),
      `voltron-${agent_name}-${Date.now()}.md`
    );
    await fs.writeFile(tmpFile, prompt);

    // 5. Check Docker CLI + daemon are both available
    const dockerErr = await checkDockerAvailable();
    if (dockerErr) {
      await fs.unlink(tmpFile).catch(() => {});
      return { content: [{ type: "text", text: `Error: ${dockerErr}` }] };
    }

    // 6. Check Dockerfile.voltron exists
    const dockerfilePath = path.join(cwd, "Dockerfile.voltron");
    try {
      await fs.access(dockerfilePath);
    } catch {
      await fs.unlink(tmpFile).catch(() => {});
      return {
        content: [
          {
            type: "text",
            text: "Error: Dockerfile.voltron not found in project root. Run scaffold_project first to generate it.",
          },
        ],
      };
    }

    // 7. Build image — async spawn so parallel agent invocations don't block each other
    try {
      await new Promise((resolve, reject) => {
        let buildStderr = "";
        const buildProc = spawn(
          "docker",
          ["build", "-t", "voltron-agent", "-f", dockerfilePath, cwd],
          { stdio: ["ignore", "ignore", "pipe"], cwd }
        );
        buildProc.stderr?.on("data", (chunk) => { buildStderr += chunk.toString(); });
        const timer = setTimeout(() => {
          buildProc.kill();
          reject(Object.assign(new Error("Docker build timed out"), { stderr: buildStderr }));
        }, 120000);
        buildProc.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) reject(Object.assign(new Error("Build failed"), { stderr: buildStderr }));
          else resolve();
        });
        buildProc.on("error", (err) => { clearTimeout(timer); reject(err); });
      });
    } catch (err) {
      await fs.unlink(tmpFile).catch(() => {});
      const buildStderr = err.stderr ? `\n\nBuild output:\n${err.stderr.trim().slice(-2000)}` : "";
      return {
        content: [
          {
            type: "text",
            text: `Error: Docker image build failed.${buildStderr}`,
          },
        ],
      };
    }

    // 8. Regenerate dashboard to show this agent as active
    await regenerateDashboard();

    // 9. Set up log infrastructure — each run gets a named container + a live log file
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeAgentName = agent_name.replace(/[^a-z0-9]/g, '-');
    const containerName = `voltron-${safeAgentName}-${ts}`;
    const logFilename = `${safeAgentName}-${ts}.log`;
    const logsDir = path.join(cwd, ".voltron", "logs");
    await fs.mkdir(logsDir, { recursive: true });

    // 10. Run agent in Docker
    // Use spawnSync with an explicit args array — avoids host-shell quoting issues
    // on Windows where execSync uses cmd.exe (which doesn't understand single quotes),
    // causing the -c argument to be mangled before reaching Docker.
    const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();

    // Conditionally mount ~/.gitconfig so git commits work inside Docker
    const gitConfigPath = path.join(homeDir, ".gitconfig");
    let gitConfigMount = [];
    try {
      await fs.access(gitConfigPath);
      gitConfigMount = ["-v", `${gitConfigPath}:/home/voltron/.gitconfig:ro`];
    } catch {
      // No ~/.gitconfig — agents must set git identity manually if they need to commit
    }

    // Pass through Claude auth env vars so the agent inside Docker can authenticate
    const authEnvArgs = [];
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      authEnvArgs.push("-e", `CLAUDE_CODE_OAUTH_TOKEN=${process.env.CLAUDE_CODE_OAUTH_TOKEN}`);
    }
    if (process.env.ANTHROPIC_API_KEY) {
      authEnvArgs.push("-e", `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
    }

    // Named container enables `docker logs <name> -f` from a second terminal while running.
    // tee writes a live log to .voltron/logs/ on the host (mounted via /workspace).
    // PIPESTATUS[0] propagates claude's exit code through the pipe to Docker's exit code.
    const dockerArgs = [
      "run", "--rm",
      "--name", containerName,
      "--entrypoint", "bash",
      ...authEnvArgs,
      "-v", `${cwd}:/workspace`,
      "-v", `${homeDir}/.claude:/home/voltron/.claude`,
      "-v", `${homeDir}/.claude.json:/home/voltron/.claude.json:ro`,
      ...gitConfigMount,        // mount ~/.gitconfig if present so git commits work
      "-v", `${tmpFile}:/tmp/task.md:ro`,
      "voltron-agent",
      "-c",
      `claude --dangerously-skip-permissions --max-turns ${max_turns} -p "$(cat /tmp/task.md)" 2>&1 | tee /workspace/.voltron/logs/${logFilename}; exit \${PIPESTATUS[0]}`,
    ];

    // Async spawn — allows multiple agents to run in parallel Docker containers
    const result = await new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      const proc = spawn("docker", dockerArgs, { cwd });

      proc.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > 10 * 1024 * 1024) {
          proc.kill();
          resolve({ status: 1, stdout: stdout.slice(-10 * 1024 * 1024), stderr, error: new Error("Output exceeded 10MB limit") });
        }
      });
      proc.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

      const timer = setTimeout(() => {
        proc.kill();
        resolve({ status: 1, stdout, stderr, error: new Error("Timeout after 10 minutes") });
      }, 600000);

      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve({ status: code, stdout, stderr, error: null });
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({ status: 1, stdout, stderr, error: err });
      });
    });

    await fs.unlink(tmpFile).catch(() => {});
    const dashPath = await regenerateDashboard();
    const dashLine = dashboardUrl(dashPath) ? `\n\nDashboard: ${dashboardUrl(dashPath)}` : "";
    const logLine = `\n\nLog: \`.voltron/logs/${logFilename}\``;

    if (result.error || result.status !== 0) {
      return {
        content: [
          {
            type: "text",
            text: `## Agent ${agent_name} failed\n\n**Exit code:** ${result.status}\n\n**Output:**\n${result.stdout || ""}\n\n**Error:**\n${result.stderr || result.error?.message || "Unknown error"}${logLine}${dashLine}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `## Agent ${agent_name} completed\n\n${result.stdout}${logLine}${dashLine}`,
        },
      ],
    };
  }
);


server.tool(
  "start_agent_in_docker",
  "Launch a specialist agent in Docker and return immediately without waiting for it to finish. Returns container_name and log_path for use with get_agent_output to poll progress. Use this instead of run_agent_in_docker when you want real-time visibility or are running multiple agents in parallel.",
  {
    agent_name: z.string().describe("The agent template name (e.g., 'fullstack-dev', 'qa-tester')"),
    task: z.string().describe("Complete task description including context, file paths, acceptance criteria"),
    max_turns: z.number().optional().describe("Maximum agent turns (default: 30)"),
  },
  async ({ agent_name, task, max_turns = 30 }) => {
    const { root: cwd } = detectProjectRoot(undefined);

    // Guard: scrum-master must run in main session
    const template = TEMPLATES[agent_name];
    if (!template || template.category !== "agent") {
      return { content: [{ type: "text", text: `Error: Unknown agent '${agent_name}'. Run list_templates to see available agents.` }] };
    }
    if (agent_name === "scrum-master") {
      return { content: [{ type: "text", text: "\u274C The scrum-master is a dedicated orchestrator that runs in the main Claude Code session, not in Docker. Invoke it via @agent-scrum-master from the Claude Code chat window instead." }] };
    }

    // Read CLAUDE.md for project context
    let claudeMd = "";
    try { claudeMd = await fs.readFile(path.join(cwd, "CLAUDE.md"), "utf-8"); } catch { /* proceed without */ }

    // Compose prompt (strip YAML frontmatter — it's for agent discovery, not runtime)
    const agentInstructions = template.content.replace(/^---\n[\s\S]*?\n---\n*/, "");
    const prompt = [agentInstructions, "", "## Project Context (from CLAUDE.md)", "", claudeMd || "(No CLAUDE.md found)", "", "## Your Task", "", task].join("\n");

    // Write prompt to temp file
    const tmpFile = path.join(os.tmpdir(), `voltron-${agent_name}-${Date.now()}.md`);
    await fs.writeFile(tmpFile, prompt);

    // Check Docker CLI + daemon are both available
    const dockerErr2 = await checkDockerAvailable();
    if (dockerErr2) {
      await fs.unlink(tmpFile).catch(() => {});
      return { content: [{ type: "text", text: `Error: ${dockerErr2}` }] };
    }

    // Check Dockerfile.voltron exists
    const dockerfilePath = path.join(cwd, "Dockerfile.voltron");
    try { await fs.access(dockerfilePath); } catch {
      await fs.unlink(tmpFile).catch(() => {});
      return { content: [{ type: "text", text: "Error: Dockerfile.voltron not found. Run scaffold_project first." }] };
    }

    // Build image
    try {
      await new Promise((resolve, reject) => {
        let buildStderr = "";
        const buildProc = spawn("docker", ["build", "-t", "voltron-agent", "-f", dockerfilePath, cwd], { stdio: ["ignore", "ignore", "pipe"], cwd });
        buildProc.stderr?.on("data", (chunk) => { buildStderr += chunk.toString(); });
        const timer = setTimeout(() => { buildProc.kill(); reject(Object.assign(new Error("Docker build timed out"), { stderr: buildStderr })); }, 120000);
        buildProc.on("close", (code) => { clearTimeout(timer); if (code !== 0) reject(Object.assign(new Error("Build failed"), { stderr: buildStderr })); else resolve(); });
        buildProc.on("error", (err) => { clearTimeout(timer); reject(err); });
      });
    } catch (err) {
      await fs.unlink(tmpFile).catch(() => {});
      const buildStderr = err.stderr ? `\n\nBuild output:\n${err.stderr.trim().slice(-2000)}` : "";
      return { content: [{ type: "text", text: `Error: Docker image build failed.${buildStderr}` }] };
    }

    // Set up log infrastructure
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeAgentName = agent_name.replace(/[^a-z0-9]/g, '-');
    const containerName = `voltron-${safeAgentName}-${ts}`;
    const logFilename = `${safeAgentName}-${ts}.log`;
    const logsDir = path.join(cwd, ".voltron", "logs");
    await fs.mkdir(logsDir, { recursive: true });
    const logPath = path.join(logsDir, logFilename);
    // Create empty log file so get_agent_output can read it immediately
    await fs.writeFile(logPath, "");

    // Mount auth and gitconfig
    const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
    const gitConfigPath = path.join(homeDir, ".gitconfig");
    let gitConfigMount = [];
    try { await fs.access(gitConfigPath); gitConfigMount = ["-v", `${gitConfigPath}:/home/voltron/.gitconfig:ro`]; } catch { /* no gitconfig */ }
    const authEnvArgs = [];
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) authEnvArgs.push("-e", `CLAUDE_CODE_OAUTH_TOKEN=${process.env.CLAUDE_CODE_OAUTH_TOKEN}`);
    if (process.env.ANTHROPIC_API_KEY) authEnvArgs.push("-e", `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);

    const dockerArgs = [
      "run", "--rm",
      "--name", containerName,
      "--entrypoint", "bash",
      ...authEnvArgs,
      "-v", `${cwd}:/workspace`,
      "-v", `${homeDir}/.claude:/home/voltron/.claude`,
      "-v", `${homeDir}/.claude.json:/home/voltron/.claude.json:ro`,
      ...gitConfigMount,
      "-v", `${tmpFile}:/tmp/task.md:ro`,
      "voltron-agent",
      "-c",
      // Write exit code to .exit file so get_agent_output can detect completion
      `claude --dangerously-skip-permissions --max-turns ${max_turns} -p "$(cat /tmp/task.md)" 2>&1 | tee /workspace/.voltron/logs/${logFilename}; echo "\${PIPESTATUS[0]}" > /workspace/.voltron/logs/${logFilename}.exit; exit \${PIPESTATUS[0]}`,
    ];

    // Detached spawn — returns immediately, container runs in background
    const proc = spawn("docker", dockerArgs, { cwd, detached: true, stdio: "ignore" });
    proc.unref(); // Don't wait for it — Node.js can exit independently

    // Clean up temp file after a short delay (container has mounted it by now)
    setTimeout(() => fs.unlink(tmpFile).catch(() => {}), 5000);

    await regenerateDashboard();

    return {
      content: [{
        type: "text",
        text: [
          `## Agent ${agent_name} started`,
          ``,
          `**Container:** \`${containerName}\``,
          `**Log:** \`${logPath}\``,
          ``,
          `The agent is now running in the background. Use \`get_agent_output\` to poll for progress:`,
          `\`\`\``,
          `get_agent_output({ container_name: "${containerName}", log_path: "${logPath}" })`,
          `\`\`\``,
          ``,
          `You can also tail the log in a terminal: \`tail -f "${logPath}"\``,
        ].join("\n"),
      }],
    };
  }
);

server.tool(
  "get_agent_output",
  "Poll a running agent container for its latest output. Returns the last N lines of the agent's log and whether it is still running. Call this repeatedly to show real-time progress in the chat window.",
  {
    container_name: z.string().describe("Container name returned by start_agent_in_docker"),
    log_path: z.string().describe("Absolute log file path returned by start_agent_in_docker"),
    tail_lines: z.number().optional().describe("Number of log lines to return (default: 40)"),
  },
  async ({ container_name, log_path, tail_lines = 40 }) => {
    // Check if container is still running
    let isRunning = false;
    try {
      const psOutput = execSync(
        `docker ps --filter "name=^/${container_name}$" --format "{{.Names}}"`,
        { encoding: "utf-8", stdio: "pipe" }
      ).trim();
      isRunning = psOutput.split("\n").some(name => name.trim() === container_name);
    } catch { isRunning = false; }

    // Read exit code file (written by container on completion)
    const exitCodePath = log_path + ".exit";
    let exitCode = null;
    try {
      const exitStr = await fs.readFile(exitCodePath, "utf-8");
      exitCode = parseInt(exitStr.trim(), 10);
    } catch { /* not written yet */ }

    // Read log file
    let logContent = "";
    try { logContent = await fs.readFile(log_path, "utf-8"); } catch { logContent = "(log file not yet available)"; }
    const allLines = logContent.split("\n").filter(line => line.length > 0);
    const totalLines = allLines.length;
    const tailLines = allLines.slice(-tail_lines).join("\n");

    // Determine status
    let status;
    if (isRunning) {
      status = "running";
    } else if (exitCode === 0) {
      status = "completed";
    } else if (exitCode !== null) {
      status = "failed";
    } else {
      // Container stopped but .exit not written yet — transient state
      status = "unknown (container stopped, exit code pending — retry in a moment)";
    }

    return {
      content: [{
        type: "text",
        text: [
          `## Agent output — \`${container_name}\``,
          ``,
          `**Status:** ${status}${exitCode !== null ? `  |  **Exit code:** ${exitCode}` : ""}`,
          `**Lines so far:** ${totalLines}  |  **Showing last ${Math.min(tail_lines, totalLines)}**`,
          ``,
          `\`\`\``,
          tailLines || "(no output yet)",
          `\`\`\``,
          status === "running" ? `\nCall \`get_agent_output\` again to see newer output.` : `\nAgent has finished. Review the output above.`,
        ].join("\n"),
      }],
    };
  }
);

// ─── Start server ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
