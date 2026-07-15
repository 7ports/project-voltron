# Beads / Dolt Reliability Plan

> **Status:** Design document — no implementation performed. Produced by `project-planner`.
> **Scope:** Diagnose why the beads (`bd`) + shared Dolt server keeps "going up and down" and fails
> across multiple concurrent Voltron projects, then design a durable fix and a task list Voltron can execute.
> **Evidence base:** injected host-only runtime facts (gathered on the host at authoring time), plus
> in-repo reads of `.beads/config.yaml`, `src/index.js` (~1721–1896), `.claude/commands/scrum-master.md`,
> and its mirror in `src/templates.js`.
> **Limitation:** the Alexandria MCP was not reachable from the authoring container, so the embedded /
> server / no-db mode descriptions below are taken from the injected summary of the Alexandria `beads`
> guide rather than re-read first-hand. Claims sourced only from that summary are flagged as such.

---

## Root Cause

The failures are not one bug; they are **one architectural choice under an unsupervised process model**, plus
**three amplifiers**. Ground truth for each claim is cited inline.

### Primary cause — an unsupervised, shared, long-running network server on a platform that does not supervise it

`.beads/config.yaml` sets `dolt.shared-server: true` (config.yaml:56): **one** `dolt sql-server` process on
`127.0.0.1:3308` serves **all four** project databases (`glimpse`, `project_hammer`, `project_pepper`,
`project_voltron` — injected fact 3). That process is a **host-level, user-launched process with no Windows
service and no scheduled task** registering it (injected fact 4). Consequences:

- **Reboot / logon orphaning.** When the user logs out or reboots, nothing restarts the server, and `bd`
  *refuses to auto-spawn it* because shared-server mode suppresses auto-start by design (injected fact 4;
  echoed in `scrum-master.md:579`). So every session after a reboot starts with a dead server.
- **Mid-session death.** The server also dies *during* a session — twice in one session even after a
  successful `bd dolt start` (injected fact 7). With no supervisor, each death is a hard stop until a human
  or the pre-flight re-runs `bd dolt start`.
- **This is the "going up and down."** The `bd`/Voltron layer has no process-lifecycle guarantee for a
  component it treats as always-on.

### Amplifier 1 — Windows loopback connection-aborts under connection churn (the `wsasend` errors)

The log tail (injected fact 5) shows, repeating continuously:

```
Cannot send HandshakeV10 packet: ... wsasend: An established connection was aborted
by the software in your host machine. Write(packet) failed conn 8
```

with "many NewConnection/ConnectionClosed per second." `bd` opens a **short-lived connection per command**;
across four active projects (host **and**, where misconfigured, container attempts) this is heavy
connect/disconnect churn against a single loopback port. On Windows + Docker Desktop/WSL2 (injected fact 6),
`127.0.0.1:3308` traffic crosses the WSL2/Windows network boundary, and these aborts are a known fragility of
that path under churn. **This is a distinct failure from process death:** a connection abort does not
necessarily kill the server process — so *supervising the process cannot fix it*. This matters for choosing
between options below.

> **Uncertainty (flagged):** I cannot prove from the evidence whether the `wsasend` aborts originate purely
> from the WSL2/Docker loopback boundary, from the stale Dolt engine, or from `bd`'s connection handling.
> Treat the "eliminate the network path" reasoning in Options as the safe design response to an
> incompletely-diagnosed abort class, not as a proven root cause.

### Amplifier 2 — a diverged, backup-less Dolt remote flooding the log and masking real errors

`.beads/config.yaml` disables `backup.git-push` (config.yaml:44–45) because the Dolt remote
(`github.com/7ports/project-voltron.git`) diverged with **no common ancestor** when `project_voltron` was
recreated fresh on the shared server. The log therefore floods with benign
`unknown push error; no common ancestor` and `nothing to commit` warnings (injected facts 1, 5). Two harms:

- **Signal masking.** These benign lines dominate a ~2.9 MB log, burying the real `wsasend` connection
  aborts (injected fact 3, 5) — already noted as a concern in injected fact 7.
- **No off-machine backup.** With `git-push: false` and Dolt-as-source-of-truth (no `no-db` mode, injected
  fact 1), the shared server's on-disk data dir is the **single point of truth** for all four projects. If it
  corrupts, there is no recovery path.

### Amplifier 3 — stale storage engine and CLI

`dolt` is `1.85.0` while upstream is `2.1.11`; `bd` is `1.0.0` while `bd doctor` reports `1.1.0` (injected
fact 2). Dolt itself warns the user is "on an old version." Running many minor releases behind on the storage
engine means any upstream fix to the loopback/handshake handling is absent. **Whether upgrading alone fixes
the `wsasend` aborts is unknown** (see risk in the Recommendation).

### Amplifier 4 — a false-positive readiness gate hides all of the above

Voltron's own pre-flight checks readiness with `bd dolt status | grep -qi running` (`scrum-master.md:529`,
`:545`; mirrored `src/templates.js:1307`, `:1328`). This prints "OK" while the server is actually **down**,
after which `bd ready` fails (injected fact 7). The gate tests the wrong thing: it greps status *text* rather
than gating on `bd ready --json` **exit 0**. Meanwhile `src/index.js`'s mandatory-dependency check
(`src/index.js:1728–1743`) only verifies `bd --version` (that the binary exists) — it never checks server
health at all. So neither layer reliably detects a down server, and when the DB layer *is* down, `bd` failures
**hard-block** the session instead of degrading gracefully.

### One-line statement

> A single unsupervised shared Dolt server is a single point of failure on a platform (Windows + WSL2/Docker)
> that neither keeps it alive (no service → orphaning + mid-session death) nor keeps its loopback connections
> stable (`wsasend` aborts under multi-project churn) — and Voltron's readiness check is blind to the outage
> while its dependency layer treats the outage as a hard block.

---

## Options

Three distinct **durable** storage architectures (A/B/C) are evaluated against the realities above, followed
by a **cross-cutting resilience layer (D)** that applies regardless of which architecture is chosen. Each is
scored on: stops the flapping/orphaning · behaves correctly with 4+ concurrent project DBs · closes the
Windows no-service gap · addresses stale versions · off-machine backup · migration cost.

### Option A — Keep the shared server, but supervise and harden it

**How it works.** Keep `dolt.shared-server: true` on port 3308, but put the server under a real process
supervisor so it is never orphaned: register `dolt sql-server` (directly, or `bd dolt start`) as a **Windows
service** (e.g. via NSSM) or a **Scheduled Task with restart-on-failure** triggered at logon *and* on process
exit. Upgrade `dolt` and `bd`. Fix the pre-flight to gate on `bd ready --json`. Add automated stale-lock
cleanup (`rm -f .beads/dolt-server.pid .beads/dolt-server.lock` — already documented at `scrum-master.md:619`)
to the restart path. Re-enable a JSONL export path for backup even if git-push stays off.

**What it fixes.** Reboot orphaning (service auto-starts) and mid-session *death* (restart-on-failure brings
it back). The false-positive gate. Version staleness. It preserves the one feature the shared server was
chosen for — cross-session, cross-project persistence on one engine.

**Trade-offs / risks.**
- **Does not fix Amplifier 1 by itself.** A `wsasend` connection abort does not necessarily terminate the
  process, so a supervisor watching for process *exit* won't react to it. The four projects still hammer one
  loopback port; the churn that produces the aborts remains. This is the core weakness of A.
- Windows service/NSSM setup is a **host-only, one-time manual action** the user must perform (and re-do on
  new machines) — it cannot be committed to the repo.
- Keeps the single-point-of-failure data dir and the diverged remote unless backup is separately fixed.

**Under our realities.** Multi-project: unchanged (still one shared server — the exact contention source).
No-service gap: **closed** (that's the point of A). Reboot/mid-session death: mostly closed for *death*, not
for *aborts*. Migration cost: **near-zero** (no DB moves). Effort: **Low–Medium**, mostly host setup.

### Option B — Per-project embedded Dolt (drop the shared server) — *recommended core*

**How it works.** Set `dolt.shared-server: false` so each project runs Dolt **in-process** inside `bd`, with
data in that project's own `.beads/embeddeddolt/` (embedded mode per the injected Alexandria `beads` guide
summary — flagged as guide-sourced). There is **no long-running server process and no TCP port** at all: `bd`
opens the embedded store for the duration of a command and closes it. Each of the four projects gets its own
isolated database directory. Migrate the four existing DBs off the shared server via Dolt export/import.

**What it fixes.**
- **Flapping and orphaning disappear by construction** — there is no server to orphan, no logon dependency,
  no mid-session process to die.
- **Amplifier 1 disappears** — no loopback TCP means no `wsasend` handshake aborts. (Inference, high
  confidence: the abort is on the SQL wire protocol connection, which embedded mode does not use. Flagged as
  inference, not a measured result.)
- **Multi-project contention disappears** — four independent embedded stores, no shared port, no cross-project
  connection churn.
- No Windows service needed → the no-service gap becomes **moot**, not merely patched.

**Trade-offs / risks.**
- **Single-writer per project.** Embedded Dolt is single-writer (injected Alexandria summary). Two writers to
  the *same* project DB at once (e.g. host scrum-master **and** a Docker agent) would conflict. But Voltron
  already forbids container-side `bd` writes (`src/templates.js:8045`: "Do NOT attempt `bd`/dolt writes from
  inside the container … Bead state changes are the orchestrator's job on the host"). So within Voltron's
  actual usage — one host orchestrator writes, containers don't — single-writer is sufficient. **Risk:** any
  future parallel host writer (two Claude sessions on one project) would need serialization.
- **One-time migration of 4 live databases** — the main cost. Export/import each DB; risk of data loss if done
  wrong (mitigate: export, verify row counts, keep the shared-server data dir as a read-only fallback until
  confirmed).
- Loses "one server for everything" cross-session convenience, but persistence is preserved per-project on
  disk, and off-machine backup should be re-enabled via JSONL export (below).

**Under our realities.** Multi-project: **best** (full isolation). No-service gap: **eliminated**.
Reboot/mid-session death: **eliminated**. Stale versions: still worth upgrading, but the failure class it
addresses is decoupled from the fix. Migration cost: **Medium** (4 DB moves, one-time). Effort: **Medium**.

### Option C — JSONL "no-db" mode (drop Dolt entirely)

**How it works.** Set `no-db: true` in `.beads/config.yaml` (the option is present and currently commented,
config.yaml:11–13). `bd` uses `.beads/issues.jsonl` as the source of truth; there is no Dolt engine and no
server. Sync/backup is plain git on the JSONL file.

**What it fixes.** Everything server-related — flapping, orphaning, `wsasend`, no-service gap, version
staleness of *Dolt* (Dolt is gone) — all become moot. Lowest possible infrastructure. Off-machine backup is
trivially git.

**Trade-offs / risks.**
- **Loses Dolt's history/branching and structured query layer** that `bd` builds on. How much `bd` 1.x
  functionality degrades under `no-db` is **not verified** from the repo and must be tested before adopting
  (flagged as a verification task).
- **JSONL merge conflicts.** With four concurrent projects and multiple branches/sessions, a single append-only
  JSONL is prone to merge conflicts and lost updates — trading a *server* reliability problem for a *merge*
  reliability problem.
- Concurrency within a project relies on file locking, which is weaker than a DB transaction.

**Under our realities.** Multi-project: workable but conflict-prone. No-service gap: **eliminated**.
Reboot/death: **eliminated**. Migration cost: **Low** (export to JSONL). Effort: **Low**, but **feature risk
is the highest** of the three. Best positioned as the **degraded fallback**, not the primary store.

### Option D — Cross-cutting resilience layer (adopt regardless of A/B/C)

These are orthogonal to the storage choice and should ship no matter what:

1. **Make `bd` non-blocking in Voltron.** Today a down DB layer hard-blocks the session (the pre-flight's
   `BEADS SERVER DOWN` path, `scrum-master.md:568`; and `src/index.js:1728–1743` treats beads as mandatory).
   Change the contract so that when the DB layer is unavailable **after** one recovery attempt, the session
   **degrades to `update_progress`-only** tracking and continues, surfacing a warning — it never hard-fails a
   whole Voltron session on a bead outage. (`scrum-master.md:652` already contemplates a "No beads: use
   `update_progress` only" mode — this promotes it from a footnote to the defined fallback.)
2. **Fix the false-positive readiness gate.** Replace `bd dolt status | grep -qi running` with a gate on
   `bd ready --json` **exit 0** (injected fact 7). Status text is not liveness; a successful `bd ready` is.
3. **Automate stale-lock recovery** in the pre-flight's auto-recover branch: on a down server, `rm -f
   .beads/dolt-server.pid .beads/dolt-server.lock` then retry `bd dolt start` (the empirically reliable
   recovery, injected fact 7; documented but manual today at `scrum-master.md:615–627`).
4. **Stop the log flood / restore backup** — with embedded (Option B) the "no common ancestor" push errors
   vanish (no server-side auto-push against a diverged remote); pair with per-project JSONL export for
   off-machine backup so there is no longer a single point of failure.

**Effort:** Low–Medium, all Voltron-repo changes (templates + `src/index.js` + docs). **This layer is what
guarantees `bd` never hard-blocks a session again**, independent of the storage decision.

---

## Recommendation

**Adopt Option B (per-project embedded Dolt) as the durable storage architecture, wrapped in the Option D
resilience layer, delivered in three phases.** Rationale against the alternatives:

- **B over A:** Option A supervises the process but **cannot stop the `wsasend` connection aborts** (Amplifier
  1) because those do not kill the process a supervisor watches — and it keeps four projects contending on one
  loopback port, which is the churn source. B removes the network path and the shared process entirely, so both
  the *death* class **and** the *abort* class disappear by construction, and the four projects become fully
  isolated. B costs a one-time 4-DB migration that A avoids; that cost is bounded and one-time, whereas A's
  residual abort risk is ongoing.
- **B over C:** C is even simpler but **risks losing `bd`/Dolt functionality** and **introduces JSONL merge
  conflicts** across four concurrent projects — trading a known reliability problem for a new one. C is the
  right *fallback*, not the primary store.

**What stops the flapping:** removing the shared long-running server (Option B) — no process to orphan or die,
no loopback port to abort on.
**What handles multi-project:** per-project embedded stores — four isolated databases, zero shared contention.
**The fallback when the DB layer is unavailable:** the Option D non-blocking contract — after one automated
recovery attempt fails, the session degrades to `update_progress`-only and continues, and (if ever needed)
`no-db` JSONL mode (Option C) is the last-resort store. `bd` must **never** hard-block a Voltron session again.

### Phasing

- **Phase 0 — Resilience first (Option D, ship immediately).** Fix the false-positive gate, make `bd`
  non-blocking, automate stale-lock recovery. This stops sessions hard-failing *today*, independent of the
  storage migration, and de-risks Phase 1.
- **Phase 1 — Migrate to embedded (Option B).** Flip `dolt.shared-server` to `false`, migrate the four DBs,
  re-enable per-project JSONL export for backup, keep the old shared-server data dir read-only until verified.
- **Phase 2 — Hygiene & docs.** Upgrade `bd` and `dolt` on the host (user action), and rewrite the Beads
  Recovery / pre-flight guidance in `scrum-master.md` + `src/templates.js` to describe the embedded default,
  demoting the shared-server recovery playbook to a clearly-labelled legacy fallback.

### Risks / assumptions to validate (do not treat as settled)

- **Assumption:** embedded mode eliminates `wsasend` aborts because it uses no TCP. High confidence, but an
  *inference* — validate by running a multi-project session on embedded and confirming the abort lines stop.
- **Unknown:** whether a `dolt`/`bd` upgrade *alone* would resolve the aborts. Do **not** assert it does;
  upgrading is hygiene (Phase 2), not the primary fix.
- **Migration risk:** moving four live databases risks data loss — export, verify row counts per project, and
  retain the shared-server data dir as read-only rollback until each project is confirmed on embedded.
- **`no-db` feature parity is unverified** — must be tested before C is relied on even as a fallback.
- **Single-writer caveat (B):** safe under current usage (host writes, containers don't — `src/templates.js:8045`),
  but a second concurrent host writer per project would need serialization.

---

## Implementation Plan

Ordered, checkbox-sized for Voltron agents. Each item notes **what changes**, **file(s)/config**, **agent
type**, and whether it is a **[REPO]** change (committed to project-voltron) or a **[HOST]** one-time action
the **user** runs (service/scheduled-task registration, `bd`/`dolt` upgrades — these cannot be committed).
Per project CLAUDE.md, all Voltron repo edits go through `harness-engineer`; host/service work is `devops`.

### Phase 0 — Resilience layer (ship first, storage-agnostic)

- [ ] **[REPO]** Fix the false-positive readiness gate: replace `bd dolt status | grep -qi running` with a
      gate on `bd ready --json` exit 0 in both pre-flight variants (Bash and PowerShell). Files:
      `.claude/commands/scrum-master.md` (~lines 526–558) and the mirror in `src/templates.js` (~lines
      1305–1330). *Agent: `harness-engineer`.*
- [ ] **[REPO]** Make `bd` non-blocking: change the mandatory-dependency handling so a down/unavailable DB
      layer, after one automated recovery attempt, **degrades to `update_progress`-only** and continues rather
      than hard-blocking the session. Files: `src/index.js` (~1721–1743, the beads dependency check) and the
      pre-flight failure copy in `scrum-master.md`/`src/templates.js` (`BEADS SERVER DOWN` path). *Agent:
      `harness-engineer`.*
- [ ] **[REPO]** Automate stale-lock recovery in the auto-recover branch: on a down server, `rm -f
      .beads/dolt-server.pid .beads/dolt-server.lock` then retry `bd dolt start`, before declaring failure.
      Files: pre-flight block in `scrum-master.md` + `src/templates.js`. *Agent: `harness-engineer`.*
- [ ] **[REPO]** Update `docs/index.html` and `README.md` to reflect the new non-blocking behaviour and the
      corrected readiness gate (required by the CLAUDE.md documentation rule). *Agent: `harness-engineer` (or
      `doc-writer`).*

### Phase 1 — Migrate to per-project embedded Dolt (Option B)

- [ ] **[HOST]** Back up all four project databases from the shared server (export each of `glimpse`,
      `project_hammer`, `project_pepper`, `project_voltron` and record row counts) **before** any change.
      Data dir: `C:\Users\Raj\.beads\shared-server\dolt`. *User action / `devops`.*
- [ ] **[REPO]** Flip `dolt.shared-server: true` → `false` and remove/redirect the `backup.git-push` comment
      accordingly in `.beads/config.yaml`. *Agent: `harness-engineer`.*
- [ ] **[HOST]** Migrate each project's data into its own `.beads/embeddeddolt/` (Dolt export/import per
      project), verify row counts match the Phase-1 backup, and keep the shared-server data dir read-only as
      rollback until verified. *User action / `devops`.*
- [ ] **[REPO]** Re-enable per-project off-machine backup (JSONL export; re-enable `backup.git-push` per
      project now that the diverged shared remote is out of the picture) so no project has a single point of
      failure. File: `.beads/config.yaml`. *Agent: `harness-engineer`.*
- [ ] **[HOST]** Run one Voltron session per project on embedded mode and confirm the `wsasend` /
      `no common ancestor` lines no longer appear (validates the Amplifier-1 assumption). *User action.*

### Phase 2 — Version hygiene & documentation

- [ ] **[HOST]** Upgrade `bd` 1.0.0 → 1.1.0 and `dolt` 1.85.0 → 2.1.11 on the host, then re-run `bd doctor`.
      *User action / `devops`.*
- [ ] **[REPO]** Rewrite the Beads Recovery + pre-flight sections in `.claude/commands/scrum-master.md` and
      `src/templates.js` to describe the embedded default; demote the shared-server + Windows Scheduled-Task
      playbook (`scrum-master.md:595–633`) to a clearly-labelled **legacy / only-if-you-keep-shared-server**
      fallback. *Agent: `harness-engineer`.*
- [ ] **[REPO]** Bump `package.json` version and update `docs/index.html` + `README.md` for the storage-model
      change (per the CLAUDE.md versioning + documentation rules). *Agent: `harness-engineer`.*
- [ ] **[HOST, optional — only if the user chooses to keep a shared server instead of Option B]** Register the
      server under a real supervisor (NSSM Windows service or Scheduled Task with restart-on-failure at logon
      *and* on exit) so it is never orphaned. This is the Option-A path, retained only as an alternative to the
      recommended embedded migration. *User action / `devops`.*

---

## Appendix — What Voltron already does (inventory, so the plan changes rather than duplicates)

- **Pre-flight (`scrum-master.md:514–573`, mirror `src/templates.js:~1300–1350`):** checks Docker, Dockerfile,
  credentials, `bd`/stringer/alexandria presence; auto-recovers a down server with `bd dolt start`; **gates
  readiness on `bd dolt status | grep -qi running` — the false positive** (Phase 0 fixes this).
- **`src/index.js:1721–1743`:** mandatory-dependency check only verifies `bd --version` (binary present); it
  does **not** check server health and treats beads as hard-mandatory (Phase 0 makes it non-blocking).
- **Beads Recovery (`scrum-master.md:575–633`):** documents the benign `no common ancestor` warnings, manual
  `bd dolt start`, the Windows Scheduled-Task permanent fix, stale pid/lock cleanup, and `bd` CLI upgrade —
  all **manual** today. Phase 0 automates the stale-lock step; Phase 2 demotes the shared-server playbook.
- **Container write prohibition (`src/templates.js:8045`):** agents must not run `bd`/dolt writes inside the
  container — this is what makes embedded single-writer safe under current usage.
