# EOL Normalization Plan — project-voltron

> **Status:** Design only. No commands in this document should be executed by the planner.
> **Purpose:** Fix the Docker/host CRLF mismatch that is masking real diffs and causing
> committer micro-agents to bail when they see whole-file EOL flips.

---

## 1. Current State Inventory (measured 2026-05-26 from inside the Docker workspace)

### 1.1 Git config

| Side | `core.autocrlf` | `core.eol` |
|---|---|---|
| Host (Windows) | `true` | unset |
| Docker container | unset | unset |
| Repo `.gitattributes` | **does not exist** | — |

### 1.2 Index/worktree EOL distribution (267 tracked files)

| `i/` (index) | `w/` (working tree) | Count | Meaning |
|---|---|---|---|
| `lf`   | `lf`   | 144 | Clean. These are files Docker has rewritten OR pure-LF source. |
| `lf`   | `crlf` | 123 | **Day-to-day footgun.** Index is LF, host autocrlf put CRLF in working tree. Every fresh Docker agent that compares working tree vs index sees the whole file as changed. |
| `crlf` | `crlf` | **8** | **Worst case.** CRLF baked into the index by an earlier commit that bypassed autocrlf. These will diff against ANY LF-write from a Docker agent. |
| `none` | `none` | 5 | Submodule / binary-detected — ignore. |

### 1.3 The 8 files with CRLF in the index (must be explicitly renormalized)

```
CLAUDE.md
README.md
apm.yml
docs/index.html
package-lock.json
scripts/build-apm-manifest.js
scripts/setup.js
src/templates.js
```

### 1.4 In-flight uncommitted files — real vs phantom diff

`git diff --numstat` vs `git diff --ignore-cr-at-eol --numstat`:

| File | Raw +/- | Real +/- (EOL-ignoring) | Phantom lines | Interpretation |
|---|---|---|---|---|
| `voltron-evals/runner.js` | 636/636 | **2/2** | 634 | CRLF-tolerant regex fix IS present, buried under EOL flip |
| `src/index.js` | 2167/2312 | **7/152** | 2160/2160 | Real dashboard rip-out hidden by EOL flip |
| `src/templates.js` | 10/22 | ~10/22 | 0 | Real edits, no phantom (index already CRLF) |
| `.claude/commands/scrum-master.md` | 7/18 | ~7/18 | 0 | Real edits, no phantom |
| `package.json` | 39/39 | 0/0 | 39 | **Pure EOL flip, zero semantic change** |
| `.claude/agents/project-planner.md` | 0/0 | 0/0 | 0 | Touched but unchanged |
| `scripts/voltron-run.sh` | 0/0 | 0/0 | 0 | Touched but unchanged |

### 1.5 Script & binary inventory

| Class | Files found |
|---|---|
| `*.sh` | `scripts/voltron-run.sh` only (already LF) |
| `*.bat` | none |
| `*.ps1` | none |
| `*.png/.jpg/.pdf/.woff/.ttf/.zip` | none (no committed binaries) |

`.voltron/` runtime artifacts (logs, dashboard.html, progress.json, journal markdown,
screenshots, tmp, *.md) are all already covered by `.gitignore` — renormalization will
not touch them.

---

## 2. Recommended `.gitattributes` Content

**Rationale for `* text=auto` over `* text eol=lf`:**

- `text=auto` lets git detect text/binary per file and apply the platform's native EOL
  in the working tree (CRLF on Windows, LF on Linux/Docker). The **index always stores
  LF**, which is the only invariant that matters for diff/merge consistency.
- `text eol=lf` would force LF in the working tree too — that's louder than needed and
  fights against Windows-native tools (Notepad, some editors) the user may run.
- Forcing LF only matters where the file is *executed* on Linux: shell scripts.

**Proposed file contents** (place at repo root as `.gitattributes`):

```gitattributes
# Default: detect text vs binary, normalize EOL to LF in index, native in working tree
* text=auto

# Source files — explicit for clarity and to avoid heuristic surprises
*.js       text
*.mjs      text
*.cjs      text
*.json     text
*.md       text
*.html     text
*.css      text
*.yml      text
*.yaml     text
*.txt      text

# Shell scripts MUST be LF in the working tree — Docker/Linux refuses CRLF shebangs
*.sh       text eol=lf
Dockerfile text eol=lf
Dockerfile.* text eol=lf

# Windows-only artifacts (none today, but future-proof the rule)
*.bat      text eol=crlf
*.cmd      text eol=crlf
*.ps1      text eol=crlf

# Voltron reflections — JSON files written by Docker agents, must round-trip cleanly
reflections/*.json text eol=lf

# Lock files — leave to git's defaults but mark explicitly text to suppress heuristics
package-lock.json text

# Binary safelist (no binaries currently committed, but lock the rule in)
*.png  binary
*.jpg  binary
*.jpeg binary
*.gif  binary
*.ico  binary
*.pdf  binary
*.woff  binary
*.woff2 binary
*.ttf  binary
*.eot  binary
*.zip  binary
*.gz   binary
*.tar  binary
*.db   binary

# Never normalize generated diffs / patches
*.patch -text
*.diff  -text
```

---

## 3. Preserving In-Flight Uncommitted Work

Each modified file gets a distinct handling strategy depending on whether its diff is
real, phantom, or mixed.

### 3.1 Files with real, semantic edits — **must be preserved**

| File | Approach |
|---|---|
| `voltron-evals/runner.js` | The 2-line regex fix lives in lines that grep can find. **Before renormalization**, copy the file out to `/tmp/runner.js.bak`. After renormalization, run `diff -u /tmp/runner.js.bak voltron-evals/runner.js` — the only diff should be EOL. The regex change persists. |
| `src/index.js` | Real dashboard rip-out is 7 added / 152 removed lines. Stash with `git stash push --keep-index` is unsafe (mixes EOL); instead **copy to `/tmp/index.js.bak`** before any renormalization step, restore after. |
| `src/templates.js` | Real edits +10/-22. Same approach: copy to `/tmp/templates.js.bak`. |
| `.claude/commands/scrum-master.md` | Real edits +7/-18. Copy to `/tmp/scrum-master.md.bak`. |

### 3.2 Files with zero-real-diff (phantom only) — discard the phantom

| File | Approach |
|---|---|
| `package.json` | `git checkout -- package.json` BEFORE renormalization. Zero semantic loss. |
| `.claude/agents/project-planner.md` | Zero-diff — `git checkout --` it. |
| `scripts/voltron-run.sh` | Zero-diff — `git checkout --` it. |

### 3.3 Index-CRLF files needing explicit forced LF rewrite

The 8 files at §1.3 will not be normalized by `* text=auto` alone because git considers
them clean (i/crlf w/crlf matches). They MUST be force-rewritten in a dedicated commit
using `git add --renormalize .` AFTER `.gitattributes` lands. This is the entire point
of the renormalization step.

---

## 4. Exact Commit Sequence

**Branch off `main` to `chore/eol-normalization` before any of this.**

### Commit 1 — Stage the rules

| Field | Value |
|---|---|
| Title | `chore: add .gitattributes for cross-platform EOL normalization` |
| Files | `.gitattributes` (new) |
| Expected diff (host) | +N lines, all additions |
| Expected diff (Docker) | identical to host (file is fresh, no EOL ambiguity) |
| Pre-commit check | `git check-attr -a scripts/voltron-run.sh` shows `text` and `eol=lf` |

### Commit 2 — Renormalize the whole repo

| Field | Value |
|---|---|
| Title | `chore: renormalize line endings to LF in index (no semantic changes)` |
| Files | All 131 files where `i/crlf` OR `w/crlf` currently appears, EXCEPT in-flight files listed in §3.1 |
| Command for staging | `git add --renormalize .` (re-stages every file with the rules now in effect) |
| Expected diff (host, autocrlf=true) | **Working-tree diff: zero.** Index diff: every previously-CRLF-in-index file shows as touched (LF replacing CRLF). |
| Expected diff (Docker) | Same as host — both sides see only EOL-only changes in the index. |
| Pre-commit check | `git diff --cached --ignore-cr-at-eol \| wc -l` must be **0** (proves zero semantic content changed). |
| Verification | `git ls-files --eol \| grep "^i/crlf"` returns nothing. |

### Commit 3 — Reapply the real in-flight content edits

| Field | Value |
|---|---|
| Title | `fix(evals): CRLF-tolerant fixture regex in voltron-evals/runner.js` |
| Files | `voltron-evals/runner.js` only |
| Source | Restored from `/tmp/runner.js.bak` then normalized by `.gitattributes` on add |
| Expected diff (host) | 2/2 — matches §1.4 "Real +/-" |
| Expected diff (Docker) | 2/2 — identical |
| Pre-commit check | `git diff --cached voltron-evals/runner.js` shows ONLY the regex lines |

### Commit 4 — Dashboard removal (the in-flight src/index.js + src/templates.js work)

| Field | Value |
|---|---|
| Title | `refactor: remove embedded dashboard from MCP server` (or whatever the user intended) |
| Files | `src/index.js`, `src/templates.js` |
| Source | Restored from `/tmp/index.js.bak` and `/tmp/templates.js.bak` |
| Expected diff (host) | ~7/152 + ~10/22 |
| Expected diff (Docker) | identical |
| Pre-commit check | scrum-master / harness-engineer agrees content is intentional |

### Commit 5 — Scrum-master command updates

| Field | Value |
|---|---|
| Title | `chore(scrum-master): apply v3.11.0 wording-invariance updates` |
| Files | `.claude/commands/scrum-master.md` |
| Source | Restored from `/tmp/scrum-master.md.bak` |
| Expected diff (host) | ~7/18 |
| Expected diff (Docker) | identical |
| Pre-commit check | content matches the auto-update output |

---

## 5. Verification That the Orchestration Loop Is Fixed

After all five commits land, run this end-to-end check **on the host first, then re-run identically inside a fresh Docker container**:

```bash
# Pick an arbitrary tracked source file
TARGET=voltron-evals/runner.js

# 1. Both should agree: index = LF, working tree = LF (on Linux) or CRLF (on Win autocrlf=true)
git ls-files --eol "$TARGET"

# 2. Single-line probe edit
sed -i 's/^/X/' "$TARGET"            # Linux; on host use a one-line PowerShell equivalent

# 3. Diff numstat should be EXACTLY the number of lines touched, not the whole file
git diff --numstat "$TARGET"

# 4. EOL-ignoring diff should be IDENTICAL to raw diff (proves no EOL noise)
git diff --ignore-cr-at-eol --numstat "$TARGET"

# 5. Reset
git checkout -- "$TARGET"
```

**Pass criteria:**

- Step 3 and step 4 numstat values are equal.
- The host's step 3 output and the Docker container's step 3 output are equal.
- `git ls-files --eol | grep "^i/crlf"` returns nothing repo-wide.

**Integration probe (best confirmation):** dispatch harness-engineer to make any
2-line edit, then dispatch committer immediately after. Committer should now report
`+2/-2` and proceed instead of bailing on a 636-line phantom diff.

---

## 6. Risks & Trade-offs

### 6.1 Does `git add --renormalize .` rewrite every file?

**Yes — every file that the new `.gitattributes` says should be LF in the index but
currently isn't will be re-staged.** Roughly 131 files in this repo. The user-visible
diff in the commit will be enormous (one EOL flip per CRLF line). That is by design and
why this step gets its own commit — separating "EOL normalization" from any semantic
change is a non-negotiable hygiene rule.

### 6.2 Will the renormalization commit hurt `git blame`?

**Yes, slightly.** Every line that flipped from CRLF to LF will show this commit as
last-author. Mitigations, in order of preference:

1. **`.git-blame-ignore-revs` file** — commit it in the same PR with the
   renormalization commit SHA listed. `git blame --ignore-revs-file=.git-blame-ignore-revs`
   and the GitHub UI (which respects this file by default) will skip past the noise
   automatically. **Recommended.**
2. Add the same SHA to a project-wide config: `git config blame.ignoreRevsFile .git-blame-ignore-revs`.
3. Do nothing — accept one commit of blame noise. Acceptable if blame archaeology is
   rare in this repo.

### 6.3 Will renormalization break `.voltron/` runtime files?

**No.** Every runtime artifact (`.voltron/logs/`, `.voltron/dashboard.html`,
`.voltron/progress.json`, `.voltron/screenshots/staged/`, `.voltron/tmp/`,
`.voltron/container-mcp.json`, `.voltron/*.md`, `.voltron/serve.js`) is already in
`.gitignore`. `git add --renormalize .` only touches tracked files.

### 6.4 Should the user switch `core.autocrlf=true` → `autocrlf=input` after this?

**This is the most consequential follow-up decision.** Once `.gitattributes` is
authoritative, `core.autocrlf` becomes mostly irrelevant — attributes override config.
That said:

- **`autocrlf=true`** (current) — Windows tools still see CRLF in the working tree.
  Compatible. `.gitattributes` is doing the real work; autocrlf is harmless fallback.
- **`autocrlf=input`** — Working tree stays LF on Windows too. Cleaner mental model
  (one EOL everywhere). Some legacy Windows tools may complain.
- **`autocrlf=false`** — Pure passthrough; respects `.gitattributes` only.

**Recommendation:** Leave `autocrlf=true` on the user's machine. `.gitattributes` is now
authoritative and the host's autocrlf only kicks in for the few files where attributes
are silent — which after this PR is none. Changing the user's global git config is out
of scope for a repo-level fix and is not worth the user friction.

### 6.5 Risk: someone with `autocrlf=false` and no attribute support commits CRLF anyway

Mitigated by the `.gitattributes` `text=auto` default — any tool that respects
attributes (which is all of git 2.10+) will normalize on add. The only way to bypass
is `git add` with attributes disabled, which is not a routine workflow.

### 6.6 Risk: the renormalization commit collides with an unrelated branch

If feature branches are in flight, rebasing them over the renormalization commit may
produce noisy conflicts (everything looks like it conflicts because every line
changed). Mitigation: **announce the renormalization, merge other open PRs FIRST, then
land this PR with no other open branches diverged from main.**

---

## 7. Recommended Execution Order

Numbered, copy-pasteable. Assumes starting state is current `main` with the in-flight
edits described in §1.4 still uncommitted on disk.

```bash
# === Pre-flight (run on host AND in Docker; both should agree) ===
git status --porcelain
git ls-files --eol | awk '{print $1}' | sort | uniq -c
git diff --numstat | head

# === Step 0: Branch and backup ===
git checkout -b chore/eol-normalization
mkdir -p /tmp/eol-backup
cp voltron-evals/runner.js          /tmp/eol-backup/runner.js.bak
cp src/index.js                     /tmp/eol-backup/index.js.bak
cp src/templates.js                 /tmp/eol-backup/templates.js.bak
cp .claude/commands/scrum-master.md /tmp/eol-backup/scrum-master.md.bak

# === Step 1: Discard the zero-real-diff phantom changes ===
git checkout -- package.json
git checkout -- .claude/agents/project-planner.md
git checkout -- scripts/voltron-run.sh

# === Step 2: Set the in-flight semantic edits aside (working tree is dirty) ===
# Reset the four files to their HEAD versions so renormalization runs from a clean base
git checkout -- voltron-evals/runner.js
git checkout -- src/index.js
git checkout -- src/templates.js
git checkout -- .claude/commands/scrum-master.md

# === Step 3: Create .gitattributes (content per §2) ===
# (write the file — content listed in §2 of this plan)

# === Step 4: Commit 1 — rules only ===
git add .gitattributes
git commit -m "chore: add .gitattributes for cross-platform EOL normalization"

# === Step 5: Commit 2 — repo-wide renormalization ===
git add --renormalize .
# Sanity check: zero semantic changes
test "$(git diff --cached --ignore-cr-at-eol | wc -l)" -eq 0 || { echo "ABORT: semantic diff in renorm"; exit 1; }
git commit -m "chore: renormalize line endings to LF in index (no semantic changes)"

# === Step 6: Restore in-flight edits and recommit them in semantic chunks ===
cp /tmp/eol-backup/runner.js.bak          voltron-evals/runner.js
git add voltron-evals/runner.js
git commit -m "fix(evals): CRLF-tolerant fixture regex in voltron-evals/runner.js"

cp /tmp/eol-backup/index.js.bak           src/index.js
cp /tmp/eol-backup/templates.js.bak       src/templates.js
git add src/index.js src/templates.js
git commit -m "refactor: remove embedded dashboard from MCP server"

cp /tmp/eol-backup/scrum-master.md.bak    .claude/commands/scrum-master.md
git add .claude/commands/scrum-master.md
git commit -m "chore(scrum-master): apply v3.11.0 wording-invariance updates"

# === Step 7: (optional) blame-ignore file ===
RENORM_SHA=$(git log --format=%H --grep="renormalize line endings" -1)
printf "# EOL normalization — not a semantic change\n%s\n" "$RENORM_SHA" > .git-blame-ignore-revs
git add .git-blame-ignore-revs
git commit -m "chore: ignore EOL renormalization commit in git blame"

# === Step 8: Post-flight verification ===
git ls-files --eol | grep "^i/crlf" && echo "FAIL: index-CRLF files remain" || echo "OK"
git diff main..HEAD --stat
```

---

## 8. DO NOT

- ❌ **Do NOT** run `git add --renormalize .` BEFORE `.gitattributes` is committed —
  without rules, git has no idea what "normalize" means and the command is a no-op
  (or worse, normalizes based on inherited config and is non-reproducible).
- ❌ **Do NOT** bundle the renormalization commit with semantic changes. Reviewers
  cannot tell signal from noise, and `git log -p` becomes unreadable forever.
- ❌ **Do NOT** use `git stash` to preserve in-flight edits across renormalization —
  stash records the working-tree blob WITH its current EOLs, so restoring re-introduces
  the mismatch you just fixed. Use file copies to `/tmp/` instead.
- ❌ **Do NOT** modify the user's global `git config core.autocrlf` from this plan.
  That is a per-machine decision and out of scope for a repo-level fix.
- ❌ **Do NOT** add `* eol=lf` (without `text=auto`) — that forces LF in the working
  tree on Windows too, which surprises users editing with Windows tools and is louder
  than the problem requires.
- ❌ **Do NOT** mark `package-lock.json` or `reflections/*.json` as `binary` — they
  are JSON, must round-trip cleanly across host/Docker, and need text-mode handling.
- ❌ **Do NOT** rebase open feature branches across the renormalization commit without
  warning their authors — they will see whole-file conflicts. Merge them first.
- ❌ **Do NOT** skip the `git diff --cached --ignore-cr-at-eol` check between Step 5
  and Step 6 — that check is the only proof the renormalization commit is truly
  semantically empty.
- ❌ **Do NOT** force-push over `main`. PR this branch through review.

---

## 9. Open Questions for Human Input

1. **Branch name** — `chore/eol-normalization` proposed. Override if a different
   convention exists.
2. **Merge ordering** — Are there other open PRs (e.g. the dashboard removal already
   on `main`?) that should land first or be coordinated with this?
3. **`.git-blame-ignore-revs`** — Adopt now (recommended) or skip?
4. **Reflections directory** — `reflections/*.json` are written by Docker agents in
   user projects (not committed from here typically). Confirming `text eol=lf` is the
   right rule (i.e. no consumer expects CRLF in these JSON files).
5. **The `scrum-master.md` "in-flight" edit** — is the +7/-18 diff intended for commit
   on this branch, or is it part of a separate v3.11.0 release that should land on its
   own PR? If the latter, drop Commit 5 from this plan.
6. **Should `voltron-evals/runner.js` CRLF-tolerance fix ship on this branch** or be
   split into its own PR for clean release notes? Recommendation: ship together — the
   fix is the proximate trigger for this whole effort, and bundling makes the story
   one PR instead of two.

---

## Summary

- **Root cause:** no `.gitattributes` + host `autocrlf=true` + Docker `autocrlf` unset
  ⇒ working-tree CRLF ≠ Docker-written LF ⇒ phantom full-file diffs.
- **Fix:** one `.gitattributes` commit + one renormalization commit + one optional
  `.git-blame-ignore-revs` commit + reapply the four in-flight semantic edits in three
  clean commits.
- **Verification:** end-to-end probe edit produces identical numstat on host and in
  Docker, and `git ls-files --eol | grep "^i/crlf"` is empty.
- **Risk profile:** low. One large EOL-only commit, scoped to a dedicated branch,
  preceded by a backup of every in-flight semantic edit.

Plan saved to `docs/eol-normalization-plan.md`. Invoke `/scrum-master` with this plan
to generate a work breakdown (likely 5–6 tasks for harness-engineer + committer).
