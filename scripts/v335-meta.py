#!/usr/bin/env python3
"""v3.3.5 meta: bump versions, build:apm, update docs."""
import json, os, re, subprocess, sys
os.chdir(os.path.join(os.path.dirname(__file__), ".."))

with open("package.json", "r", encoding="utf-8") as f:
    pkg = json.load(f)
assert pkg["version"] == "3.3.4"
pkg["version"] = "3.3.5"
with open("package.json", "w", encoding="utf-8") as f:
    json.dump(pkg, f, indent=2); f.write("\n")
print("package.json: 3.3.4 -> 3.3.5")

with open("apm.yml", "r", encoding="utf-8") as f:
    apm = f.read()
apm = re.sub(r"^version: .+$", "version: 3.3.5", apm, flags=re.MULTILINE)
with open("apm.yml", "w", encoding="utf-8") as f:
    f.write(apm)
print("apm.yml: version -> 3.3.5")

r = subprocess.run(["node", "scripts/build-apm-manifest.js"], capture_output=True, text=True, timeout=30)
if r.returncode != 0: print("FAILED:", r.stderr or r.stdout); sys.exit(1)
print(r.stdout.strip())

with open("docs/index.html", "r", encoding="utf-8") as f:
    html = f.read()
assert html.count('<span class="badge">v3.3.4</span>') == 1
html = html.replace('<span class="badge">v3.3.4</span>', '<span class="badge">v3.3.5</span>', 1)
assert html.count('v3.3.4 &middot;') == 1
html = html.replace('v3.3.4 &middot;', 'v3.3.5 &middot;', 1)
with open("docs/index.html", "w", encoding="utf-8") as f:
    f.write(html)
print("docs/index.html: v3.3.5 badge + footer")

# Verify scene-architect.agent.md actually got coplay tools
with open(".apm/agents/scene-architect.agent.md", "r", encoding="utf-8") as f:
    c = f.read()
assert "mcp__coplay-mcp__create_game_object" in c
assert "mcp__coplay-mcp__list_game_objects_in_hierarchy" in c
print(".apm/agents/scene-architect.agent.md: coplay tools verified")

print("SUCCESS: v3.3.5 meta")
