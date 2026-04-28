#!/usr/bin/env python3
"""v3.3.6: Rewrite sub-manager description fields to remove edit-implying language.

User reported micro-agents still aren't being heavily used despite v3.3.4
giving sub-managers dispatch tools and v3.3.3 reframing the body intros.

Root-cause audit:
  ✓ All 37 canonical micro-agents exist in TEMPLATES
  ✓ All Tier-3 'Write' agents have Write+Edit tools (can do their jobs)
  ✓ All Composition Recipes reference real, existing micro-agents
  ✗ All 8 sub-manager FRONTMATTER DESCRIPTIONS still say "Writes...",
    "Builds...", "Handles testing/writing/...". The description field
    is what Claude Code surfaces in the agent picker AND what anchors
    the agent's self-image when invoked. v3.3.3 reframed the body
    intro but missed the description.

Fix: rewrite all 8 sub-manager description fields to consistently say
"Sub-manager for X. Composes Tier-3 micro-agent chains for ... Owns the
... validation gate. Never writes code itself — always dispatches."

Run from repo root: python3 scripts/v336-submanager-descriptions.py
"""
import re
import os
import subprocess
import sys

os.chdir(os.path.join(os.path.dirname(__file__), ".."))

# ── Per-agent description rewrites ────────────────────────────────────────────

REWRITES = {
    "fullstack-dev": {
        "old": "Writes React/TypeScript frontend code and Node.js/Express backend code. Invoke for components, hooks, API routes, data fetching, state management, WebSocket/SSE connections, and full-stack feature implementation. Understands modern React patterns, Express middleware, and TypeScript best practices.",
        "new": "Sub-manager for React/TypeScript + Node/Express work. Composes Tier-3 micro-agent chains for components, hooks, API routes, data fetching, state management, WebSocket/SSE connections, and full-stack features. Owns the typecheck-runner/lint-runner/test-runner validation gate. Never writes code itself — always dispatches micro-agents and verifies their output.",
    },
    "csharp-dev": {
        "old": "Writes, edits, and refactors C# scripts for Unity. Invoke for any scripting task — MonoBehaviours, ScriptableObjects, editor tools, gameplay systems, interfaces, and utility classes. This agent understands Unity's component model, lifecycle methods, and best practices for performant, maintainable Unity C#.",
        "new": "Sub-manager for Unity C# script work. Composes Tier-3 micro-agent chains for MonoBehaviours, ScriptableObjects, editor tools, gameplay systems, interfaces, and utilities. Owns the build-runner/test-runner validation gate (dispatches build-validator on the host for Unity-Editor-side compile checks). Never writes scripts itself — always dispatches micro-agents and verifies their output.",
    },
    "mobile-dev": {
        "old": "React Native cross-platform mobile developer. Builds iOS and Android apps from a single TypeScript codebase using React Native and Expo. Handles navigation, state management, native modules, and platform-specific adaptations.",
        "new": "Sub-manager for React Native cross-platform mobile work. Composes Tier-3 micro-agent chains for screens, navigation, state, native modules, and platform-specific adaptations across iOS and Android. Owns the typecheck-runner/lint-runner/test-runner validation gate. Never writes code itself — always dispatches micro-agents and verifies their output.",
    },
    "ios-dev": {
        "old": "Native iOS developer. Builds iPhone and iPad apps in Swift and SwiftUI. Handles Xcode project configuration, App Store signing, frameworks, and Apple platform APIs.",
        "new": "Sub-manager for native iOS (Swift / SwiftUI) work. Composes Tier-3 micro-agent chains for views, view-models, models, frameworks, Xcode configuration, signing, and App Store integration. Owns the build-runner/test-runner validation gate. Never writes code itself — always dispatches micro-agents and verifies their output.",
    },
    "android-dev": {
        "old": "Native Android developer. Builds Android apps in Kotlin with Jetpack Compose. Handles Gradle configuration, Play Store signing, Jetpack libraries, and Android platform APIs.",
        "new": "Sub-manager for native Android (Kotlin / Jetpack Compose) work. Composes Tier-3 micro-agent chains for Composables, ViewModels, data layer, Gradle configuration, signing, and Play Store integration. Owns the build-runner/test-runner validation gate. Never writes code itself — always dispatches micro-agents and verifies their output.",
    },
    "devops-engineer": {
        "old": "Handles infrastructure as code, CI/CD pipelines, deployment configuration, and cloud services. Invoke for Terraform modules, GitHub Actions workflows, Dockerfiles, Fly.io configuration, AWS S3/CloudFront setup, environment management, and deployment workflows.",
        "new": "Sub-manager for infrastructure, CI/CD, and deployment work. Composes Tier-3 micro-agent chains for Terraform modules, GitHub Actions workflows, Dockerfiles, deployment targets (Fly.io, Vercel, AWS, etc.), env/secret management, and monitoring config. Owns the build-runner/security-scanner validation gate. Never edits config or infrastructure files itself — always dispatches micro-agents and verifies their output.",
    },
    "qa-tester": {
        "old": "Handles testing strategy, quality audits, performance validation, and quality gates. Invoke for writing unit/integration/E2E tests, running Lighthouse audits, checking bundle size, verifying error boundaries, testing offline/PWA functionality, and enforcing quality thresholds.",
        "new": "Sub-manager for testing, auditing, and quality gates. Composes Tier-3 micro-agent chains for unit/integration/E2E tests (test-writer, test-runner), accessibility (accessibility-auditor), performance (lighthouse-runner), bundle size (bundle-sizer), and security (security-scanner). Interprets results into a pass/fail verdict. Never writes tests or runs validators itself — always dispatches micro-agents.",
    },
    "scene-architect": {
        "old": "Manages Unity scene hierarchy, GameObjects, prefabs, and scene composition. Invoke when creating or modifying scenes, setting up prefabs, arranging object hierarchies, adding/removing components, or configuring transforms. Use for any task involving the Unity Editor's scene structure rather than script logic. Must be invoked directly from the chat window — cannot run in Docker.",
        "new": "Sub-manager for Unity scene composition. Operates Unity Editor via coplay-mcp tools (host-only — cannot run in Docker; must be invoked directly from the chat window). Composes scene operations (hierarchy, GameObjects, prefabs, transforms, components, UI, materials) and dispatches csharp-dev for any C# script work that arises. Owns the build-runner / Play-Mode validation gate. Never writes scripts itself — always dispatches.",
    },
}

with open("src/templates.js", "r", encoding="utf-8") as f:
    js = f.read()

for key, entry in REWRITES.items():
    old_desc = entry["old"]
    new_desc = entry["new"]

    # Build the exact frontmatter line
    old_line = f"name: {key}\ndescription: {old_desc}\ntools:"
    new_line = f"name: {key}\ndescription: {new_desc}\ntools:"

    if old_line in js:
        n = js.count(old_line)
        assert n == 1, f"{key}: description anchor not unique ({n})"
        js = js.replace(old_line, new_line, 1)
        print(f"  {key}: description rewritten")
    elif new_desc[:60] in js:
        print(f"  {key}: already rewritten (idempotent skip)")
    else:
        raise AssertionError(f"{key}: description anchor not found")

# ── Write + verify ────────────────────────────────────────────────────────────

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

# Verify no sub-manager description still has flagged verbs
import re as _re
sub_managers = list(REWRITES.keys())
for k in sub_managers:
    m = _re.search(r'name:\s*' + k + r'\ndescription:\s*([^\n]+)\ntools:', js)
    desc = m.group(1)
    bad = _re.findall(r'\b(?:Writes?|Edits?|Creates?|Implements?|Builds?|Develops?)\b', desc)
    sub_manager_signal = "Sub-manager for" in desc
    print(f"  {k}: sub-manager-framed={sub_manager_signal}, bad-verbs={bad}")
    assert sub_manager_signal, f"{k}: missing 'Sub-manager for' phrase"
    assert not bad, f"{k}: still has flagged verbs {bad}"

print("\nSUCCESS: v3.3.6 — 8 sub-manager descriptions reframed")
