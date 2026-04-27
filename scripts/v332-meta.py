#!/usr/bin/env python3
"""v3.3.2: Bump package.json + apm.yml; update docs; rebuild .apm/agents/.
Run from repo root: python3 scripts/v332-meta.py
"""
import json
import os
import re
import subprocess
import sys

os.chdir(os.path.join(os.path.dirname(__file__), ".."))

# ── 1. package.json ──────────────────────────────────────────────────────────

with open("package.json", "r", encoding="utf-8") as f:
    pkg = json.load(f)

assert pkg["version"] == "3.3.1", f"Unexpected version: {pkg['version']} (expected 3.3.1)"
pkg["version"] = "3.3.2"

with open("package.json", "w", encoding="utf-8") as f:
    json.dump(pkg, f, indent=2)
    f.write("\n")
print("package.json: 3.3.1 -> 3.3.2")

# ── 2. apm.yml ───────────────────────────────────────────────────────────────

with open("apm.yml", "r", encoding="utf-8") as f:
    apm = f.read()
apm = re.sub(r"^version: .+$", "version: 3.3.2", apm, flags=re.MULTILINE)
with open("apm.yml", "w", encoding="utf-8") as f:
    f.write(apm)
assert "version: 3.3.2" in apm
print("apm.yml: version -> 3.3.2")

# ── 3. Rebuild .apm/agents/ ──────────────────────────────────────────────────

r = subprocess.run(
    ["node", "scripts/build-apm-manifest.js"],
    capture_output=True, text=True, timeout=30
)
if r.returncode != 0:
    print("build-apm-manifest.js FAILED:", r.stderr or r.stdout)
    sys.exit(1)
print(r.stdout.strip())

# ── 4. docs/index.html ───────────────────────────────────────────────────────

with open("docs/index.html", "r", encoding="utf-8") as f:
    html = f.read()

assert html.count('<span class="badge">v3.3.1</span>') == 1, "version badge not unique"
html = html.replace('<span class="badge">v3.3.1</span>', '<span class="badge">v3.3.2</span>', 1)

assert html.count('v3.3.1 &middot;') == 1, "footer version not unique"
html = html.replace('v3.3.1 &middot;', 'v3.3.2 &middot;', 1)

with open("docs/index.html", "w", encoding="utf-8") as f:
    f.write(html)

assert "v3.3.2" in html
print("docs/index.html: v3.3.2 badge + footer")

print("SUCCESS: v332 meta — version 3.3.2 across package.json, apm.yml, docs, .apm/agents/")
