# Validation Policy Design — Mandatory Validation in Voltron Dispatches

> **Bead:** voltron-8sr
> **Author:** project-planner (design only — implementation is delegated to `@agent-harness-engineer`)
> **Date:** 2026-05-29
> **Status:** Design ready for harness-engineer to apply.

---

## 0. Why this exists (user motivation, verbatim)

> *"I'd like any and all work voltron does to ideally be validated with tests. Rarely should voltron complete work without some attempt to validate it or some instructions to assist in validating."*

Today, validation in Voltron dispatches is **opt-in**. The scrum-master and sub-managers *can* chain a `typecheck-runner` / `test-runner` / `build-runner` after a write — and the composition-recipe tables suggest they should — but the rule is not enforced in the task description format. Reflections show agents finishing tasks with `[DONE]` lines that say *"created file X"* and no verification that X compiles, runs, or matches the request.

This design makes validation **mandatory** at the dispatch-contract level. Every task description must end with one of three explicit modes (a/b/c, defined below), and orchestrators must refuse to dispatch tasks without one.

---

## 1. The Contract — exact wording for the scrum-master template

The following block is to be inserted into the `scrum-master` template in `src/templates.js` (around line 1133, immediately above the existing `## Work Plan Format` heading) and titled **`## Validation Contract (Mandatory)`**. Treat the literal markdown below as the source — copy it verbatim.

```markdown
## Validation Contract (Mandatory)

Every task you dispatch — via `run_agent_in_docker`, `run_agent_in_docker_batch`, or the host-side `Agent` tool — MUST include exactly one of the following validation modes. There are no exceptions. A task description without a validation clause is malformed and will be refused.

**Mode (a) — Self-validation (preferred when an automated check exists).**
The task description ends with: *"Before emitting [DONE], run `<command>` and confirm `<expected outcome>`. If the check fails, do not emit [DONE]; report the failure."*
Examples of `<command>`: `npm run typecheck`, `npm test -- <pattern>`, `pytest tests/<file>`, `dotnet build`, `cargo test`, `grep -c <token> <file>` (to confirm an edit landed), `tsc --noEmit`, `npm run lint`.

**Mode (b) — User-runnable validation (when a self-check is not feasible inside the agent's context).**
The task description ends with: *"The [DONE] line MUST include the literal command(s) the user can run to verify, formatted as: `Verify: <command>` on a single line."*
Examples: visual rendering checks ("Verify: `npm run dev` then load http://localhost:5173 and confirm the header turns blue"), Play Mode tests, infra deploys.

**Mode (c) — Documented "no automated validation possible" (last resort).**
The task description ends with: *"No automated validation possible because <one-sentence reason>; the [DONE] line MUST cite this reason explicitly."*
This mode is allowed only when (1) the change has no observable, mechanically-checkable consequence (e.g., a comment-only typo fix, a CHANGELOG bullet), or (2) validation requires a capability genuinely unreachable in the agent's environment AND a user-runnable substitute (mode b) is also impossible. If you find yourself reaching for mode (c) more than once per work plan, stop — you are probably under-decomposing.

### Surfacing the choice in the Work Plan table

The Work Plan table gets a new column, `Validation`, inserted after `Acceptance Criteria`. Every row of every Work Plan you produce must populate this column with a short tag indicating which mode applies and, when feasible, the literal command. Examples:

- `(a) npm run typecheck`
- `(a) grep -c 'export const usersRouter' server/src/routes/users.ts == 1`
- `(b) Verify: load /api/users in browser, expect 200 JSON`
- `(c) doc-only — no runnable check`

### Refusal script (use this verbatim when tempted to dispatch without validation)

> *"I can't dispatch `<task>` without a validation criterion. Adding `<suggested mode>` as the validation step: `<concrete command or user-runnable instruction>`. If no automated check applies, this becomes `[user must verify <X>]` in the [DONE] line, and I'll mark the row `(c) <reason>` in the Work Plan."*

If you cannot honestly fill in `<concrete command>`, stop dispatching and ask the user. Do not silently demote to mode (c) to make the task go through.
```

---

## 2. Work Plan Format Update

The current Work Plan example in the scrum-master template (around line 1133–1155) reads:

```
| # | Task | Agent | Dependencies | Acceptance Criteria |
|---|---|---|---|---|
| 1 | [What to do] | @agent-[name] | — | [How to verify it's done] |
```

Replace with this exact block — `Validation` column appended:

```markdown
## Work Plan Format

Always output your plan as a structured table. Every row must populate the `Validation` column with the mode and command per the Validation Contract (Mandatory) above.

\`\`\`
## Work Plan — [Feature or Sprint Name]

### Phase 1: [Phase Name]

| # | Task | Agent | Dependencies | Acceptance Criteria | Validation |
|---|---|---|---|---|---|
| 1 | Add GET /api/users route in server/src/routes/users.ts | @agent-route-adder | — | route returns 200 with user array | (a) `npm run typecheck && npm test -- users.test.ts` |
| 2 | Style the new header bar with the design tokens | @agent-css-writer | #1 | header uses `--color-accent` and is responsive | (b) Verify: `npm run dev`, load /, header is full-width and uses accent colour |
| 3 | Fix typo "recieve" → "receive" in CHANGELOG.md | @agent-file-patch-runner | — | typo gone | (a) `grep -c 'recieve' CHANGELOG.md == 0` |
| 4 | Document the new `--debug-port` flag in README intro paragraph | @agent-readme-section-writer | #1 | flag described once, near the intro | (c) doc-only — no runnable check; mode (a) `grep -c '--debug-port' README.md >= 1` is also acceptable |

### Phase 2: [Phase Name]

| # | Task | Agent | Dependencies | Acceptance Criteria | Validation |
|---|---|---|---|---|---|
| 5 | Run full QA pass | @agent-qa-tester | #1, #2, #3 | typecheck + tests + lint all green | (a) `npm run typecheck && npm test && npm run lint` |

### Blockers / Questions
- [Question or blocker that needs human input]
\`\`\`

Row 1 is a classic (a)-style self-validation: a single command verifies the change.
Row 2 is (b)-style — visual correctness is not mechanically checkable without a user, so the validation is a user-runnable command + expected outcome.
Row 3 demonstrates (a)-style even for trivial changes: a `grep` is a perfectly valid mechanical check.
Row 4 shows the (c) → (a) escape hatch: if any cheap mechanical check exists (even a grep that a token landed), prefer it over (c).
```

The four rows above are not optional examples — they are the canonical reference for (a), (b), and (c) modes side by side. The harness-engineer should keep all four in the template so future scrum-masters can pattern-match.

---

## 3. Sub-manager template updates

Each of the five sub-managers — `fullstack-dev`, `csharp-dev`, `devops-engineer`, `qa-tester`, `scene-architect` — has a **Composition Recipes** section in `src/templates.js` (located at the line numbers below) that lists default micro-agent chains. The policy change:

> **After every WRITE-class micro-agent in a recipe, the sub-manager MUST chain a corresponding VALIDATE-class micro-agent before the chain terminates (or before any `committer` / `pr-opener` / `deploy-trigger` runs).** If the chosen language/stack has no applicable validator, the sub-manager MUST document this in the dispatch by appending the mode-(b) or mode-(c) clause to the task description (see Validation Contract section 1).

### Per-sub-manager insertion: literal text

Insert the following block immediately **above** the `## Composition Recipes` heading in each sub-manager template:

```markdown
### Validation Chain Rule (mandatory before committer)

After every WRITE-class micro-agent (anything that produces or edits source — `route-adder`, `component-scaffolder`, `function-writer`, `csharp-script-writer`, `csharp-member-adder`, `dockerfile-editor`, `ci-workflow-writer`, `yaml-patcher`, `migration-writer`, `config-editor`, `css-writer`, `design-token-writer`, `file-patch-runner`, etc.), you MUST chain a corresponding VALIDATE-class micro-agent (`typecheck-runner`, `test-runner`, `lint-runner`, `build-runner`, `schema-validator`, `security-scanner`, `url-route-matcher`, `accessibility-auditor`, `coverage-runner`) BEFORE `committer`, `pr-opener`, or `deploy-trigger` runs. The recipe table below already reflects this rule; if you build a custom chain that diverges from a recipe, you must still honor the rule.

If no validator applies to the file class being edited (e.g., a CHANGELOG bullet, a one-line README edit, a comment-only diff), you MUST instead include a mode-(b) or mode-(c) clause in the writer's task description per the scrum-master Validation Contract — and you MUST surface that in your [DONE] report to the scrum-master.
```

### Per-sub-manager validate-class selection rules

Each sub-manager's block must specify which VALIDATE-class micro-agent maps to each WRITE-class micro-agent. Add this table beneath the rule, customized per stack:

#### `fullstack-dev` (TypeScript / React / Node — template at ~line 3211)

| If writer is… | Chain validator… | Rationale |
|---|---|---|
| `route-adder`, `middleware-writer`, `function-writer`, `store-slice-writer`, `type-definer`, `component-scaffolder` | `typecheck-runner` AND (if tests exist for the touched file) `test-runner` | TS types are the cheapest correctness signal; tests catch regressions |
| `css-writer`, `design-token-writer` | `lint-runner` (stylelint) | CSS has no type system; lint is the only mechanical check |
| `migration-writer` | `schema-validator` | DB schema correctness is upstream of all tests |
| `test-writer` | `test-runner` | A test that doesn't run is no test |
| `env-var-setter`, `config-editor` (env files only) | mode (a) `grep -c '<VAR>=' .env == 1` OR mode (c) | No runtime check for env existence; grep suffices |
| `file-patch-runner` | `typecheck-runner` + `lint-runner` | Bulk edits can break either |

#### `csharp-dev` (Unity C# — template at ~line 2055)

| If writer is… | Chain validator… | Rationale |
|---|---|---|
| `csharp-script-writer`, `csharp-member-adder` | `build-runner` AND (if EditMode tests exist) `test-runner` | Compile is the first gate; tests catch behavioural regressions |
| `unity-manifest-editor` | `build-runner` | Manifest changes can break the package resolver |
| `file-patch-runner` (C#) | `build-runner` + `lint-runner` (if configured) | Bulk C# edits can break compile |
| Play-Mode-only behaviour | mode (b): `Verify: open Unity, enter Play Mode, observe <X>` | Cannot run inside Docker |

#### `devops-engineer` (Infra / CI/CD — template at ~line 3539)

| If writer is… | Chain validator… | Rationale |
|---|---|---|
| `dockerfile-editor` | `build-runner` (`docker build` the image) | Build is the only way to confirm Dockerfile validity |
| `ci-workflow-writer`, `yaml-patcher` (workflow files) | `lint-runner` (`actionlint`) + mode (b) `Verify: trigger workflow run, watch outcome` | YAML lint catches structural errors; actual run is user-side |
| `config-editor`, `env-var-setter` | mode (a) `grep` + (when relevant) `build-runner` | Config changes often have no automated runtime check |
| `docker-compose-editor` | mode (a) `docker compose config` (parse-check) | Validates the compose file without spinning up services |
| `terraform-writer` (if added) | `terraform validate` + `terraform plan` | Static + planning gates |

#### `qa-tester` (Testing / Auditing — template at ~line 4167)

This sub-manager is already validate-heavy by nature, but it still composes test-writers. Rule:

| If writer is… | Chain validator… | Rationale |
|---|---|---|
| `test-writer`, `test-config-writer`, `mock-writer`, `fixture-writer` | `test-runner` (immediately after the writer wave) | A QA agent that writes tests without running them is failed by definition |
| `file-patch-runner` (test bulk edit) | `test-runner` | Catches the case where the patch broke an unrelated test |

In addition, `qa-tester` is the canonical agent for **mode-(a) verification on behalf of other sub-managers**. If a sub-manager cannot run a validator in its own dispatch (e.g., `scene-architect` cannot run Play Mode tests inside Docker), it MUST surface a follow-up `qa-tester` task in the same Work Plan, dependency-linked to its own task.

#### `scene-architect` (Unity scene composition — template at ~line 1802)

This sub-manager's work spans Docker (file edits) and host (Unity Editor / Coplay MCP). Rule:

| If writer is… | Chain validator… | Rationale |
|---|---|---|
| `csharp-script-writer`, `csharp-member-adder` (delegated to `csharp-dev`) | `build-runner` | Compile gate |
| `unity-manifest-editor` | `build-runner` | Package resolver gate |
| Editor-side wiring (Coplay MCP — host-only) | mode (b): `Verify: open the scene in Unity, enter Play Mode, observe <X>` | Docker cannot run the Editor |
| Scene prefab / hierarchy edits | mode (b) Play-Mode smoke OR mode (c) when the change is structurally trivial (e.g., rename one GameObject) | Most scene work is visually verified |

The `scene-architect` template, more than any other sub-manager, will lean on modes (b) and (c). That is acceptable — what is NOT acceptable is omitting the mode tag entirely.

---

## 4. Agent template self-validation guidance (shared boilerplate addition)

The `Validation & Handoff` section is repeated across ~50 micro-agent templates (every occurrence of `## Validation & Handoff` between line 1522 and the end of `src/templates.js`). It is not centralized — each template embeds its own copy with a customized `from_agent` field. To roll out the policy, the harness-engineer must update **every** occurrence.

### Literal addition — insert as a new step **3** between current steps 2 and 3

Old (current) numbered list (canonical form, from line 5200 onward):

```
1. Re-read the acceptance criteria provided in your task.
2. For each criterion, state how you verified it (command run, file diff, test passed).
3. If any criterion is unverified or you improvised outside your scope, STOP and hand off…
4. If validation requires a capability you don't have …
```

New (target) numbered list — insert the bolded item as new step 3, renumber old 3/4 to 4/5:

```
1. Re-read the acceptance criteria provided in your task.
2. For each criterion, state how you verified it (command run, file diff, test passed).
3. **Your [DONE] line MUST end with one of the following clauses. If the dispatcher's task description included a mode (a/b/c) tag, honor it. If it did not, default to the lowest-cost applicable mode and state which you chose:**
   - **(a) `Self-validated: <command(s) run> → <result>`** — e.g. `Self-validated: npm run typecheck → 0 errors; grep -c 'export const usersRouter' = 1`.
   - **(b) `User verify: <exact command>` (and a one-line expected outcome)** — e.g. `User verify: npm run dev, then load http://localhost:5173 and confirm the header is blue`.
   - **(c) `No runnable check possible because <reason>`** — e.g. `No runnable check possible because the change is a single comment edit with no observable behavior`. Mode (c) is allowed only when modes (a) and (b) are both genuinely infeasible.
4. If any criterion is unverified or you improvised outside your scope, STOP and hand off: name the agent (e.g. `@agent-test-runner`) and describe the exact next task.
5. If validation requires a capability you don't have (e.g. run Play Mode, macOS-only build, live browser test), escalate to scrum-master — do NOT mark complete.
```

**Why renumber rather than append:** the [DONE] format constraint must run *before* the handoff escape hatch, because it forces the agent to confront whether validation actually happened. An agent that finishes the rest of the checklist and then realizes it owes a mode tag is more likely to honestly pick (b) or (c) than one that bolts the tag on as an afterthought.

---

## 5. Refusal script — scrum-master must refuse to dispatch tasks without validation

The scrum-master template must contain a refusal script searchable by grep (`grep -nF "I can't dispatch" src/templates.js` should match). Insert the following block at the end of the `## Validation Contract (Mandatory)` section (continuation of section 1 above):

```markdown
### When you catch yourself about to dispatch without a Validation tag

**Refuse out loud. Use this script verbatim:**

> "I can't dispatch `<task summary>` without a validation criterion. The Validation Contract requires every task to end with one of:
> - **(a)** a self-validation command the dispatched agent runs before [DONE], OR
> - **(b)** a `Verify: <command>` line for the user to run, OR
> - **(c)** an explicit `no runnable check possible because <reason>` note.
>
> Adding `<suggested mode and concrete clause>` as the validation step. If no mechanical check applies and the user cannot verify either, this task is malformed — I'll surface a clarifying question rather than dispatch it."

If you cannot honestly complete the suggested clause, do NOT silently downgrade to mode (c). Surface a `## Blockers / Questions` entry on the Work Plan and ask the user how they want this verified. Mode (c) is for trivially unverifiable changes (typo in a comment), not for "I didn't bother to think of a check."
```

The refusal script is intentionally a literal quotation block so it is mechanically copy-pasteable and grep-able. **Acceptance check for harness-engineer:** `grep -F "I can't dispatch" src/templates.js` returns at least one hit after the change.

---

## 6. What this does NOT mean (guard against over-correction)

This policy is **not** "every trivial config edit needs a full Jest suite." That would burn cost on no-value verification, push agents toward writing throwaway tests to satisfy the gate, and slow every dispatch by 10–30s of Docker spin-up.

**The threshold is:** *does the change have an observable, mechanically-checkable consequence?* If yes, validate it with the cheapest available check. If no, document why and move on.

Concrete examples of right-sized validation:

| Change | Right-sized validation | Wrong (over-corrected) |
|---|---|---|
| Typo fix in a comment | (c) `comment-only` OR (a) `grep -c '<typo>' file == 0` | Writing a Jest test that loads the file and asserts comment content |
| Adding a CHANGELOG bullet | (c) `doc-only` OR (a) `grep -c '<bullet text>' CHANGELOG.md >= 1` | Running `npm test` |
| Editing an env var | (a) `grep -c '<VAR>=' .env == 1` | Spinning up the full app to "verify" the var is loaded |
| Renaming an exported TS symbol | (a) `npm run typecheck` (TS will catch every caller) | Manually re-grepping every importer |
| Adding a new API route | (a) `npm run typecheck && npm test -- <route>.test.ts` | One-line grep that the route file exists |
| Editing a Unity scene prefab | (b) `Verify: open scene in Unity, enter Play Mode, observe <X>` | Mode (c) — Play Mode is the canonical check, never skip it |
| Adding visual polish to a header | (b) `Verify: npm run dev, load /, observe <X>` | Mode (c) — visual changes have observable consequences |

The decision tree is short:

1. Is there a single command (`grep`, `tsc`, `jest`, `build`, `lint`) that will mechanically tell us the change worked? → mode (a), use that command.
2. If not, is there a thing a human can do in under 60 seconds to confirm? → mode (b), describe that thing.
3. If not, is the change genuinely unverifiable (typo in a comment, doc-only bullet, dead-code removal already proven by a static analyzer in CI)? → mode (c), say so.
4. None of those? → the task is malformed. Refuse and ask the user.

---

## 7. Acceptance for the implementation that follows

The harness-engineer agent will execute the changes against `src/templates.js`. Mechanical acceptance criteria for that work:

1. **Validation Contract section present in scrum-master template.**
   `grep -c 'Validation Contract' src/templates.js` returns `>= 1`.
2. **Refusal script searchable.**
   `grep -F "I can't dispatch" src/templates.js` returns at least one match.
3. **All five sub-manager templates carry the validation-chain rule.**
   `grep -c 'after every WRITE-class micro-agent' src/templates.js` (case-insensitive: `grep -ic`) returns `>= 5`. (Each of `fullstack-dev`, `csharp-dev`, `devops-engineer`, `qa-tester`, `scene-architect` must contain the exact phrase.)
4. **Work Plan example shows the Validation column.**
   The Work Plan code-fenced example in the scrum-master template contains the header row `| # | Task | Agent | Dependencies | Acceptance Criteria | Validation |` (verify by `grep -F '| Acceptance Criteria | Validation |' src/templates.js` returning `>= 1`).
5. **Every micro-agent's `Validation & Handoff` block includes the mode (a)/(b)/(c) [DONE] clause.**
   `grep -c 'Self-validated:' src/templates.js` and `grep -c 'User verify:' src/templates.js` and `grep -c 'No runnable check possible' src/templates.js` each return `>= 40` (one occurrence per micro-agent template; ~50 templates exist).
6. **JS file still parses.**
   `node --check src/templates.js` exits 0.
7. **Version + docs bumped.**
   `package.json` `version` field increments (this is a minor bump — significant behaviour change across the orchestrator stack — recommend `2.Y.0 → 2.Y+1.0`). `docs/index.html` and `README.md` updated to reflect the new mandatory validation contract.
8. **No reflections file edits** (this policy does not touch the reflection corpus — only the live templates).

### Hand-off to scrum-master

After this design is approved, invoke `/scrum-master` with this document as the input. The scrum-master should produce a Work Plan with at minimum:

- Phase 1: `@agent-harness-engineer` — add the Validation Contract section + Work Plan example update to the scrum-master template. Validation: mechanical checks #1, #2, #4 above.
- Phase 2: `@agent-harness-engineer` — add the validation-chain rule to all five sub-manager templates. Validation: mechanical check #3.
- Phase 3: `@agent-harness-engineer` — update the shared `Validation & Handoff` block across all ~50 micro-agent templates. Validation: mechanical check #5.
- Phase 4: `@agent-harness-engineer` — bump version, update `docs/index.html` and `README.md`. Validation: mechanical checks #6, #7.
- Phase 5: `@agent-qa-tester` — run final mechanical acceptance suite (#1–#7 in one pass) and report.

---

## 8. Open questions for the user

1. **Mode-(c) audit threshold.** Should we instrument the harness to count mode-(c) usage per session and warn when it exceeds N? (e.g., "you've dispatched 4 mode-(c) tasks in this session — is the work actually under-decomposed?") Out of scope for this policy doc; flagging for a future bead.
2. **Backward compatibility for existing reflections.** Should the `submit_reflection` schema gain a `validation_mode` field so future analysis can correlate failure modes with skipped validation? Out of scope; flagging.
3. **Recommended version bump:** the user should confirm whether this lands as a patch (`2.x.Y`) or minor (`2.Y.0`). My recommendation is **minor** (`2.Y.0`) — this is a contract change across the entire orchestrator stack, visible to every user of every template.

---

## 9. Summary

This design makes validation mandatory at the dispatch-contract level, not just at the recipe-suggestion level. The three modes (a/b/c) give orchestrators a clear vocabulary; the refusal script gives them a literal sentence to say instead of dispatching an unverifiable task; the Work Plan column makes the choice auditable; and the shared `Validation & Handoff` boilerplate change pushes the constraint all the way down to the micro-agent [DONE] line.

Implementation is delegated to `@agent-harness-engineer`. Mechanical acceptance is defined in section 7.

> Plan saved to `docs/validation-policy-design.md`. Invoke `/scrum-master` with this plan to generate a work breakdown.
