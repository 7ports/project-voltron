#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const voltronRoot = join(__dirname, '..');
const mainScriptAbsolutePath = join(voltronRoot, 'src', 'index.js').replace(/\\/g, '/');
const claudeDir = join(os.homedir(), '.claude');
const settingsPath = join(claudeDir, 'settings.json');

// ─── Step 1: Install npm dependencies ────────────────────────────────────────
// Skip if we're already inside an npm lifecycle to prevent recursion
const lifecycle = process.env.npm_lifecycle_event;
const mcpDir = join(voltronRoot, 'node_modules', '@modelcontextprotocol');

if (lifecycle === 'install' || lifecycle === 'postinstall') {
  console.log('  ✓ Skipping npm install (already in npm lifecycle)');
} else if (existsSync(mcpDir)) {
  console.log('  ✓ npm dependencies already installed');
} else {
  console.log('  Installing npm dependencies...');
  const r = spawnSync('npm', ['install'], { cwd: voltronRoot, stdio: 'inherit' });
  if (r.status === 0) {
    console.log('  ✓ npm dependencies installed');
  } else {
    console.log('  ⚠ npm install failed (exit ' + r.status + ')');
  }
}

// ─── Step 2: Register MCP server ─────────────────────────────────────────────
function readSettings() {
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    return {};
  }
}

// Check registration via `claude mcp list` — canonical source of truth regardless of
// which settings file Claude Code uses internally (settings.json vs .claude.json)
// On Windows, scripts like `claude` may need shell:true to execute .cmd wrappers.
// Also capture both stdout and stderr — claude mcp list mixes output between them.
function claudeCmd(args) {
  const opts = { encoding: 'utf-8', stdio: 'pipe', shell: process.platform === 'win32' };
  let r = spawnSync('claude', args, opts);
  if (r.error?.code === 'ENOENT' && !opts.shell) {
    r = spawnSync('claude.cmd', args, opts);
  }
  return r;
}

const listResult = claudeCmd(['mcp', 'list']);
const listOutput = (listResult.stdout || '') + (listResult.stderr || '');
const isRegistered = listOutput.includes('project-voltron');

if (isRegistered) {
  console.log('  ✓ MCP server already registered');
} else if (listResult.error?.code === 'ENOENT') {
  console.log('  ⚠ Could not auto-register (claude CLI not found). Run this manually:');
  console.log(`    claude mcp add --scope user project-voltron -- node "${mainScriptAbsolutePath}"`);
} else {
  const addResult = claudeCmd(['mcp', 'add', '--scope', 'user', 'project-voltron', '--', 'node', mainScriptAbsolutePath]);
  const errMsg = (addResult.stderr || '').trim();
  if (addResult.status === 0 || errMsg.toLowerCase().includes('already')) {
    console.log('  ✓ MCP server registered');
  } else {
    console.log('  ⚠ MCP registration failed. Run this manually:');
    console.log(`    claude mcp add --scope user project-voltron -- node "${mainScriptAbsolutePath}"`);
    if (errMsg) console.log('    Error: ' + errMsg);
  }
}

// ─── Step 3: Update global allowlist ─────────────────────────────────────────
const VOLTRON_ALLOW = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
  'Bash(git *)', 'Bash(gh *)', 'Bash(mkdir *)', 'Bash(ls *)', 'Bash(ls)',
  'Bash(cat *)', 'Bash(echo *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(wc *)',
  'Bash(sort *)', 'Bash(uniq *)', 'Bash(cut *)', 'Bash(tr *)', 'Bash(sed *)',
  'Bash(awk *)', 'Bash(grep *)', 'Bash(rg *)', 'Bash(find *)', 'Bash(which *)',
  'Bash(where *)', 'Bash(type *)', 'Bash(pwd)', 'Bash(cd *)', 'Bash(cp *)',
  'Bash(mv *)', 'Bash(touch *)', 'Bash(chmod *)', 'Bash(unzip *)', 'Bash(tar *)',
  'Bash(curl *)', 'Bash(wget *)', 'Bash(diff *)', 'Bash(patch *)', 'Bash(tee *)',
  'Bash(xargs *)', 'Bash(jq *)', 'Bash(node *)', 'Bash(npm *)', 'Bash(npx *)',
  'Bash(python *)', 'Bash(pip *)', 'Bash(env *)', 'Bash(export *)',
  'Bash(set *)', 'Bash(test *)', 'Bash([ *)', 'Bash(true)', 'Bash(false)',
  'Bash(date *)', 'Bash(date)', 'Bash(realpath *)', 'Bash(basename *)',
  'Bash(dirname *)', 'Bash(stat *)', 'Bash(file *)', 'Bash(du *)', 'Bash(df *)',
  'Bash(docker *)', 'Bash(docker-compose *)', 'Bash(openssl *)', 'Bash(eval *)',
  'Bash(sleep *)',
  'mcp__project-voltron__*', 'mcp__alexandria__*',
];

const VOLTRON_DENY = [
  'Bash(git push --force *)', 'Bash(git push -f *)', 'Bash(git reset --hard *)',
  'Bash(rm -rf *)', 'Bash(rm -r *)', 'Bash(rmdir *)',
];

let settings = readSettings();
if (!settings.permissions) settings.permissions = {};
if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
if (!Array.isArray(settings.permissions.deny)) settings.permissions.deny = [];

const existingAllow = new Set(settings.permissions.allow);
const existingDeny = new Set(settings.permissions.deny);

let addedAllow = 0;
let addedDeny = 0;

for (const entry of VOLTRON_ALLOW) {
  if (!existingAllow.has(entry)) {
    settings.permissions.allow.push(entry);
    addedAllow++;
  }
}
for (const entry of VOLTRON_DENY) {
  if (!existingDeny.has(entry)) {
    settings.permissions.deny.push(entry);
    addedDeny++;
  }
}

try {
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  console.log(`  ✓ Added ${addedAllow} new allowlist entries, ${addedDeny} deny rules`);
} catch (err) {
  console.log('  ⚠ Could not write settings.json: ' + err.message);
}

// ─── Step 4: Verify Docker ────────────────────────────────────────────────────
const dockerResult = spawnSync('docker', ['--version'], { encoding: 'utf-8', stdio: 'pipe' });
if (dockerResult.status === 0) {
  const version = (dockerResult.stdout || '').trim().replace(/^Docker version\s+/i, '').split(',')[0];
  console.log(`  ✓ Docker available: ${version}`);
} else {
  console.log('  ⚠ Docker not found. Install Docker Desktop: https://www.docker.com/products/docker-desktop');
  console.log('    Docker is required for autonomous agent execution.');
}

// ─── Step 5: Check Claude Code version ───────────────────────────────────────
{
  const CLAUDE_MIN = [1, 8, 0]; // [major, minor, patch]
  let verResult = spawnSync('claude', ['--version'], { encoding: 'utf-8', stdio: 'pipe', shell: process.platform === 'win32' });
  if (!verResult.stdout && process.platform === 'win32') {
    verResult = spawnSync('claude.cmd', ['--version'], { encoding: 'utf-8', stdio: 'pipe' });
  }
  const verStr = (verResult.stdout || '').trim();
  const m = verStr.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!verStr) {
    console.log('  ⚠ Could not detect Claude Code version. Ensure claude is in your PATH.');
  } else if (!m) {
    console.log('  ✓ Claude Code detected: ' + verStr);
  } else {
    const [, maj, min, pat] = m.map(Number);
    const [minMaj, minMin, minPat] = CLAUDE_MIN;
    const ok = maj > minMaj || (maj === minMaj && (min > minMin || (min === minMin && pat >= minPat)));
    if (ok) {
      console.log('  ✓ Claude Code: ' + verStr);
    } else {
      console.log('  ⚠ Claude Code ' + verStr + ' is below the recommended minimum (' + CLAUDE_MIN.join('.') + ').');
      console.log('    Update Claude Code: https://docs.anthropic.com/en/docs/claude-code/setup');
    }
  }
}

// ─── Step 6: Check beads CLI (optional) ──────────────────────────────────────
{
  const bdResult = spawnSync('bd', ['--version'], { encoding: 'utf-8', stdio: 'pipe', shell: process.platform === 'win32' });
  if (bdResult.status === 0) {
    const version = (bdResult.stdout || '').trim().split(/\s+/).slice(-1)[0] || 'unknown';
    console.log(`  ✓ beads (bd) ${version} — dependency-aware task tracking available`);
  } else {
    console.log('  ⚠ beads (bd) not found. The scrum-master uses beads for dependency tracking.');
    console.log('    Install with: npm install -g @beads/bd');
    console.log('    Without beads, the scrum-master falls back to manual dependency reasoning.');
  }
}

// ─── Final summary ────────────────────────────────────────────────────────────
const HR = '━'.repeat(45);
console.log('');
console.log(HR);
console.log('  ✅ Project Voltron setup complete!');
console.log(HR);
console.log('');
console.log('  Next steps:');
console.log('  1. Restart Claude Code to load the MCP server and allowlist');
console.log('  2. In any project: "Scaffold this project with Voltron agents"');
console.log('  3. Invoke the scrum-master: @agent-scrum-master');
console.log('');
console.log('  To re-run setup later:  node scripts/setup.js');
console.log('  To verify from Claude:  mcp__project-voltron__setup_voltron');
console.log(HR);
console.log('');
