# Plan: Zero-Setup GitHub Credentials for Voltron Agent Containers

> **Owner / next agent:** `harness-engineer` (implementation), then `committer` for the version bump + docs.
> **Scope:** design only — this document does **not** edit source. Implementation goes in
> `src/index.js` (`dispatchOneAgent`, mount/env assembly ~L1800-L1913) and
> `src/templates.js` (`VOLTRON_RUN_SCRIPT` ~L9908-L9959).
> **Recommended mechanism (one phrase):** *host-side `gh auth token` derivation at dispatch, injected as `GH_TOKEN` (no manual env, no mount).*

---

## 1. Problem

`gh` 2.93.0 and `git` are now in the agent image, and PR #43 added an **optional**
`GH_TOKEN` / `GITHUB_TOKEN` env passthrough plus a container-side `gh auth setup-git`
bootstrap (`ghBootstrap`, `src/index.js` L1900). But a live diagnostic in the rebuilt
container shows `GH_TOKEN` **unset** and `gh auth status` = **not logged in**.

Root cause: the passthrough at `src/index.js` L1841 reads
`process.env.GH_TOKEN || process.env.GITHUB_TOKEN` — it only fires when the **user has
manually exported `GH_TOKEN` on the host** before the MCP server process started. The
MCP server is a long-lived background process; it rarely inherits an interactive
`export`, so in practice the token is always empty. That manual step is exactly what we
are eliminating.

**Goal:** after a one-time host `gh auth login`, both `gh` and `git push` work inside
every dispatched container with **zero per-session user action** — mirroring how
`~/.claude/.credentials.json` is already auto-mounted read-only (L1815-L1825).

---

## 2. Candidate mechanisms

The host credential lives in different forms depending on how the user authenticated:

| Host auth method | Where the credential lives | Reachable by MCP (Node, on host)? |
|---|---|---|
| `gh auth login` (default, keyring) | OS keyring (macOS Keychain / Windows Cred Manager / libsecret) — **not** a file | Only via `gh auth token` shelling out |
| `gh auth login` (no keyring / `GH_CONFIG_DIR`) | `~/.config/gh/hosts.yml` (Unix/macOS) · `%APPDATA%\GitHub CLI\hosts.yml` (Windows) | Yes — readable file |
| git credential store | `~/.git-credentials` or `osxkeychain`/`manager` helper | Sometimes (only the plaintext-store variant) |
| Fine-grained PAT | wherever the user puts it | Only if exported |

### Option A — **Derive token via `gh auth token` at dispatch (RECOMMENDED)**

At dispatch time, the MCP server runs `gh auth token` (host process, host PATH) and, if it
returns a token, injects it as `GH_TOKEN` into the container env. The existing
`ghBootstrap` (L1900) then writes a 0600 `~/.config/gh/hosts.yml` and runs
`gh auth setup-git`, so **both** `gh` and `git push` authenticate.

- **Pros:** Works regardless of *where* the host stored the credential (keyring or file) —
  `gh` abstracts that away. Single code path across Linux/macOS/Windows. Reuses the entire
  existing `ghBootstrap` + `ghEnvArgs` machinery — the *only* change is sourcing the token.
  No new mount, so no UID/permission or read-only-clobber concerns. Token is always fresh
  at dispatch (picks up rotation automatically).
- **Cons:** Requires `gh` installed **on the host** (most users targeting this feature have
  it). Spawns one extra short-lived process per dispatch (~50-150ms). Token is a short-lived
  OAuth token but still a bearer secret in container env (see §4).
- **Backward-compat:** if `gh` is absent or `gh auth token` fails/empty, fall through to the
  current `process.env.GH_TOKEN || process.env.GITHUB_TOKEN`. If that is also empty,
  `ghEnvArgs` stays `[]` and agents launch exactly as today — push just won't work.

### Option B — Bind-mount the host `gh` `hosts.yml` read-only

Mount the host `hosts.yml` → `/home/voltron/.config/gh/hosts.yml:ro`, mirroring the
credentials-mount pattern (L1823).

- **Pros:** No token in env/process args; no extra process spawn; declarative like the
  Claude creds mount. `gh auth setup-git` inside the container reads the file directly.
- **Cons:** **Only works when the host stored creds in the file** (no keyring). Default
  `gh auth login` on macOS/Windows uses the OS keyring → `hosts.yml` contains no
  `oauth_token`, so the mount is empty/useless for the majority case. Read-only mount means
  the in-container `git_protocol`/setup-git may need a writable copy. Cross-platform path
  resolution for `%APPDATA%` adds complexity. **Rejected as primary** because it fails the
  "zero-setup after one `gh auth login`" bar for keyring users.

### Option C — Mount the host git credential store

Mount `~/.git-credentials` → container, or replicate the host credential helper.

- **Pros:** Directly satisfies `git push`.
- **Cons:** Does **not** authenticate `gh` (PR creation, status). The plaintext store is
  often not present (helpers like `osxkeychain`/`manager` store nothing on disk). Mounting a
  plaintext credentials file is the weakest security posture. **Rejected.**

**Decision: Option A.** It is the only mechanism that satisfies *both* `gh` and `git push`
from a single one-time `gh auth login`, regardless of keyring vs file storage, on all three
host OSes. Options B/C are noted as fallbacks but not implemented.

---

## 3. Cross-platform specifics

The MCP server is Node running **on the host**, so it derives the token using the host's own
`gh`. The container is always Linux; it only ever sees the resulting `GH_TOKEN` env value —
there is no host→container path translation needed for Option A (its key advantage over B).

| Host OS | One-time setup | How MCP derives | Container side |
|---|---|---|---|
| **Linux** | `gh auth login` | `gh auth token` (PATH) | `GH_TOKEN` env → existing `ghBootstrap` |
| **macOS** | `gh auth login` (Keychain) | `gh auth token` (PATH; Homebrew `/opt/homebrew/bin`) | same |
| **Windows (Docker Desktop → Linux container)** | `gh auth login` (Cred Manager) | `gh auth token` via the Node child process; `gh.exe` resolved from PATH | same — token is just a string env value, no `%APPDATA%` mount |

Notes for the implementer:
- Resolve `gh` via PATH (`spawnSync("gh", ["auth", "token"])`). On Windows, Node resolves
  `gh.cmd`/`gh.exe` from PATH automatically; set `shell: false` and rely on PATH, or
  `shell: true` only if PATH resolution misbehaves under Docker Desktop.
- The MCP server may run with a **minimal PATH** (launched by Claude Code, not a login
  shell). If `gh auth token` returns ENOENT, treat as "no gh" and fall back silently — do
  **not** crash dispatch.
- This mechanism needs **no** knowledge of `hosts.yml` locations; the keyring-vs-file
  question is entirely `gh`'s problem. (Those paths are documented above only for Option B.)

---

## 4. Security

- **Never bake into an image layer.** Token is runtime-only env (`-e GH_TOKEN=...`), exactly
  as today. No `Dockerfile` change. ✅
- **Read-only / least privilege.** No new mount, so nothing new is writable. The
  container-side `hosts.yml` is written 0600 by `ghBootstrap` (already L1900).
- **Token scope/lifetime.** `gh auth token` returns the user's existing OAuth token (or PAT).
  Prefer the short-lived OAuth token over a long-lived PAT. Document that the token carries
  the full scope of the host login; recommend a fine-grained PAT with `contents:write` +
  `pull_requests:write` for users who want to narrow blast radius (they set `GH_TOKEN`
  manually and Option A's fallback uses it).
- **Do not log the token.** This is critical:
  - `ghBootstrap` already routes the token to a file via `printf`, never stdout, and sends
    `gh` stderr to `/dev/null` (L1900) — keep that.
  - The new derivation must **not** `console.log`/`console.error` the token, and must not
    include it in any debug print of `dockerArgs`. If dispatch logs the docker command for
    debugging, redact `GH_TOKEN=...` → `GH_TOKEN=***`.
  - `gh auth token` output is captured in-process and assigned straight to the env array;
    never echoed.
- **Process-args exposure.** `-e GH_TOKEN=<value>` makes the token visible in the host
  process table (`ps`) for the life of the `docker run`. This already applies to the
  current passthrough; acceptable for a local dev tool. (A future hardening could pass the
  token via `--env-file` or stdin, but that is out of scope here.)

---

## 5. Exact edit locus & concrete change (for `harness-engineer`)

### 5.1 `src/index.js` — `dispatchOneAgent`, replace the token source at L1841-L1842

Today:
```js
const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const ghEnvArgs = ghToken ? ["-e", `GH_TOKEN=${ghToken}`] : [];
```

Change to (derive from host `gh` when env is unset; nested containers skip — they inherit
via `--volumes-from`/parent env and have no host `gh`):

```js
// v3.x: GitHub credential auto-provision. Priority:
//   1. explicit host env GH_TOKEN / GITHUB_TOKEN (manual override / PAT)
//   2. derived from host `gh auth token` (zero-setup after one `gh auth login`)
// All optional & non-fatal: if none resolve, ghEnvArgs stays [] and agents launch
// read-only exactly as before. Never logged. Skipped when isNested.
let ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
if (!ghToken && !isNested) {
  try {
    const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000 });
    if (r.status === 0 && r.stdout) ghToken = r.stdout.trim();
  } catch { /* gh absent / not logged in — fall through, push disabled */ }
}
const ghEnvArgs = ghToken ? ["-e", `GH_TOKEN=${ghToken}`] : [];
```

- `spawnSync` is already imported alongside `spawn` (it's from `child_process`; confirm the
  import line near the top and add `spawnSync` if only `spawn` is imported).
- **Do not** touch `ghBootstrap` (L1900) or the `dockerArgs` assembly (L1902-L1913) — they
  already consume `ghEnvArgs` and run `gh auth setup-git`. The container side is done.
- The "No auth available" error message (L1846) still mentions optional `GH_TOKEN`; update
  its parenthetical to note that a one-time `gh auth login` on the host now suffices and
  manual `GH_TOKEN` is only needed to override.
- Guard with `!isNested` so nested dispatch (which has no host `gh` and uses
  `--volumes-from`) is unaffected.

### 5.2 `src/templates.js` — `VOLTRON_RUN_SCRIPT`, augment the `GH_ARGS` block (~L9933-L9938)

The host launcher script should mirror the same auto-derivation so manual `voltron-run.sh`
users get parity. After the existing env checks, add a `gh auth token` fallback:

```bash
GH_ARGS=()
if [ -n "$GH_TOKEN" ]; then
  GH_ARGS+=(-e "GH_TOKEN=$GH_TOKEN")
elif [ -n "$GITHUB_TOKEN" ]; then
  GH_ARGS+=(-e "GH_TOKEN=$GITHUB_TOKEN")
elif command -v gh >/dev/null 2>&1; then
  _GH_TOK="$(gh auth token 2>/dev/null)"
  [ -n "$_GH_TOK" ] && GH_ARGS+=(-e "GH_TOKEN=$_GH_TOK")
fi
```

- Keep the comment block (L9926-L9932) but reword: "one-time `gh auth login` is enough;
  manual `GH_TOKEN`/PAT only needed to override."
- Do **not** echo `$_GH_TOK`.
- The container side (`Dockerfile`/entry `gh auth setup-git`) is unchanged.

### 5.3 Backward-compatibility checklist
- No host `gh` and no env token → `ghEnvArgs = []`, container launches read-only as today. ✅
- Explicit `GH_TOKEN`/PAT in env → still wins (priority 1). ✅
- Nested containers → skipped, unaffected. ✅
- No `Dockerfile`, mount, or `ghBootstrap` changes. ✅

### 5.4 Required docs updates (same commit — Documentation Rule)
- `docs/index.html` — version badge + any auth/feature section.
- `README.md` — GitHub auth now zero-setup after `gh auth login`.
- Cross-link this doc and `docs/voltron-git-credentials-plan.md`.
- Bump `package.json` (patch or minor per the change size).

---

## 6. End-to-end validation

> **Host-side change:** this lives in the MCP server (Node on the host). It takes effect
> **only after the MCP server / Claude Code restarts** — the running server won't pick up
> the new dispatch code until reload. The agent image does **not** need rebuilding (the
> container side, `gh`/`ghBootstrap`, is already present).

**Preconditions:** one-time `gh auth login` done on host; `voltron-agent` image present.

1. **Restart** the MCP server (reload Claude Code) so the new `dispatchOneAgent` loads.
2. **Host sanity:** `gh auth token` on the host prints a token (non-empty). If empty, run
   `gh auth login` first.
3. **Dispatch a probe agent** (e.g. via `run_agent_in_docker` with a publish-capable agent)
   whose task is:
   - `gh auth status` → expect **"Logged in to github.com"** (was "not logged in").
   - `git push` to a throwaway branch:
     ```bash
     git checkout -b voltron-auth-probe-$(date +%s)
     git commit --allow-empty -m "voltron gh auth probe"
     git push -u origin HEAD          # expect success, no username prompt
     git push origin --delete HEAD    # clean up the throwaway branch
     git checkout -                   # leave probe branch
     ```
4. **Confirm zero manual step:** verify no `GH_TOKEN` was exported in the host shell that
   launched Claude Code (`echo $GH_TOKEN` empty) yet the push still succeeded — proving the
   token came from `gh auth token` derivation, not manual env.
5. **No-creds regression:** on a host with `gh` logged **out** (`gh auth logout`), dispatch a
   read-only agent → it must still launch and complete; only push/PR ops fail with the
   familiar "could not read Username" — i.e. identical to today's behavior.
6. **Log hygiene:** grep the agent log under `.voltron/logs/` and the docker process args for
   the literal token value → expect **no match** (token never logged).

**Acceptance:** steps 3 (status logged-in + push round-trip), 4 (no manual env), 5
(graceful no-creds), and 6 (no token in logs) all pass.

---

## 7. Open questions (human input)
- Should we cache the derived token across a dispatch batch to avoid N `gh auth token`
  spawns, or is per-dispatch freshness preferred? (Recommend: per-dispatch — simpler, picks
  up rotation; spawn cost is negligible.)
- Do we want a `VOLTRON_DISABLE_GH_AUTOTOKEN` escape hatch for users who deliberately want
  agents to have **no** push capability even though the host is logged in? (Recommend: yes,
  cheap to add — skip derivation when set.)
