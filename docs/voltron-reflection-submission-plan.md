# Plan: Reliable `submit_reflection` Persistence & Submission

## Overview

The `submit_reflection` MCP tool (`src/index.js`, function body ~L965–1023) writes a
reflection JSON file and then unconditionally runs `git add` → `git commit` → `git push`
(~L1001–1006). This auto-commit/push behavior is broken in three observable ways:

1. **Strands commits on protected `main`.** `main` is branch-protected (GH013 rejects direct
   pushes). A reflection submitted while `main` is checked out commits locally but the push
   fails, leaving the commit stranded ahead of `origin/main`. **3 such stranded commits exist
   right now** on this branch (`fdcb2e5`, `86e7f15`, `1984deb`).
2. **Pollutes unrelated feature-branch PRs.** When a feature branch is checked out, the
   reflection commit lands on that branch and rides into its PR (this happened in PR #43).
3. **Fails silently / leaves files loose.** **62 reflection JSON files are currently untracked**
   in `reflections/` — the add/commit/push path either did not run or errored without the
   caller being able to tell.

Net: reflections are never "properly submitted." This plan recommends one approach to fix the
tool's behavior, specifies the exact edit for a harness-engineer, and designs a safe one-time
cleanup of the existing loose state.

---

## Recommended Approach

### **Write-only + explicit status reporting (no auto-commit, no auto-push)**

`submit_reflection` should **only write the reflection file to `reflections/`** and then
**return an explicit, machine-readable status** describing what it did and what the caller must
do next. It must **not** run `git add`, `git commit`, or `git push` at all.

Committing and pushing reflections becomes the responsibility of an explicit, branch-aware step
— a dedicated sweep (see Cleanup, below) or the normal session-close protocol — never a side
effect buried in an MCP tool call that has no idea which branch is checked out or whether it is
protected.

**Why this is the right default:**

- **Cannot strand commits on `main`** — it never commits, so there is nothing to fail to push
  (eliminates problem #1).
- **Cannot pollute a feature-branch PR** — it never commits onto the working branch
  (eliminates problem #2).
- **Cannot fail silently** — file write success/failure is reported explicitly in the tool
  result, and the caller is told the file is uncommitted and how to submit it
  (eliminates problem #3).
- **Matches reality of an LLM-driven harness** — the orchestrator (scrum-master / main Claude)
  already owns git workflow and branch hygiene per the session-close protocol. A tool that
  silently commits behind the orchestrator's back fights that ownership. Returning a clear
  "file written, NOT committed — commit it on a non-protected branch / via PR" instruction puts
  the decision where the branch context actually lives.
- **Reflections are an append-only historical record**, not latency-sensitive. A short delay
  between "written" and "merged to main via PR" is harmless; a stranded or PR-polluting commit
  is not.

### What the tool RETURNS (the key behavioral contract)

The result text **and** a structured summary must always state:

- `saved: true/false` and the relative path `reflections/<filename>`.
- `committed: false` — explicitly, every time (the tool no longer commits).
- A one-line next-step instruction for the orchestrator, e.g.:
  > Reflection written to `reflections/<filename>` (uncommitted). It will reach `main` when the
  > reflections sweep commits `reflections/*.json` and merges via PR. Do **not** commit it onto
  > an unrelated feature branch.
- On write failure: `saved: false` plus the error message, so the caller knows the reflection
  was lost and can retry. (Write failure is the only failure mode left, and it is surfaced, not
  swallowed.)

This guarantees the orchestrator always knows the true outcome: the file is on disk, it is not
yet in git, and submission is a separate, explicit, branch-safe action.

### Alternatives Considered

| Alternative | How it works | Trade-offs / why not chosen |
|---|---|---|
| **A. Commit only on a safe (non-protected, non-feature) branch; otherwise just write** | Detect current branch; if it is a dedicated/safe branch, commit (no push); otherwise write-only. | Better than today, but the tool must encode branch-protection rules it cannot reliably know (protection lives server-side on GitHub), and a "commit but don't push" still leaves local-only commits that can be force-lost or accidentally amended. Adds branch-detection complexity for little gain over write-only. |
| **B. Dedicated `reflections` branch + auto-PR** | Tool commits each reflection to an orphan/long-lived `reflections` branch and opens/appends a PR. | Cleanest "auto-submit" story and never touches the working branch, **but** requires the MCP server to manage branch checkout/worktree, network auth, and `gh`/API calls from inside a tool invocation — heavy, stateful, and failure-prone in Docker/headless runs. Push/auth failures reintroduce silent-failure risk. Reasonable future enhancement once a sweep workflow exists; over-engineered as the immediate fix. |
| **C. Best-effort push with explicit success/failure reporting** | Keep add/commit/push but report the true result instead of swallowing it. | Reporting is an improvement, but it does **not** fix stranding (#1) or PR pollution (#2) — it only makes them visible. Keeps the tool coupled to git/branch state it cannot reason about. |

The recommended write-only approach is the smallest change that structurally eliminates all
three problems rather than merely reporting them. Approach B is the natural follow-up if fully
automated submission is later desired.

---

## Exact Edit Locus & Behavioral Change (for harness-engineer)

**File:** `src/index.js`
**Locus:** the `try { … } catch (err) { … }` git block at **~L998–1010**, inside the
`submit_reflection` tool handler. The file-write at L996 (`writeFileSync`) is **kept** — only
the git side effects change.

**Precise change:**

1. **Delete** the three git side-effect lines in the `try` block (~L1001–1006):
   ```js
   execSync(`git add "reflections/${filename}"`, { cwd: repoRoot });
   execSync(`git commit -m "Add reflection: ${filename}"`, { cwd: repoRoot });
   execSync("git push", { cwd: repoRoot });
   ```
   Remove the now-unused `repoRoot` and the success-string assignment for git, and the
   surrounding `try/catch` that wrapped them. (`execSync` may now be unused by this tool — leave
   any other usages elsewhere in the file untouched.)

2. **Wrap the existing `writeFileSync` (L996) in its own try/catch** so a write failure is the
   reported failure mode:
   - On success: continue to the success result.
   - On failure: return a result with `saved: false` and the error message.

3. **Change the returned result** (currently ~L1012–1022) so it always communicates the
   write-only contract:
   - State the file path and that it is **saved but NOT committed**.
   - Include the next-step instruction (commit via the reflections sweep / PR; do not commit
     onto a feature branch).
   - Drop the old `Committed and pushed to remote.` / git-warning text entirely.

**Acceptance for the implementing agent:**
- `submit_reflection` performs **no** `git add/commit/push`.
- Result text explicitly says the file is uncommitted and names the path.
- A simulated write failure yields a result indicating the reflection was **not** saved.
- `node src/index.js` starts without error (hangs on stdin — expected).

**Docs to update in the same commit** (per the project Documentation Rule): adjust any
description of `submit_reflection` in `docs/index.html` and `README.md` to say reflections are
written locally and committed via the reflections sweep / PR, not auto-pushed. Bump
`package.json` (patch — behavioral fix, no template content change). Note: this is a change to
MCP tool logic in `src/index.js`, not a template `content` edit.

---

## One-Time Cleanup of Existing Loose Reflections

**Goal:** get all loose reflections into git history and onto `origin/main` **non-destructively**
(reflections are a historical record — **never delete**). Verified current state on branch
`fix/reflections-and-result-overflow`:

- **3 stranded "Add reflection" commits** ahead of `origin/main`, already carried as ancestors
  of this branch: `fdcb2e5`, `86e7f15`, `1984deb`. Because they are ancestors of HEAD, they will
  reach `origin/main` automatically when this branch's PR merges — **no separate action needed**
  for them beyond confirming they ride the PR. (They are not "lost"; they just need a legal path
  to `main`, which the PR provides.)
- **62 untracked `reflections/*.json`** files. **46** reflection files are already tracked.

**Recommended cleanup (single, safe, on this branch):**

1. Stage **only** the reflections, explicitly, so no unrelated working-tree files are swept in:
   ```bash
   git add reflections/*.json
   git status --short reflections/   # confirm 62 files staged as new (A)
   ```
2. Commit them in one batch on this feature branch:
   ```bash
   git commit -m "Add 62 pending reflections (batch backfill)"
   ```
3. Push the branch and let them reach `origin/main` **through this branch's PR** — the same PR
   that carries the source fix. This routes everything through the protected-branch PR flow
   (no direct push to `main`), satisfying branch protection:
   ```bash
   git push
   ```
4. After merge, verify: `git ls-files reflections/ | wc -l` on `origin/main` shows `46 + 62 = 108`
   tracked files, and `git log origin/main` contains the 3 previously-stranded commits.

**Why batch-commit on this branch (not a separate reflections branch):** the 3 stranded commits
are already on this branch, and this branch already has an open path to `main` via PR. Committing
the 62 here gets every loose reflection to `main` through one reviewed, protection-compliant
merge — minimal steps, fully non-destructive, nothing deleted, nothing force-pushed.

**Guardrails:**
- Do **not** rebase, squash, or drop the 3 stranded commits — preserve them as-is.
- Use `git add reflections/*.json` (path-scoped), never `git add -A`, to avoid pulling in the
  other modified working-tree files (`Dockerfile.voltron`, `scripts/voltron-run.sh`,
  `.claude/commands/scrum-master.md`, etc.) unless intentionally part of this PR.
- No file deletions at any step.

---

## Open Questions (need human input)

1. **Scope of this PR's commit:** should the 62-reflection backfill ride **this** branch's PR
   (recommended — fewest steps), or go on a separate `reflections-backfill` branch/PR to keep the
   source fix diff clean? Either is safe; this is a review-hygiene preference.
2. **Future full automation:** once write-only lands, is an automated reflections sweep desired
   (a scheduled job or a `/scrum-master` close step that commits `reflections/*.json` and opens a
   PR — Alternative B)? If yes, that is a follow-up task to spec separately.
3. **Should the tool result include a structured field** (e.g. JSON block with
   `saved`/`committed`/`path`) in addition to prose, so orchestrators can parse outcome
   programmatically? Recommended, but confirm the orchestrator consumes it.

---

> Plan saved to `docs/voltron-reflection-submission-plan.md`. Invoke `/scrum-master` with this
> plan to generate a work breakdown (harness-engineer implements the `src/index.js` edit + docs;
> the cleanup commit can be done in-session).
