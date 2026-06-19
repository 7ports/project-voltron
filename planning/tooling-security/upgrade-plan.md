# Project Plan: Voltron Comprehensive Tooling & Security Upgrade

> **Sprint type:** Tooling modernization + security hardening
> **Author:** `project-planner` (design only — no implementation)
> **Baseline:** project-voltron `v3.15.1` (`package.json:3`), branch `feat/voltron-engine-rebrand`
> **Predecessor sprint:** branding/docs rebrand (Phases 0–1 already committed)
> **Grounded in:** `CLAUDE.md`, `README.md`, `src/index.js` (2,430 LOC), `Dockerfile.voltron`, `scripts/voltron-run.sh`, `scripts/setup.js`, `.github/workflows/{process-reflections,voltron-evals}.yml`, `src/templates.js` infra block (`:10062-10085`), and `planning/branding/engine-inventory.md`.

This document is a blueprint for the **scrum-master** to decompose into agent-sized beads tasks. Phases are milestone-level. Each finding/upgrade is concrete enough to become one or more tasks with file paths attached.

---

## Goals & Scope

### Why this sprint

Voltron's differentiating engine — Docker-isolated agent execution, nested Docker-out-of-Docker (DooD) dispatch, a self-rewriting reflection loop, and an 18-tool MCP surface — is powerful precisely because it grants agents broad, autonomous host access. That power is also the project's largest **unmanaged trust boundary**. The single most security-relevant fact about Voltron is already flagged in the codebase (`README.md:279`, `Dockerfile.voltron:48-63`):

> Mounting `/var/run/docker.sock` into an agent container is **equivalent to root on the host**. Combined with a read-only mount of `~/.claude/.credentials.json`, every dispatched agent runs `claude --dangerously-skip-permissions` with effective host-root reach.

The rebrand makes Voltron more public-facing; that raises the bar on (a) being able to honestly describe the security model on the new site, and (b) actually hardening it. This sprint pairs that hardening with a long-overdue **tooling modernization** pass: there is currently **no lockfile, no automated tests in CI, no linter/formatter, no dependency scanning, and no `npm audit` gate** in the repo proper (the only tests are ad-hoc `scripts/test-*.mjs` run by hand; CI runs only reflections + monthly evals).

### In scope

1. **Security audit + hardening** of the agent execution trust boundary: Docker socket exposure, credential mounting, container privilege, the MCP tool surface, CI secret handling, and dependency/supply-chain risk.
2. **A security baseline** established *first* by a `code-analyst` / security-scanner pass so subsequent fixes target real, enumerated findings rather than assumptions.
3. **Tooling modernization**: lockfile + reproducible installs, lint/format/test/coverage gates, a real CI test workflow, CI hardening (least-privilege `GITHUB_TOKEN`, SHA-pinned actions), Dockerfile hardening/slimming, MCP-server input validation & error ergonomics, structured logging/observability for dispatch, and eval-harness tooling polish.
4. **Documentation of the security model** so `docs/index.html` (security disclosure) and `README.md` accurately describe the hardened posture, satisfying `CLAUDE.md`'s Documentation Rule.

### Explicitly out of scope

- **No agent-template prose redesign.** Editing the 70 agent templates' behavior is the reflection-loop's job (`harness-engineer`), not this sprint. Template *infra constants* (`VOLTRON_ALLOW/DENY`, `DOCKERFILE_CONTENT`, `VOLTRON_RUN_SCRIPT`) ARE in scope because they are engine/security config that merely happens to live in `src/templates.js:10062-10085`.
- **No engine/content module split.** `engine-inventory.md` Part B documents seams for a future `src/index.js` vs `src/templates.js` separation; that refactor is deferred — this sprint must not destabilize the import surface (`src/index.js:16-29`).
- **No new project types or new agents.** No `minor`/`major` template additions.
- **No migration off Docker, beads, Dolt, Stringer, or Alexandria.** We harden what exists.
- **No rewrite of `voltron-evals` architecture.** Only additive tooling polish (doctor in CI, schema lint).
- **Windows-only and macOS-only execution paths** are documented and accommodated but not deeply re-engineered.

### Research note

The `project-planner` Alexandria consult (`get_project_setup_recommendations`, `search_guides`) **could not be completed in this environment — the `alexandria` MCP server is not connected.** First task for whoever picks this up: run the Alexandria consult for "Docker socket proxy", "rootless Docker", "GitHub Actions hardening", "npm audit / Dependabot", and "ESLint flat config", and fold any existing guides into the relevant tasks below. External best-practice sources consulted for this plan are cited inline.

---

## Security Audit Findings & Hardening

> **TASK 0 (must run first):** A `code-analyst`-led security baseline. Dispatch Inspect-layer micro-agents + a dependency/secret scanner (`npm audit --json`, `gitleaks`/`trufflehog` over history, `hadolint` on `Dockerfile.voltron`, `semgrep` on `src/index.js`) and write the findings to `.voltron/analyses/<ts>-security-baseline.md` via `submit_analysis`. **Every hardening item below is a hypothesis to confirm/quantify against that baseline** — the audit grounds severity and may surface items not listed here. Do not start fixes until the baseline exists.

Severity scale: **Critical** (host compromise / credential theft), **High** (privilege escalation or secret exposure within trust boundary), **Medium** (hardening / defense-in-depth), **Low** (hygiene).

### S1 — Docker socket mounted into agent containers — **Critical**

- **Where:** `src/index.js:1940-1941` (`socketMount` for `nestable && !isNested`), `Dockerfile.voltron:48-63` (sudo-shimmed `docker` wrapper granting the non-root `voltron` user passwordless `docker` access), self-disclosed at `README.md:279`.
- **Risk:** Any nestable agent holds host-root-equivalent power: it can `docker run --privileged -v /:/host`, read every file the daemon can, and tamper with other containers. A prompt-injection or a buggy agent escalates straight to host compromise. The `sudo NOPASSWD: /usr/bin/docker` shim (`Dockerfile.voltron:60-63`) is scoped to the docker binary but the docker binary *is* the escalation primitive.
- **Hardening direction (sequenced, pick per Open Decision OD-1):**
  1. **Default-deny the socket.** Make socket mounting opt-in per dispatch (`VOLTRON_ENABLE_NESTED=1` or a `allow_nested` tool param) instead of automatic for every `nestable` template. Most dispatch waves are flat Tier-2→Tier-3 and don't need recursion from inside a container; the scrum-master can fan out Tier-3 from the host.
  2. **Interpose a Docker-socket proxy** (e.g. Tecnativa/11notes `docker-socket-proxy`) that allowlists only the API endpoints nested dispatch actually uses (`POST /containers/create`, `/start`, `/wait`, `DELETE`, image inspect) and blocks `--privileged`, host bind-mounts outside the project, and `exec` into siblings. Point agents at it via `DOCKER_HOST=tcp://socket-proxy:2375`. ([11notes/docker-socket-proxy](https://github.com/11notes/docker-socket-proxy), [LinuxServer socket-proxy](https://docs.linuxserver.io/images/docker-socket-proxy/))
  3. **Evaluate a stronger runtime** for nested execution — rootless Docker or Sysbox (runs Docker-in-Docker without `--privileged` and without sharing the host daemon). ([OWASP Docker Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html), [Ken Muse — rootless trade-offs](https://www.kenmuse.com/blog/rootless-docker-and-its-hidden-security-trade-offs/))
  4. **Document the residual risk honestly** wherever the socket is still mounted (keep/strengthen the `README.md:279` disclosure and mirror it into the new site's security section).

### S2 — Long-lived credential mounting (`~/.claude/.credentials.json`, `GH_TOKEN`, `.gitconfig`) — **High**

- **Where:** creds mount `src/index.js:1862-1872` (`readonly` bind), `scripts/voltron-run.sh:35-36`; `GH_TOKEN` auto-derived from host `gh auth token` and injected as an env var `src/index.js:1892-1899`, written to `~/.config/gh/hosts.yml` inside the container `src/index.js:1973`; `.gitconfig` mount `:1852-1858`.
- **Risk:** Every agent — including pure file-editing Tier-3 micro-agents that never push — receives the full Claude OAuth token (read-only mount, but readable by the agent process) and, when `gh` is logged in on the host, a GitHub token with `repo` scope. A compromised/injected agent can exfiltrate both. The token is passed via `-e GH_TOKEN=...` which is visible in the container's `/proc/1/environ` and any `docker inspect`.
- **Hardening direction:**
  - **Scope GitHub tokens to the agents that need them.** Only `committer`/`pr-opener`/`branch-manager`/`deploy-trigger` should get `GH_TOKEN`; gate `ghEnvArgs` on the dispatched template name (or a `needs_push` capability flag in the template object). Read-only agents get nothing. Prefer short-lived **fine-grained PATs / GitHub App installation tokens** over the broad host `gh` token where push is required.
  - **Prefer file-mount over env-var for secrets** (env vars leak via `docker inspect`/`/proc`); write `GH_TOKEN` to a tmpfs-mounted file the entrypoint reads, or use Docker secrets.
  - **Confirm credential redaction in logs.** The full transcript is teed to `.voltron/logs/` (`src/index.js:1985`); the audit must verify tokens never land there (the code claims so at `:1971-1972` — verify with a test).
  - **Document the credential blast radius** in the security model section.

### S3 — `--dangerously-skip-permissions` with no in-container guardrails — **High**

- **Where:** `src/index.js:1985` and `scripts/voltron-run.sh:53` (every agent runs with the flag), container-scoped settings are written with an **empty hooks map** (`src/index.js:1937`) which also disables any allow/deny enforcement inside the container.
- **Risk:** The `VOLTRON_ALLOW`/`VOLTRON_DENY` lists (`src/templates.js:10062-10085`) protect the *host* session but are bypassed inside containers by `--dangerously-skip-permissions`. The denylist is also weak: it blocks `rm -rf *` / `git push --force` but the allowlist contains `Bash(eval *)`, `Bash(curl *)`, `Bash(docker *)`, and `Bash(chmod *)` — together a trivial escape if ever enforced.
- **Hardening direction:**
  - Accept that full autonomy is the design, and compensate with **container-level confinement** instead of in-agent permission prompts: drop Linux capabilities (`--cap-drop=ALL`, add back only what's needed), `--security-opt=no-new-privileges`, `--pids-limit`, `--memory`/`--cpus` limits, a non-root user (already `USER voltron`, good), and `--read-only` root fs with explicit tmpfs for writable paths.
  - **Network egress policy:** consider `--network` restrictions or an egress allowlist so an injected agent can't exfiltrate to arbitrary hosts (`curl`/`wget` are allowlisted).
  - Re-examine `VOLTRON_DENY` (`src/templates.js:10082-10085`) and tighten the host allowlist that `setup.js` installs.

### S4 — MCP tool surface: input validation, path traversal, command construction — **Medium/High**

- **Where:** 18 `server.tool(...)` registrations across `src/index.js:300-2421`. Dispatch builds a shell `-c` string by interpolation (`src/index.js:1985`); `detectProjectRoot()` walks the filesystem (`:181-226`); `submit_reflection`/`append_journal`/`submit_analysis` write files from tool params (`:973-1160`).
- **Risk:** `agent_name`, `topic`, `model`, and `task` flow into container names, file paths, and shell command strings. `safeAgentName` is used for the container/log name (good) but the audit must verify: (a) no param can traverse paths in `submit_analysis`/`append_journal` (`topic`/`date` → filename), (b) `task` content reaching the `-c` heredoc can't break out (it's read from a mounted file via `cat`, which is safer — confirm), (c) `model`/`max_turns` are validated (`max_turns` flows unquoted into the command at `:1985`).
- **Hardening direction:** add strict Zod refinements (enum for `model`, bounded int for `max_turns`, slug-only for `topic`/filenames, reject `..`/absolute paths), centralize a `sanitizeForShell`/`sanitizeFilename` helper, and add unit tests for each tool's input boundary. This also improves error ergonomics (see T5).

### S5 — CI workflows: secret exposure, token scope, unpinned actions — **Medium/High**

- **Where:** `.github/workflows/process-reflections.yml`, `.github/workflows/voltron-evals.yml`.
- **Findings:**
  - **`process-reflections.yml` runs `claude --dangerously-skip-permissions` with `ANTHROPIC_API_KEY` in scope** (`:81-90`) on an autonomous agent that then **pushes a branch and opens a PR** with `GITHUB_TOKEN` (`:92-107`). The job has `contents: write` + `pull-requests: write` (`:16-18`). An autonomous LLM with write tokens is exactly the supply-chain risk class GitHub hardened against in late 2025. ([Wiz — Hardening GitHub Actions](https://www.wiz.io/blog/github-actions-security-guide))
  - **Actions are pinned by tag, not SHA** (`actions/checkout@v4`, `actions/setup-node@v4`, `actions/cache@v4`, `actions/upload-artifact@v4`). Since Aug 2025 GitHub supports SHA-pin enforcement; tag pins are mutable. ([secure-pipelines cheat sheet](https://secure-pipelines.com/ci-cd-security/github-actions-security-cheat-sheet/))
  - The eval workflow correctly uses `permissions: contents: read` (`voltron-evals.yml:17-18`) — good baseline to copy.
- **Hardening direction:**
  - **Pin every action to a full commit SHA** with a comment naming the version; add Dependabot (`.github/dependabot.yml`) for `github-actions` + `npm` ecosystems to manage SHA bumps.
  - **Minimize `GITHUB_TOKEN` scope per job**; default the workflow to `permissions: {}` and grant write only on the push/PR step.
  - **Confine the autonomous agent step**: cap `--max-turns` (already dynamic, `:50-55`), and consider requiring human approval (environment protection rule) before the PR-open step, since the agent edits `src/templates.js`.
  - Verify no `pull_request_target`/`workflow_run` triggers exist (they don't today — keep it that way) and document the rule.
  - Migrate to **OIDC short-lived tokens** for any future cloud publishing rather than long-lived secrets. ([GitHub Docs — secure use](https://docs.github.com/en/actions/reference/security/secure-use))

### S6 — Dependency & supply-chain hygiene — **Medium**

- **Where:** `package.json:35-38` (only `@modelcontextprotocol/sdk ^1.12.1`, `yaml ^2.5.0`), **no `package-lock.json` at repo root** (one exists only under a test fixture, `voltron-evals/lib/fixtures/T1-001/`), `Dockerfile.voltron` installs `@anthropic-ai/claude-code`, `@beads/bd`, and downloads `stringer` via `curl | tar` from a GitHub release (`:70-76`), GitHub CLI + docker-ce-cli from apt repos.
- **Risk:** No lockfile ⇒ non-reproducible installs and no `npm audit` baseline; `postinstall` auto-runs `scripts/setup.js` (`package.json:13`) — a supply-chain foothold if a dep is compromised. Dockerfile pulls binaries over the network at build time with no checksum verification (`stringer` tarball, `:70-76`) — a classic supply-chain gap (cf. Shai-Hulud npm worm, Nov 2025). Floating `^` ranges + image deps with no digest pinning.
- **Hardening direction:**
  - Commit a root `package-lock.json`; switch CI/installs to `npm ci`; add an `npm audit --audit-level=high` gate.
  - **Pin & verify** the `stringer` download with a SHA-256 checksum; pin the base image (`node:20-slim`) by digest; pin apt-installed `docker-ce-cli`/`gh`/`hadolint` versions where practical.
  - Review the `postinstall` auto-run (`package.json:13`) — it executes `scripts/setup.js` which writes to `~/.claude` and registers MCP servers; consider making it opt-in (`npm run setup`) to avoid surprising side effects on `npm install`.
  - Add Dependabot/`npm audit` to CI (overlaps S5).

### S7 — Secrets in repo / history & artifact retention — **Low/Medium**

- **Where:** reflection JSONs and `.voltron/logs/` transcripts; CI artifacts (`voltron-evals.yml:55-61`, 90-day retention).
- **Risk:** Agent transcripts may capture environment or partial secrets; eval artifacts retained 90 days. Audit must scan history with `gitleaks`/`trufflehog` and confirm `.gitignore` excludes `.voltron/logs/` and creds (the scaffold writes a Voltron `.gitignore` block — verify it covers logs/tmp).
- **Hardening direction:** confirm gitignore coverage, scrub any found secrets, set sane artifact retention, document a "never paste secrets into prompts" rule for users.

---

## Tooling Upgrades

These modernize the dev/agent tooling. They are largely independent of the security fixes and can parallelize once the baseline (Task 0) exists.

### T1 — Reproducible installs & dependency management

- Generate and commit a root **`package-lock.json`**; document `npm ci` as the canonical install.
- Add **Dependabot** config for `npm` + `github-actions`.
- Add `engines.node` to `package.json` (CI uses Node 20; Dockerfile uses `node:20-slim` — make it explicit).
- Reconsider `postinstall` side effects (see S6).

### T2 — Lint / format / typecheck gates

- Add **ESLint (flat config)** + **Prettier** tuned for ES modules (`"type": "module"`). Target `src/`, `scripts/`, `voltron-evals/`. Start with a non-blocking baseline, then ratchet to blocking.
- Add **`hadolint`** for `Dockerfile.voltron` and a **`shellcheck`** pass for `scripts/voltron-run.sh` and the inline bash in `src/index.js:1973-1985` (the most fragile, security-relevant shell in the repo).
- `src/index.js` is plain JS with no types; **do not** introduce TypeScript this sprint (out of scope) — instead add JSDoc + `// @ts-check` on the dispatch core for cheap safety.

### T3 — Real test suite + coverage in CI

- The only tests today are hand-run `scripts/test-*.mjs` (`test-batch-tool-comprehensive.mjs`, `test-parallel-dispatch*.mjs`) — **not wired to CI, not a framework.**
- Adopt a lightweight runner (**`node:test`** built-in, or Vitest) and:
  - Port the existing `scripts/test-*.mjs` into the suite.
  - Add **unit tests for the security-sensitive pure functions**: `detectProjectRoot`, `hostJoin`, `parseClaudeVersion`/`meetsMinVersion`, `safeAgentName`/filename sanitization, and the new input-validation refinements (S4).
  - Add a **dispatch-arg-builder test** that asserts the `dockerArgs` array for a given input contains the expected mounts and *does not* mount the socket unless explicitly enabled (locks in S1/S3).
- Add a **`ci.yml`** workflow (lint + `npm ci` + test + `npm audit` + `node voltron-evals/runner.js --doctor`) on `pull_request` and `push`, with `permissions: contents: read` and SHA-pinned actions. This is the missing day-to-day CI gate; today CI only runs reflections (manual) and monthly evals.

### T4 — Dockerfile hardening & slimming

- Apply the S3 runtime flags at the `docker run` layer (`src/index.js` dispatch + `scripts/voltron-run.sh`): `--cap-drop=ALL`, `--security-opt=no-new-privileges`, resource limits.
- **Pin base image by digest**; **checksum-verify** the `stringer` download (S6); pin apt package versions where feasible.
- Consider multi-stage / layer consolidation to shrink the image and reduce attack surface (currently 5 separate `apt-get install` layers: `:4-18`, `:27-33`, `:40-46`, `:57-63`, plus npm/curl installs). Add `hadolint` (T2) to keep it clean.
- Re-evaluate the `sudo`-shimmed `docker` wrapper (`:48-63`) in light of the S1 socket-proxy decision — it may become unnecessary.

### T5 — MCP tool ergonomics & error handling

- Tighten Zod schemas (S4): enums, bounded ints, slug/path refinements with helpful `.describe()` messages.
- Standardize a consistent **error envelope** across tools (today some return `isError: true`, some return plain text; `submit_reflection` returns a "NOT Saved" success-shaped message on failure, `:998-1010`). Define one shape.
- Fix the documented **doc-drift**: `README.md:162` advertises `start_agent_in_docker`, which **is not registered** in `src/index.js` (only `run_agent_in_docker` + `_batch` exist) — per `engine-inventory.md:35`. Either implement it or remove it from docs (Documentation Rule).

### T6 — Observability & structured logging for dispatch

- Dispatch currently tees a raw transcript to `.voltron/logs/<name>.log` (`src/index.js:1985`) and emits `[entry]`/`[exec]`/`[exit]` markers. Add:
  - A **structured dispatch record** (JSON: agent, model, container, start/end, exit code, turns, token/cost if available, mounts used) per run, so runs are queryable and the security posture of each dispatch (did it get the socket? a token?) is auditable.
  - **Token/secret redaction** verified by test (overlaps S2).
  - Optional: surface dispatch metrics through a new read-only MCP tool or extend `get_progress`.

### T7 — Eval-harness tooling polish

- Wire **`node voltron-evals/runner.js --doctor`** (schema/rubric/shape validation, no LLM) into the new `ci.yml` so eval definitions can't drift silently.
- Commit a lockfile for the eval fixtures consistently (one already exists at `voltron-evals/lib/fixtures/T1-001/package-lock.json`).
- Ensure the eval workflow keeps `permissions: contents: read` and gets SHA-pinned (S5).

---

## Sequencing & Dependencies

```
Phase 0: SECURITY BASELINE (blocks all hardening)
  └─ Task 0: code-analyst security audit → .voltron/analyses/<ts>-security-baseline.md
            (npm audit, gitleaks/trufflehog, hadolint, shellcheck, semgrep, MCP input review)
            + Alexandria consult (Docker proxy, rootless, GHA hardening, ESLint)
                         │
        ┌────────────────┼─────────────────────────────┐
        ▼                ▼                                ▼
Phase 1: TOOLING FOUNDATION        Phase 2: CI HARDENING        (parallel, low-risk)
  T1 lockfile/Dependabot             S5 SHA-pin + least-priv tokens
  T2 ESLint/Prettier/hadolint/       T3 ci.yml (needs T1+T2+T3 tests)
     shellcheck                      T7 eval --doctor in CI
  T3 test suite (node:test)
        │                                    │
        └──────────────┬─────────────────────┘
                       ▼
Phase 3: SECURITY HARDENING (highest-risk — needs tests as a safety net)
  S1 socket default-deny / proxy / runtime  ← gated on OD-1 decision
  S2 scoped credential injection
  S3 container confinement flags (T4)
  S4 MCP input validation (T5)
  S6 supply-chain pinning (Dockerfile + deps)
  S7 secret scan remediation
                       │
                       ▼
Phase 4: DOCS & VERIFICATION
  - Update docs/index.html security section + README (Documentation Rule)
  - Bump package.json version (patch/minor per Versioning Convention)
  - Full verification pass (DoD below); run voltron-evals to confirm no template/dispatch regressions
```

**Ordering rules:**
- **Task 0 blocks everything.** Audit before fixes (it sets real severity and may add/remove items).
- **Tests (T3) should land before the risky S1/S3/S4 changes** — they are the regression net for dispatch-arg changes.
- **Phase 1 (tooling foundation) and Phase 2 (CI hardening) parallelize**; both depend only on Task 0. T3's `ci.yml` step depends on T1+T2 existing.
- **S1 is gated on Open Decision OD-1** — do not start until the user picks the socket approach.
- **Phase 4 docs must ship in the same PRs as the code** (`CLAUDE.md` Documentation Rule), not as a trailing task.

**Parallelizable clusters for batch dispatch:** {T1, T2 (lint), T2 (hadolint/shellcheck)}; {S5 pinning, T7}; {S4 per-tool validation tasks — one per tool}; {unit-test tasks per pure function}.

---

## Risks & Open Decisions

> Flagged for the **scrum-master to surface to the user** before/at the start of the relevant phase. Each blocks a specific task.

| ID | Decision | Options | Trade-off | Blocks |
|----|----------|---------|-----------|--------|
| **OD-1** | How to contain the Docker socket (S1) | (a) **Default-deny + opt-in flag** — smallest change, keeps DooD working when requested; (b) **socket-proxy** — fine-grained API allowlist, new moving part; (c) **rootless Docker / Sysbox** — strongest isolation, biggest infra lift + host setup burden + 2025 namespace CVEs ([Ken Muse](https://www.kenmuse.com/blog/rootless-docker-and-its-hidden-security-trade-offs/)) | Security vs. setup complexity vs. breaking nested dispatch for existing users | S1, T4 |
| **OD-2** | Is nested DooD dispatch still a required feature? | Keep / make opt-in / deprecate | If rarely used, default-deny (OD-1a) is nearly free; if core, justifies proxy/Sysbox investment | S1 scope |
| **OD-3** | Per-agent credential scoping (S2) — acceptable to break agents that assumed a token? | Scope tokens to publish agents only / keep broad | Tightening may break user workflows that relied on any agent pushing | S2 |
| **OD-4** | CI autonomous-agent PR step (S5) — require human approval gate? | Add environment protection / keep auto | Safety vs. automation friction in the self-improvement loop | S5 |
| **OD-5** | `postinstall` auto-setup (S6) — keep auto or make opt-in? | Keep `postinstall` / move to `npm run setup` | Convenience vs. surprising host mutations + supply-chain footprint | T1, S6 |
| **OD-6** | Test framework | `node:test` (zero-dep, built-in) / Vitest (richer, adds dep) | Minimal deps vs. ergonomics; note repo is ESM | T3 |
| **OD-7** | Lint strictness rollout | Blocking from day 1 / warn-then-ratchet | Velocity vs. immediate enforcement | T2 |
| **OD-8** | Version bump for this sprint | patch (`3.15.x`) vs minor (`3.16.0`) | Per `CLAUDE.md` Versioning Convention these are infra/security changes, not template additions — but they're substantial; recommend **minor `3.16.0`** | Phase 4 |

**Standing risks (not decisions):**
- Dispatch-arg changes (S1/S3) touch the hottest, most fragile code path (`dispatchOneAgent`, `src/index.js:1758-2130`) shared by both single and batch tools — high blast radius; mitigated by T3 tests.
- Container confinement flags can break legitimate agent work (e.g. `--read-only` + missing tmpfs path); roll out behind a feature flag and validate via voltron-evals.
- SHA-pinning + Dependabot adds PR churn; acceptable.

---

## Acceptance / Definition of Done

Per-area verification. The scrum-master should turn each row into an acceptance criterion on the corresponding bead.

| Area | Done when… | Verified by |
|------|-----------|-------------|
| **Task 0 baseline** | `.voltron/analyses/<ts>-security-baseline.md` exists with enumerated, severity-rated findings; every S-item below is confirmed/quantified or explicitly dismissed | `submit_analysis` output; manual review |
| **S1 socket** | Socket is NOT mounted by default; mounting requires explicit opt-in (or proxy in place); a dispatch-arg test asserts no `/var/run/docker.sock` mount for a standard agent | `node --test` dispatch-arg test; manual `docker inspect` of a running agent |
| **S2 credentials** | `GH_TOKEN` injected only for publish-capable agents; read-only agents get no token; test asserts token absent from `dockerArgs`/logs for a file-editing agent | unit test + log-redaction test |
| **S3 confinement** | `docker run` includes `--cap-drop=ALL`/`no-new-privileges`/resource limits; agents still pass voltron-evals PR tier | eval sweep green; arg test |
| **S4 MCP inputs** | Every tool rejects malformed/traversal/oversized input with a clear error; one boundary test per tool | `node --test` suite |
| **S5 CI** | All actions SHA-pinned; workflows default to least privilege; Dependabot active; no `pull_request_target` | workflow lint; review of `permissions:` blocks |
| **S6 supply chain** | Root `package-lock.json` committed; `npm ci` used; `npm audit --audit-level=high` clean (or documented exceptions); `stringer` + base image pinned/checksummed | CI `npm audit` step; `hadolint` clean |
| **S7 secrets** | `gitleaks`/`trufflehog` history scan clean; `.gitignore` covers `.voltron/logs/`, tmp, creds | scan output |
| **T1–T2 tooling** | `npm run lint`, `npm run format:check`, `hadolint`, `shellcheck` all pass in CI | `ci.yml` green |
| **T3 tests** | `npm test` runs in CI on every PR with meaningful coverage of dispatch core + pure utils | `ci.yml` green; coverage report |
| **T5 ergonomics** | Consistent error envelope across tools; `start_agent_in_docker` doc-drift resolved | grep `README.md` vs `server.tool` registrations |
| **T6 observability** | Structured per-dispatch JSON record emitted; redaction test passes | inspect a run's record |
| **T7 evals** | `runner.js --doctor` runs in CI and passes | `ci.yml` green |
| **Docs (Phase 4)** | `docs/index.html` security section + `README.md` reflect the hardened model; version bumped | Documentation Rule check; `git diff` shows docs in same PRs |
| **Overall regression** | Full `voltron-evals` sweep shows no agent/dispatch regression vs. pre-sprint baseline | `node voltron-evals/runner.js --tier=all` |

**Global gate (from `CLAUDE.md`):** no code change merges without same-PR updates to `docs/index.html` and `README.md`; `node src/index.js` must start cleanly; work is not done until pushed via PR (no direct push to `main`).

---

## Notes for the Scrum-Master

- **Decompose Task 0 first** and block all S-tasks on it (`bd dep add`).
- Many items map to **one bead per file/tool** — e.g. S4 → one task per MCP tool; T3 → one task per pure function. Good candidates for `run_agent_in_docker_batch` waves.
- Dispatch security-sensitive edits to **`harness-engineer`** (owns all Voltron modifications per `CLAUDE.md`); the baseline audit to **`code-analyst`**; CI/Dockerfile work to **`harness-engineer`** (or `devops-engineer` patterns).
- Surface **OD-1 through OD-8** to the user before the dependent phase begins — OD-1 in particular blocks the highest-value security work.
- Keep this on the existing `feat/voltron-engine-rebrand` lineage or branch fresh from `main`; do **not** push to `main` directly.
