#!/usr/bin/env node
/**
 * build-apm-manifest.js
 *
 * Generates .apm/agents/<key>.agent.md for every agent template in
 * src/templates.js and syncs the `version` field in apm.yml to match
 * package.json.
 *
 * Run: node scripts/build-apm-manifest.js
 * Or:  npm run build:apm
 *
 * This script MUST be run after every version bump so the APM package
 * stays in sync with the installed templates. The harness-engineer
 * template includes this as a required step in its Direct Modification
 * Mode workflow.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, join } from "path";
import { fileURLToPath } from "url";
import { TEMPLATES } from "../src/templates.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── 1. Read version from package.json ──────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const version = pkg.version;

// ── 2. Generate .apm/agents/<key>.agent.md ─────────────────────────────────────

const apmAgentsDir = join(ROOT, ".apm", "agents");
mkdirSync(apmAgentsDir, { recursive: true });

let count = 0;
for (const [key, tpl] of Object.entries(TEMPLATES)) {
  if (tpl.category !== "agent") continue;
  const filePath = join(apmAgentsDir, `${key}.agent.md`);
  writeFileSync(filePath, tpl.content, "utf-8");
  count++;
}
console.log(`.apm/agents/: ${count} agent files written`);

// ── 3. Sync version in apm.yml ─────────────────────────────────────────────────

const apmYmlPath = join(ROOT, "apm.yml");
let apmYml = readFileSync(apmYmlPath, "utf-8");
const before = apmYml;
apmYml = apmYml.replace(/^version: .+$/m, `version: ${version}`);
if (apmYml !== before) {
  writeFileSync(apmYmlPath, apmYml, "utf-8");
  console.log(`apm.yml: version synced to ${version}`);
} else {
  console.log(`apm.yml: version already ${version}`);
}

console.log(`SUCCESS: build:apm complete — ${count} agents, v${version}`);
