#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const voltronRoot = join(__dirname, '..');
const mainScriptAbsolutePath = join(voltronRoot, 'src', 'index.js').replace(/\\/g, '/');
const settingsPath = join(os.homedir(), '.claude', 'settings.json');

const results = {
  deps: { ok: false, msg: '' },
  mcp: { ok: false, msg: '' },
  allowlist: { ok: false, msg: '' },
  docker: { ok: false, msg: '' },
};

// ─── Step 1: Install npm dependencies ────────────────────────────────────────
const mcpDir = join(voltronRoot, 'node_modules', '@modelcontextprotocol');
if (existsSync(mcpDir)) {
  results.deps = { ok: true, msg: 'npm dependencies already installed' };
} else {
  console.log('Installing npm dependencies...');
  const r = spawnSync('npm', ['install'], { cwd: voltronRoot, stdio: 'inherit' });
  if (r.status === 0) {
    results.deps = { ok: true, msg: 'npm dependencies installed' };
  } else {
    results.deps = { ok: false, msg: 'npm install failed (exit ' + r.status + ')' };
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

let settings = readSettings();
if (settings.mcpServers?.['project-voltron']) {
  results.mcp = { ok: true, msg: 'MCP server already registered' };
} else {
  const args = ['mcp', 'add', '--scope', 'user', 'project-voltron', '--', 'node', mainScriptAbsolutePath];
  let r = spawnSync('claude', args, { encoding: 'utf-8', stdio: 'pipe' });

  if (r.error?.code === 'ENOENT' && process.platform === 'win32') {
    r = spawnSync('claude.cmd', args, { encoding: 'utf-8', stdio: 'pipe' });
  }

  if (r.error?.code === 'ENOENT') {
    const cmd = `claude mcp add --scope user project-voltron -- node ${mainScriptAbsolutePath}`;
    console.log('⚠ Claude CLI not found. Run this manually:');
    console.log('  ' + cmd);
    results.mcp = { ok: false, msg: 'Claude CLI not found — run manually (see above)' };
  } else if (r.status === 0) {
    results.mcp = { ok: true, msg: 'MCP server registered' };
  } else {
    const errMsg = (r.stderr || '').trim();
    // Treat "already exists" as success
    if (errMsg.toLowerCase().includes('already exists')) {
      results.mcp = { ok: true, msg: 'MCP server already registered' };
    } else {
      console.log('⚠ MCP registration failed: ' + (errMsg || 'exit ' + r.status));
      results.mcp = { ok: false, msg: 'MCP registration failed — check Claude CLI' };
    }
  }
}

// ─── Step 3: Update global allowlist ─────────────────────────────────────────
const ALLOW_ENTRIES = [
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
  'Bash(docker *)', 'Bash(docker-compose *)', 'Bash(openssl *)',
  'Bash(eval *)', 'Bash(sleep *)',
  'mcp__project-voltron__*', 'mcp__alexandria__*',
];

const DENY_ENTRIES = [
  'Bash(git push --force *)', 'Bash(git push -f *)', 'Bash(git reset --hard *)',
  'Bash(rm -rf *)', 'Bash(rm -r *)', 'Bash(rmdir *)',
];

settings = readSettings();
if (!settings.permissions) settings.permissions = {};
if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
if (!Array.isArray(settings.permissions.deny)) settings.permissions.deny = [];

const existingAllow = new Set(settings.permissions.allow);
const existingDeny = new Set(settings.permissions.deny);

let addedCount = 0;
for (const entry of ALLOW_ENTRIES) {
  if (!existingAllow.has(entry)) {
    settings.permissions.allow.push(entry);
    addedCount++;
  }
}
for (const entry of DENY_ENTRIES) {
  if (!existingDeny.has(entry)) {
    settings.permissions.deny.push(entry);
    addedCount++;
  }
}

try {
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  if (addedCount > 0) {
    results.allowlist = { ok: true, msg: `Allowlist updated (+${addedCount} entries)` };
  } else {
    results.allowlist = { ok: true, msg: 'Allowlist already up to date' };
  }
} catch (err) {
  results.allowlist = { ok: false, msg: 'Could not write settings.json: ' + err.message };
}

// ─── Step 4: Check Docker ─────────────────────────────────────────────────────
const dockerResult = spawnSync('docker', ['--version'], { encoding: 'utf-8', stdio: 'pipe' });
if (dockerResult.status === 0) {
  const version = (dockerResult.stdout || '').trim().replace(/^Docker version\s+/i, '').split(',')[0];
  results.docker = { ok: true, msg: `Docker ${version}` };
} else {
  console.log('⚠ Docker not found — install Docker Desktop to enable autonomous agent execution.');
  console.log('  https://www.docker.com/products/docker-desktop/');
  results.docker = { ok: false, msg: 'Docker not found — install Docker Desktop' };
}

// ─── Summary box ─────────────────────────────────────────────────────────────
const INNER = 46; // inner width (between ║ characters)
const pad = (str, w) => str + ' '.repeat(Math.max(0, w - str.length));

// Wrap a message to fit within available inner width
function wrapRow(icon, msg, innerWidth) {
  const prefix = `  ${icon}  `;
  const indent = ' '.repeat(prefix.length);
  const maxLen = innerWidth - prefix.length;
  const lines = [];

  // Split message into tokens, reassemble into lines
  const words = msg.split(' ');
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= maxLen) {
      current += ' ' + word;
    } else {
      lines.push(current.length === 0 ? '' : current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);

  return lines.map((l, i) => (i === 0 ? prefix : indent) + l);
}

const rows = [
  { ok: results.deps.ok, msg: results.deps.msg },
  { ok: results.mcp.ok, msg: results.mcp.msg },
  { ok: results.allowlist.ok, msg: results.allowlist.msg },
  { ok: results.docker.ok, msg: results.docker.msg },
];

console.log('');
console.log('╔' + '═'.repeat(INNER) + '╗');
console.log('║  ' + pad('Project Voltron Setup Complete', INNER - 2) + '║');
console.log('╠' + '═'.repeat(INNER) + '╣');
for (const row of rows) {
  const icon = row.ok ? '✓' : '⚠';
  const lines = wrapRow(icon, row.msg, INNER);
  for (const line of lines) {
    console.log('║' + pad(line, INNER) + '║');
  }
}
console.log('╚' + '═'.repeat(INNER) + '╝');
console.log('');
console.log('Next steps:');
console.log('  1. Restart Claude Code to apply MCP and allowlist changes');
console.log('  2. In any project: "Scaffold this project with Voltron agents"');
console.log('  3. Verify install: call mcp__project-voltron__setup_voltron from Claude Code');
console.log('');
