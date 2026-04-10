#!/usr/bin/env node
// auto-update-agents.js
// Run as a Claude Code UserPromptSubmit hook to keep Voltron agents and
// infrastructure files current.
// Usage: node /path/to/project-voltron/scripts/auto-update-agents.js
// The hook runs from the project directory (cwd = project root).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  TEMPLATES,
  AGENT_NAMES,
  DOCKERFILE_CONTENT,
  VOLTRON_RUN_SCRIPT,
  VOLTRON_ALLOW,
  VOLTRON_DENY,
  voltronGitignoreBlock,
} from "../src/templates.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const voltronRoot = resolve(__dirname, "..");

// Read current Voltron version
const pkg = JSON.parse(readFileSync(join(voltronRoot, "package.json"), "utf-8"));
const currentVersion = pkg.version;

// Project root = cwd (Claude Code hooks run from project root)
const projectRoot = process.cwd();
const agentsDir = resolve(projectRoot, ".claude", "agents");
const scrumMasterPath = resolve(agentsDir, "scrum-master.md");

// Exit silently if this project doesn't have Voltron agents
if (!existsSync(scrumMasterPath)) {
  process.exit(0);
}

// Read installed version from scrum-master.md
const installedContent = readFileSync(scrumMasterPath, "utf-8");
const versionMatch = installedContent.match(/\*\*Version:\*\*\s+([\d.]+)/);
const installedVersion = versionMatch ? versionMatch[1] : null;

const needsUpdate = installedVersion !== currentVersion;

let updated = 0;
const updatedItems = [];

// ── Update agent files (only when version changed) ───────────────────────────
if (needsUpdate) {
  for (const agentKey of AGENT_NAMES) {
    const template = TEMPLATES[agentKey];
    if (!template) continue;

    const agentFilename = template.destination.split("/").pop();
    const agentPath = resolve(agentsDir, agentFilename);

    if (existsSync(agentPath)) {
      const existing = readFileSync(agentPath, "utf-8");
      if (existing !== template.content) {
        writeFileSync(agentPath, template.content, "utf-8");
        updated++;
        updatedItems.push(agentKey);
      }
    }
  }

  // Dockerfile.voltron — only update if it already exists (project uses Docker)
  const dockerfilePath = resolve(projectRoot, "Dockerfile.voltron");
  if (existsSync(dockerfilePath)) {
    const existing = readFileSync(dockerfilePath, "utf-8");
    if (existing !== DOCKERFILE_CONTENT) {
      writeFileSync(dockerfilePath, DOCKERFILE_CONTENT, "utf-8");
      updated++;
      updatedItems.push("Dockerfile.voltron");
    }
  }

  // scripts/voltron-run.sh — only update if it already exists
  const runScriptPath = resolve(projectRoot, "scripts", "voltron-run.sh");
  if (existsSync(runScriptPath)) {
    const existing = readFileSync(runScriptPath, "utf-8");
    if (existing !== VOLTRON_RUN_SCRIPT) {
      writeFileSync(runScriptPath, VOLTRON_RUN_SCRIPT, "utf-8");
      updated++;
      updatedItems.push("voltron-run.sh");
    }
  }

  // Check for missing Voltron npm dependencies and install if needed
  try {
    const deps = Object.keys(pkg.dependencies || {});
    const missingDeps = deps.filter(
      (dep) => !existsSync(join(voltronRoot, "node_modules", dep))
    );
    if (missingDeps.length > 0) {
      execSync(`npm install --prefix "${voltronRoot}" --silent`, { stdio: "ignore" });
      updated++;
      updatedItems.push(`npm install (${missingDeps.join(", ")})`);
    }
  } catch {
    // Non-fatal — user can run npm install manually if needed
  }
}

// ── Update .gitignore — add Voltron block if missing (always check) ──────────
const gitignorePath = resolve(projectRoot, ".gitignore");
try {
  const block = voltronGitignoreBlock();
  let gitignoreContent = "";
  if (existsSync(gitignorePath)) {
    gitignoreContent = readFileSync(gitignorePath, "utf-8");
  }
  if (!gitignoreContent.includes("# ── Voltron managed")) {
    const separator = gitignoreContent.length > 0 && !gitignoreContent.endsWith("\n") ? "\n\n" : (gitignoreContent.length > 0 ? "\n" : "");
    writeFileSync(gitignorePath, gitignoreContent + separator + block, "utf-8");
    // Stage it so it's not left as an untracked change
    try { execSync("git add .gitignore", { cwd: projectRoot, stdio: "ignore" }); } catch { /* not a git repo, non-fatal */ }
    updated++;
    updatedItems.push(".gitignore");
  }
} catch {
  // Non-fatal
}

// ── Update .mcp.json — ensure project-voltron is registered (always check) ───
const mcpJsonPath = resolve(projectRoot, ".mcp.json");
try {
  let mcpJson = {};
  if (existsSync(mcpJsonPath)) {
    mcpJson = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
  }
  if (!mcpJson.mcpServers) mcpJson.mcpServers = {};
  if (!mcpJson.mcpServers["project-voltron"]) {
    const voltronIndexPath = resolve(voltronRoot, "src", "index.js");
    mcpJson.mcpServers["project-voltron"] = {
      type: "stdio",
      command: "node",
      args: [voltronIndexPath],
    };
    writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + "\n", "utf-8");
    updated++;
    updatedItems.push(".mcp.json");
  }
} catch {
  // Non-fatal — .mcp.json update is best-effort
}

// ── Merge global ~/.claude/settings.json permissions ─────────────────────────
try {
  const globalSettingsPath = join(homedir(), ".claude", "settings.json");
  let globalSettings = {};
  if (existsSync(globalSettingsPath)) {
    globalSettings = JSON.parse(readFileSync(globalSettingsPath, "utf-8"));
  }

  let settingsDirty = false;

  // Permissions
  const currentAllow = globalSettings?.permissions?.allow ?? [];
  const currentDeny = globalSettings?.permissions?.deny ?? [];
  const missingAllow = VOLTRON_ALLOW.filter((e) => !currentAllow.includes(e));
  const missingDeny = VOLTRON_DENY.filter((e) => !currentDeny.includes(e));
  if (missingAllow.length > 0 || missingDeny.length > 0) {
    if (!globalSettings.permissions) globalSettings.permissions = {};
    if (!globalSettings.permissions.allow) globalSettings.permissions.allow = [];
    if (!globalSettings.permissions.deny) globalSettings.permissions.deny = [];
    globalSettings.permissions.allow.push(...missingAllow);
    globalSettings.permissions.deny.push(...missingDeny);
    settingsDirty = true;
  }

  // Clean up stale mcpServers key (written incorrectly by v2.9.2 — wrong file)
  if (globalSettings.mcpServers) {
    delete globalSettings.mcpServers;
    settingsDirty = true;
  }

  if (settingsDirty) {
    mkdirSync(dirname(globalSettingsPath), { recursive: true });
    writeFileSync(globalSettingsPath, JSON.stringify(globalSettings, null, 2), "utf-8");
    updated++;
    updatedItems.push("~/.claude/settings.json");
  }
} catch {
  // Non-fatal — global settings update is best-effort
}

// ── Register project-voltron in ~/.claude.json (the correct MCP config file) ─
try {
  const claudeJsonPath = join(homedir(), ".claude.json");
  let claudeJson = {};
  if (existsSync(claudeJsonPath)) {
    claudeJson = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
  }

  const voltronIndexPath = resolve(voltronRoot, "src", "index.js");
  if (!claudeJson?.mcpServers?.["project-voltron"]) {
    if (!claudeJson.mcpServers) claudeJson.mcpServers = {};
    claudeJson.mcpServers["project-voltron"] = {
      type: "stdio",
      command: "node",
      args: [voltronIndexPath],
      env: {},
    };
    writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2), "utf-8");
    updated++;
    updatedItems.push("~/.claude.json");
  }
} catch {
  // Non-fatal — ~/.claude.json update is best-effort
}

// ── Report ────────────────────────────────────────────────────────────────────
if (updated > 0) {
  const from = installedVersion ? `v${installedVersion}` : "unknown version";
  const versionNote = needsUpdate ? ` from ${from} → v${currentVersion}` : "";
  console.log(
    `[VOLTRON] Auto-updated ${updated} file(s)${versionNote}: ${updatedItems.join(", ")}`
  );
} else {
  process.exit(0);
}
