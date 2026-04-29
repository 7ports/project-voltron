#!/usr/bin/env python3
"""v3.4.0: Make beads, stringer, and alexandria HARD-MANDATORY dependencies.

User reported the Stringer integration is too loose — Claude can't even
work out how to install Stringer, and Stringer is marked "optional" when
it shouldn't be. Same logic applies to beads and Alexandria — they're
treated as optional/warn-only when they're foundational to the v3 design.

This release flips all three from optional to mandatory across every
layer where the requirement should land:

  1. Dockerfile.voltron — installs beads + stringer in the agent
     container so Tier-3 agents have access to the same toolchain
     scrum-master uses on the host. (Alexandria is host-only — it's an
     MCP server registered in ~/.claude.json, so containers don't need it.)

  2. setup_voltron MCP tool — hard-fails if any of the three are missing,
     with the exact install command shown. Not optional warnings; the
     report makes the missing dep impossible to ignore.

  3. scrum-master template's Pre-Flight Check — turns "warn / fall back"
     and "(optional)" language into "STOP — install first" hard fails.

  4. CLAUDE.md templates (unity, web, general) — adds a "Mandatory
     Dependencies" section right after the header, listing all three
     with one-line install commands and what each is for.

  5. README.md — strikes "Optional: beads" and replaces the prerequisites
     section with the three required tools.

Install commands used throughout:
  beads:      npm install -g @beads/bd       (cross-platform)
              brew install beads              (macOS / Linux alt)
  stringer:   go install github.com/davetashner/stringer/cmd/stringer@latest
              (or pre-built binary from GitHub releases)
              brew install davetashner/tap/stringer (macOS alt)
  alexandria: git clone https://github.com/7ports/project-alexandria
              cd project-alexandria/mcp-server && npm install
              then register in ~/.claude.json mcpServers

Run from repo root: python3 scripts/v340-mandatory-deps.py
"""
import os
import re
import subprocess
import sys

os.chdir(os.path.join(os.path.dirname(__file__), ".."))

with open("src/templates.js", "r", encoding="utf-8") as f:
    tpl = f.read()
with open("src/index.js", "r", encoding="utf-8") as f:
    idx = f.read()

# ════════════════════════════════════════════════════════════════════════════
# FIX 1 — Dockerfile.voltron: install beads + stringer in the agent container
# ════════════════════════════════════════════════════════════════════════════

OLD_DOCKERFILE = (
    "export const DOCKERFILE_CONTENT =\n"
    '  "FROM node:20-slim\\n" +\n'
    '  "\\n" +\n'
    '  "# System tools for multi-language development\\n" +\n'
    '  "RUN apt-get update && apt-get install -y --no-install-recommends \\\\\\n" +\n'
    '  "    git \\\\\\n" +\n'
    '  "    curl \\\\\\n" +\n'
    '  "    wget \\\\\\n" +\n'
    '  "    python3 \\\\\\n" +\n'
    '  "    python3-pip \\\\\\n" +\n'
    '  "    python3-venv \\\\\\n" +\n'
    '  "    ruby \\\\\\n" +\n'
    '  "    ruby-dev \\\\\\n" +\n'
    '  "    build-essential \\\\\\n" +\n'
    '  "    zip \\\\\\n" +\n'
    '  "    unzip \\\\\\n" +\n'
    '  "    jq \\\\\\n" +\n'
    '  "    ca-certificates \\\\\\n" +\n'
    '  "    && rm -rf /var/lib/apt/lists/*\\n" +\n'
    '  "\\n" +\n'
    '  "# Install Claude Code globally\\n" +\n'
    '  "RUN npm install -g @anthropic-ai/claude-code\\n" +\n'
    '  "\\n" +\n'
    '  "# Non-root user for security\\n" +\n'
    '  "RUN useradd -m -s /bin/bash voltron\\n" +\n'
    '  "USER voltron\\n" +\n'
    '  "WORKDIR /workspace\\n" +\n'
    '  \'ENTRYPOINT ["claude"]\';'
)

NEW_DOCKERFILE = (
    "export const DOCKERFILE_CONTENT =\n"
    '  "FROM node:20-slim\\n" +\n'
    '  "\\n" +\n'
    '  "# System tools for multi-language development\\n" +\n'
    '  "RUN apt-get update && apt-get install -y --no-install-recommends \\\\\\n" +\n'
    '  "    git \\\\\\n" +\n'
    '  "    curl \\\\\\n" +\n'
    '  "    wget \\\\\\n" +\n'
    '  "    python3 \\\\\\n" +\n'
    '  "    python3-pip \\\\\\n" +\n'
    '  "    python3-venv \\\\\\n" +\n'
    '  "    ruby \\\\\\n" +\n'
    '  "    ruby-dev \\\\\\n" +\n'
    '  "    build-essential \\\\\\n" +\n'
    '  "    zip \\\\\\n" +\n'
    '  "    unzip \\\\\\n" +\n'
    '  "    jq \\\\\\n" +\n'
    '  "    ca-certificates \\\\\\n" +\n'
    '  "    && rm -rf /var/lib/apt/lists/*\\n" +\n'
    '  "\\n" +\n'
    '  "# Install Claude Code globally\\n" +\n'
    '  "RUN npm install -g @anthropic-ai/claude-code\\n" +\n'
    '  "\\n" +\n'
    '  "# v3.4.0: mandatory voltron dependencies\\n" +\n'
    '  "# beads (gastownhall/beads) — dependency-aware task tracking; required by scrum-master\\n" +\n'
    '  "RUN npm install -g @beads/bd\\n" +\n'
    '  "\\n" +\n'
    '  "# stringer (davetashner/stringer v1.7.0) — codebase baseline analysis; required by code-analyst\\n" +\n'
    '  "RUN STRINGER_VERSION=1.7.0 && \\\\\\n" +\n'
    '  "    curl -fsSL https://github.com/davetashner/stringer/releases/download/v${STRINGER_VERSION}/stringer_${STRINGER_VERSION}_linux_amd64.tar.gz -o /tmp/stringer.tgz && \\\\\\n" +\n'
    '  "    mkdir -p /tmp/stringer-extract && \\\\\\n" +\n'
    '  "    tar -xzf /tmp/stringer.tgz -C /tmp/stringer-extract && \\\\\\n" +\n'
    '  "    find /tmp/stringer-extract -name stringer -type f -executable -exec mv {} /usr/local/bin/ \\\\; && \\\\\\n" +\n'
    '  "    chmod +x /usr/local/bin/stringer && \\\\\\n" +\n'
    '  "    rm -rf /tmp/stringer.tgz /tmp/stringer-extract\\n" +\n'
    '  "\\n" +\n'
    '  "# Non-root user for security\\n" +\n'
    '  "RUN useradd -m -s /bin/bash voltron\\n" +\n'
    '  "USER voltron\\n" +\n'
    '  "WORKDIR /workspace\\n" +\n'
    '  \'ENTRYPOINT ["claude"]\';'
)

if OLD_DOCKERFILE in tpl:
    n = tpl.count(OLD_DOCKERFILE)
    assert n == 1, f"Dockerfile anchor not unique: {n}"
    tpl = tpl.replace(OLD_DOCKERFILE, NEW_DOCKERFILE, 1)
    print("templates.js: DOCKERFILE_CONTENT now installs beads + stringer")
elif "v3.4.0: mandatory voltron dependencies" in tpl:
    print("templates.js: DOCKERFILE_CONTENT already has v3.4.0 deps (idempotent skip)")
else:
    raise AssertionError("Dockerfile anchor not found")

# ════════════════════════════════════════════════════════════════════════════
# FIX 2 — setup_voltron in src/index.js: hard-fail on missing deps
# ════════════════════════════════════════════════════════════════════════════

# 2a. Replace the entire Stringer block (which says "(optional)") with a
# new block that's mandatory + adds beads + adds Alexandria checks.

OLD_STRINGER_BLOCK = """    // Check Stringer (optional — codebase baseline analysis)
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
    }"""

NEW_MANDATORY_BLOCK = """    // v3.4.0: hard-mandatory dependency checks for beads, stringer, alexandria.
    // Each missing dep is a blocking failure surfaced prominently in the report.
    const blockingFailures = [];

    // ─── beads ─── dependency-aware task tracking (required by scrum-master)
    let beadsStatus = "";
    let beadsInstalled = false;
    try {
      execSync("bd --version", { stdio: "ignore", timeout: 5000 });
      beadsInstalled = true;
    } catch { /* not installed */ }

    if (beadsInstalled) {
      beadsStatus = "✓ Installed";
    } else {
      beadsStatus = "❌ NOT INSTALLED — mandatory. Run: `npm install -g @beads/bd` (or `brew install beads`)";
      blockingFailures.push({
        name: "beads",
        why: "scrum-master requires beads for dependency-aware task tracking; without it, the bead graph cannot enforce task dependencies and the work plan reverts to manual sequencing.",
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
          install: `Re-clone https://github.com/7ports/project-alexandria, run \\`npm install\\` in mcp-server/, then update ~/.claude.json mcpServers.alexandria.args[0] to the new path`,
          alt: "",
        });
      }
    } else {
      alexandriaStatus = "❌ NOT REGISTERED — mandatory. Clone project-alexandria and register the MCP";
      blockingFailures.push({
        name: "alexandria",
        why: "Every Voltron agent that touches tools/setup is required to consult Alexandria first (search_guides → quick_setup) and update_guide after. Without the MCP registered, the agents can call the tool but the tool won't respond.",
        install: "git clone https://github.com/7ports/project-alexandria ~/Documents/project-alexandria && cd ~/Documents/project-alexandria/mcp-server && npm install",
        alt: "Then add to ~/.claude.json:\\n```json\\n\\\"alexandria\\\": { \\\"command\\\": \\\"node\\\", \\\"args\\\": [\\\"<absolute path to project-alexandria>/mcp-server/index.js\\\"] }\\n```",
      });
    }"""

if OLD_STRINGER_BLOCK in idx:
    n = idx.count(OLD_STRINGER_BLOCK)
    assert n == 1, f"Stringer block anchor not unique: {n}"
    idx = idx.replace(OLD_STRINGER_BLOCK, NEW_MANDATORY_BLOCK, 1)
    print("index.js: setup_voltron — Stringer block replaced with mandatory beads/stringer/alexandria checks")
elif "v3.4.0: hard-mandatory dependency checks" in idx:
    print("index.js: setup_voltron mandatory checks already present (idempotent skip)")
else:
    raise AssertionError("Stringer block anchor in setup_voltron not found")

# 2b. Update the report section to surface the blocking failures + show the new
# beads / alexandria status lines.

OLD_REPORT_LINES = """    const report = [
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
    ].join("\\n");"""

NEW_REPORT_LINES = """    // Build blocking-failure section if any mandatory deps are missing
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
        `**Install:** \\`${f.install}\\``,
        ...(f.alt ? ["", `**Alternative:** ${f.alt}`] : []),
        "",
      ]),
      "After installing, run `setup_voltron` again to verify.",
      "",
    ].join("\\n");

    const report = [
      "## Project Voltron Health Check",
      "",
      `- **MCP Server:** ${mcpStatus}`,
      `- **Allowlist:** ${allowStatus}`,
      `- **Deny rules:** ${denyStatus}`,
      `- **beads (mandatory):** ${beadsStatus}`,
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
    ].join("\\n");"""

if OLD_REPORT_LINES in idx:
    n = idx.count(OLD_REPORT_LINES)
    assert n == 1, f"report-lines anchor not unique: {n}"
    idx = idx.replace(OLD_REPORT_LINES, NEW_REPORT_LINES, 1)
    print("index.js: setup_voltron report — beads/stringer/alexandria status lines added + blocking-failure section")
elif "MANDATORY DEPENDENCIES MISSING" in idx:
    print("index.js: setup_voltron report already has mandatory section (idempotent skip)")
else:
    raise AssertionError("setup_voltron report anchor not found")

# ════════════════════════════════════════════════════════════════════════════
# FIX 3 — scrum-master Pre-Flight Check: turn warnings into hard fails
# ════════════════════════════════════════════════════════════════════════════

OLD_PREFLIGHT = """### Pre-Flight Check (Required)

Run before creating any work plan:
\\`\\`\\`bash
docker --version                                                   # Docker available?
test -f Dockerfile.voltron && echo "OK" || echo "MISSING"         # Dockerfile present?
echo "Token: $(test -n "$CLAUDE_CODE_OAUTH_TOKEN" && echo YES || echo NO)"  # OAuth token?
bd --version 2>/dev/null && echo "beads OK" || echo "beads missing"          # beads CLI?
\\`\\`\\`

- **Docker missing** → "Docker is not installed or not running. Install Docker Desktop, then retry."
- **Dockerfile missing** → "Run \\`mcp__project-voltron__scaffold_project\\` first."
- **Token missing** → Agents fail silently with "Not logged in". Check Alexandria guide \\`project-voltron-docker\\` before proceeding.
- **beads missing** → warn, fall back to manual dependency tracking. Install: \\`npm install -g @beads/bd\\`
- **Voltron MCP tools unavailable** (e.g. \\`mcp__project-voltron__update_progress\\` not found) → The MCP server is not loaded in this session. Tell the user: "Voltron MCP is not connected. Quit and relaunch Claude Code — the auto-update hook will register it in global settings on the next session start." Do not attempt to proceed with progress tracking or Docker agent invocations until the MCP is confirmed available.
- **Stringer not installed** (optional) → codebase analysis works without it; install stringer and run \\`@agent-stringer-baseline-builder\\` to enable baseline analysis and delta checks.
- """ + r'**Stringer baseline stale** (>14 days or >50 commits since last scan) → surface a refresh suggestion: \"Run @agent-stringer-baseline-builder to refresh the codebase baseline.\"'

# Build NEW_PREFLIGHT in pieces to avoid Python parser confusion with \\""" sequences
_NP_HEAD = """### Pre-Flight Check (Required)

Run before creating any work plan:
\\`\\`\\`bash
docker --version                                                                        # Docker available?
test -f Dockerfile.voltron && echo "OK" || echo "MISSING"                              # Dockerfile present?
echo "Token: $(test -n "$CLAUDE_CODE_OAUTH_TOKEN" && echo YES || echo NO)"             # OAuth token?
bd --version 2>/dev/null && echo "beads OK" || echo "BEADS MISSING"                    # beads CLI (mandatory)?
stringer --version 2>/dev/null && echo "stringer OK" || echo "STRINGER MISSING"        # stringer CLI (mandatory)?
node -e "process.exit(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.claude.json')).mcpServers?.alexandria ? 0 : 1)" 2>/dev/null && echo "alexandria OK" || echo "ALEXANDRIA MISSING"  # Alexandria MCP (mandatory)?
\\`\\`\\`

**Mandatory dependencies — STOP and install if any are missing.** Voltron will not function correctly without all three (beads, stringer, alexandria); these are not optional, and the user expectation is that scaffolding/setup accounts for them.

- **Docker missing** → "Docker is not installed or not running. Install Docker Desktop, then retry."
- **Dockerfile missing** → "Run \\`mcp__project-voltron__scaffold_project\\` first."
- **Token missing** → Agents fail silently with "Not logged in". Check Alexandria guide \\`project-voltron-docker\\` before proceeding.
- **beads MISSING (mandatory)** → STOP. Tell the user: "beads is mandatory and not installed. Run \\`npm install -g @beads/bd\\` (or \\`brew install beads\\`) and retry. Do not proceed without it."
- **stringer MISSING (mandatory)** → STOP. Tell the user: "stringer is mandatory and not installed. Run \\`go install github.com/davetashner/stringer/cmd/stringer@latest\\` (or download a release binary from https://github.com/davetashner/stringer/releases/latest, or \\`brew install davetashner/tap/stringer\\` on macOS) and retry. Do not proceed without it."
"""
_NP_ALEX = r'- **alexandria MISSING (mandatory)** → STOP. Tell the user: "Alexandria MCP is mandatory and not registered. Clone https://github.com/7ports/project-alexandria, run \`npm install\` in mcp-server/, then add it to \`~/.claude.json\` mcpServers as \`{ \"command\": \"node\", \"args\": [\"<path>/mcp-server/index.js\"] }\` and restart Claude Code. Do not proceed without it."'
_NP_TAIL = """
- **Voltron MCP tools unavailable** (e.g. \\`mcp__project-voltron__update_progress\\` not found) → The MCP server is not loaded in this session. Tell the user: "Voltron MCP is not connected. Quit and relaunch Claude Code — the auto-update hook will register it in global settings on the next session start." Do not attempt to proceed with progress tracking or Docker agent invocations until the MCP is confirmed available.
"""
_NP_STALE = r'- **Stringer baseline stale** (>14 days or >50 commits since last scan) → surface a refresh suggestion: \"Run @agent-stringer-baseline-builder to refresh the codebase baseline.\"'

NEW_PREFLIGHT = _NP_HEAD + _NP_ALEX + _NP_TAIL + _NP_STALE

if OLD_PREFLIGHT in tpl:
    n = tpl.count(OLD_PREFLIGHT)
    assert n == 1, f"preflight anchor not unique: {n}"
    tpl = tpl.replace(OLD_PREFLIGHT, NEW_PREFLIGHT, 1)
    print("templates.js: scrum-master Pre-Flight Check now hard-fails on beads/stringer/alexandria")
elif "Mandatory dependencies — STOP and install" in tpl:
    print("templates.js: scrum-master preflight already updated (idempotent skip)")
else:
    raise AssertionError("scrum-master preflight anchor not found")

# ════════════════════════════════════════════════════════════════════════════
# FIX 4 — Add Mandatory Dependencies section to all 3 CLAUDE.md templates
# ════════════════════════════════════════════════════════════════════════════

MANDATORY_DEPS_SECTION = """## Mandatory Dependencies

Voltron's three-tier agent model relies on three external tools. Setup/scaffold accounts for all of them; if any is missing, run the install command before invoking agents.

| Tool | Purpose | Install (cross-platform) | Alternative |
|---|---|---|---|
| **beads** ([gastownhall/beads](https://github.com/gastownhall/beads)) | Dependency-aware task tracking — drives the bead graph that scrum-master uses to enforce task ordering. | \\`npm install -g @beads/bd\\` | \\`brew install beads\\` (macOS / Linux) |
| **stringer** ([davetashner/stringer](https://github.com/davetashner/stringer)) | Codebase baseline analysis — read by code-analyst before every audit. | \\`go install github.com/davetashner/stringer/cmd/stringer@latest\\` (needs Go) | Pre-built binary from [releases](https://github.com/davetashner/stringer/releases/latest), or \\`brew install davetashner/tap/stringer\\` (macOS) |
| **alexandria** ([7ports/project-alexandria](https://github.com/7ports/project-alexandria)) | Tooling/setup guides — every agent calls \\`mcp__alexandria__quick_setup\\` before installing any tool, and \\`update_guide\\` after. | \\`git clone\\` + \\`npm install\\` in \\`mcp-server/\\` + register MCP server in \\`~/.claude.json\\` | (none — required setup) |

Verify all three by running \\`mcp__project-voltron__setup_voltron\\` — it hard-fails with install commands if any are missing.

---

"""

for k in ["claude-md-unity", "claude-md-web", "claude-md-general"]:
    # Anchor: insertion point is the first `---\n\n## Project Identity` after the header
    pattern = r'(  "' + k + r'":\s*\{[^`]*?content:\s*`# CLAUDE\.md[^\n]+\n\n> [^\n]+\n> [^\n]+\n\n)(---\n\n## Project Identity)'
    m = re.search(pattern, tpl)
    if not m:
        # Idempotent check
        body_check = re.search(r'  "' + k + r'":\s*\{[^`]*?content:\s*`(.{0,500})', tpl)
        if body_check and "## Mandatory Dependencies" in body_check.group(1):
            print(f"templates.js: {k} already has Mandatory Dependencies section (idempotent skip)")
            continue
        raise AssertionError(f"{k}: insertion-point anchor not found")
    insertion_point = m.end(1)
    tpl = tpl[:insertion_point] + MANDATORY_DEPS_SECTION + tpl[insertion_point:]
    print(f"templates.js: {k} — Mandatory Dependencies section inserted")

# ════════════════════════════════════════════════════════════════════════════
# FIX 5 — README.md: strike "Optional" language; require all three tools
# ════════════════════════════════════════════════════════════════════════════

with open("README.md", "r", encoding="utf-8") as f:
    rdm = f.read()

OLD_README_BEADS = "### Optional: beads dependency tracker\n\nThe scrum-master uses [beads](https://github.com/gastownhall/beads) for dependency-aware task orchestration:"
NEW_README_BEADS = """### Required: beads dependency tracker

The scrum-master uses [beads](https://github.com/gastownhall/beads) for dependency-aware task orchestration. **This is mandatory** as of v3.4.0 — agents will refuse to dispatch work plans without a working `bd` CLI:"""

if OLD_README_BEADS in rdm:
    rdm = rdm.replace(OLD_README_BEADS, NEW_README_BEADS, 1)
    print("README.md: 'Optional: beads' -> 'Required: beads' + mandatory note")
elif "### Required: beads dependency tracker" in rdm:
    print("README.md: beads section already marked Required (idempotent skip)")
else:
    print(f"README.md: 'Optional: beads' anchor not found — leaving as-is (may already be updated)")

with open("README.md", "w", encoding="utf-8") as f:
    f.write(rdm)

# ════════════════════════════════════════════════════════════════════════════
# Write + verify
# ════════════════════════════════════════════════════════════════════════════

with open("src/templates.js", "w", encoding="utf-8") as f:
    f.write(tpl)
with open("src/index.js", "w", encoding="utf-8") as f:
    f.write(idx)

# Syntax + parse checks
for jspath in ["src/index.js", "src/templates.js"]:
    r = subprocess.run(["node", "--check", jspath], capture_output=True, text=True)
    if r.returncode != 0:
        print(f"SYNTAX ERROR in {jspath}:", r.stderr); sys.exit(1)
    print(f"node --check {jspath}: OK")

r = subprocess.run(
    ["node", "--input-type=module", "-e",
     "import('./src/templates.js').then(() => console.log('PARSE OK')).catch(e => { console.error(e.message); process.exit(1); })"],
    capture_output=True, text=True, timeout=15
)
if r.returncode != 0:
    print("PARSE ERROR:", r.stderr or r.stdout); sys.exit(1)
print(r.stdout.strip())

# Sanity verifications
assert "RUN npm install -g @beads/bd" in tpl, "Dockerfile missing beads install"
assert "stringer_${STRINGER_VERSION}_linux_amd64" in tpl, "Dockerfile missing stringer install"
assert "v3.4.0: hard-mandatory dependency checks" in idx, "setup_voltron missing v3.4.0 marker"
assert "MANDATORY DEPENDENCIES MISSING" in idx, "setup_voltron report missing blocking section"
assert "Mandatory dependencies — STOP and install" in tpl, "scrum-master preflight not updated"
mandatory_sections = tpl.count("## Mandatory Dependencies")
assert mandatory_sections == 3, f"Mandatory Dependencies should appear in 3 CLAUDE.md templates, got {mandatory_sections}"
print(f"\nVerified: Dockerfile installs beads + stringer; setup_voltron has hard-fail logic;")
print(f"          scrum-master preflight has STOP language for all 3 deps;")
print(f"          {mandatory_sections} CLAUDE.md templates have Mandatory Dependencies section.")
print("\nSUCCESS: v3.4.0 — beads, stringer, alexandria are now mandatory across every layer")
