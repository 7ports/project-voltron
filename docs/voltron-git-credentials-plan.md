# Plan: GitHub Push Credentials for Voltron Agent Containers

> **Owner / next agent:** `harness-engineer` (implementation), then `committer` for the version bump.
> **Scope:** design only — this document does not edit source. Implementation goes in
> `src/templates.js` (`DOCKERFILE_CONTENT`, `VOLTRON_RUN_SCRIPT`) and `src/index.js`
> (`dispatchOneAgent`, around L1780-L1875).

---

## 1. Problem

Voltron specialist agents run in Docker via `dispatchOneAgent` (`src/index.js` L1723-L1875).
The container today receives:

- Source bind-mount: `${VOLTRON_HOST_ROOT}:/workspace`
- `~/.gitconfig` read-only (for `user.name` / `user.email`)
- `~/.claude/.credentials.json` read-only (Claude OAuth)
- `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` env passthrough

But it receives **no GitHub credentials**, so publish agents (`pr-opener`, `committer`,
`branch-manager`, `deploy-trigger`) cannot push or call `gh`:

- `git push` → `fatal: could not read Username for 'https://github.com'`
- `gh pr create` / `gh auth status` → `HTTP 401 / not authenticated`
- `gh` is also **not installed** in the image (`DOCKERFILE_CONTENT`, `src/templates.js`
  L9806-L9887, only installs `git`, `node`, `python3`, `ruby`, `docker-ce-cli`, `sudo`,
  `bd`, `stringer`). Publish must be solved in two layers: (a) install `gh`, (b) inject
  a credential.

The repeated forced fallback (human pushes from host) wipes out the value of automating
the entire write→validate→publish chain.

---

## 2. Recommended Approach (primary)

**Inject a host-sourced GitHub token as an env-var (`GH_TOKEN`), and have the
container configure both `gh` and `git` to use it on startup.** Mirrors the existing
`CLAUDE_CODE_OAUTH_TOKEN` pattern verbatim.

### 2.1 What the user sets up on the host (one-time)

The token is sourced **once per shell**, never persisted to the container image.
The MCP server reads `process.env.GH_TOKEN` (or `GITHUB_TOKEN` as a fallback) and
passes it through with `-e GH_TOKEN=...`, the same way `CLAUDE_CODE_OAUTH_TOKEN`
is passed (`src/index.js` L1808).

Sourcing options, in priority order:

| Sourcing path | Who it fits | One-time setup | How the token reaches the MCP env |
|---|---|---|---|
| **A. `gh auth token`** (recommended) | Anyone who already has `gh` installed and logged in on the host (Windows or Unix) | `gh auth login` (interactive, one time) | The user (or a shell rc / Claude Code launch wrapper) exports `GH_TOKEN="$(gh auth token)"` before launching Claude Code. On Windows PowerShell: `$env:GH_TOKEN = (gh auth token)`. |
| **B. Classic / fine-grained PAT** | CI, headless boxes, or users who don't want `gh` on the host | Generate a PAT at https://github.com/settings/tokens with `repo` + `workflow` scopes (and `read:org` if pushing to org repos) | Store the PAT in the shell rc / Windows User Environment Variables as `GH_TOKEN` (or `GITHUB_TOKEN`). Done. |
| **C. Git Credential Manager** (Windows host store) | Windows users who never use `gh` | Already configured by Git for Windows install | NOT directly reusable: the Linux container cannot call the Windows DPAPI-protected credential helper. User must materialize a token via `gh auth login` (option A) or PAT (option B). Document this as a known limitation. |

This mirrors the existing asymmetry the codebase already documents
(`src/templates.js` L9901-L9902 — Windows users must run `claude setup-token`
to materialize `~/.claude/.credentials.json` because Windows Credential Manager
is unreachable from the Linux container). The same asymmetry applies here.

**The user-facing contract:** "Set `GH_TOKEN` (or `GITHUB_TOKEN`) in the
environment that launches Claude Code. Easiest: `export GH_TOKEN="$(gh auth token)"`."

### 2.2 What the container does at start (per dispatch)

A new init step in the container command — added to the `bash -c` payload at
`src/index.js` L1874 — runs before `claude` is invoked. The step is a no-op if
the token is absent (preserves backward compatibility for read-only agents):

```sh
if [ -n "$GH_TOKEN" ]; then
  # 1. Configure gh non-interactively (gh prefers env-var anyway, but explicit hosts.yml
  #    avoids the 'You are not logged in' message on `gh auth status`).
  mkdir -p ~/.config/gh
  printf 'github.com:\n    oauth_token: %s\n    git_protocol: https\n' "$GH_TOKEN" > ~/.config/gh/hosts.yml
  chmod 600 ~/.config/gh/hosts.yml

  # 2. Wire git to the same token via gh's built-in helper.
  gh auth setup-git 2>/dev/null || \
    git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f'
fi
```

The fallback branch (the inline `credential.helper` function) is used if `gh` is
not yet on PATH at the moment of evaluation, or if `gh auth setup-git` fails on
some platform — it is a pure-`git` solution and never writes the token to disk.

### 2.3 Why this is the recommended approach

- **Mirrors the existing CLAUDE token pattern** — no new architecture to learn,
  reuses the env-var passthrough already validated at `src/index.js` L1807-L1813.
- **Cross-platform with no new host plumbing** — works the same on Windows and
  Unix because the input is just `process.env.GH_TOKEN`, set by whatever
  mechanism the user prefers.
- **No bind mount required** — avoids the Windows/Unix path-translation hazards
  Voltron already battle-scarred with on the `~/.claude` mount.
- **Token never lands in an image layer** — only injected at `docker run` time;
  `~/.config/gh/hosts.yml` is written inside an ephemeral `--rm` container.
- **`gh` and `git` both work** — `gh pr create`, `gh issue ...`, `git push`,
  `git fetch` against private repos all authenticate the same way.

---

## 3. Alternatives Considered

### Alternative A — Bind-mount `~/.config/gh/hosts.yml` (Unix only)

**How:** Add an optional mount alongside the existing creds mount.

**Trade-offs:**
- ✅ Zero-config for Unix `gh` users.
- ❌ Cross-platform parity broken: Windows `gh` stores creds in
  `%AppData%\GitHub CLI\hosts.yml` *or* `%USERPROFILE%\.config\gh\hosts.yml`
  depending on install path — we'd duplicate the same fragile path-translation
  logic the `.gitconfig` mount already does.
- ❌ Does not solve `git push` for protocols where `gh` is not invoked
  (raw `git push origin main` still fails until `gh auth setup-git` ran on host).
- **Verdict:** add as a *secondary, opt-in mount* later if users ask, not as
  the primary mechanism.

### Alternative B — Mount the host's Git Credential Manager store

**How:** Bind-mount `~/.git-credentials` or the equivalent platform store.

**Trade-offs:**
- ❌ Windows GCM uses DPAPI; the Linux container cannot decrypt it. Dead on arrival.
- ❌ macOS Keychain helper requires `security` binary; also unreachable.
- ❌ Plaintext `~/.git-credentials` mount works but is widely considered a bad
  pattern and we'd need to handle absence/path-translation.
- **Verdict:** rejected.

### Alternative C — `docker run --secret`

**How:** Use BuildKit secrets / docker `--secret` flag.

**Trade-offs:**
- ✅ Cleanest security model (token never appears in `docker inspect` env).
- ❌ Requires BuildKit + secret backend setup the user does not have today;
  significant deviation from how Anthropic creds are currently handled.
- ❌ Per-dispatch ergonomics suffer; spawn args grow.
- **Verdict:** defer until BuildKit is already in use for other reasons.

---

## 4. Security Constraints

| Requirement | How the recommended approach satisfies it |
|---|---|
| Token never baked into image | Token is only read via `process.env.GH_TOKEN` at `docker run` time. The Dockerfile contains no `ENV GH_TOKEN=...`, `ARG GH_TOKEN`, or `COPY` of a creds file. |
| Read-only on host | We never write to the host; the token round-trips through an env var the user already maintains. |
| Container layer immutable | `~/.config/gh/hosts.yml` is written inside the `--rm` container; layer is discarded on exit. |
| Token lifetime bounded | When sourced from `gh auth token`, the token is the user's session token and is rotated by `gh auth refresh`. PAT users own their PAT rotation schedule. We document recommending fine-grained PATs scoped to the necessary repos. |
| No log exfiltration | `gh auth setup-git` and the fallback `credential.helper` both avoid printing the token. The `printf` writing `hosts.yml` writes to a file, not stdout, so it won't end up in `.voltron/logs/`. **MUST** verify no `set -x` is active in the wrapper script when this runs. |
| Audit trail | Existing `[entry]` / `[exec]` markers in the wrapper log do not include env values. New log lines added by this plan must avoid `echo $GH_TOKEN` — verify in code review. |
| Scope guidance (docs) | Recommend fine-grained PATs with: `Contents: read+write`, `Pull requests: read+write`, `Workflows: read+write` (if `deploy-trigger` is used), scoped to specific repos. Classic PATs need `repo`, `workflow`. |

**Things NOT to do:**
- Do NOT add `ENV GH_TOKEN=...` or `ARG GH_TOKEN` to `DOCKERFILE_CONTENT` — that bakes
  the token (or its declaration) into the layer history.
- Do NOT `echo "GH_TOKEN=$GH_TOKEN"` in the wrapper command (it lands in
  `.voltron/logs/<agent>-<ts>.log` via `tee`).
- Do NOT bind-mount a plaintext `~/.git-credentials` file from the host without
  documenting the security trade-off — and even then, only as an opt-in escape hatch.
- Do NOT write the token into `~/.gitconfig`; the existing `.gitconfig` mount is
  read-only and would also leak across runs.
- Do NOT pass the token via `--build-arg`; build args are visible in `docker history`.

---

## 5. Files & Functions to Change (for harness-engineer)

### 5.1 `src/templates.js` — `DOCKERFILE_CONTENT` (L9806-L9887)

Add an install step for `gh` (GitHub CLI). Insert between the existing
`docker-ce-cli` block (ends L9839) and the `beads` block (starts L9858):

```dockerfile
# v3.x.x: GitHub CLI for publish agents (pr-opener, committer, branch-manager).
# Token is supplied at `docker run` time via -e GH_TOKEN; gh auth setup-git wires
# git to the same credential. See docs/voltron-git-credentials-plan.md.
RUN install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*
```

No `ENV` or `ARG` for the token — verify nothing of the sort exists anywhere in the
Dockerfile.

### 5.2 `src/templates.js` — `VOLTRON_RUN_SCRIPT` (L9889-L9925)

Add a `GH_TOKEN`/`GITHUB_TOKEN` passthrough block after the existing
`AUTH_ARGS` setup (after L9905, before `CREDS_MOUNT`):

```sh
# v3.x.x: GitHub publish credentials. Supplied by the host via env var so the
# token never persists in an image layer. On Windows, run once:
#   $env:GH_TOKEN = (gh auth token)
# On Unix:
#   export GH_TOKEN="$(gh auth token)"
# Or set a fine-grained PAT directly. Falls back to GITHUB_TOKEN if GH_TOKEN unset.
GH_ARGS=()
if [ -n "$GH_TOKEN" ]; then
  GH_ARGS+=(-e "GH_TOKEN=$GH_TOKEN")
elif [ -n "$GITHUB_TOKEN" ]; then
  GH_ARGS+=(-e "GH_TOKEN=$GITHUB_TOKEN")
fi
```

Then add `"${GH_ARGS[@]}" \` to the `docker run` invocation (currently L9918-L9925)
on a new line alongside `"${AUTH_ARGS[@]}"`.

### 5.3 `src/index.js` — `dispatchOneAgent` (L1723-L1875)

Two changes:

**(a) Env passthrough — extend `authEnvArgs` (L1807-L1813):**

```js
// v3.x.x: GitHub credential passthrough. Sourced from host env (set by
// `export GH_TOKEN="$(gh auth token)"` or a fine-grained PAT). Container init
// uses this to run `gh auth setup-git`. See docs/voltron-git-credentials-plan.md.
const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (ghToken) {
  authEnvArgs.push("-e", `GH_TOKEN=${ghToken}`);
}
```

Place this just after the `ANTHROPIC_API_KEY` block. Do NOT add `ghToken` to the
`credsAvailable` gate — Voltron must still be functional for users who do not
publish.

**(b) Container init step — extend the `bash -c` payload at L1874:**

Prepend an `if [ -n "$GH_TOKEN" ]; then ... fi` block to the existing inline
script, before the `claude` invocation:

```js
const ghBootstrap = [
  `if [ -n "$GH_TOKEN" ]; then`,
  `  mkdir -p ~/.config/gh`,
  `  printf 'github.com:\\n    oauth_token: %s\\n    git_protocol: https\\n' "$GH_TOKEN" > ~/.config/gh/hosts.yml`,
  `  chmod 600 ~/.config/gh/hosts.yml`,
  `  gh auth setup-git 2>/dev/null || git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f'`,
  `fi`,
].join('; ');
```

Then splice `${ghBootstrap};` into the existing `bash -c` payload at the start
of the `{ ... }` brace group. Match indentation and quoting of the existing
template literal — note that `$GH_TOKEN` inside the heredoc-style string needs
the same `\$` escape treatment that `\$CLAUDE_EXIT` already uses (L1874) to
defer expansion to the container shell.

### 5.4 `src/index.js` — Validation/error message (L1817)

Update the no-auth error message to mention the new optional `GH_TOKEN` for
publish workflows. Strictly informational — do not add `GH_TOKEN` to the
required-auth gate.

### 5.5 Docs (mandatory per CLAUDE.md "Documentation Rule")

- `docs/index.html` — add a row to the env-var table; document the Windows vs
  Unix setup pattern in the same callout style as the existing Claude OAuth note.
- `README.md` — mirror the docs/index.html addition.

### 5.6 Reflection-suggestion bump

Bump `package.json` per CLAUDE.md versioning convention:
- **Minor (3.13.0)** — this is a new capability (publish agents become functional
  without host fallback). Not a patch.

---

## 6. Validation Plan

The implementer (harness-engineer) MUST run these checks before declaring done.
Each check is paired with the agent that should run it once the plan ships.

### 6.1 Smoke test inside a fresh container (no real push)

Goal: confirm `gh` and `git` are authenticated end-to-end without writing to a
remote. Run from a host shell that already has `GH_TOKEN` populated:

```sh
docker build -t voltron-agent -f Dockerfile.voltron .
docker run --rm \
  -e GH_TOKEN="$GH_TOKEN" \
  voltron-agent \
  bash -lc '
    set -e
    # Bootstrap (mirrors the production init step)
    mkdir -p ~/.config/gh
    printf "github.com:\n    oauth_token: %s\n    git_protocol: https\n" "$GH_TOKEN" > ~/.config/gh/hosts.yml
    chmod 600 ~/.config/gh/hosts.yml
    gh auth setup-git

    # Check 1: gh authenticates
    gh auth status
    # Check 2: gh can read a private resource
    gh api user --jq .login
    # Check 3: git can authenticate over HTTPS without a prompt
    git ls-remote https://github.com/<owner>/<repo>.git HEAD > /dev/null && echo "git auth OK"
  '
```

All three checks must pass. Confirm `~/.config/gh/hosts.yml` is mode `600`.

### 6.2 Push test — throwaway branch + delete

From within a running voltron container (or via a one-shot `run_agent_in_docker`
dispatch of `branch-manager`):

```sh
git checkout -b ci/voltron-auth-smoke-$RANDOM
git commit --allow-empty -m "Voltron auth smoke test"
git push -u origin HEAD
git push origin --delete "$(git branch --show-current)"
```

A successful push followed by a successful delete confirms read+write end-to-end.
This is also a perfect validation task to dispatch via `run_agent_in_docker`
once the plan is implemented — a self-validating change.

### 6.3 Log-leak audit

After running the smoke test, grep `.voltron/logs/*.log` from the run for the
token to confirm zero leaks:

```sh
grep -rF "$GH_TOKEN" .voltron/logs/ && echo "LEAK DETECTED" || echo "clean"
```

Must print `clean`.

### 6.4 Backward-compat sanity

Run a non-publishing agent (e.g. `code-analyst`) with `GH_TOKEN` unset, confirm
it still launches and completes. The `if [ -n "$GH_TOKEN" ]` gate must
make this a true no-op.

### 6.5 `pr-opener` end-to-end

Once 6.1-6.4 pass, dispatch `pr-opener` on a test branch and confirm a PR is
created without human intervention. This is the user-visible success criterion
that motivated the work.

---

## 7. Open Questions for Human Input

1. **PAT vs `gh auth token`** — should the README *strongly prefer* `gh auth
   token` (rotates with `gh`) over a long-lived PAT, or are CI users a primary
   audience that needs PAT-first instructions?
2. **Default-on vs opt-in install of `gh`** — `gh` adds ~50 MB to the image.
   Acceptable for v3.13.0, or should the install be conditional / a separate
   image variant?
3. **Org-SSO repos** — fine-grained PATs must be SSO-authorized per org.
   Document this prominently or leave it as user-discovers-it?
4. **`branch-manager` write-scope minimum** — pin a recommended scope set in
   the README, or leave it generic ("scopes needed to push and open PRs")?

---

## 8. Phased Rollout (for scrum-master)

Three sequential phases. Each is independently testable.

### Phase 1 — Image + env passthrough
- **Goal:** `gh` installed in the image, `GH_TOKEN` reaches the container.
- **Deliverables:** Dockerfile change (§5.1), `VOLTRON_RUN_SCRIPT` change (§5.2),
  `dispatchOneAgent` env passthrough (§5.3a).
- **Validation:** §6.1 (smoke test) + §6.4 (backward-compat).
- **Dependencies:** none.

### Phase 2 — Container init + git wiring
- **Goal:** `git push` works without prompt; `gh auth status` shows authenticated.
- **Deliverables:** `dispatchOneAgent` bootstrap step (§5.3b),
  error-message update (§5.4).
- **Validation:** §6.2 (push test) + §6.3 (log-leak audit).
- **Dependencies:** Phase 1.

### Phase 3 — Docs + version bump
- **Goal:** users can set up the feature without reading source.
- **Deliverables:** `docs/index.html`, `README.md`, `package.json` 3.13.0,
  changelog entry.
- **Validation:** §6.5 (pr-opener end-to-end on a real repo).
- **Dependencies:** Phase 2.

---

## 9. Notes / Side-effects

- `src/templates.js` L3915 currently tells agents "never attempt `git clone` +
  `git push` for secondary repos — HTTPS auth credentials are not available in
  the Docker environment." That sentence becomes incorrect after this change
  and must be **updated**, not deleted (the rule still holds when `GH_TOKEN` is
  unset).
- The existing `VOLTRON_ALLOW` list already permits `Bash(gh *)` and `Bash(git
  *)` (`src/templates.js` L9930). No allowlist change required.
- `pr-opener`, `committer`, `branch-manager`, `deploy-trigger`, and
  `changelog-updater` templates should get a one-line precondition reminder
  ("requires `GH_TOKEN` env on host") added near their existing usage notes,
  in the same commit, per CLAUDE.md's documentation rule.

---
