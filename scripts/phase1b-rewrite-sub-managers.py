#!/usr/bin/env python3
"""Phase 1b: Rewrite 8 sub-manager templates — strip Write/Edit tools,
add sub-manager notice + composition recipes.
Run from repo root: python3 scripts/phase1b-rewrite-sub-managers.py
"""
import sys, os
os.chdir(os.path.join(os.path.dirname(__file__), ".."))

with open("src/templates.js", "r", encoding="utf-8") as f:
    content = f.read()

NOTICE = """> **Sub-Manager (Tier 2).** You orchestrate micro-agents within your domain. You NEVER write code or edit files directly. For every implementation task: compose the right micro-agent chain → dispatch them → own the validation gate → report results to scrum-master.

"""

def recipes(rows):
    header = "## Composition Recipes\n\nDefault chains for common tasks. Dispatch via `run_agent_in_docker` or `start_agent_in_docker`.\n\n| Task | Micro-agent chain |\n|---|---|\n"
    return header + "\n".join(f"| {task} | {chain} |" for task, chain in rows) + "\n\n"


# Each tuple: (exact_old_string, exact_new_string)
# old_string = tools line + frontmatter close + blank line + first body sentence (unique combo)
# new_string = updated tools + same frontmatter close + notice + recipes + first body sentence

CHANGES = []

# ── fullstack-dev ──────────────────────────────────────────────────────────────
CHANGES.append((
    "tools: Read, Write, Edit, Bash, mcp__alexandria__quick_setup, mcp__alexandria__search_guides, mcp__alexandria__update_guide\n---\n\nYou are a Senior Full-Stack Developer",
    "tools: Read, Bash, mcp__alexandria__quick_setup, mcp__alexandria__search_guides, mcp__alexandria__update_guide\n---\n\n"
    + NOTICE
    + recipes([
        ("New API route",     "route-adder → typecheck-runner → test-writer → test-runner"),
        ("New component",     "component-scaffolder → typecheck-runner → test-writer → test-runner"),
        ("Add TypeScript type","type-definer → typecheck-runner"),
        ("Fix type errors",   "type-error-reader → type-definer → typecheck-runner"),
        ("New DB migration",  "migration-writer → schema-validator"),
        ("New env var",       "env-var-setter"),
        ("Pre-PR checklist",  "typecheck-runner + test-runner + lint-runner + security-scanner"),
    ])
    + "You are a Senior Full-Stack Developer"
))

# ── csharp-dev ────────────────────────────────────────────────────────────────
CHANGES.append((
    "tools: Read, Write, Edit, Bash, mcp__alexandria__quick_setup, mcp__alexandria__search_guides, mcp__alexandria__update_guide\n---\n\nYou are a Senior Unity C# Developer",
    "tools: Read, Bash, mcp__alexandria__quick_setup, mcp__alexandria__search_guides, mcp__alexandria__update_guide\n---\n\n"
    + NOTICE
    + recipes([
        ("New C# class/script", "test-writer (stub) → write class → build-runner → test-runner"),
        ("Fix compile errors",  "type-error-reader → config-editor or type-definer → build-runner"),
        ("Add unit tests",      "test-lister → test-writer → test-runner"),
        ("Refactor",            "git-state-reader → write changes → build-runner → test-runner"),
        ("Pre-PR checklist",    "build-runner + test-runner + lint-runner"),
    ])
    + "You are a Senior Unity C# Developer"
))

# ── devops-engineer ────────────────────────────────────────────────────────────
CHANGES.append((
    "tools: Read, Write, Edit, Bash, mcp__alexandria__quick_setup, mcp__alexandria__search_guides, mcp__alexandria__update_guide\n---\n\nYou are a Senior DevOps Engineer",
    "tools: Read, Bash, mcp__alexandria__quick_setup, mcp__alexandria__search_guides, mcp__alexandria__update_guide\n---\n\n"
    + NOTICE
    + recipes([
        ("New Dockerfile/service", "dockerfile-editor → build-runner → deploy-trigger"),
        ("Config change",          "config-editor → build-runner"),
        ("CI/CD workflow update",  "yaml-patcher → build-runner"),
        ("Add env var",            "env-var-setter → config-editor"),
        ("Security audit",         "security-scanner → (committer if patches applied)"),
        ("Deploy",                 "build-runner → committer → deploy-trigger"),
    ])
    + "You are a Senior DevOps Engineer"
))

# ── qa-tester ─────────────────────────────────────────────────────────────────
CHANGES.append((
    "tools: Read, Write, Edit, Bash, mcp__alexandria__quick_setup, mcp__alexandria__search_guides\n---\n\nYou are a Senior QA Engineer",
    "tools: Read, Bash, mcp__alexandria__quick_setup, mcp__alexandria__search_guides\n---\n\n"
    + NOTICE
    + recipes([
        ("Full test suite",        "test-runner"),
        ("Write missing tests",    "test-lister → test-writer → test-runner"),
        ("Type-check",             "typecheck-runner"),
        ("Lint audit",             "lint-reader → (lint-runner if fixes needed)"),
        ("Accessibility audit",    "accessibility-auditor"),
        ("Performance audit",      "lighthouse-runner"),
        ("Security scan",          "security-scanner"),
        ("Full QA pass",           "typecheck-runner + test-runner + lint-runner + security-scanner + accessibility-auditor"),
    ])
    + "You are a Senior QA Engineer"
))

# ── mobile-dev ────────────────────────────────────────────────────────────────
CHANGES.append((
    "tools: Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, mcp__alexandria__get_project_setup_recommendations, mcp__alexandria__list_guides, mcp__alexandria__quick_setup, mcp__alexandria__search_guides, mcp__alexandria__update_guide\n---\n\nYou are a React Native mobile developer",
    "tools: Read, Bash, Glob, Grep, WebFetch, WebSearch, mcp__alexandria__get_project_setup_recommendations, mcp__alexandria__list_guides, mcp__alexandria__quick_setup, mcp__alexandria__search_guides, mcp__alexandria__update_guide\n---\n\n"
    + NOTICE
    + recipes([
        ("New screen/component",  "component-scaffolder → typecheck-runner → test-writer → test-runner"),
        ("New navigation route",  "route-adder → typecheck-runner"),
        ("Add type definitions",  "type-definer → typecheck-runner"),
        ("Fix type errors",       "type-error-reader → type-definer → typecheck-runner"),
        ("Add env var",           "env-var-setter"),
        ("Pre-release QA",        "typecheck-runner + test-runner + lint-runner + accessibility-auditor"),
    ])
    + "You are a React Native mobile developer"
))

# ── ios-dev ───────────────────────────────────────────────────────────────────
CHANGES.append((
    "tools: Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, mcp__alexandria__get_project_setup_recommendations, mcp__alexandria__list_guides, mcp__alexandria__quick_setup, mcp__alexandria__search_guides, mcp__alexandria__update_guide\n---\n\nYou are a native iOS developer",
    "tools: Read, Bash, Glob, Grep, WebFetch, WebSearch, mcp__alexandria__get_project_setup_recommendations, mcp__alexandria__list_guides, mcp__alexandria__quick_setup, mcp__alexandria__search_guides, mcp__alexandria__update_guide\n---\n\n"
    + NOTICE
    + recipes([
        ("New SwiftUI view",      "component-scaffolder → build-runner → test-writer → test-runner"),
        ("New model/struct",      "type-definer → build-runner → typecheck-runner"),
        ("Fix build errors",      "type-error-reader → type-definer or config-editor → build-runner"),
        ("Add config/plist key",  "config-editor → build-runner"),
        ("Pre-submission QA",     "build-runner + test-runner + lint-runner"),
        ("App Store upload",      "build-runner → app-store-uploader"),
    ])
    + "You are a native iOS developer"
))

# ── android-dev ───────────────────────────────────────────────────────────────
CHANGES.append((
    "tools: Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, mcp__alexandria__get_project_setup_recommendations, mcp__alexandria__list_guides, mcp__alexandria__quick_setup, mcp__alexandria__search_guides, mcp__alexandria__update_guide\n---\n\nYou are a native Android developer",
    "tools: Read, Bash, Glob, Grep, WebFetch, WebSearch, mcp__alexandria__get_project_setup_recommendations, mcp__alexandria__list_guides, mcp__alexandria__quick_setup, mcp__alexandria__search_guides, mcp__alexandria__update_guide\n---\n\n"
    + NOTICE
    + recipes([
        ("New Composable screen", "component-scaffolder → build-runner → test-writer → test-runner"),
        ("New data class/model",  "type-definer → build-runner"),
        ("Fix compile errors",    "type-error-reader → type-definer or config-editor → build-runner"),
        ("Gradle config change",  "config-editor → build-runner"),
        ("Pre-release QA",        "build-runner + test-runner + lint-runner"),
        ("Play Store upload",     "build-runner → app-store-uploader"),
    ])
    + "You are a native Android developer"
))

# ── scene-architect ───────────────────────────────────────────────────────────
CHANGES.append((
    "tools: Read, Write, Edit, Bash, mcp__alexandria__quick_setup, mcp__alexandria__search_guides, mcp__alexandria__update_guide\n---\n\nYou are a Unity Scene Architect",
    "tools: Read, Bash, mcp__alexandria__quick_setup, mcp__alexandria__search_guides, mcp__alexandria__update_guide\n---\n\n"
    + NOTICE
    + recipes([
        ("New scene prefab",      "git-state-reader → (scene editing — requires Unity Editor, run manually) → build-runner"),
        ("Script attachment",     "csharp-dev (write script) → build-runner → scene-architect (wire in Editor)"),
        ("Asset import change",   "config-editor → build-runner"),
        ("Scene validation",      "build-runner → (Play Mode test — requires Unity Editor)"),
    ])
    + "You are a Unity Scene Architect"
))

# ── Apply all changes ─────────────────────────────────────────────────────────
applied = 0
failed = []
for old, new in CHANGES:
    if old not in content:
        failed.append(repr(old[:80]))
        continue
    if content.count(old) != 1:
        failed.append(f"NOT UNIQUE: {repr(old[:80])}")
        continue
    content = content.replace(old, new, 1)
    applied += 1

if failed:
    print(f"FAILED ({len(failed)} anchors not found or not unique):")
    for f in failed:
        print(" ", f)
    sys.exit(1)

assert applied == 8, f"Expected 8 changes, applied {applied}"

# ── Verify tools lines updated ────────────────────────────────────────────────
still_has_write = []
for key in ["fullstack-dev", "csharp-dev", "mobile-dev", "ios-dev", "android-dev",
            "devops-engineer", "qa-tester", "scene-architect"]:
    # Find the tools line within each template's content field
    idx = content.find(f"name: {key}\n")
    if idx == -1:
        still_has_write.append(f"{key} — name not found")
        continue
    snippet = content[idx:idx+500]
    if "tools: Read, Write" in snippet:
        still_has_write.append(key)

if still_has_write:
    print("WARNING: These agents still have Write in tools:", still_has_write)
    sys.exit(1)

with open("src/templates.js", "w", encoding="utf-8") as f:
    f.write(content)

print(f"SUCCESS: {applied}/8 sub-managers updated (Write/Edit removed, notice + recipes added)")
