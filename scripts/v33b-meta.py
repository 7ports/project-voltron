#!/usr/bin/env python3
"""v3.3b: Bump package.json to v3.3.0; update docs/index.html
(v3.3.0 badge, APM section); sync apm.yml version.
Run from repo root: python3 scripts/v33b-meta.py
"""
import sys, os, json, subprocess
os.chdir(os.path.join(os.path.dirname(__file__), ".."))

# ── 1. package.json ────────────────────────────────────────────────────────────

with open("package.json", "r", encoding="utf-8") as f:
    pkg = json.load(f)

assert pkg["version"] == "3.2.0", f"Unexpected version: {pkg['version']} (expected 3.2.0)"
pkg["version"] = "3.3.0"

with open("package.json", "w", encoding="utf-8") as f:
    json.dump(pkg, f, indent=2)
    f.write("\n")

print("package.json: 3.2.0 -> 3.3.0")

# ── 2. apm.yml — sync version ──────────────────────────────────────────────────

import re
with open("apm.yml", "r", encoding="utf-8") as f:
    apm_yml = f.read()

apm_yml = re.sub(r'^version: .+$', 'version: 3.3.0', apm_yml, flags=re.MULTILINE)

with open("apm.yml", "w", encoding="utf-8") as f:
    f.write(apm_yml)

assert "version: 3.3.0" in apm_yml
print("apm.yml: version -> 3.3.0")

# ── 3. Rebuild .apm/agents/ ────────────────────────────────────────────────────

r = subprocess.run(
    ["node", "scripts/build-apm-manifest.js"],
    capture_output=True, text=True, timeout=30
)
if r.returncode != 0:
    print("build-apm-manifest.js FAILED:", r.stderr or r.stdout); sys.exit(1)
print(r.stdout.strip())

# ── 4. docs/index.html ─────────────────────────────────────────────────────────

with open("docs/index.html", "r", encoding="utf-8") as f:
    html = f.read()

# 4a. Version badge
assert html.count('<span class="badge">v3.2.0</span>') == 1, "version badge not unique"
html = html.replace('<span class="badge">v3.2.0</span>', '<span class="badge">v3.3.0</span>', 1)

# 4b. Footer version
assert html.count('v3.2.0 &middot;') == 1, "footer version not unique"
html = html.replace('v3.2.0 &middot;', 'v3.3.0 &middot;', 1)

# 4c. Agent count stays at 63 (no new agents in v3.3)

# 4d. Add APM section after the Stringer section (before Install comment)
OLD_INSTALL = '  <!-- Install -->'
APM_SECTION = '''  <!-- APM -->
  <section style="background:#161b22;padding:3rem 0;border-top:1px solid #21262d">
    <div class="container">
      <h2>Install via APM <span class="badge" style="font-size:0.7rem;vertical-align:middle">v3.3 new</span></h2>
      <p class="section-sub">One command deploys all 63 agents + MCP server registration using the <a href="https://github.com/microsoft/apm" style="color:#58a6ff">Agent Package Manager</a>.</p>
      <div style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:1.25rem 1.5rem;margin:1.5rem 0;font-family:monospace;font-size:0.9rem">
        <div style="color:#8b949e;margin-bottom:0.5rem"># Install APM (once)</div>
        <div style="color:#e6edf3">pip install apm-cli</div>
        <br/>
        <div style="color:#8b949e;margin-bottom:0.5rem"># Deploy Voltron to Claude Code (any project)</div>
        <div style="color:#e6edf3">apm install 7ports/project-voltron</div>
      </div>
      <p style="color:#8b949e;font-size:0.85rem">APM automatically deploys all agent <code>.md</code> files to <code>.claude/agents/</code> and registers the Voltron MCP server in <code>~/.claude.json</code>. Claude can run this command on itself. The <code>apm.yml</code> manifest is always kept in sync with the latest agent set — when new agents are added to Voltron, run <code>apm update 7ports/project-voltron</code> to get them.</p>
      <p style="color:#8b949e;font-size:0.85rem;margin-top:0.75rem">The classic <code>setup_voltron</code> MCP tool remains the primary setup path and works without APM. APM is an additional convenience for users who prefer a CLI-first workflow.</p>
    </div>
  </section>

  <!-- Install -->'''

assert html.count(OLD_INSTALL) == 1, f"install comment not unique: {html.count(OLD_INSTALL)}"
html = html.replace(OLD_INSTALL, APM_SECTION, 1)

# Verify
assert "v3.3.0" in html, "version not updated"
assert "apm install 7ports/project-voltron" in html, "APM section not inserted"

with open("docs/index.html", "w", encoding="utf-8") as f:
    f.write(html)

print("docs/index.html: v3.3.0 badge, APM section added")
print("SUCCESS: v33b - version 3.3.0, docs updated, apm.yml synced")
