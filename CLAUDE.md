# CLAUDE.md — Project Voltron

> This file is automatically loaded by Claude Code when working in the project-voltron repo.
> Project Voltron is an MCP server that provides agent templates. It improves itself through
> post-session reflections submitted by agents running in user projects.

---

## Repository Structure

```
src/
  index.js       — MCP server: tool definitions, fs operations for reflections
  templates.js   — All agent + config templates as embedded JS objects
reflections/     — Post-session JSON feedback from voltron agents in user projects
docs/
  index.html     — GitHub Pages landing page
package.json     — Version (bump on every template change)
```

**All template content lives in `src/templates.js`.** Edit the `content` field of each template entry to improve agent behavior. The `src/index.js` file only defines tool logic — don't put template text there.

---

## Self-Improvement Protocol

When you start a session here, check for pending reflections first:

1. **Call `project-voltron__list_reflections`** (or read `reflections/*.json`) to see what's waiting
2. **Group feedback by agent** — look for patterns across multiple reflections
3. **Prioritize by frequency** — a suggestion appearing in 2+ reflections is a strong signal; 1 reflection is worth noting but not necessarily acting on immediately
4. **Apply improvements to `src/templates.js`**:
   - Clarify instructions where agents had to improvise
   - Add missing patterns, examples, or domain-specific guidance
   - Fix incorrect or outdated guidance
   - Add new sections if a whole area was missing
5. **Mark reflections as processed**: set `"processed": true` in each reflection JSON file you've acted on
6. **Bump `package.json` version**: patch (2.x.Y) for minor improvements, minor (2.Y.0) for significant additions
7. **Commit** with a message referencing the reflection(s): `v2.x.y: [summary of improvements] (from N reflections)`

---

## Template Structure

Each template in `TEMPLATES` has:
```javascript
"template-key": {
  name: "Display Name",
  filename: "filename.md",
  description: "One-liner (used in list_templates output)",
  category: "agent" | "project-config",
  destination: ".claude/agents/filename.md" | "CLAUDE.md",
  tags: ["core", "unity", "web", "general"],  // controls which scaffold includes this
  content: `...markdown with YAML frontmatter...`
}
```

Agent templates start with YAML frontmatter:
```yaml
---
name: agent-key
description: [Role description — shown to Claude when invoking the agent]
tools: Read, Write, Edit, Bash, ...
---
```

---

## Adding a New Agent

1. Add entry to `TEMPLATES` in `src/templates.js`
2. Add the key to the appropriate tag group(s) in `PROJECT_TYPE_TAGS`
3. Add the key to `AGENT_NAMES` array (it's derived from `TEMPLATES`, so check if manually maintained)
4. Test: `node src/index.js` — should start without errors (hangs on stdin, that's expected)
5. Verify `getTemplatesForType("unity")` / `getTemplatesForType("web")` return expected keys

---

## Versioning Convention

| Change type | Version bump |
|---|---|
| Minor instruction improvement, clarification | patch (2.0.x → 2.0.x+1) |
| New section in existing agent | patch |
| New agent added | minor (2.x.0 → 2.x+1.0) |
| New project type or major restructure | major (x.0.0) |

---

## Documentation Rule

**Any code change must be accompanied by documentation updates in the same commit.** This means:

- `docs/index.html` — update version badges, tool tables, feature sections, and workflow descriptions to reflect the change
- `README.md` — keep in sync with any new tools, changed behavior, or new workflows

Do not commit code changes without also updating `docs/index.html` and `README.md`. GitHub Pages deploys automatically from `docs/` on `main` — outdated pages will be immediately visible to users.

---

## Agent Team Roles

### Orchestrator (slash command — runs in the main Claude Code session)

| Command | File | Purpose |
|---|---|---|
| `/scrum-master` | `.claude/commands/scrum-master.md` | Work breakdown, task assignment, sprint coordination |

The scrum-master is a **slash command**, not a subagent. It runs in your main chat session so it can stream real-time agent output, drive the dashboard, and channel communication between you and the specialists. Subagent contexts cannot do any of that.

### Specialist subagents (defined in `.claude/agents/`)

| Agent | File | Purpose |
|---|---|---|
| `project-planner` | `project-planner.md` | Architecture design, research, project planning |
| `researcher` | `researcher.md` | Deep research, web scraping, information gathering |
| `harness-engineer` | `harness-engineer.md` | **All Voltron modifications** — agent templates, Dockerfile, MCP server, docs, scripts. Also processes session reflections into template improvements. Delegate ALL Voltron edit tasks here. |

**Invoke with:** `/scrum-master` (orchestrator), `@agent-project-planner`, `@agent-researcher`, `@agent-harness-engineer` (specialists — usually dispatched by the scrum-master rather than invoked directly).

Docker execution is available via `Dockerfile.voltron` + `scripts/voltron-run.sh`.
Prerequisites: Docker installed and running.

---

## Things Claude Should Never Do

- Modify `node_modules/` or `package-lock.json` manually
- Push directly to `main` — use feature branches if changes are significant
- Delete reflection files — mark them `processed: true` instead (they're historical record)
- Bump version without also updating the template content (version must reflect actual template state)
- Ship code changes without updating `docs/index.html` and `README.md`


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
