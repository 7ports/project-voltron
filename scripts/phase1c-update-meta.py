#!/usr/bin/env python3
"""Phase 1c: Add three-tier section to scrum-master, update docs, bump to v3.0.0.
Run from repo root: python3 scripts/phase1c-update-meta.py
"""
import sys, os, json
os.chdir(os.path.join(os.path.dirname(__file__), ".."))

errors = []

# ─── 1. package.json version bump ─────────────────────────────────────────────

with open("package.json", "r", encoding="utf-8") as f:
    pkg = json.load(f)

assert pkg["version"] == "2.11.0", f"Unexpected version: {pkg['version']} (expected 2.11.0)"
pkg["version"] = "3.0.0"

with open("package.json", "w", encoding="utf-8") as f:
    json.dump(pkg, f, indent=2)
    f.write("\n")

print("package.json: 2.11.0 → 3.0.0")

# ─── 2. src/templates.js — scrum-master three-tier section ────────────────────

with open("src/templates.js", "r", encoding="utf-8") as f:
    tmpl = f.read()

THREE_TIER = r"""## Three-Tier Delegation

Voltron v3 uses a three-tier model. You sit at **Tier 1** as the only coordinator.

| Tier | Agents | Writes code? | Role |
|---|---|---|---|
| **1 — Coordinator** | scrum-master | No | Cross-domain planning, journaling, user communication |
| **2 — Sub-managers** | fullstack-dev, csharp-dev, mobile-dev, ios-dev, android-dev, devops-engineer, qa-tester, scene-architect | No | Domain orchestration, composition recipes, validation gates |
| **3 — Micro-agents** | dep-reader, route-adder, typecheck-runner, committer, etc. (37 total) | Yes | One verb, one noun. Max ~10 turns each. |

### Default path: you → sub-manager → micro-agents

**Bypass rule:** For trivial single-file changes (<3 turns), dispatch a micro-agent directly without going through a sub-manager.

### Sub-manager selection

| Domain | Sub-manager |
|---|---|
| Web / API / React | `fullstack-dev` |
| Unity C# scripts | `csharp-dev` |
| React Native | `mobile-dev` |
| Native iOS | `ios-dev` |
| Native Android | `android-dev` |
| Infrastructure / CI | `devops-engineer` |
| Testing / quality | `qa-tester` |
| Unity scenes | `scene-architect` |

### Micro-agent taxonomy (Tier 3)

Use micro-agents directly for trivial tasks or let sub-managers compose them. All 37 micro-agents are available via `run_agent_in_docker` / `start_agent_in_docker`.

- **Inspect** (read-only): `dep-reader`, `route-lister`, `schema-inspector`, `log-tailer`, `test-lister`, `lint-reader`, `type-error-reader`, `git-state-reader`, `api-shape-probe`, `bundle-sizer`, `dead-code-finder`
- **Write** (code-producing): `route-adder`, `component-scaffolder`, `test-writer`, `migration-writer`, `config-editor`, `fixture-writer`, `type-definer`, `env-var-setter`, `dockerfile-editor`, `yaml-patcher`, `readme-section-writer`
- **Validate** (check-only): `typecheck-runner`, `test-runner`, `lint-runner`, `build-runner`, `schema-validator`, `url-route-matcher`, `accessibility-auditor`, `lighthouse-runner`, `security-scanner`
- **Publish** (side-effects): `committer`, `pr-opener`, `branch-manager`, `deploy-trigger`, `app-store-uploader`, `changelog-updater`

"""

ANCHOR_OLD = "Alexandria is for non-project-specific documentation only. Project-specific content belongs in CLAUDE.md.\n\n## Task Decomposition Rules"
ANCHOR_NEW = "Alexandria is for non-project-specific documentation only. Project-specific content belongs in CLAUDE.md.\n\n" + THREE_TIER + "## Task Decomposition Rules"

assert tmpl.count(ANCHOR_OLD) == 1, f"Anchor not unique: {tmpl.count(ANCHOR_OLD)}"
tmpl = tmpl.replace(ANCHOR_OLD, ANCHOR_NEW, 1)
assert THREE_TIER[:30] in tmpl, "Three-tier section not inserted"

with open("src/templates.js", "w", encoding="utf-8") as f:
    f.write(tmpl)

print("src/templates.js: three-tier section added to scrum-master")

# ─── 3. docs/index.html ────────────────────────────────────────────────────────

with open("docs/index.html", "r", encoding="utf-8") as f:
    html = f.read()

# 3a. Version badges
assert html.count('<span class="badge">v2.11.0</span>') == 1, "badge version not unique"
html = html.replace('<span class="badge">v2.11.0</span>', '<span class="badge">v3.0.0</span>', 1)

assert html.count('v2.11.0 &middot;') == 1, "footer version not unique"
html = html.replace('v2.11.0 &middot;', 'v3.0.0 &middot;', 1)

# 3b. Agent count badge
assert html.count('<span class="badge">19 Agents</span>') == 1, "agent count badge not unique"
html = html.replace('<span class="badge">19 Agents</span>', '<span class="badge">56 Agents</span>', 1)

# 3c. Insert micro-agent catalog section after the agents section
AGENTS_SECTION_END = '  </section>\n\n  <!-- Install -->'
MICRO_CATALOG = '''  </section>

  <!-- Micro-agent Catalog -->
  <section class="micro-catalog">
    <div class="container">
      <h2>Micro-Agent Catalog <span class="badge" style="font-size:0.7rem;vertical-align:middle">v3.0 new</span></h2>
      <p class="section-sub">37 focused workers across four layers — each does one verb on one noun. Composed by sub-managers or dispatched directly by scrum-master for trivial tasks.</p>
      <div class="tier-grid">
        <div class="tier-card tier-inspect">
          <h3>Inspect <span class="tier-badge">Read-only · 11 agents</span></h3>
          <code>dep-reader</code> <code>route-lister</code> <code>schema-inspector</code> <code>log-tailer</code> <code>test-lister</code> <code>lint-reader</code> <code>type-error-reader</code> <code>git-state-reader</code> <code>api-shape-probe</code> <code>bundle-sizer</code> <code>dead-code-finder</code>
        </div>
        <div class="tier-card tier-write">
          <h3>Write <span class="tier-badge">Code-producing · 11 agents</span></h3>
          <code>route-adder</code> <code>component-scaffolder</code> <code>test-writer</code> <code>migration-writer</code> <code>config-editor</code> <code>fixture-writer</code> <code>type-definer</code> <code>env-var-setter</code> <code>dockerfile-editor</code> <code>yaml-patcher</code> <code>readme-section-writer</code>
        </div>
        <div class="tier-card tier-validate">
          <h3>Validate <span class="tier-badge">Check-only · 9 agents</span></h3>
          <code>typecheck-runner</code> <code>test-runner</code> <code>lint-runner</code> <code>build-runner</code> <code>schema-validator</code> <code>url-route-matcher</code> <code>accessibility-auditor</code> <code>lighthouse-runner</code> <code>security-scanner</code>
        </div>
        <div class="tier-card tier-publish">
          <h3>Publish <span class="tier-badge">Side-effects · 6 agents</span></h3>
          <code>committer</code> <code>pr-opener</code> <code>branch-manager</code> <code>deploy-trigger</code> <code>app-store-uploader</code> <code>changelog-updater</code>
        </div>
      </div>
    </div>
  </section>

  <!-- Install -->'''

assert html.count(AGENTS_SECTION_END) == 1, f"agents section end not unique: {html.count(AGENTS_SECTION_END)}"
html = html.replace(AGENTS_SECTION_END, MICRO_CATALOG, 1)

# 3d. Add tier-grid CSS before </style>
TIER_CSS = """
    .tier-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; margin-top: 1.5rem; }
    .tier-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1.25rem; }
    .tier-card h3 { color: #58a6ff; margin-bottom: 0.75rem; font-size: 1rem; }
    .tier-badge { font-size: 0.7rem; background: #30363d; color: #8b949e; padding: 0.1rem 0.5rem; border-radius: 10px; font-weight: 400; margin-left: 0.4rem; }
    .tier-card code { display: inline-block; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 0.1rem 0.4rem; font-size: 0.75rem; margin: 0.15rem; color: #79c0ff; }
    .tier-inspect { border-top: 3px solid #388bfd; }
    .tier-write  { border-top: 3px solid #3fb950; }
    .tier-validate { border-top: 3px solid #d29922; }
    .tier-publish { border-top: 3px solid #a371f7; }
"""
assert html.count("  </style>") == 1, "style closing tag not unique"
html = html.replace("  </style>", TIER_CSS + "  </style>", 1)

assert "tier-grid" in html, "CSS not inserted"
assert "dep-reader" in html, "catalog not inserted"
assert "v3.0.0" in html, "version not updated"

with open("docs/index.html", "w", encoding="utf-8") as f:
    f.write(html)

print("docs/index.html: v3.0.0 badge, 56 Agents, micro-agent catalog section added")

# ─── Summary ──────────────────────────────────────────────────────────────────

if errors:
    for e in errors:
        print("ERROR:", e)
    sys.exit(1)

print("SUCCESS: Phase 1c complete — v3.0.0, three-tier section, micro-agent catalog")
