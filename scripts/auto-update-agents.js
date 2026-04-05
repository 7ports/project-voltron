#!/usr/bin/env node
// auto-update-agents.js
// Run as a Claude Code UserPromptSubmit hook to keep Voltron agents current.
// Usage: node /path/to/project-voltron/scripts/auto-update-agents.js
// The hook runs from the project directory (cwd = project root).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TEMPLATES, AGENT_NAMES } from "../src/templates.js";

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

// Update all installed agent files
let updated = 0;
const updatedAgents = [];

for (const agentKey of AGENT_NAMES) {
  const template = TEMPLATES[agentKey];
  if (!template) continue;

  // Destination filename is the last segment of template.destination
  const agentFilename = template.destination.split("/").pop();
  const agentPath = resolve(agentsDir, agentFilename);

  if (existsSync(agentPath)) {
    writeFileSync(agentPath, template.content, "utf-8");
    updated++;
    updatedAgents.push(agentKey);
  }
}

if (updated > 0) {
  const from = installedVersion ? `v${installedVersion}` : "unknown version";
  console.log(
    `[VOLTRON] Auto-updated ${updated} agent(s) from ${from} → v${currentVersion}: ${updatedAgents.join(", ")}`
  );
} else {
  // Agents dir exists but no agent files matched — nothing to do
  process.exit(0);
}
