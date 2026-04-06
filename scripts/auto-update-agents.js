#!/usr/bin/env node
// auto-update-agents.js
// Run as a Claude Code UserPromptSubmit hook to keep Voltron agents and
// infrastructure files current.
// Usage: node /path/to/project-voltron/scripts/auto-update-agents.js
// The hook runs from the project directory (cwd = project root).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TEMPLATES,
  AGENT_NAMES,
  DOCKERFILE_CONTENT,
  VOLTRON_RUN_SCRIPT,
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

// Exit silently if already up to date
if (installedVersion === currentVersion) {
  process.exit(0);
}

// ── Update agent files ────────────────────────────────────────────────────────
let updated = 0;
const updatedItems = [];

for (const agentKey of AGENT_NAMES) {
  const template = TEMPLATES[agentKey];
  if (!template) continue;

  const agentFilename = template.destination.split("/").pop();
  const agentPath = resolve(agentsDir, agentFilename);

  if (existsSync(agentPath)) {
    writeFileSync(agentPath, template.content, "utf-8");
    updated++;
    updatedItems.push(agentKey);
  }
}

// ── Update infrastructure files ───────────────────────────────────────────────

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

// ── Report ────────────────────────────────────────────────────────────────────
if (updated > 0) {
  const from = installedVersion ? `v${installedVersion}` : "unknown version";
  console.log(
    `[VOLTRON] Auto-updated ${updated} file(s) from ${from} → v${currentVersion}: ${updatedItems.join(", ")}`
  );
} else {
  process.exit(0);
}
