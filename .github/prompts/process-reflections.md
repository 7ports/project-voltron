# Process Voltron Reflections

You are working in the **project-voltron** repository — an MCP server that provides agent templates for Claude Code. Your task is to process all unprocessed reflections and apply improvements to the agent templates.

## Steps

1. **Find unprocessed reflections**: Read every `.json` file in `reflections/`. Filter to those where `"processed"` is `false` or absent.

2. **If there are none**: output "No unprocessed reflections found. Nothing to do." and stop — do not commit anything.

3. **For each unprocessed reflection**, read:
   - `agent_feedback` — array of `{ agent, worked_well, needs_improvement, suggested_change }`
   - `overall_notes` — cross-agent observations

4. **Apply improvements to `src/templates.js`**:
   - Locate the agent's `content` field (the markdown string for that agent template)
   - Make surgical, targeted edits based on `suggested_change` — add a section, clarify existing instructions, fix incorrect guidance
   - Do not rewrite entire agents — only edit what the feedback specifically calls out
   - If multiple reflections suggest the same change, apply it once

5. **Mark each reflection processed**: set `"processed": true` in the JSON file.

6. **Bump the patch version** in `package.json` (e.g. `2.1.0` → `2.1.1`).

7. **Commit all changes**:
   ```bash
   git add src/templates.js reflections/ package.json
   git commit -m "v<new-version>: <brief summary of improvements> (from <N> reflection(s))"
   ```
   Write a commit message that summarizes what changed and which agents were improved.

## Constraints

- Only modify `src/templates.js`, `reflections/*.json`, and `package.json` — nothing else
- Do **not** touch `src/index.js`, `docs/`, `README.md`, `CLAUDE.md`, or any other files
- If a reflection's feedback is too vague to implement safely, mark it `processed: true` but make no template change — note this in the commit message with "skipped [agent]: feedback too vague"
- Do not change template frontmatter (`name:`, `description:`, `tools:`) unless explicitly called for by the feedback

Refer to `CLAUDE.md` in the project root for the full self-improvement protocol, versioning convention, and template structure guide.
