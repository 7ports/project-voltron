#!/usr/bin/env python3
"""v3.3a: APM integration — adds build:apm script to package.json,
updates reflection-processor workflow to run build:apm after version bumps,
adds APM status check to setup_voltron health report, and runs
build-apm-manifest.js to generate .apm/agents/.
Run from repo root: python3 scripts/v33a-apm.py
"""
import sys, os, json, subprocess
os.chdir(os.path.join(os.path.dirname(__file__), ".."))

# ── 1. package.json — add build:apm script ─────────────────────────────────────

with open("package.json", "r", encoding="utf-8") as f:
    pkg = json.load(f)

if "build:apm" not in pkg.get("scripts", {}):
    pkg["scripts"]["build:apm"] = "node scripts/build-apm-manifest.js"
    with open("package.json", "w", encoding="utf-8") as f:
        json.dump(pkg, f, indent=2)
        f.write("\n")
    print("package.json: added build:apm script")
else:
    print("package.json: build:apm already present, skipping")

# ── 2. templates.js — update reflection-processor Direct Modification Mode ─────

with open("src/templates.js", "r", encoding="utf-8") as f:
    content = f.read()

# 2a. Direct Modification Mode: insert build:apm step after version bump (step 6)
OLD_DIRECT = (
    "6. **Bump the version** in \\`package.json\\` — patch for improvements, minor for new agents/features\n"
    "7. **Update docs/index.html and README.md** — keep version badges, agent counts, and descriptions in sync\n"
    "8. **Commit** with a clear message describing what changed and why"
)
NEW_DIRECT = (
    "6. **Bump the version** in \\`package.json\\` — patch for improvements, minor for new agents/features\n"
    "7. **Rebuild APM manifest:** \\`npm run build:apm\\` — regenerates \\`.apm/agents/\\` and syncs \\`apm.yml\\` version\n"
    "8. **Update docs/index.html and README.md** — keep version badges, agent counts, and descriptions in sync\n"
    "9. **Commit** with a clear message describing what changed and why"
)
assert content.count(OLD_DIRECT) == 1, f"Direct Mode anchor not unique: {content.count(OLD_DIRECT)}"
content = content.replace(OLD_DIRECT, NEW_DIRECT, 1)
print("templates.js: Direct Modification Mode — build:apm step inserted (step 7)")

# 2b. Reflection Processing Mode: insert build:apm after patch version bump (step 8)
OLD_REFLECTION = (
    "8. **Bump the patch version** in \\`package.json\\`.\n"
    "9. **Update \\`docs/index.html\\`** and \\`README.md\\` if agent behavior descriptions changed.\n"
    "10. **Commit** all changes."
)
NEW_REFLECTION = (
    "8. **Bump the patch version** in \\`package.json\\`.\n"
    "9. **Rebuild APM manifest:** \\`npm run build:apm\\`\n"
    "10. **Update \\`docs/index.html\\`** and \\`README.md\\` if agent behavior descriptions changed.\n"
    "11. **Commit** all changes."
)
assert content.count(OLD_REFLECTION) == 1, f"Reflection Mode anchor not unique: {content.count(OLD_REFLECTION)}"
content = content.replace(OLD_REFLECTION, NEW_REFLECTION, 1)
print("templates.js: Reflection Processing Mode — build:apm step inserted (step 9)")

with open("src/templates.js", "w", encoding="utf-8") as f:
    f.write(content)

# Verify syntax
r1 = subprocess.run(["node", "--check", "src/templates.js"], capture_output=True, text=True)
if r1.returncode != 0:
    print("SYNTAX ERROR:", r1.stderr); sys.exit(1)
r2 = subprocess.run(
    ["node", "--input-type=module", "-e",
     "import('./src/templates.js').then(() => console.log('PARSE OK')).catch(e => { console.error(e.message); process.exit(1); })"],
    capture_output=True, text=True, timeout=15
)
if r2.returncode != 0:
    print("PARSE ERROR:", r2.stderr or r2.stdout); sys.exit(1)
print(r2.stdout.strip())

# ── 3. index.js — add APM status check to setup_voltron health report ──────────

with open("src/index.js", "r", encoding="utf-8") as f:
    js = f.read()

# Insert APM detection block before "// Build report"
APM_BLOCK = r"""
    // Check APM (Agent Package Manager — optional, enhances install experience)
    let apmStatus = "";
    try {
      execSync("apm --version", { stdio: "ignore", timeout: 5000 });
      apmStatus = "✓ Installed — `apm install 7ports/project-voltron` reinstalls all agents + MCP";
    } catch {
      apmStatus = "not installed (optional) — `pip install apm-cli` for one-command agent deployment";
    }

"""

ANCHOR_OLD = "    // Build report\n    const allowStatus = missingAllow.length === 0"
ANCHOR_NEW = APM_BLOCK + "    // Build report\n    const allowStatus = missingAllow.length === 0"
assert js.count(ANCHOR_OLD) == 1, f"Build-report anchor not unique: {js.count(ANCHOR_OLD)}"
js = js.replace(ANCHOR_OLD, ANCHOR_NEW, 1)
print("index.js: APM detection block inserted before Build report")

# Add APM status line to report after Stringer line
OLD_STRINGER_LINE = '      `- **Stringer:** ${stringerStatus}`,'
NEW_STRINGER_LINE = '      `- **Stringer:** ${stringerStatus}`,\n      `- **APM:** ${apmStatus}`,'
assert js.count(OLD_STRINGER_LINE) == 1, f"Stringer report line not unique: {js.count(OLD_STRINGER_LINE)}"
js = js.replace(OLD_STRINGER_LINE, NEW_STRINGER_LINE, 1)
print("index.js: APM status added to health check report")

with open("src/index.js", "w", encoding="utf-8") as f:
    f.write(js)

r3 = subprocess.run(["node", "--check", "src/index.js"], capture_output=True, text=True)
if r3.returncode != 0:
    print("SYNTAX ERROR:", r3.stderr); sys.exit(1)
print("node --check src/index.js: OK")

# ── 4. Run build-apm-manifest.js to generate .apm/agents/ ──────────────────────

r4 = subprocess.run(
    ["node", "scripts/build-apm-manifest.js"],
    capture_output=True, text=True, timeout=30
)
if r4.returncode != 0:
    print("build-apm-manifest.js FAILED:", r4.stderr or r4.stdout); sys.exit(1)
print(r4.stdout.strip())

# ── 5. Verify .apm/agents/ ──────────────────────────────────────────────────────

agent_files = [f for f in os.listdir(".apm/agents") if f.endswith(".agent.md")]
assert len(agent_files) >= 60, f"Expected at least 60 agent files, got {len(agent_files)}"
assert "scrum-master.agent.md" in agent_files, "scrum-master.agent.md missing"
assert "code-analyst.agent.md" in agent_files, "code-analyst.agent.md missing"
assert "stringer-baseline-builder.agent.md" in agent_files, "stringer-baseline-builder.agent.md missing"
print(f".apm/agents/: {len(agent_files)} agent files verified")

print("SUCCESS: v33a - APM integration complete")
