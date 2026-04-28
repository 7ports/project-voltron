#!/usr/bin/env python3
"""v3.3.4: Two combined fixes.

Bug #1 (sub-manager dispatch gap):
  All 8 sub-managers currently have Read+Bash+Alexandria tools but NO
  mcp__project-voltron__run_agent_in_docker / start_agent_in_docker /
  get_agent_output / get_template / update_progress. They are physically
  unable to dispatch micro-agents — when invoked they fall back to using
  Bash heredocs to write files directly, defeating the three-tier model.
  Fix: add the 5 dispatch MCP tools to every sub-manager's frontmatter.

Bug #2 (Alexandria coverage gap):
  Audit on 2026-04-27 found only 18 of 63 agents (29%) had Alexandria
  integration. Per the user's "option a" choice, add Alexandria to ~22
  agents that need it: 2 missing T1 coordinators, 3 Voltron-aware
  specialty agents, 11 tooling micro-agents, 4 doc micro-agents.
  Pattern: full section for the 5 coordinator/specialty agents, short
  footer for the 15 micro-agents.

Run from repo root: python3 scripts/v334-dispatch-and-alexandria.py
"""
import re
import os
import subprocess
import sys

os.chdir(os.path.join(os.path.dirname(__file__), ".."))

with open("src/templates.js", "r", encoding="utf-8") as f:
    js = f.read()

# ────────────────────────────────────────────────────────────────────────────
# FIX #1 — Add dispatch tools to all 8 sub-managers' frontmatter
# ────────────────────────────────────────────────────────────────────────────

DISPATCH_TOOLS = (
    "mcp__project-voltron__run_agent_in_docker, "
    "mcp__project-voltron__start_agent_in_docker, "
    "mcp__project-voltron__get_agent_output, "
    "mcp__project-voltron__get_template, "
    "mcp__project-voltron__update_progress"
)

SUB_MANAGERS_5_TOOLS = ["fullstack-dev", "csharp-dev", "devops-engineer", "scene-architect"]
SUB_MANAGERS_4_TOOLS = ["qa-tester"]
SUB_MANAGERS_LONG = ["mobile-dev", "ios-dev", "android-dev"]

# Pattern A: 5-tool sub-managers — "Read, Bash, mcp__alexandria__quick_setup, mcp__alexandria__search_guides, mcp__alexandria__update_guide"
for k in SUB_MANAGERS_5_TOOLS:
    old = f"name: {k}\ndescription:"
    # Find the tools line within this agent's frontmatter
    m = re.search(
        r'(  "' + k + r'":\s*\{[^`]*?content:\s*`---\nname:\s*' + k +
        r'\ndescription:[^\n]*\ntools:\s*)([^\n]+)(\n---)',
        js
    )
    assert m, f"{k}: tools-line anchor not found"
    old_tools = m.group(2)
    if "run_agent_in_docker" in old_tools:
        print(f"  {k}: dispatch tools already present (idempotent skip)")
        continue
    new_tools = f"Read, Bash, {DISPATCH_TOOLS}, mcp__alexandria__quick_setup, mcp__alexandria__search_guides, mcp__alexandria__update_guide"
    js = js[:m.start(2)] + new_tools + js[m.end(2):]
    print(f"  {k}: dispatch tools added")

# Pattern B: qa-tester (only 4 tools — missing update_guide)
for k in SUB_MANAGERS_4_TOOLS:
    m = re.search(
        r'(  "' + k + r'":\s*\{[^`]*?content:\s*`---\nname:\s*' + k +
        r'\ndescription:[^\n]*\ntools:\s*)([^\n]+)(\n---)',
        js
    )
    assert m, f"{k}: tools-line anchor not found"
    old_tools = m.group(2)
    if "run_agent_in_docker" in old_tools:
        print(f"  {k}: dispatch tools already present (idempotent skip)")
        continue
    # Also adds update_guide while we're here
    new_tools = f"Read, Bash, {DISPATCH_TOOLS}, mcp__alexandria__quick_setup, mcp__alexandria__search_guides, mcp__alexandria__update_guide"
    js = js[:m.start(2)] + new_tools + js[m.end(2):]
    print(f"  {k}: dispatch tools + update_guide added")

# Pattern C: mobile/ios/android — already have a richer toolset with WebFetch/WebSearch
for k in SUB_MANAGERS_LONG:
    m = re.search(
        r'(  "' + k + r'":\s*\{[^`]*?content:\s*`---\nname:\s*' + k +
        r'\ndescription:[^\n]*\ntools:\s*)([^\n]+)(\n---)',
        js
    )
    assert m, f"{k}: tools-line anchor not found"
    old_tools = m.group(2)
    if "run_agent_in_docker" in old_tools:
        print(f"  {k}: dispatch tools already present (idempotent skip)")
        continue
    # Insert dispatch tools right after "Bash, " (keep the rich toolset intact)
    new_tools = old_tools.replace(
        "Read, Bash, ",
        f"Read, Bash, {DISPATCH_TOOLS}, ",
        1
    )
    assert new_tools != old_tools, f"{k}: 'Read, Bash, ' anchor not present in tools list"
    js = js[:m.start(2)] + new_tools + js[m.end(2):]
    print(f"  {k}: dispatch tools added (preserved WebFetch/WebSearch)")

# ────────────────────────────────────────────────────────────────────────────
# FIX #2 — Add Alexandria to non-compliant agents
# ────────────────────────────────────────────────────────────────────────────

ALEX_FULL_TOOLS = "mcp__alexandria__list_guides, mcp__alexandria__quick_setup, mcp__alexandria__search_guides, mcp__alexandria__update_guide"
ALEX_SHORT_TOOLS = "mcp__alexandria__quick_setup, mcp__alexandria__update_guide"

ALEX_FULL_SECTION = """## Alexandria Integration

Before doing meaningful work, call \\`mcp__alexandria__list_guides\\` to see what's already documented for the current task. For tooling/setup steps, call \\`mcp__alexandria__quick_setup\\` instead of reinventing setup. After the task, if you discovered any platform-specific gotcha, workaround, or new pattern, call \\`mcp__alexandria__update_guide\\` to capture it for next time.

Alexandria is for non-project-specific documentation only. Project-specific content belongs in CLAUDE.md.

"""

ALEX_SHORT_SECTION = """## Alexandria

Before any tool/install/config work, call \\`mcp__alexandria__quick_setup\\` (it returns the existing guide if there is one). After discovering anything tool-specific not already documented, call \\`mcp__alexandria__update_guide\\` to capture it.

"""

# Group B: full Alexandria — coordinators + Voltron-aware specialty
FULL_ALEX_AGENTS = [
    "code-analyst", "doc-writer", "reflection-processor",
    "stringer-baseline-builder", "stringer-delta-reader",
]

# Group C: short Alexandria — tooling micro-agents + doc micro-agents
SHORT_ALEX_AGENTS = [
    # Tooling micro-agents (touch tools/configs)
    "env-var-setter", "config-editor", "dockerfile-editor", "migration-writer",
    "committer", "pr-opener", "deploy-trigger", "app-store-uploader",
    "build-runner", "lint-runner", "test-runner",
    # Doc micro-agents (write/update guides)
    "adr-writer", "api-doc-generator", "diagram-maker", "readme-section-writer",
]

def add_tools(js, agent_key, new_tools_to_add):
    """Append the listed Alexandria tools to the agent's frontmatter tools line."""
    m = re.search(
        r'(  "' + agent_key + r'":\s*\{[^`]*?content:\s*`---\nname:\s*' + agent_key +
        r'\ndescription:[^\n]*\ntools:\s*)([^\n]+)(\n---)',
        js
    )
    if not m:
        raise AssertionError(f"{agent_key}: tools-line anchor not found")
    old_tools = m.group(2)
    # Idempotent check
    if "mcp__alexandria__quick_setup" in old_tools and "mcp__alexandria__update_guide" in old_tools:
        return js, False  # already there
    # Append new tools
    new_tools = f"{old_tools}, {new_tools_to_add}"
    return js[:m.start(2)] + new_tools + js[m.end(2):], True

def add_section_before_validation(js, agent_key, section_text):
    """Insert section_text right before '## Validation & Handoff' inside this agent's body."""
    # Anchor on agent_key occurrence + "## Validation & Handoff"
    # Use a non-greedy match scoped to this agent
    m = re.search(
        r'(  "' + agent_key + r'":\s*\{[^`]*?content:\s*`(?:[^`]|\\`)*?)(\n## Validation & Handoff\n)',
        js
    )
    if not m:
        raise AssertionError(f"{agent_key}: V&H anchor not found")
    # Idempotent check — section already inserted
    body_so_far = m.group(1)
    if section_text.strip() in body_so_far:
        return js, False
    # Insert: replace "\n## Validation..." with "\n[section]## Validation..."
    insertion_point = m.start(2) + 1  # +1 to position after the leading \n
    return js[:insertion_point] + section_text + js[insertion_point:], True

# Apply Group B (full Alexandria)
for k in FULL_ALEX_AGENTS:
    js, did_tools = add_tools(js, k, ALEX_FULL_TOOLS)
    js, did_sect = add_section_before_validation(js, k, ALEX_FULL_SECTION)
    print(f"  {k}: full Alexandria — tools={'+' if did_tools else 'skip'}, section={'+' if did_sect else 'skip'}")

# Apply Group C (short Alexandria)
for k in SHORT_ALEX_AGENTS:
    js, did_tools = add_tools(js, k, ALEX_SHORT_TOOLS)
    js, did_sect = add_section_before_validation(js, k, ALEX_SHORT_SECTION)
    print(f"  {k}: short Alexandria — tools={'+' if did_tools else 'skip'}, section={'+' if did_sect else 'skip'}")

# ────────────────────────────────────────────────────────────────────────────
# Write + verify
# ────────────────────────────────────────────────────────────────────────────

with open("src/templates.js", "w", encoding="utf-8") as f:
    f.write(js)

r = subprocess.run(["node", "--check", "src/templates.js"], capture_output=True, text=True)
if r.returncode != 0:
    print("SYNTAX ERROR:", r.stderr); sys.exit(1)
print("\nnode --check src/templates.js: OK")

r = subprocess.run(
    ["node", "--input-type=module", "-e",
     "import('./src/templates.js').then(() => console.log('PARSE OK')).catch(e => { console.error(e.message); process.exit(1); })"],
    capture_output=True, text=True, timeout=15
)
if r.returncode != 0:
    print("PARSE ERROR:", r.stderr or r.stdout); sys.exit(1)
print(r.stdout.strip())

# ── Final verification ────────────────────────────────────────────────────────

# All 8 sub-managers must now have run_agent_in_docker
sub_managers = ["fullstack-dev", "csharp-dev", "mobile-dev", "ios-dev", "android-dev",
                "devops-engineer", "qa-tester", "scene-architect"]
fail = []
for k in sub_managers:
    m = re.search(r'  "' + k + r'":\s*\{[^`]*?content:\s*`---\nname:\s*' + k +
                  r'\ndescription:[^\n]*\ntools:\s*([^\n]+)\n---', js)
    if not m or "run_agent_in_docker" not in m.group(1):
        fail.append(k)
assert not fail, f"sub-managers still missing dispatch: {fail}"
print(f"\nVerified: all 8 sub-managers have dispatch tools")

# All 20 Alexandria additions must have quick_setup + update_guide in tools
alex_added = FULL_ALEX_AGENTS + SHORT_ALEX_AGENTS
fail = []
for k in alex_added:
    m = re.search(r'  "' + k + r'":\s*\{[^`]*?content:\s*`---\nname:\s*' + k +
                  r'\ndescription:[^\n]*\ntools:\s*([^\n]+)\n---', js)
    if not m:
        fail.append(f"{k}: not found"); continue
    tools = m.group(1)
    if "alexandria__quick_setup" not in tools or "alexandria__update_guide" not in tools:
        fail.append(f"{k}: tools={tools}")
assert not fail, f"agents missing Alexandria tools: {fail}"
print(f"Verified: all {len(alex_added)} agents have Alexandria tools")

print("\nSUCCESS: v3.3.4 — sub-manager dispatch + Alexandria coverage applied")
