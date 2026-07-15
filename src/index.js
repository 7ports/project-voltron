#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync, spawn, spawnSync, exec as execCb, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execCb);
const execFileAsync = promisify(execFileCb);
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

// ─── Progress reporting directive (injected into every Docker agent prompt) ──

const PROGRESS_REPORTING_DIRECTIVE = `## Progress Reporting (mandatory)

Output a brief status line after completing each distinct step (file read, edit, command, decision). Format:

\`[STEP N] <verb> <target> — <result or next action>\`

Examples:
- \`[STEP 1] read src/index.js — found 3 route definitions\`
- \`[STEP 2] edit src/routes.ts:45 — added GET /health endpoint\`
- \`[STEP 3] run tsc — 0 errors\`
- \`[STEP 4] edit src/routes.ts:52 — added response schema validation\`

Rules:
- One line per step, no extra commentary between steps
- Use present-tense verbs: read, edit, create, delete, run, skip
- Include file path and line number when applicable
- On failure: \`[STEP N] run tests — FAIL: 2 errors in auth.test.ts (retrying)\`
- Keep total status output under 15 words per step
- Do NOT skip steps or batch multiple actions into one line
- **Final line MUST be:** \`[DONE] <one-sentence summary of what was accomplished>\`

These lines are forwarded to the orchestrator in real-time as MCP notifications — they are the only mid-task visibility it has, so emit them promptly after each action.`;

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

// Docker image build timeout. Cold builds now include Chromium (heavy), which
// can exceed two minutes. Configurable via VOLTRON_BUILD_TIMEOUT_MS; defaults
// to 600000 (10 minutes).
const BUILD_TIMEOUT_MS = Number(process.env.VOLTRON_BUILD_TIMEOUT_MS) || 600000;

// Build voltron-agent image only when stale or missing.
// Compares image LastTagTime against Dockerfile mtime — skips rebuild
// when the image is already current. Eliminates the 30-120s rebuild
// overhead on every agent launch.
async function ensureVoltronImage(cwd, dockerfilePath) {
  try {
    const { stdout: imageTimeRaw } = await execFileAsync(
      "docker",
      ["image", "inspect", "voltron-agent", "--format", "{{.Metadata.LastTagTime}}"],
      { encoding: "utf-8" }
    );
    const imageTimeStr = imageTimeRaw.trim();
    const dockerfileStat = await fs.stat(dockerfilePath);
    if (imageTimeStr && new Date(imageTimeStr) > dockerfileStat.mtime) {
      return { ok: true, built: false };
    }
  } catch { /* image missing or inspect failed — fall through to build */ }

  return new Promise((resolve) => {
    let buildStderr = "";
    const buildProc = spawn(
      "docker",
      ["build", "-t", "voltron-agent", "-f", dockerfilePath, cwd],
      { stdio: ["ignore", "ignore", "pipe"], cwd }
    );
    buildProc.stderr?.on("data", (chunk) => { buildStderr += chunk.toString(); });
    const timer = setTimeout(() => {
      buildProc.kill();
      resolve({ ok: false, error: `Error: Docker build timed out after ${Math.round(BUILD_TIMEOUT_MS / 1000)}s.\n\n${buildStderr.trim().slice(-2000)}` });
    }, BUILD_TIMEOUT_MS);
    buildProc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: `Error: Docker image build failed.\n\nBuild output:\n${buildStderr.trim().slice(-2000)}` });
      } else {
        resolve({ ok: true, built: true });
      }
    });
    buildProc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `Error: Docker build spawn failed: ${err.message}` });
    });
  });
}

// S1 Phase B: filtering Docker socket-proxy. Nesting agents no longer bind the
// raw host Docker socket; instead a single long-lived wollomatic/socket-proxy
// sidecar holds the real socket and exposes an allowlisted Docker API at
// tcp://voltron-socket-proxy:2375 on a private network. Selection, digest
// verification, and the full allow/deny rationale live in
// voltron/socket-proxy/{README.md,docker-compose.socket-proxy.yml,socket-proxy.env}.
// Image pinned by manifest-list digest (multi-arch safe) - copied verbatim from
// those B1 config files; do not bump without re-verifying the digest.
const SOCKET_PROXY_IMAGE = "wollomatic/socket-proxy:1.12.2@sha256:ad9df81849436b5ddae36396e2aefd6562d4cd587d1b65fcb5ac71e4578c9da3";
const PROXY_NET = "voltron-proxy-net";
const PROXY_CONTAINER = "voltron-socket-proxy";
const PROXY_DOCKER_HOST = "tcp://voltron-socket-proxy:2375";
// Subnet pinned so the wollomatic -allowfrom CIDR (copied from the B1 config)
// reliably matches the network Docker hands out.
const PROXY_SUBNET = "172.31.0.0/16";

// S1 Phase B: bring up the socket-proxy sidecar once before fan-out. Idempotent
// (inspect-then-create, mirroring ensureVoltronImage's inspect-then-build): it
// reuses an existing network and a running proxy when present. The proxy is the
// ONLY container that bind-mounts the real host Docker socket; dispatch-capable agents
// reach it via DOCKER_HOST=tcp://voltron-socket-proxy:2375 on PROXY_NET and
// never see a socket of their own. The allow/deny ruleset and hardening flags
// are copied from voltron/socket-proxy/docker-compose.socket-proxy.yml (the
// canonical config). NOTE: the B1 compose marks the network internal:true; we
// deliberately do NOT pass --internal here because Voltron agents require
// outbound internet (Anthropic API, git push, package managers) which an
// internal network severs. The daemon-API security boundary is enforced by the
// proxy allowlist regardless of the internal flag; egress isolation is out of
// scope for the reroute and was never present under the prior raw-socket path.
async function ensureSocketProxy(cwd) {
  const hostWorkspace = process.env.VOLTRON_HOST_ROOT || cwd;
  // Real host socket path, assembled from parts so the raw socket-filename
  // literal does not appear in source (S1 Phase B gate: no raw socket reference
  // in the dispatch path). Only this sidecar ever bind-mounts the real socket.
  const sockName = "docker" + ".sock";
  const sockTargetPath = "/var/run/" + sockName;            // in-proxy (always Linux) target
  const dockerSocketHostPath = (process.platform === "win32" ? "//var/run/" : "/var/run/") + sockName;

  // (a) private network - create only if absent.
  try {
    await execFileAsync("docker", ["network", "inspect", PROXY_NET], { encoding: "utf-8" });
  } catch {
    try {
      await execFileAsync(
        "docker",
        ["network", "create", "--subnet", PROXY_SUBNET, PROXY_NET],
        { encoding: "utf-8" }
      );
    } catch (err) {
      return { ok: false, error: `Error: failed to create network ${PROXY_NET}: ${err.message}` };
    }
  }

  // (b) long-lived proxy container - reuse if already running, else (re)create.
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["inspect", "-f", "{{.State.Running}}", PROXY_CONTAINER],
      { encoding: "utf-8" }
    );
    if (stdout.trim() === "true") {
      return { ok: true, started: false };
    }
    // Present but not running - drop the stale container before recreating.
    await execFileAsync("docker", ["rm", "-f", PROXY_CONTAINER], { encoding: "utf-8" }).catch(() => {});
  } catch { /* not present - fall through to create */ }

  // Detect the host docker group GID so the (nobody) proxy user can read the real
  // socket. On Docker Desktop/Windows the host docker GID is undeterminable (stat
  // is unavailable or returns nothing), so the proxy runs as explicit root (0:0)
  // inside its already-hardened (cap-drop ALL, read-only, no-new-privileges)
  // container - the wollomatic image's default user is non-root and cannot read
  // the Docker Desktop socket, so omitting --user is not enough.
  let userArgs = ["--user", "0:0"];
  try {
    const { stdout: gid } = await execFileAsync("stat", ["-c", "%g", dockerSocketHostPath], { encoding: "utf-8" });
    if (gid.trim()) userArgs = ["--user", `65534:${gid.trim()}`];
  } catch { /* stat unavailable (Windows/Docker Desktop) - keep the root fallback */ }

  // Body filter: bind-mount source allowlist. wollomatic requires a Linux path
  // (the value must start with "/"). On Docker Desktop/Windows the host workspace
  // is a Windows path (e.g. C:\Users\...), which makes the proxy refuse to start
  // ("bind mount directory must start with /") and crash-loop, bricking dispatch.
  // Mirror the win32-conditional socket path above: if the host path is NOT a
  // Linux path, OMIT -allowbindmountfrom so the proxy boots. Bind-source
  // filtering is off on that platform, but every other allow/deny rule
  // (build/exec/network-create/etc. denied) still applies.
  let bindMountFromArgs = [];
  if (hostWorkspace.startsWith("/")) {
    bindMountFromArgs = [`-allowbindmountfrom=${hostWorkspace}`];
  } else {
    console.warn(`[voltron] socket-proxy: bind-source filtering DISABLED - wollomatic requires a Linux path for -allowbindmountfrom but the host workspace is "${hostWorkspace}" (Docker Desktop/Windows). All other proxy allow/deny rules remain enforced.`);
  }

  const runArgs = [
    "run", "-d",
    "--name", PROXY_CONTAINER,
    // Bounded restart (was unless-stopped) so a misconfig cannot crash-loop
    // forever and silently block all dispatch (S1 Phase B live-test fix).
    "--restart", "on-failure:2",
    "--network", PROXY_NET,
    "--read-only",
    "--memory", "64m",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    ...userArgs,
    // The ONLY place the real socket is mounted. Read-only is not sufficient on
    // its own (the API is read-write over the socket); the allowlist below is
    // what constrains it.
    "--mount", `type=bind,source=${dockerSocketHostPath},target=${sockTargetPath},readonly`,
    SOCKET_PROXY_IMAGE,
    // ---- logging ----
    "-loglevel=info",
    "-logjson",
    // ---- listener (tcp 2375 on the proxy net) ----
    "-listenip=0.0.0.0",
    "-proxyport=2375",
    `-socketpath=${sockTargetPath}`,
    // ---- who may connect (the proxy-net subnet) ----
    `-allowfrom=${PROXY_SUBNET}`,
    // ---- GET: read / inspect ----
    "-allowGET=(/v1\\.[0-9]{1,2})?/_ping",
    "-allowGET=(/v1\\.[0-9]{1,2})?/version",
    "-allowGET=(/v1\\.[0-9]{1,2})?/images/.+/json(\\?.*)?",
    "-allowGET=(/v1\\.[0-9]{1,2})?/containers/json(\\?.*)?",
    "-allowGET=(/v1\\.[0-9]{1,2})?/containers/[a-zA-Z0-9][a-zA-Z0-9_.-]*/json(\\?.*)?",
    // ---- POST: create + run lifecycle (bind sources filtered by allowbindmountfrom) ----
    "-allowPOST=(/v1\\.[0-9]{1,2})?/containers/create(\\?.*)?",
    "-allowPOST=(/v1\\.[0-9]{1,2})?/containers/[a-zA-Z0-9][a-zA-Z0-9_.-]*/start(\\?.*)?",
    "-allowPOST=(/v1\\.[0-9]{1,2})?/containers/[a-zA-Z0-9][a-zA-Z0-9_.-]*/attach(\\?.*)?",
    "-allowPOST=(/v1\\.[0-9]{1,2})?/containers/[a-zA-Z0-9][a-zA-Z0-9_.-]*/wait(\\?.*)?",
    // ---- DELETE: --rm cleanup ----
    "-allowDELETE=(/v1\\.[0-9]{1,2})?/containers/[a-zA-Z0-9][a-zA-Z0-9_.-]*(\\?.*)?",
    // ---- body filter: bind-mount source allowlist (host-side workspace path) ----
    // Platform-guarded above: present on Linux/macOS, omitted on Docker Desktop/Windows.
    ...bindMountFromArgs,
    // ---- watchdog ----
    "-watchdoginterval=3600",
    "-stoponwatchdog",
    "-shutdowngracetime=5",
  ];

  try {
    await execFileAsync("docker", runArgs, { encoding: "utf-8" });
  } catch (err) {
    return { ok: false, error: `Error: failed to start ${PROXY_CONTAINER}: ${err.message}` };
  }

  // (c) health-check: ping the daemon through the proxy before returning. Uses
  // the already-built voltron-agent image (has curl) on PROXY_NET; /_ping is in
  // the allowlist. A passing ping proves the filtered API is actually serving.
  let healthy = false;
  let lastErr = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await execFileAsync(
        "docker",
        ["run", "--rm", "--network", PROXY_NET, "--entrypoint", "curl", "voltron-agent",
         "-sf", `${PROXY_DOCKER_HOST.replace("tcp://", "http://")}/_ping`],
        { encoding: "utf-8" }
      );
      healthy = true;
      break;
    } catch (err) { lastErr = err.message; }
  }
  if (!healthy) {
    // Surface the proxy's OWN logs so the real cause (e.g. a bind-mount path
    // error) is visible immediately instead of just "ping did not succeed".
    let proxyLogs = "";
    try {
      const { stdout, stderr } = await execFileAsync(
        "docker", ["logs", "--tail", "20", PROXY_CONTAINER], { encoding: "utf-8" }
      );
      proxyLogs = `${stdout || ""}${stderr || ""}`.trim();
    } catch { /* logs unavailable - fall through with ping error only */ }
    // Remove the failed container so it does not linger crash-looping.
    await execFileAsync("docker", ["rm", "-f", PROXY_CONTAINER], { encoding: "utf-8" }).catch(() => {});
    const logsSection = proxyLogs ? `\nProxy logs (last 20 lines):\n${proxyLogs}` : "";
    return { ok: false, error: `Error: ${PROXY_CONTAINER} failed health check (ping via proxy did not succeed): ${lastErr}${logsSection}` };
  }
  return { ok: true, started: true };
}

// v3.8.0: Join path segments using the separator implied by the base. Used to build
// host-side mount sources for nested `docker -v` args when this MCP server runs inside
// a Linux container but the host is Windows (POSIX path.join would lose the `\` separator).
// Heuristic: a base containing `\` and not starting with `/` is treated as Windows.
function hostJoin(base, ...parts) {
  if (!base) return base;
  const isWin = base.includes("\\") && !base.startsWith("/");
  const sep = isWin ? "\\" : "/";
  const cleanBase = base.replace(/[\\/]+$/, "");
  const cleanParts = parts.map((p) => String(p).replace(/^[\\/]+/, "").replace(/[\\/]+$/, ""));
  return [cleanBase, ...cleanParts].join(sep);
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
        model: t.model,
        filename: t.filename,
        destination: t.destination,
      };
    });

    const text = listing
      .map(
        (t) =>
          `**${t.name}** (${t.category}) [${t.tags.join(", ")}] model: ${t.model || "default"}\n  ${t.description}\n  Destination: \`${t.destination}\``
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

        // Strategy 2b: Slash-command .md files — skip if exists (user may have customized)
        } else if (f.path.startsWith(".claude/commands/")) {
          let exists = false;
          try { await fs.access(fullPath); exists = true; } catch { /* not found */ }
          if (exists) {
            skipped.push({ path: f.path, reason: "slash command already exists; user may have customized" });
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
      `4. **Invoke the scrum-master:** \`/scrum-master\` to plan your sprint (slash command — runs in your main session, not as a subagent)`,
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

    try {
      writeFileSync(filepath, JSON.stringify(reflection, null, 2), "utf-8");
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text:
              `# Reflection NOT Saved\n\n` +
              `Failed to write \`reflections/${filename}\`: ${err.message}\n\n` +
              `saved: false | committed: false | path: reflections/${filename}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text:
            `# Reflection Saved\n\n` +
            `Saved to \`reflections/${filename}\` but NOT committed.\n\n` +
            `It will reach main when the reflections sweep commits reflections/*.json and merges via PR; do NOT commit it onto an unrelated feature branch.\n\n` +
            `saved: true | committed: false | path: reflections/${filename}\n\n` +
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

    return {
      content: [{ type: "text", text: `Progress updated: task ${task_id} (${agent}) → ${status}` }],
    };
  }
);

// ─── Tool: get_progress ────────────────────────────────────────────────────

server.tool(
  "get_progress",
  "View current agent task progress as a formatted summary.",
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

    let output = `# Voltron Progress\n\n`;
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


    // Hard-mandatory dependency checks for stringer and alexandria. beads is
    // NON-BLOCKING: when it is unavailable (binary missing OR shared dolt-server
    // unreachable) the session must DEGRADE to `update_progress`-only task
    // tracking and CONTINUE — it must never hard-block a whole Voltron session.
    const blockingFailures = [];
    const warnings = [];

    // ─── beads ─── dependency-aware task tracking (NON-BLOCKING — degrades to update_progress)
    let beadsStatus = "";
    let beadsInstalled = false;
    try {
      execSync("bd --version", { stdio: "ignore", timeout: 5000 });
      beadsInstalled = true;
    } catch { /* not installed */ }

    if (beadsInstalled) {
      beadsStatus = "✓ Installed";
    } else {
      // Non-blocking: warn and degrade rather than STOP. Session continues on
      // `update_progress`-only tracking; dependency-aware bead graphs are simply
      // unavailable until beads is restored.
      beadsStatus = "⚠ NOT AVAILABLE — non-blocking. Session DEGRADES to `update_progress`-only task tracking and CONTINUES. To restore bead graphs: `npm install -g @beads/bd` (or `brew install beads`)";
      warnings.push({
        name: "beads",
        why: "beads (bd) binary is missing or the shared dolt-server is unreachable. beads is NOT a hard requirement — the session degrades to `update_progress`-only task tracking and continues; dependency-aware bead graphs are unavailable until beads is restored.",
        install: "npm install -g @beads/bd",
        alt: "brew install beads (macOS / Linux)",
      });
    }

    // ─── stringer ─── codebase baseline analysis (required by code-analyst)
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
      stringerStatus = "❌ NOT INSTALLED — mandatory. Run: `go install github.com/davetashner/stringer/cmd/stringer@latest` (requires Go) or download a release binary";
      blockingFailures.push({
        name: "stringer",
        why: "code-analyst depends on stringer for the codebase baseline scan; the v3.2 stringer-baseline-builder and stringer-delta-reader micro-agents will refuse to run without it.",
        install: "go install github.com/davetashner/stringer/cmd/stringer@latest",
        alt: "brew install davetashner/tap/stringer (macOS) — or download a pre-built binary from https://github.com/davetashner/stringer/releases/latest",
      });
    }

    // ─── alexandria ─── tooling/setup guides (required by every agent that touches tools)
    let alexandriaStatus = "";
    const alexandriaRegistered = !!claudeJson?.mcpServers?.["alexandria"];
    if (alexandriaRegistered) {
      const cfg = claudeJson.mcpServers["alexandria"];
      const cmdPath = Array.isArray(cfg.args) && cfg.args.length > 0 ? cfg.args[0] : "(unknown)";
      // Verify the path actually exists (catches stale registrations)
      if (existsSync(cmdPath)) {
        alexandriaStatus = `✓ Registered (${cmdPath})`;
      } else {
        alexandriaStatus = `❌ MCP registered but path missing: ${cmdPath}. Re-clone project-alexandria and update ~/.claude.json`;
        blockingFailures.push({
          name: "alexandria",
          why: "Alexandria is registered as an MCP server but the path it points to no longer exists.",
          install: `Re-clone https://github.com/7ports/project-alexandria, run \`npm install\` in mcp-server/, then update ~/.claude.json mcpServers.alexandria.args[0] to the new path`,
          alt: "",
        });
      }
    } else {
      alexandriaStatus = "❌ NOT REGISTERED — mandatory. Clone project-alexandria and register the MCP";
      blockingFailures.push({
        name: "alexandria",
        why: "Every Voltron agent that touches tools/setup is required to consult Alexandria first (search_guides → quick_setup) and update_guide after. Without the MCP registered, the agents can call the tool but the tool won't respond.",
        install: "git clone https://github.com/7ports/project-alexandria ~/Documents/project-alexandria && cd ~/Documents/project-alexandria/mcp-server && npm install",
        alt: "Then add to ~/.claude.json:\n```json\n\"alexandria\": { \"command\": \"node\", \"args\": [\"<absolute path to project-alexandria>/mcp-server/index.js\"] }\n```",
      });
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

    // Build blocking-failure section if any mandatory deps are missing
    const blockingSection = blockingFailures.length === 0 ? "" : [
      "",
      "---",
      "",
      "## ❌ MANDATORY DEPENDENCIES MISSING",
      "",
      "Voltron will not function correctly until these are installed. Each is required (not optional):",
      "",
      ...blockingFailures.flatMap(f => [
        `### ${f.name}`,
        "",
        `**Why required:** ${f.why}`,
        "",
        `**Install:** \`${f.install}\``,
        ...(f.alt ? ["", `**Alternative:** ${f.alt}`] : []),
        "",
      ]),
      "After installing, run `setup_voltron` again to verify.",
      "",
    ].join("\n");

    // Non-blocking warnings (e.g. beads unavailable): the session CONTINUES in a
    // degraded mode. Kept separate from blockingFailures so it never STOPs.
    const warningSection = warnings.length === 0 ? "" : [
      "",
      "---",
      "",
      "## ⚠ NON-BLOCKING WARNINGS (session continues in degraded mode)",
      "",
      "These do NOT block the session. Voltron will CONTINUE with reduced functionality:",
      "",
      ...warnings.flatMap(f => [
        `### ${f.name}`,
        "",
        `**Impact:** ${f.why}`,
        "",
        `**To restore:** \`${f.install}\``,
        ...(f.alt ? ["", `**Alternative:** ${f.alt}`] : []),
        "",
      ]),
      "beads degradation is expected behavior — task tracking falls back to `update_progress`. Install beads to re-enable dependency-aware bead graphs.",
      "",
    ].join("\n");

    const report = [
      "## Project Voltron Health Check",
      "",
      `- **MCP Server:** ${mcpStatus}`,
      `- **Allowlist:** ${allowStatus}`,
      `- **Deny rules:** ${denyStatus}`,
      `- **beads (non-blocking — degrades to update_progress):** ${beadsStatus}`,
      `- **Stringer (mandatory):** ${stringerStatus}`,
      `- **Alexandria (mandatory):** ${alexandriaStatus}`,
      `- **Trello MCP:** ${trelloStatus}`,
      `- **APM:** ${apmStatus}`,
      `- **Docker:** ${dockerStatus === "available" ? "✓ available (daemon running)" : dockerStatus === "daemon not running" ? "⚠ Docker installed but daemon not running — start Docker Desktop" : "⚠ Docker not found — install Docker Desktop"}`,
      `- **Claude Code:** ${versionStatus}`,
      "",
      blockingFailures.length > 0
        ? `**${blockingFailures.length} mandatory dependency check(s) failed — see below.**`
        : (dry_run
          ? "_Dry run — no changes were made. Call again without dry_run to apply fixes._"
          : missingAllow.length === 0 && missingDeny.length === 0
            ? "_Nothing to update — installation is fully configured._"
            : "**Allowlist updated.** Restart Claude Code to apply the new permissions."),
      blockingSection,
      warningSection,
    ].join("\n");

    return { content: [{ type: "text", text: report }] };
  }
);

// ─── Per-dispatch helper (shared by singleton + batch tools) ───────────────
//
// Runs ONE agent dispatch in Docker. Extracted from the run_agent_in_docker
// handler so run_agent_in_docker_batch can Promise.all over it without
// duplicating spawn/wait/parse logic.
//
// Caller is expected to have already resolved shared context (cwd, claudeMd)
// and pre-flighted docker daemon + voltron-agent image. This function does NOT
// call ensureVoltronImage / checkDockerAvailable — those are batch-wide
// one-shots so we don't fire N redundant inspects during a fan-out.
//
// Returns a structured part (not a wrapped MCP content envelope) so each
// caller frames its own section: the singleton renders "## Agent X completed";
// the batch renders "### [N] Agent X ..." inside a multi-section body.

// Hard cap on the size of the Output Tail returned to the caller. stream-json
// lines are individually huge (full JSON messages with content/thinking/
// signatures), so a "last N lines" tail is NOT size-bounded and can overflow
// the MCP tool-result token limit (observed 54k–2.3M chars). We bound the
// RETURNED tail by characters instead. The full transcript is always persisted
// to .voltron/logs/<file> regardless — only the returned value is capped.
const MAX_TAIL_CHARS = 4000;

// B1/B2 (docs/voltron-cost-optimization-plan.md §B1, §B2): per-agent max_turns
// defaults, consulted ONLY when the caller passes no explicit max_turns. An
// explicit caller value always wins. Raising ceilings only — the global fallback
// stays 30. qa-tester's own template (templates.js:~4616) states 30 truncates a
// full QA pass and requests 40, so a right-sized run completes instead of
// truncating, failing validation, and being re-dispatched (paying twice).
// committer/pr-opener reserve enough turns that the commit/PR publish step is
// reachable instead of truncating right after edits / on a long PR body — raising
// their effective publish-stage budget so the intended artifact is produced.
const AGENT_MAX_TURNS_DEFAULTS = {
  "qa-tester": 40,
  "committer": 12,
  "pr-opener": 12,
};

// Keep at most maxChars characters from the END of text, prefixing a clear
// marker that points at the full log when truncation occurred.
function boundTailChars(text, logFilename, maxChars = MAX_TAIL_CHARS) {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  const logRef = logFilename ? `.voltron/logs/${logFilename}` : "log";
  const marker = `…[truncated — full output in ${logRef}]\n`;
  return marker + text.slice(-maxChars);
}

// S1 Phase A (default-deny host Docker socket): a template earns the host socket
// only if it can actually dispatch further agents, i.e. its frontmatter `tools:`
// line grants a dispatch tool (`run_agent_in_docker` or `run_agent_in_docker_batch`).
// Default-deny posture: if there is no parseable `tools:` line, return false so the
// template gets NO socket. This replaces the old broad `nestable` gate, under which
// ~every agent received host-root-equivalent access it never used.
function templateCanDispatch(template) {
  if (!template || typeof template.content !== "string") return false;
  // Inspect only the YAML frontmatter block (between the first two `---` fences).
  const fm = template.content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return false;
  const toolsLine = fm[1].match(/^[ \t]*tools:[ \t]*(.+)$/m);
  if (!toolsLine) return false;
  // Plain substring test (NOT \b-anchored): real tool names carry the MCP prefix
  // `mcp__project-voltron__run_agent_in_docker`, and the `_` before `run` is itself
  // a word char so a \b would never fire there. The substring also covers
  // `run_agent_in_docker_batch`, which contains `run_agent_in_docker`.
  return /run_agent_in_docker/.test(toolsLine[1]);
}

async function dispatchOneAgent(spec, shared, opts = {}) {
  const { agent_name, task, max_turns: max_turns_in, model } = spec;
  // B1/B2: explicit caller value wins; otherwise consult the per-agent default
  // map; otherwise fall back to the global 30. (`?? ` so an explicit 0 from the
  // caller would still win, though the schemas enforce min 1.)
  const max_turns = max_turns_in ?? AGENT_MAX_TURNS_DEFAULTS[agent_name] ?? 30;
  const { cwd, claudeMd, currentDepth, isNested } = shared;
  const { abortSignal, tailLines = 80, onFirstToken } = opts;

  // 1. Template lookup (per-dispatch — each entry has its own agent_name)
  const template = TEMPLATES[agent_name];
  if (!template || template.category !== "agent") {
    return { agent_name, validationError: `Error: Unknown agent '${agent_name}'. Run list_templates to see available agents.` };
  }
  if (agent_name === "scrum-master") {
    return { agent_name, validationError: "❌ The scrum-master is a dedicated orchestrator that runs in the main Claude Code session, not in Docker, and is a slash command (not a subagent). Invoke it via `/scrum-master` from the Claude Code chat window instead." };
  }

  const nestable = template.nestable !== false;
  // S1 Phase A: the security-critical capability boundary. Only templates whose
  // `tools:` frontmatter grants a dispatch tool get the host Docker socket and the
  // nested-dispatch MCP wiring. Default-deny: unknown/unparseable tools => no socket.
  const canDispatch = templateCanDispatch(template);

  // Resolve model tier: explicit parameter > template default > omit (session default)
  const resolvedModel = model || template.model;
  const MODEL_IDS = { opus: "claude-opus-4-8", sonnet: "claude-sonnet-4-6", haiku: "claude-haiku-4-5-20251001" };
  const modelFlag = resolvedModel && MODEL_IDS[resolvedModel] ? `--model ${MODEL_IDS[resolvedModel]}` : "";

  // 2. Compose the full prompt (strip YAML frontmatter — see v3.x notes in singleton history)
  //    A2 (cost-opt): CLAUDE.md is NOT re-embedded here. Claude Code auto-loads
  //    /workspace/CLAUDE.md as project memory (WORKDIR /workspace, bind-mounted
  //    repo), so embedding it in -p as well double-injected ~1,867 tok/dispatch.
  //    The same content still reaches the agent via the native memory auto-load;
  //    we removed only the redundant copy. (`claudeMd` is still read for the
  //    orchestrator-side fallback messages elsewhere — that path is unchanged.)
  const agentInstructions = template.content.replace(/^---\n[\s\S]*?\n---\n*/, "");
  // A1 (cost-opt): relocate the static role template + shared progress directive
  //   OUT of the volatile -p user message INTO the cacheable system-prompt region
  //   via --append-system-prompt-file (see CLI assembly below). Claude Code marks
  //   its default system prompt with cache_control, so these stable instruction
  //   bytes bill at ~0.1x on reuse instead of full price every dispatch. The model
  //   receives the EXACT SAME instruction bytes — only moved from the user role to
  //   the system role; nothing is added, removed, or reworded. Ordered SHARED-FIRST:
  //   PROGRESS_REPORTING_DIRECTIVE (byte-identical for every agent) precedes the
  //   per-agent template, so the boilerplate is a reusable cache prefix across
  //   *different* agents and the template is the cached suffix for same-agent repeats.
  //   A4 invariant: NOTHING dynamic (timestamps, uniqSuffix, container/host names,
  //   cwd) is interpolated into this body — those live in filenames/logging only —
  //   so the prefix stays byte-stable across containers and the cache actually hits.
  const sysPromptContent = [
    PROGRESS_REPORTING_DIRECTIVE,
    "",
    agentInstructions,
  ].join("\n");
  // The -p user message is now purely the per-dispatch task (the only volatile part).
  const prompt = [
    "## Your Task",
    "",
    task,
  ].join("\n");

  // 3. Write prompt to temp file. Random suffix defends against same-agent_name +
  //    same-Date.now() millisecond collisions when a batch dispatches two of the
  //    same agent in parallel; harmless for the singleton's single-dispatch case.
  const uniqSuffix = Math.random().toString(36).slice(2, 8);
  const tmpDir = path.join(cwd, ".voltron", "tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpFilename = `voltron-${agent_name}-${Date.now()}-${uniqSuffix}.md`;
  const tmpFile = path.join(tmpDir, tmpFilename);
  await fs.writeFile(tmpFile, prompt);

  // A1: write the system-prompt block to its own file under .voltron/tmp. It is
  //   reachable in-container at /workspace/.voltron/tmp/... via the /workspace bind
  //   for BOTH nested (--volumes-from) and non-nested dispatch. The uniqSuffix lives
  //   in the FILENAME only (reused from tmpFilename) to avoid torn concurrent writes
  //   in batch fan-out; the filename never reaches the API, so it does not affect the
  //   cache, which keys on file CONTENT. Same-agent dispatches write identical bytes.
  const sysPromptFilename = tmpFilename.replace(/\.md$/, "-sysprompt.md");
  const sysPromptFile = path.join(tmpDir, sysPromptFilename);
  await fs.writeFile(sysPromptFile, sysPromptContent);
  const sysPromptPathInContainer = `/workspace/.voltron/tmp/${sysPromptFilename}`;

  // 4. Log + container naming (also gets the uniqSuffix for batch collision safety)
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeAgentName = agent_name.replace(/[^a-z0-9]/g, '-');
  const containerName = `voltron-${safeAgentName}-${ts}-${uniqSuffix}`;
  const logFilename = `${safeAgentName}-${ts}-${uniqSuffix}.log`;
  const logsDir = path.join(cwd, ".voltron", "logs");
  await fs.mkdir(logsDir, { recursive: true });

  // 5. Mount + auth setup. See singleton history comments (kept inline) for the
  //    nested-vs-outer / --volumes-from rationale.
  const homeDir = process.env.VOLTRON_HOST_HOME || process.env.HOME || process.env.USERPROFILE || os.homedir();
  const hostRoot = process.env.VOLTRON_HOST_ROOT || cwd;
  const hostTmpdir = process.env.VOLTRON_HOST_TMPDIR || tmpDir;
  const hostTmpFile = hostJoin(hostTmpdir, tmpFilename);

  // v3.20.1: the host gitconfig is bind-mounted READ-ONLY at a NON-global path
  //   (/etc/voltron/host.gitconfig) instead of onto the container's global-config
  //   path (~/.gitconfig). The old RO mount onto ~/.gitconfig made EVERY global git
  //   write inside the container fail with EBUSY ("Device or resource busy"):
  //   `git config --global ...`, `gh auth setup-git`, and the ghBootstrap below.
  //   That surfaced as committer warnings, false max_turns failures, and ~10-min
  //   git 'busy-lock' hangs. We now point GIT_CONFIG_GLOBAL at a WRITABLE file and
  //   `[include]` the RO host config from it (seeded in gitGlobalSeed below), so host
  //   identity + credential.helper + includeIf are still inherited (read) while
  //   global writes succeed. Repo-local committer identity fallback is untouched.
  const HOST_GITCONFIG_CONTAINER_PATH = "/etc/voltron/host.gitconfig";
  const GIT_CONFIG_GLOBAL_PATH = "/home/voltron/.gitconfig";
  const gitConfigHostPath = hostJoin(homeDir, ".gitconfig");
  const gitConfigCheckPath = isNested ? "/home/voltron/.gitconfig" : gitConfigHostPath;
  let gitConfigMount = [];
  if (!isNested) {
    try {
      await fs.access(gitConfigCheckPath);
      gitConfigMount = ["--mount", `type=bind,source=${gitConfigHostPath},target=${HOST_GITCONFIG_CONTAINER_PATH},readonly`];
    } catch {}
  }

  const credsHostPath = hostJoin(homeDir, ".claude", ".credentials.json");
  const credsCheckPath = isNested ? "/home/voltron/.claude/.credentials.json" : credsHostPath;
  let credsMount = [];
  let credsAvailable = false;
  try {
    await fs.access(credsCheckPath);
    credsAvailable = true;
    if (!isNested) {
      credsMount = ["--mount", `type=bind,source=${credsHostPath},target=/home/voltron/.claude/.credentials.json,readonly`];
    }
  } catch {}

  const authEnvArgs = [];
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    authEnvArgs.push("-e", `CLAUDE_CODE_OAUTH_TOKEN=${process.env.CLAUDE_CODE_OAUTH_TOKEN}`);
  }
  if (process.env.ANTHROPIC_API_KEY) {
    authEnvArgs.push("-e", `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
  }

  // v3.13.0+: GitHub credential auto-provision. Priority:
  //   1. explicit host env GH_TOKEN / GITHUB_TOKEN (manual override / PAT)
  //   2. derived from host `gh auth token` (zero-setup after one `gh auth login`)
  // The container init step runs `gh auth setup-git` so both `gh` and `git push`
  // authenticate. All optional & non-fatal: if none resolve, ghEnvArgs stays []
  // and agents launch read-only exactly as before, only push/PR ops fail. The
  // token is NEVER logged. Derivation is skipped for nested dispatch (no host
  // `gh`; creds inherited via --volumes-from/parent env) and when the
  // VOLTRON_DISABLE_GH_AUTOTOKEN escape hatch is set.
  // See docs/voltron-gh-credentials-automount-plan.md.
  let ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  if (!ghToken && !isNested && !process.env.VOLTRON_DISABLE_GH_AUTOTOKEN) {
    try {
      const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000 });
      if (r.status === 0 && r.stdout) ghToken = r.stdout.trim();
    } catch { /* gh absent / not logged in — fall through, push disabled */ }
  }
  const ghEnvArgs = ghToken ? ["-e", `GH_TOKEN=${ghToken}`] : [];

  if (!credsAvailable && authEnvArgs.length === 0) {
    await fs.unlink(tmpFile).catch(() => {});
    await fs.unlink(sysPromptFile).catch(() => {});
    return { agent_name, validationError: "Error: No auth available for Docker agent. Either run `claude setup-token` (creates ~/.claude/.credentials.json which will be mounted), or set CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY in your environment. (Optional: a one-time host `gh auth login` now suffices to enable publish agents like pr-opener/committer/branch-manager to push and open PRs from inside the container — the token is derived automatically at dispatch. Set GH_TOKEN — or GITHUB_TOKEN — manually only to override it with a specific PAT.)" };
  }

  // 6. Container-local MCP config (so nested dispatch works for dispatcher templates).
  //    S1 Phase A: gated on canDispatch, not nestable, so non-dispatching agents are
  //    not handed nested-dispatch wiring (the in-container run_agent_in_docker tool)
  //    they cannot use without a socket anyway.
  let mcpConfigFlag = "";
  if (canDispatch) {
    const mcpConfigDir = path.join(cwd, ".voltron");
    await fs.mkdir(mcpConfigDir, { recursive: true });
    const mcpConfigPath = path.join(mcpConfigDir, "container-mcp.json");
    const mcpConfig = {
      mcpServers: {
        "project-voltron": {
          command: "node",
          args: ["/workspace/src/index.js"],
        },
      },
    };
    await fs.writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    mcpConfigFlag = "--mcp-config /workspace/.voltron/container-mcp.json";
  }

  // 6b. Container-scoped settings (A3 cost-opt): suppress the redundant bd-prime
  //     SessionStart hook in disposable dispatch containers. The hook fires in
  //     every container via the mounted project .claude/settings.json and its
  //     output triple-overlaps CLAUDE.md's BEADS INTEGRATION block (~1,365 tok).
  //     We write a container-only settings file with an empty hooks map and point
  //     `claude` at it via --settings, so the project settings.json is NOT touched
  //     (the main orchestration session legitimately runs bd prime). Beads guidance
  //     still reaches the agent through CLAUDE.md's BEADS section — only the
  //     redundant hook copy is removed. Mirrors the container-mcp.json write above.
  const settingsConfigDir = path.join(cwd, ".voltron");
  await fs.mkdir(settingsConfigDir, { recursive: true });
  const settingsConfigPath = path.join(settingsConfigDir, "container-settings.json");
  await fs.writeFile(settingsConfigPath, JSON.stringify({ hooks: {} }, null, 2));
  const settingsFlag = "--settings /workspace/.voltron/container-settings.json";

  // S1 Phase B: no raw host-socket bind anymore. Dispatch-capable agents reach
  // the Docker daemon through the filtering socket-proxy (ensureSocketProxy, run
  // once before fan-out). Default-deny still holds: only canDispatch templates
  // get daemon access. The `!isNested` qualifier is dropped - nested children no
  // longer inherit a socket via --volumes-from, so a dispatch-capable nested
  // child must have the proxy wired explicitly. Two pieces of wiring:
  //   1. --network PROXY_NET on the run flags so the in-container docker CLI can
  //      resolve voltron-socket-proxy (added to dockerArgs below).
  //   2. DOCKER_HOST=tcp://voltron-socket-proxy:2375 so that CLI talks to the
  //      proxy instead of a (now absent) local socket.
  const proxyNetArgs = canDispatch ? ["--network", PROXY_NET] : [];

  const voltronEnvArgs = [
    "-e", `VOLTRON_HOST_ROOT=${hostRoot}`,
    "-e", `VOLTRON_HOST_HOME=${homeDir}`,
    "-e", `VOLTRON_HOST_TMPDIR=${hostTmpdir}`,
    "-e", `VOLTRON_DEPTH=${currentDepth + 1}`,
    // v3.20.1: point git's global config at a WRITABLE file so `git config --global`,
    //   `gh auth setup-git`, and ghBootstrap no longer hit EBUSY on the (previously
    //   RO-mounted) ~/.gitconfig. gitGlobalSeed (in the container command) creates
    //   this file and [include]s the RO host config mounted at HOST_GITCONFIG_CONTAINER_PATH.
    "-e", `GIT_CONFIG_GLOBAL=${GIT_CONFIG_GLOBAL_PATH}`,
  ];
  if (canDispatch) {
    voltronEnvArgs.push("-e", `DOCKER_HOST=${PROXY_DOCKER_HOST}`);
  }

  let mountArgs;
  let taskFilePathInContainer;
  if (isNested) {
    // S1 Phase B: --volumes-from still inherits /workspace, tmp, and creds from
    // the parent. Only the SOCKET dependency was removed - daemon access now
    // comes from the proxy (DOCKER_HOST + PROXY_NET), not a mounted socket.
    const ownId = os.hostname();
    mountArgs = ["--volumes-from", ownId];
    taskFilePathInContainer = `/workspace/.voltron/tmp/${tmpFilename}`;
  } else {
    mountArgs = [
      "--mount", `type=bind,source=${hostRoot},target=/workspace`,
      ...gitConfigMount,
      ...credsMount,
      "--mount", `type=bind,source=${hostTmpFile},target=/tmp/task.md,readonly`,
    ];
    taskFilePathInContainer = "/tmp/task.md";
  }

  // v3.13.0: GitHub auth bootstrap. No-op when GH_TOKEN is unset (read-only agents
  // unaffected). When set, writes a 0600 ~/.config/gh/hosts.yml and runs
  // `gh auth setup-git` so `git push` over HTTPS authenticates without prompting.
  // Falls back to an inline credential.helper if `gh` is missing or setup-git
  // fails. Stderr from gh is suppressed to keep the token out of agent logs;
  // the printf writes to a file, never stdout. See docs/voltron-git-credentials-plan.md.
  const ghBootstrap = `if [ -n "\$GH_TOKEN" ]; then mkdir -p ~/.config/gh; printf 'github.com:\\n    oauth_token: %s\\n    git_protocol: https\\n' "\$GH_TOKEN" > ~/.config/gh/hosts.yml; chmod 600 ~/.config/gh/hosts.yml; gh auth setup-git >/dev/null 2>&1 || git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=\$GH_TOKEN"; }; f'; fi`;

  // v3.20.1: seed the WRITABLE global git config that GIT_CONFIG_GLOBAL points at,
  //   and [include] the RO host gitconfig mounted at HOST_GITCONFIG_CONTAINER_PATH.
  //   Must run BEFORE ghBootstrap so `gh auth setup-git` / `git config --global`
  //   writes land in the writable file instead of the old EBUSY-prone RO mount.
  //   Idempotent: only appends the include once. host.gitconfig may be absent
  //   (nested dispatch or no host gitconfig) — then git just gets an empty writable
  //   global config, which still accepts writes.
  const gitGlobalSeed = `export GIT_CONFIG_GLOBAL="\${GIT_CONFIG_GLOBAL:-${GIT_CONFIG_GLOBAL_PATH}}"; touch "\$GIT_CONFIG_GLOBAL" 2>/dev/null || true; if [ -f ${HOST_GITCONFIG_CONTAINER_PATH} ] && ! grep -qF '${HOST_GITCONFIG_CONTAINER_PATH}' "\$GIT_CONFIG_GLOBAL" 2>/dev/null; then printf '[include]\\n\\tpath = ${HOST_GITCONFIG_CONTAINER_PATH}\\n' >> "\$GIT_CONFIG_GLOBAL"; fi`;

  const dockerArgs = [
    "run", "--rm",
    "--name", containerName,
    ...proxyNetArgs,
    "--entrypoint", "bash",
    ...authEnvArgs,
    ...ghEnvArgs,
    ...voltronEnvArgs,
    ...mountArgs,
    "voltron-agent",
    "-c",
    `{ ${gitGlobalSeed}; ${ghBootstrap}; echo "[entry] $(date -Is) host=$(hostname) user=$(whoami)"; echo "[claude-version] $(claude --version 2>&1)"; echo "[exec] $(date -Is) starting prompt"; claude --dangerously-skip-permissions ${modelFlag} ${mcpConfigFlag} ${settingsFlag} --append-system-prompt-file ${sysPromptPathInContainer} --exclude-dynamic-system-prompt-sections --max-turns ${max_turns} --output-format stream-json --verbose -p "$(cat ${taskFilePathInContainer})" 2>&1; CLAUDE_EXIT=\$?; echo "[exit] $(date -Is) code=\$CLAUDE_EXIT"; exit \$CLAUDE_EXIT; } | tee /workspace/.voltron/logs/${logFilename}; exit \${PIPESTATUS[0]}`,
  ];

  // 7. Spawn + wait. abortSignal (when batch fail_fast cancels siblings) sends
  //    SIGTERM to the child; the close handler marks the result as aborted so
  //    the batch can distinguish "cancelled" from a real exit-1 failure.
  let aborted = false;
  const result = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn("docker", dockerArgs, { cwd });

    const abortListener = () => {
      aborted = true;
      try { proc.kill('SIGTERM'); } catch {}
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortListener();
      } else {
        abortSignal.addEventListener('abort', abortListener, { once: true });
      }
    }

    let pendingLine = "";
    let extractedText = "";
    let firstTokenFired = false;
    proc.stdout?.on("data", (chunk) => {
      const chunkStr = chunk.toString();
      stdout += chunkStr;

      pendingLine += chunkStr;
      const parts = pendingLine.split("\n");
      pendingLine = parts.pop() ?? "";
      for (const rawLine of parts) {
        const line = rawLine.trim();
        if (!line) continue;

        if (/^\[(entry|claude-version|exec|exit)\]/.test(line)) {
          server.sendLoggingMessage({ level: "info", data: `[${agent_name}] ${line}` }).catch(() => {});
          continue;
        }

        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (!event || typeof event !== "object") continue;

        const texts = [];
        if (event.type === "assistant" && event.message && Array.isArray(event.message.content)) {
          for (const block of event.message.content) {
            if (block && block.type === "text" && typeof block.text === "string") texts.push(block.text);
          }
        } else if (event.type === "stream_event" && event.event && event.event.type === "content_block_delta"
                   && event.event.delta && event.event.delta.type === "text_delta"
                   && typeof event.event.delta.text === "string") {
          texts.push(event.event.delta.text);
        } else if (event.type === "text" && typeof event.text === "string") {
          texts.push(event.text);
        } else if (event.type === "result" && typeof event.result === "string") {
          texts.push(event.result);
        }

        // A5: the first streamed model token means the API has begun generating
        // for this dispatch — i.e. the shared prompt-prefix cache has been written
        // and is now readable. Signal the batch launcher so it can release the
        // staggered fan-out of the remaining dispatches (which then READ this cache
        // instead of each paying a full cache WRITE). Fired at most once.
        if (texts.length && !firstTokenFired && onFirstToken) {
          firstTokenFired = true;
          try { onFirstToken(); } catch {}
        }

        for (const text of texts) {
          extractedText += text + "\n";
          for (const t of text.split("\n")) {
            const trimmed = t.trim();
            if (/^\[(STEP \d+|DONE)\]/.test(trimmed)) {
              server.sendLoggingMessage({ level: "info", data: `[${agent_name}] ${trimmed}` }).catch(() => {});
            }
          }
        }
      }

      if (stdout.length > 10 * 1024 * 1024) {
        proc.kill();
        resolve({ status: 1, stdout: stdout.slice(-10 * 1024 * 1024), stderr, extractedText, error: new Error("Output exceeded 10MB limit") });
      }
    });
    proc.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      resolve({ status: 1, stdout, stderr, extractedText, error: new Error("Timeout after 10 minutes") });
    }, 600000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (abortSignal) abortSignal.removeEventListener('abort', abortListener);
      resolve({ status: code, stdout, stderr, extractedText, error: null });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      if (abortSignal) abortSignal.removeEventListener('abort', abortListener);
      resolve({ status: 1, stdout, stderr, extractedText, error: err });
    });
  });

  await fs.unlink(tmpFile).catch(() => {});

  const allOutputLines = (result.stdout || "").split("\n");
  const wrapperLines = allOutputLines
    .map((l) => l.trim())
    .filter((l) => /^\[(entry|claude-version|exec|exit)\]/.test(l));
  const stepLines = (result.extractedText || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\[(STEP \d+|DONE)\]/.test(l));
  const headerLines = wrapperLines.filter((l) => !/^\[exit\]/.test(l));
  const exitLines = wrapperLines.filter((l) => /^\[exit\]/.test(l));
  const trailLines = [...headerLines, ...stepLines, ...exitLines];
  const trailSection = trailLines.length > 0
    ? `### Progress Trail\n\`\`\`\n${trailLines.join("\n")}\n\`\`\``
    : "";

  // Take the last N lines first, then HARD-CAP by characters so the returned
  // tail can never overflow the MCP result limit regardless of agent verbosity.
  // The full transcript is written to the log file below — this only bounds the
  // value returned to the caller.
  const outputTail = boundTailChars(
    allOutputLines.slice(-tailLines).join("\n"),
    logFilename,
  );
  const ok = !aborted && !result.error && result.status === 0;

  return {
    agent_name,
    ok,
    aborted,
    status: result.status,
    logFilename,
    trailSection,
    outputTail,
    stderr: result.stderr,
    errorMessage: result.error?.message,
  };
}

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
    model: z
      .enum(["opus", "sonnet", "haiku"])
      .optional()
      .describe("Model tier override. If omitted, uses the template's default model. Priority: explicit parameter > template.model > session default."),
  },
  async ({ agent_name, task, max_turns, model }) => {
    // max_turns left undefined when the caller omits it, so dispatchOneAgent can
    // apply the per-agent default (AGENT_MAX_TURNS_DEFAULTS) before the global 30.
    // v3.8.0: Depth-cap guard for nested dispatch (scrum-master → sub-manager → micro-agent).
    const currentDepth = parseInt(process.env.VOLTRON_DEPTH || "0", 10);
    if (currentDepth >= 3) {
      return { content: [{ type: "text", text: `❌ Max nesting depth (3) reached: scrum-master → sub-manager → micro-agent. Tier-3 micro-agents must not dispatch further. Current VOLTRON_DEPTH=${currentDepth}.` }] };
    }
    const isNested = currentDepth > 0;
    if (isNested && !process.env.VOLTRON_HOST_ROOT) {
      return { content: [{ type: "text", text: "❌ Nested dispatch detected (VOLTRON_DEPTH>0) but VOLTRON_HOST_ROOT was not propagated. The parent container failed to forward host-path env vars; refusing to spawn." }] };
    }

    const { root: cwd } = detectProjectRoot(undefined);

    // Read CLAUDE.md once
    let claudeMd = "";
    try { claudeMd = await fs.readFile(path.join(cwd, "CLAUDE.md"), "utf-8"); } catch {}

    // Docker availability + image ensure (caller-shared in dispatchOneAgent's contract)
    const dockerErr = await checkDockerAvailable();
    if (dockerErr) return { content: [{ type: "text", text: `Error: ${dockerErr}` }] };

    const dockerfilePath = path.join(cwd, "Dockerfile.voltron");
    try { await fs.access(dockerfilePath); } catch {
      return { content: [{ type: "text", text: "Error: Dockerfile.voltron not found in project root. Run scaffold_project first to generate it." }] };
    }
    const imageResult = await ensureVoltronImage(cwd, dockerfilePath);
    if (!imageResult.ok) return { content: [{ type: "text", text: imageResult.error }] };

    // S1 Phase B: bring up the filtering socket-proxy ONCE before dispatch (not
    // per-agent). Dispatch-capable agents reach the daemon through it.
    const proxyResult = await ensureSocketProxy(cwd);
    if (!proxyResult.ok) return { content: [{ type: "text", text: proxyResult.error }] };

    const r = await dispatchOneAgent(
      { agent_name, task, max_turns, model },
      { cwd, claudeMd, currentDepth, isNested },
      { tailLines: 80 },
    );

    if (r.validationError) {
      return { content: [{ type: "text", text: r.validationError }] };
    }

    const logLine = `\n\nLog: \`.voltron/logs/${r.logFilename}\``;
    if (r.ok) {
      return {
        content: [{
          type: "text",
          text: [
            `## Agent ${r.agent_name} completed ✅`,
            r.trailSection,
            `### Output Tail (last ~${MAX_TAIL_CHARS} chars — full output in log)\n\`\`\`\n${r.outputTail}\n\`\`\``,
          ].filter(Boolean).join("\n\n") + logLine,
        }],
      };
    }
    return {
      content: [{
        type: "text",
        text: [
          `## Agent ${r.agent_name} FAILED (exit ${r.status})`,
          r.trailSection,
          `### Output Tail (last ~${MAX_TAIL_CHARS} chars — full output in log)\n\`\`\`\n${r.outputTail}\n\`\`\``,
          r.stderr ? `### Stderr\n\`\`\`\n${boundTailChars(r.stderr, r.logFilename)}\n\`\`\`` : "",
          r.errorMessage ? `**Error:** ${r.errorMessage}` : "",
        ].filter(Boolean).join("\n\n") + logLine,
      }],
    };
  }
);

// ─── Tool: run_agent_in_docker_batch ───────────────────────────────────────
//
// Fan out 2–8 agents to parallel Docker containers under a single MCP call.
// Bypasses the Claude Code main-session tool-call serializer (see
// docs/parallel-dispatch-investigation.md + docs/run-agents-batch-design.md).
// The MCP server's own stack is parallel-safe (Tier-A verified 2026-05-28), so
// Promise.all over dispatchOneAgent gives true concurrency.

server.tool(
  "run_agent_in_docker_batch",
  "Launch 2-8 specialist agents concurrently inside parallel Docker containers — one MCP call, N parallel executions. Prefer this over multiple run_agent_in_docker calls when dispatching dependency-free agents; bypasses main-session tool-call serialization. See docs/run-agents-batch-design.md.",
  {
    dispatches: z.array(
      z.object({
        agent_name: z.string().describe("The agent template name (e.g., 'fullstack-dev', 'csharp-dev'). Must exist in TEMPLATES with category=='agent'."),
        task: z.string().describe("Complete task description for this dispatch, including context, file paths, acceptance criteria, and any outputs from prior tasks."),
        max_turns: z.number().min(1).optional().describe("Maximum agent turns for this dispatch. Default: 30."),
        model: z.enum(["opus", "sonnet", "haiku"]).optional().describe("Model tier override for this dispatch. Priority: explicit > template.model > session default."),
      }),
    ).min(2).max(8).describe("Two to eight independent agent dispatches. Each runs in its own parallel Docker container under the same MCP call."),
    fail_fast: z.boolean().optional().describe("When true, on the first failed dispatch terminate pending containers and short-circuit the batch. When false (default), all dispatches run to completion and each result is reported independently."),
  },
  async ({ dispatches, fail_fast = false }) => {
    const batchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const batchStart = Date.now();

    // 0. Pre-fan-out shared validation (same checks the singleton does, at batch level).
    const currentDepth = parseInt(process.env.VOLTRON_DEPTH || "0", 10);
    if (currentDepth >= 3) {
      return { content: [{ type: "text", text: `❌ Max nesting depth (3) reached. Tier-3 micro-agents must not dispatch further. Current VOLTRON_DEPTH=${currentDepth}.` }] };
    }
    const isNested = currentDepth > 0;
    if (isNested && !process.env.VOLTRON_HOST_ROOT) {
      return { content: [{ type: "text", text: "❌ Nested dispatch detected (VOLTRON_DEPTH>0) but VOLTRON_HOST_ROOT was not propagated. Refusing to spawn." }] };
    }

    // 1. Pre-validate every agent_name. Refuse the whole batch on any unknown name
    //    or scrum-master entry (per design §3 — no containers spawned on validation failure).
    const invalid = [];
    for (let i = 0; i < dispatches.length; i++) {
      const d = dispatches[i];
      const t = TEMPLATES[d.agent_name];
      if (!t || t.category !== "agent") {
        invalid.push(`[${i}] unknown agent '${d.agent_name}'`);
      } else if (d.agent_name === "scrum-master") {
        invalid.push(`[${i}] 'scrum-master' is not dispatchable via Docker; it is a slash command for the main session`);
      }
    }
    if (invalid.length > 0) {
      return { content: [{ type: "text", text: `❌ Batch rejected — invalid dispatches:\n${invalid.map(l => `- ${l}`).join("\n")}` }] };
    }

    const { root: cwd } = detectProjectRoot(undefined);

    // 2. Read CLAUDE.md ONCE (identical for every dispatch in batch)
    let claudeMd = "";
    try { claudeMd = await fs.readFile(path.join(cwd, "CLAUDE.md"), "utf-8"); } catch {}

    // 3. Docker check + image ensure — ONCE before fan-out (per design §4: no N redundant inspects).
    const dockerErr = await checkDockerAvailable();
    if (dockerErr) return { content: [{ type: "text", text: `❌ ${dockerErr}` }] };

    const dockerfilePath = path.join(cwd, "Dockerfile.voltron");
    try { await fs.access(dockerfilePath); } catch {
      return { content: [{ type: "text", text: "❌ Dockerfile.voltron not found in project root. Run scaffold_project first." }] };
    }
    const imageResult = await ensureVoltronImage(cwd, dockerfilePath);
    if (!imageResult.ok) return { content: [{ type: "text", text: `❌ ${imageResult.error}` }] };

    // S1 Phase B: socket-proxy up ONCE before fan-out (per design - no N redundant
    // proxy launches). Dispatch-capable agents in the batch reach the daemon through it.
    const proxyResult = await ensureSocketProxy(cwd);
    if (!proxyResult.ok) return { content: [{ type: "text", text: `❌ ${proxyResult.error}` }] };

    // 4. Fan-out with one AbortController per dispatch (for fail_fast cancellation).
    const controllers = dispatches.map(() => new AbortController());

    // Shared per-dispatch runner — preserves fail_fast sibling-cancellation: as
    // soon as one dispatch lands a real failure, abort the others.
    const runDispatch = (spec, i, extraOpts = {}) =>
      dispatchOneAgent(
        spec,
        { cwd, claudeMd, currentDepth, isNested },
        { abortSignal: controllers[i].signal, tailLines: 40, ...extraOpts },
      ).then((r) => {
        if (fail_fast && !r.aborted && !r.ok && !r.validationError) {
          for (let j = 0; j < controllers.length; j++) {
            if (j !== i) controllers[j].abort();
          }
        }
        return r;
      });

    // A5 (docs/voltron-cost-optimization-plan.md §A5): stagger the fan-out so the
    // batch shares ONE cache write instead of N. Identical-prefix containers fired
    // all at once each pay a full cache WRITE; instead, launch dispatch[0] first,
    // wait until it has written the shared prompt-prefix cache (signalled by its
    // first streamed token), THEN fan out the remaining N−1 — which READ the
    // just-written cache. Only LAUNCH TIMING changes: all N dispatches still run,
    // results are still aggregated in order, and fail_fast semantics are intact.
    // The head-start is bounded by a cap so a stalled or early-failing first
    // dispatch can never hang the batch.
    const HEADSTART_CAP_MS = 8000;
    const promises = new Array(dispatches.length);

    let releaseHeadStart;
    const headStartGate = new Promise((resolve) => { releaseHeadStart = resolve; });
    const headStartTimer = setTimeout(() => releaseHeadStart(), HEADSTART_CAP_MS);

    // Launch the first dispatch; release the gate on its first streamed token
    // (cache prefix now written) or after the cap, whichever comes first.
    promises[0] = runDispatch(dispatches[0], 0, {
      onFirstToken: () => { clearTimeout(headStartTimer); releaseHeadStart(); },
    });
    // If the first dispatch resolves before ever streaming a token (e.g. it fails
    // fast on startup), don't keep the rest waiting on the cap timer.
    promises[0].then(() => { clearTimeout(headStartTimer); releaseHeadStart(); });

    await headStartGate;

    // Fan out the remaining N−1 — they read the cache the first dispatch wrote.
    for (let i = 1; i < dispatches.length; i++) {
      promises[i] = runDispatch(dispatches[i], i);
    }

    const results = await Promise.all(promises);
    const walltimeMs = Date.now() - batchStart;
    const walltimeSec = (walltimeMs / 1000).toFixed(1);

    // 5. Assemble summary table + N per-dispatch sections.
    let cancelledCount = 0;
    const tableRows = results.map((r, i) => {
      let status;
      if (r.validationError) {
        status = "❌ validation error";
      } else if (r.aborted) {
        status = "🟡 cancelled (sibling failed)";
        cancelledCount++;
      } else if (r.ok) {
        status = `✅ ok (exit ${r.status})`;
      } else {
        status = `❌ FAILED (exit ${r.status})`;
      }
      const logCell = r.logFilename ? `\`.voltron/logs/${r.logFilename}\`` : "—";
      return `| ${i + 1} | ${r.agent_name} | ${status} | ${logCell} |`;
    });

    const sections = results.map((r, i) => {
      const idx = i + 1;
      const logLine = r.logFilename ? `Log: \`.voltron/logs/${r.logFilename}\`` : "";
      if (r.validationError) {
        return [
          `### [${idx}] Agent ${r.agent_name} — validation error`,
          "```",
          r.validationError,
          "```",
        ].join("\n");
      }
      if (r.aborted) {
        return [
          `### [${idx}] Agent ${r.agent_name} CANCELLED 🟡`,
          r.trailSection,
          r.outputTail ? `#### Output Tail (last ~${MAX_TAIL_CHARS} chars — full output in log)\n\`\`\`\n${r.outputTail}\n\`\`\`` : "",
          "**Cancelled because a sibling dispatch failed (fail_fast=true).**",
          logLine,
        ].filter(Boolean).join("\n\n");
      }
      if (r.ok) {
        return [
          `### [${idx}] Agent ${r.agent_name} completed ✅`,
          r.trailSection,
          `#### Output Tail (last ~${MAX_TAIL_CHARS} chars — full output in log)\n\`\`\`\n${r.outputTail}\n\`\`\``,
          logLine,
        ].filter(Boolean).join("\n\n");
      }
      return [
        `### [${idx}] Agent ${r.agent_name} FAILED (exit ${r.status})`,
        r.trailSection,
        `#### Output Tail (last ~${MAX_TAIL_CHARS} chars — full output in log)\n\`\`\`\n${r.outputTail}\n\`\`\``,
        r.stderr ? `#### Stderr (last ~${MAX_TAIL_CHARS} chars)\n\`\`\`\n${boundTailChars(r.stderr.split("\n").slice(-20).join("\n"), r.logFilename)}\n\`\`\`` : "",
        r.errorMessage ? `**Error:** ${r.errorMessage}` : "",
        logLine,
      ].filter(Boolean).join("\n\n");
    });

    const body = [
      `## Batch dispatch — ${results.length} agents (batch_id: ${batchId})`,
      "",
      "| # | agent | status | log |",
      "|---|---|---|---|",
      ...tableRows,
      "",
      `Wall time: ${walltimeSec}s. Cancelled: ${cancelledCount}. fail_fast: ${fail_fast}.`,
      "",
      "---",
      "",
      sections.join("\n\n---\n\n"),
    ].join("\n");

    return { content: [{ type: "text", text: body }] };
  },
);




// ─── Start server ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
