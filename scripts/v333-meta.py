#!/usr/bin/env python3
"""v3.3.3: Bump package.json + apm.yml; update docs; rebuild .apm/agents/.
Run from repo root: python3 scripts/v333-meta.py
"""
import json
import os
import re
import subprocess
import sys

os.chdir(os.path.join(os.path.dirname(__file__), ".."))

# package.json
with open("package.json", "r", encoding="utf-8") as f:
    pkg = json.load(f)
assert pkg["version"] == "3.3.2", f"Unexpected version: {pkg['version']}"
pkg["version"] = "3.3.3"
with open("package.json", "w", encoding="utf-8") as f:
    json.dump(pkg, f, indent=2)
    f.write("\n")
print("package.json: 3.3.2 -> 3.3.3")

# apm.yml
with open("apm.yml", "r", encoding="utf-8") as f:
    apm = f.read()
apm = re.sub(r"^version: .+$", "version: 3.3.3", apm, flags=re.MULTILINE)
with open("apm.yml", "w", encoding="utf-8") as f:
    f.write(apm)
print("apm.yml: version -> 3.3.3")

# Rebuild .apm/agents/
r = subprocess.run(["node", "scripts/build-apm-manifest.js"], capture_output=True, text=True, timeout=30)
if r.returncode != 0:
    print("build-apm-manifest.js FAILED:", r.stderr or r.stdout); sys.exit(1)
print(r.stdout.strip())

# docs/index.html
with open("docs/index.html", "r", encoding="utf-8") as f:
    html = f.read()
assert html.count('<span class="badge">v3.3.2</span>') == 1
html = html.replace('<span class="badge">v3.3.2</span>', '<span class="badge">v3.3.3</span>', 1)
assert html.count('v3.3.2 &middot;') == 1
html = html.replace('v3.3.2 &middot;', 'v3.3.3 &middot;', 1)
with open("docs/index.html", "w", encoding="utf-8") as f:
    f.write(html)
print("docs/index.html: v3.3.3 badge + footer")

# Sanity: confirm sub-manager reframes propagated to .apm/agents/
keys = ["fullstack-dev", "csharp-dev", "mobile-dev", "ios-dev", "android-dev",
        "devops-engineer", "qa-tester", "scene-architect"]
for k in keys:
    p = f".apm/agents/{k}.agent.md"
    with open(p, "r", encoding="utf-8") as f:
        c = f.read()
    assert "You are the sub-manager for" in c, f"{k}: new intro not in .apm/agents/"
print(f".apm/agents/: all 8 sub-manager files contain new intro")

print("SUCCESS: v333 meta — version 3.3.3 across package.json, apm.yml, docs, .apm/agents/")
