#!/usr/bin/env python3
"""v3.3.4: Bump package.json + apm.yml; rebuild .apm/agents/; update docs.
Run from repo root: python3 scripts/v334-meta.py
"""
import json, os, re, subprocess, sys
os.chdir(os.path.join(os.path.dirname(__file__), ".."))

# package.json
with open("package.json", "r", encoding="utf-8") as f:
    pkg = json.load(f)
assert pkg["version"] == "3.3.3", f"Unexpected: {pkg['version']}"
pkg["version"] = "3.3.4"
with open("package.json", "w", encoding="utf-8") as f:
    json.dump(pkg, f, indent=2); f.write("\n")
print("package.json: 3.3.3 -> 3.3.4")

# apm.yml
with open("apm.yml", "r", encoding="utf-8") as f:
    apm = f.read()
apm = re.sub(r"^version: .+$", "version: 3.3.4", apm, flags=re.MULTILINE)
with open("apm.yml", "w", encoding="utf-8") as f:
    f.write(apm)
print("apm.yml: version -> 3.3.4")

# Rebuild .apm/agents/
r = subprocess.run(["node", "scripts/build-apm-manifest.js"], capture_output=True, text=True, timeout=30)
if r.returncode != 0:
    print("FAILED:", r.stderr or r.stdout); sys.exit(1)
print(r.stdout.strip())

# docs/index.html
with open("docs/index.html", "r", encoding="utf-8") as f:
    html = f.read()
assert html.count('<span class="badge">v3.3.3</span>') == 1
html = html.replace('<span class="badge">v3.3.3</span>', '<span class="badge">v3.3.4</span>', 1)
assert html.count('v3.3.3 &middot;') == 1
html = html.replace('v3.3.3 &middot;', 'v3.3.4 &middot;', 1)
with open("docs/index.html", "w", encoding="utf-8") as f:
    f.write(html)
print("docs/index.html: v3.3.4 badge + footer")

# Spot-check: csharp-dev's regenerated .apm file shows dispatch tools
with open(".apm/agents/csharp-dev.agent.md", "r", encoding="utf-8") as f:
    c = f.read()
assert "mcp__project-voltron__run_agent_in_docker" in c, "dispatch tool missing in csharp-dev.agent.md"

# committer's regenerated .apm file shows Alexandria section
with open(".apm/agents/committer.agent.md", "r", encoding="utf-8") as f:
    c = f.read()
assert "## Alexandria" in c, "Alexandria section missing in committer.agent.md"
assert "mcp__alexandria__quick_setup" in c, "Alexandria tool missing in committer.agent.md"

print(".apm/agents/: csharp-dev (dispatch) + committer (Alexandria) verified")
print("SUCCESS: v3.3.4 meta")
