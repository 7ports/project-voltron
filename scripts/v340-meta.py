#!/usr/bin/env python3
"""v3.4.0 meta: bump versions, build:apm, update docs."""
import json, os, re, subprocess, sys
os.chdir(os.path.join(os.path.dirname(__file__), ".."))

with open("package.json", "r", encoding="utf-8") as f:
    pkg = json.load(f)
assert pkg["version"] == "3.3.6"
pkg["version"] = "3.4.0"
with open("package.json", "w", encoding="utf-8") as f:
    json.dump(pkg, f, indent=2); f.write("\n")
print("package.json: 3.3.6 -> 3.4.0")

with open("apm.yml", "r", encoding="utf-8") as f:
    apm = f.read()
apm = re.sub(r"^version: .+$", "version: 3.4.0", apm, flags=re.MULTILINE)
with open("apm.yml", "w", encoding="utf-8") as f:
    f.write(apm)
print("apm.yml: version -> 3.4.0")

r = subprocess.run(["node", "scripts/build-apm-manifest.js"], capture_output=True, text=True, timeout=30)
if r.returncode != 0: print("FAILED:", r.stderr or r.stdout); sys.exit(1)
print(r.stdout.strip())

with open("docs/index.html", "r", encoding="utf-8") as f:
    html = f.read()
assert html.count('<span class="badge">v3.3.6</span>') == 1
html = html.replace('<span class="badge">v3.3.6</span>', '<span class="badge">v3.4.0</span>', 1)
assert html.count('v3.3.6 &middot;') == 1
html = html.replace('v3.3.6 &middot;', 'v3.4.0 &middot;', 1)
with open("docs/index.html", "w", encoding="utf-8") as f:
    f.write(html)
print("docs/index.html: v3.4.0 badge + footer")

# Verify Dockerfile.voltron file (if scaffolded) gets the new content next time
# (it's regenerated from DOCKERFILE_CONTENT on scaffold)

# Verify regenerated .apm files reflect the changes
with open(".apm/agents/scrum-master.agent.md", "r", encoding="utf-8") as f:
    c = f.read()
assert "STRINGER MISSING" in c, "scrum-master agent file should have STOP language"
assert "Mandatory dependencies" in c, "scrum-master should reference mandatory dependencies"
print(".apm/agents/scrum-master.agent.md: mandatory dep language confirmed")

print("SUCCESS: v3.4.0 meta")
