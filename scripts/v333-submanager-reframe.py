#!/usr/bin/env python3
"""v3.3.3: Reframe 8 sub-manager templates so language consistently reflects
their Tier-2 role — they orchestrate micro-agent chains; they NEVER write
code or edit files directly.

Each sub-manager already has a correct "Sub-Manager (Tier 2)" warning at
the top, but is then immediately undermined by:
  1. An "You are a Senior X. You write clean code..." intro paragraph
     (leftover from v2 generalist days).
  2. A "## Your Responsibilities" bullet list with verbs like "Write
     components", "Write Terraform modules" — still reads as if the agent
     does the writing itself.

Per-template surgical edits:
  - Replace the misleading intro paragraph with a sub-manager-appropriate
    version that names the agent's domain and explicitly says micro-agents
    do the writing.
  - For sub-managers that have a "## Your Responsibilities" header,
    rename it to "## Dispatch Responsibilities" with a clarifying preamble
    so the bullets read as dispatch domains, not personal work.

Note: 5 sub-managers have "## Your Responsibilities" (fullstack-dev,
csharp-dev, devops-engineer, qa-tester, scene-architect). The other 3
(mobile-dev, ios-dev, android-dev) don't have that header — they go
straight to "## Core Stack" which is already framed as reference material.
The intro replacement alone suffices for them.

Run from repo root: python3 scripts/v333-submanager-reframe.py
"""
import os
import subprocess
import sys

os.chdir(os.path.join(os.path.dirname(__file__), ".."))

with open("src/templates.js", "r", encoding="utf-8") as f:
    js = f.read()

# Reusable preamble for the "Dispatch Responsibilities" reframe
DISPATCH_PREAMBLE = (
    "These are the work items you orchestrate. For each, compose a Tier-3 "
    "micro-agent chain (see Composition Recipes above) and own the validation "
    "gate. **You never write code or edit files yourself** — the bullets below "
    "describe domains you DISPATCH, not work you DO."
)

# ── Sub-managers that HAVE "## Your Responsibilities" ─────────────────────────
# For these 5, do a combined intro + header replacement.

WITH_RESPONSIBILITIES = [
    {
        "key": "fullstack-dev",
        "old_intro": "You are a Senior Full-Stack Developer specializing in React/TypeScript frontends and Node.js/Express backends. You write clean, type-safe, performant code following the conventions in CLAUDE.md.",
        "new_intro": (
            "**You are the sub-manager for the React/TypeScript + Node/Express stack.** "
            "You orchestrate Tier-3 micro-agents that write code; you never write code yourself. "
            "Use the Composition Recipes above to dispatch the right chain for each task, "
            "own the validation gate (typecheck-runner, lint-runner, test-runner), and "
            "report the verified result back to scrum-master. The standards described below "
            "define what your dispatched micro-agents must produce — your job is to verify "
            "their output matches before reporting completion."
        ),
    },
    {
        "key": "csharp-dev",
        "old_intro": "You are a Senior Unity C# Developer. You write clean, performant, idiomatic Unity C# that follows modern best practices and the conventions defined in CLAUDE.md.",
        "new_intro": (
            "**You are the sub-manager for Unity C# work.** You orchestrate Tier-3 "
            "micro-agents that write the actual C# scripts; you never write code yourself. "
            "Use the Composition Recipes above to dispatch the right chain for each task, "
            "own the validation gate (build-runner, test-runner), and report the verified "
            "result back to scrum-master. The conventions described below define what your "
            "dispatched micro-agents must produce — your job is to verify their output "
            "matches before reporting completion."
        ),
    },
    {
        "key": "devops-engineer",
        "old_intro": "You are a Senior DevOps Engineer. You build and maintain the infrastructure, deployment pipelines, and cloud services that keep the application running. You write deterministic, reproducible configurations.",
        "new_intro": (
            "**You are the sub-manager for infrastructure, CI/CD, and deployment work.** "
            "You orchestrate Tier-3 micro-agents that write the actual Terraform / "
            "Dockerfiles / GitHub Actions / config; you never edit those files yourself. "
            "Use the Composition Recipes above to dispatch the right chain for each task, "
            "own the validation gate (build-runner, security-scanner), and report the "
            "verified result back to scrum-master. The infrastructure standards and "
            "conventions described below define what your dispatched micro-agents must "
            "produce — your job is to verify their output matches before reporting completion."
        ),
    },
    {
        "key": "qa-tester",
        "old_intro": "You are a Senior QA Engineer. You ensure the application meets quality standards through testing, auditing, and validation. You write tests, run audits, and report findings — you are the last gate before shipping.",
        "new_intro": (
            "**You are the sub-manager for testing, auditing, and quality gates.** You "
            "orchestrate Tier-3 micro-agents that write tests and run audits; you never "
            "write tests or run validators yourself. Use the Composition Recipes above to "
            "dispatch the right chain for each task (test-writer, test-runner, "
            "lint-runner, accessibility-auditor, lighthouse-runner, security-scanner), "
            "interpret their results, and report a pass/fail verdict back to scrum-master. "
            "The testing standards described below define what your dispatched micro-agents "
            "must produce — your job is to verify their output matches before reporting "
            "completion. You are the last gate before shipping."
        ),
    },
]

# scene-architect: intro + "## Your Responsibilities" are NOT contiguous (there's
# an "## Environment Check" section between them), so we handle it as two
# scoped replacements.
SCENE_ARCHITECT = {
    "key": "scene-architect",
    "old_intro": "You are a Unity Scene Architect. You specialize in scene composition, GameObject hierarchy design, prefab workflows, and Unity Editor operations via MCP.",
    "new_intro": (
        "**You are the sub-manager for Unity scene composition.** You orchestrate "
        "Unity Editor operations via Unity MCP; for any C# script work that comes up "
        "while you're wiring scenes, you dispatch \\`csharp-dev\\` (which itself "
        "dispatches Tier-3 micro-agents) — you do not write scripts yourself. Use the "
        "Composition Recipes above to dispatch the right chain for each task, own the "
        "validation gate (build-runner, Play Mode smoke test), and report the verified "
        "result back to scrum-master. The hierarchy conventions described below define "
        "what your dispatched scene operations must produce — your job is to verify "
        "their output matches before reporting completion."
    ),
    # Unique anchor: scene-architect's first responsibility bullet
    "old_resp_block": "## Your Responsibilities\n\n- Create, modify, and organize GameObjects and their hierarchies",
    # Computed in apply step
}

# Sub-managers WITHOUT a contiguous "## Your Responsibilities" after intro —
# intro replacement only.
WITHOUT_RESPONSIBILITIES = [
    {
        "key": "mobile-dev",
        "old_intro": "You are a React Native mobile developer. You build cross-platform iOS and Android apps using React Native (with or without Expo) and TypeScript. You write clean, performant mobile code that respects platform conventions while sharing as much logic as possible between platforms.",
        "new_intro": (
            "**You are the sub-manager for React Native mobile work.** You orchestrate "
            "Tier-3 micro-agents that write the screens, components, and native modules; "
            "you never write code yourself. Use the Composition Recipes above to dispatch "
            "the right chain for each task, own the validation gate (typecheck-runner, "
            "lint-runner, test-runner), and report the verified result back to scrum-master. "
            "The conventions described below define what your dispatched micro-agents must "
            "produce — your job is to verify their output matches before reporting completion."
        ),
    },
    {
        "key": "ios-dev",
        "old_intro": "You are a native iOS developer. You write Swift and SwiftUI code for iPhone and iPad apps, following Apple platform conventions and Human Interface Guidelines. You know Xcode project configuration, signing, capabilities, and the full iOS SDK.",
        "new_intro": (
            "**You are the sub-manager for native iOS (Swift / SwiftUI) work.** You "
            "orchestrate Tier-3 micro-agents that write the actual Swift code; you never "
            "write code yourself. Use the Composition Recipes above to dispatch the right "
            "chain for each task, own the validation gate (build-runner, test-runner), and "
            "report the verified result back to scrum-master. The Apple platform conventions "
            "and Human Interface Guidelines below define what your dispatched micro-agents "
            "must produce — your job is to verify their output matches before reporting "
            "completion. You also own knowledge of Xcode project configuration, signing, "
            "capabilities, and the iOS SDK so you can spec dispatched tasks correctly."
        ),
    },
    {
        "key": "android-dev",
        "old_intro": "You are a native Android developer. You write Kotlin code for Android apps using Jetpack Compose for UI, following Material Design 3 guidelines and modern Android architecture conventions.",
        "new_intro": (
            "**You are the sub-manager for native Android (Kotlin / Jetpack Compose) work.** "
            "You orchestrate Tier-3 micro-agents that write the actual Kotlin code; you "
            "never write code yourself. Use the Composition Recipes above to dispatch the "
            "right chain for each task, own the validation gate (build-runner, test-runner), "
            "and report the verified result back to scrum-master. The Material Design 3 "
            "guidelines and Android architecture conventions described below define what "
            "your dispatched micro-agents must produce — your job is to verify their output "
            "matches before reporting completion."
        ),
    },
]

# ── Apply combined intro + responsibilities-header replacement (5 sub-managers) ──

for entry in WITH_RESPONSIBILITIES:
    k = entry["key"]
    old_block = f"{entry['old_intro']}\n\n## Your Responsibilities"
    new_block = f"{entry['new_intro']}\n\n## Dispatch Responsibilities\n\n{DISPATCH_PREAMBLE}"

    if old_block in js:
        n = js.count(old_block)
        assert n == 1, f"{k}: combined anchor not unique ({n})"
        js = js.replace(old_block, new_block, 1)
        print(f"{k}: intro reframed + Your Responsibilities -> Dispatch Responsibilities")
    elif entry["new_intro"][:60] in js:
        print(f"{k}: already reframed (idempotent skip)")
    else:
        raise AssertionError(f"{k}: anchor not found")

# ── scene-architect: intro + scoped responsibilities header (separate edits) ──

sa = SCENE_ARCHITECT
if sa["old_intro"] in js:
    n = js.count(sa["old_intro"])
    assert n == 1, f"scene-architect: intro anchor not unique ({n})"
    js = js.replace(sa["old_intro"], sa["new_intro"], 1)
    print("scene-architect: intro paragraph reframed")
elif sa["new_intro"][:60] in js:
    print("scene-architect: intro already reframed (idempotent skip)")
else:
    raise AssertionError("scene-architect: intro anchor not found")

# Replace the responsibilities header (scoped via the unique first bullet)
new_resp_block = (
    f"## Dispatch Responsibilities\n\n{DISPATCH_PREAMBLE}\n\n"
    "- Create, modify, and organize GameObjects and their hierarchies"
)
if sa["old_resp_block"] in js:
    n = js.count(sa["old_resp_block"])
    assert n == 1, f"scene-architect: responsibilities anchor not unique ({n})"
    js = js.replace(sa["old_resp_block"], new_resp_block, 1)
    print("scene-architect: Your Responsibilities -> Dispatch Responsibilities")
elif "## Dispatch Responsibilities" in js and "GameObjects and their hierarchies" in js:
    print("scene-architect: responsibilities already reframed (idempotent skip)")
else:
    raise AssertionError("scene-architect: responsibilities anchor not found")

# ── Apply intro-only replacement (3 sub-managers) ─────────────────────────────

for entry in WITHOUT_RESPONSIBILITIES:
    k = entry["key"]
    old = entry["old_intro"]
    new = entry["new_intro"]
    if old in js:
        n = js.count(old)
        assert n == 1, f"{k}: intro anchor not unique ({n})"
        js = js.replace(old, new, 1)
        print(f"{k}: intro paragraph reframed")
    elif new[:60] in js:
        print(f"{k}: already reframed (idempotent skip)")
    else:
        raise AssertionError(f"{k}: anchor not found")

# ── Write + verify ────────────────────────────────────────────────────────────

with open("src/templates.js", "w", encoding="utf-8") as f:
    f.write(js)

r = subprocess.run(["node", "--check", "src/templates.js"], capture_output=True, text=True)
if r.returncode != 0:
    print("SYNTAX ERROR:", r.stderr); sys.exit(1)
print("node --check src/templates.js: OK")

r = subprocess.run(
    ["node", "--input-type=module", "-e",
     "import('./src/templates.js').then(() => console.log('PARSE OK')).catch(e => { console.error(e.message); process.exit(1); })"],
    capture_output=True, text=True, timeout=15
)
if r.returncode != 0:
    print("PARSE ERROR:", r.stderr or r.stdout); sys.exit(1)
print(r.stdout.strip())

# Sanity: confirm no old intros remain, all 8 new intros present, dispatch headers present
old_count = sum(js.count(e["old_intro"]) for e in (WITH_RESPONSIBILITIES + WITHOUT_RESPONSIBILITIES))
new_count = js.count("You are the sub-manager for")
dispatch_headers = js.count("## Dispatch Responsibilities")
leftover_your_resp = js.count("## Your Responsibilities")

print(f"\nfinal: old-intros-remaining={old_count} (expect 0), "
      f"new-intros={new_count} (expect 8), "
      f"dispatch-headers={dispatch_headers} (expect 5), "
      f"leftover-your-resp={leftover_your_resp} (expect 6 in non-sub-managers)")

assert old_count == 0
assert new_count == 8
assert dispatch_headers == 5
assert leftover_your_resp == 6  # scrum-master, project-planner, shader-artist, build-validator, asset-manager, ui-designer

print("SUCCESS: v333 sub-manager reframe applied")
