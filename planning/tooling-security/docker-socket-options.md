# S1 Docker-Socket Containment: Three Options (Decision Support)

> **Status:** Decision support only. No implementation. This document specs the three
> candidate containment approaches for security finding **S1** (Critical) so the user can
> choose one. It does not pick for you; the recommendation at the end is advisory.
> **Blocks:** Open Decision **OD-1** in `planning/tooling-security/upgrade-plan.md`.
> **Grounded in:** `src/index.js` (`dispatchOneAgent` ~`:1758-2130`, socket mount `:1940-1941`,
> nesting/`--volumes-from` `:1950-1965`, depth cap `:2166-2172`/`:2257-2263`),
> `Dockerfile.voltron:23-63`, `README.md:279-287`, `src/templates.js` (nestable flags).

---

## The Problem, As Voltron Actually Wires It

Voltron dispatches each specialist agent into a throwaway Docker container that runs
`claude --dangerously-skip-permissions`. To let an agent dispatch further agents
(Docker-out-of-Docker, "DooD"), the host Docker socket is bind-mounted into the container:

```js
// src/index.js:1940-1941
const dockerSocketHostPath = process.platform === "win32" ? "//var/run/docker.sock" : "/var/run/docker.sock";
const socketMount = (nestable && !isNested) ? ["--mount", `type=bind,source=${dockerSocketHostPath},target=/var/run/docker.sock`] : [];
```

Mounting `/var/run/docker.sock` is **host-root-equivalent**: an agent holding it can
`docker run --privileged -v /:/host`, read or write any file the daemon can reach, and
tamper with sibling containers. Combined with the read-only mount of
`~/.claude/.credentials.json` and an auto-derived `GH_TOKEN`, a prompt-injected or buggy
agent escalates straight to host compromise. This is self-disclosed at `README.md:279-287`.

### How the grant propagates today

- **Gate 1, the template `nestable` flag.** `const nestable = template.nestable !== false`
  (`src/index.js:1776`). Templates without an explicit `nestable: false` are nestable.
- **Gate 2, `!isNested`.** The host-level dispatch (`VOLTRON_DEPTH=0`) bind-mounts the
  socket directly. A nested dispatch (depth > 0) does **not** re-bind it; instead it uses
  `--volumes-from <ownId>` (`src/index.js:1952-1965`), which **inherits the parent's
  socket mount**. So the socket flows down the whole chain: host mount -> sub-manager ->
  micro-agent, up to the depth-3 cap (`src/index.js:2166-2172`).
- **The DooD shim.** Because the host socket is `root:docker 0660` and the in-container
  `voltron` user is not in that GID, `Dockerfile.voltron:48-63` installs `sudo` and shadows
  `docker` with a wrapper that re-execs the real CLI as root
  (`sudo -n /usr/bin/docker "$@"`). The sudoers entry is scoped to `/usr/bin/docker`, but
  the docker binary **is** the escalation primitive, so that scoping buys little.

### Who actually needs the socket (the lever for Option 1)

Of **70 agent templates, 14 are nestable** and therefore receive the socket at host-level
dispatch:

> `project-planner`, `scene-architect`, `csharp-dev`, `shader-artist`, `build-validator`,
> `asset-manager`, `fullstack-dev`, `devops-engineer`, `ui-designer`, `qa-tester`,
> `harness-engineer`, `researcher`, `code-analyst`, `doc-writer`

The remaining **56 (the micro-agents: `committer`, `pr-opener`, `branch-manager`, etc.)**
carry `nestable: false` and never get the socket.

But the live orchestration model (`.claude/commands/scrum-master.md`, `src/templates.js`
scrum-master content `:879-961`) is: **the scrum-master runs on the host (not in a
container) and fans out every wave itself** via `run_agent_in_docker` /
`run_agent_in_docker_batch`. Inside a container, only **sub-manager roles that compose
micro-agents** genuinely re-dispatch, namely `fullstack-dev`, `csharp-dev`, `qa-tester`,
`harness-engineer`, and `code-analyst`/`devops-engineer` for batch waves. The rest of the
14 (`project-planner`, `researcher`, `doc-writer`, `ui-designer`, `shader-artist`,
`build-validator`, `asset-manager`, `scene-architect`) are research/design/single-file
roles that are flagged nestable but **never call the dispatch tools** -- they hold
host-root for nothing. That over-grant is exactly what Option 1 removes.

---

## Option 1: Default-Deny + Opt-In Socket Mount

### How it works (for Voltron)

Invert the default. The socket is mounted **only** when a dispatch explicitly requests
nesting, instead of automatically for every `nestable` template. Two combinable triggers:

1. A per-template capability flag, e.g. `dispatches: true`, set on the five real
   sub-manager templates only (`fullstack-dev`, `csharp-dev`, `qa-tester`,
   `harness-engineer`, `code-analyst`). The other nine currently-nestable templates lose
   the socket because they never dispatch.
2. A per-call opt-in on the dispatch tools, e.g. an `allow_nested` boolean param on
   `run_agent_in_docker` / `_batch`, defaulting to `false`. The scrum-master sets it true
   only for a wave it knows will recurse.

The socket mounts only when `(templateDispatches || allow_nested) && !isNested`. Everything
else (depth cap, `--volumes-from` inheritance for genuine nesters) is unchanged.

### Exact change surface

- `src/index.js:1941` -- change the `socketMount` condition from `nestable && !isNested`
  to `(canDispatch) && !isNested`, where `canDispatch` is derived from the new
  `template.dispatches` flag and/or the new `allow_nested` opt-in plumbed through `spec`/`opts`.
- `src/index.js:1758-1776` (`dispatchOneAgent` signature/destructure) -- thread the
  `allow_nested` value in from the tool handlers.
- `src/index.js:2134-2200` and `:2230-2320` -- add `allow_nested` (default `false`) to the
  Zod schemas of `run_agent_in_docker` and `run_agent_in_docker_batch`; pass it into `spec`.
- `src/index.js:1909-1923` -- consider gating the `--mcp-config` injection on the same
  `canDispatch` so non-dispatchers cannot even reach the nested-dispatch MCP tool.
- `src/templates.js` -- add `dispatches: true` to the 5 sub-manager templates; no Dockerfile
  change required.
- Tests (`T3`) -- a dispatch-arg test asserting `dockerArgs` contains the socket mount only
  when opt-in is set.

### Effort / Risk

- **Effort: S.** A condition change plus a schema field plus a handful of template flags.
- **Risk:** Low-to-medium. The main breakage is a wave that *expected* to nest but did not
  request it: the inner `run_agent_in_docker` call fails because there is no socket. The
  depth-cap error path already exists, but a "socket missing" path should give a clear
  message ("re-dispatch with allow_nested"). Because the scrum-master orchestrates from the
  host, most real waves are flat and unaffected.

### Nesting compatibility

Preserved for opted-in dispatchers. A sub-manager dispatched with the socket still nests via
`--volumes-from` exactly as today; the depth-3 cap and `VOLTRON_HOST_ROOT` propagation are
untouched. `run_agent_in_docker_batch` works unchanged; each batch entry can carry its own
opt-in.

### Residual risk

The socket is still **full host-root** for any agent that does receive it. This narrows the
blast radius from 14 templates to ~5 (and to only the waves that opt in), but does not reduce
the privilege of a nesting agent. Defense-in-depth (S3 confinement flags) and honest docs are
still required. Easy to misconfigure back to broad access by over-applying the flag.

---

## Option 2: Docker Socket-Proxy (Filter the API Surface)

### How it works (for Voltron)

Stop handing agents the raw socket. Run a **socket-proxy** sidecar (for example
`11notes/docker-socket-proxy` or the Tecnativa/LinuxServer image) that holds the real
`/var/run/docker.sock` and exposes a TCP endpoint allowlisting **only** the Docker API calls
nested dispatch uses: image inspect, `POST /containers/create`, `/start`, `/wait`,
and `DELETE` (for `--rm` cleanup). Agents get `DOCKER_HOST=tcp://socket-proxy:2375` instead
of a socket bind-mount. The proxy denies `--privileged`, host bind-mounts outside the
project, `exec` into siblings, image build, swarm, and the other escape primitives.

The catch worth surfacing: Voltron's nesting relies on `--volumes-from <ownId>` and host-path
bind-mounts (`VOLTRON_HOST_ROOT` -> `/workspace`). A strict proxy that blocks arbitrary binds
will also block Voltron's own legitimate `type=bind,source=${hostRoot}` mount unless the
allowlist is widened. Tuning the proxy so it permits Voltron's exact mount shape while still
blocking `-v /:/host` is the core engineering effort, and an over-wide bind allowlist erodes
much of the benefit.

### Exact change surface

- `src/index.js:1940-1965` -- replace `socketMount` with `DOCKER_HOST` env injection toward
  the proxy; the docker CLI then talks TCP, so the **`--volumes-from`/socket-bind branch at
  `:1952-1965` must be reworked** (volumes-from semantics differ when the daemon is reached
  via a proxy; nested mounts must be re-expressed as explicit binds the proxy allows).
- `Dockerfile.voltron:48-63` -- the `sudo`/`docker` shim becomes **unnecessary** (no socket
  GID problem over TCP); it can be removed, slimming the image. `docker-ce-cli` stays.
- New infra -- a long-lived proxy container plus a private Docker network shared with each
  dispatched agent (new `docker run --network` wiring in dispatch, and lifecycle management
  for the proxy: start, health-check, teardown). `scripts/voltron-run.sh` needs the same.
- The proxy allowlist (env flags like `CONTAINERS=1`, `POST=1`, `EXEC=0`, etc.) plus the
  bind-mount policy become new committed config.
- Docs + tests for the allowed/denied API matrix.

### Effort / Risk

- **Effort: L.** New runtime component, network plumbing, lifecycle management, and a
  delicate allowlist that must permit Voltron's bind shape while blocking abuse.
- **Risk:** Medium-to-high. Easy to either over-restrict (nested dispatch silently breaks
  because a needed endpoint or bind is denied) or under-restrict (bind allowlist wide enough
  to re-enable host escape). The proxy is a new moving part and a new failure mode on every
  dispatch wave.

### Nesting compatibility

Works **only after** the `--volumes-from` path is re-expressed. As written today, nested
dispatch would break under a strict proxy because the inner container's bind-mounts and
volumes-from are exactly what the proxy filters. Achievable, but it is the main cost of this
option, not a free addition. `run_agent_in_docker_batch` works once the underlying create
calls are permitted.

### Residual risk

Even a tuned proxy that allows container-create plus the project bind-mount leaves an agent
able to launch sibling containers that mount `/workspace` and inherit the credentials path;
container-create with bind permission is itself a meaningful primitive. The proxy reduces the
API surface dramatically (no `--privileged`, no `exec`, no arbitrary host binds) but does not
make a nesting agent harmless. Strong **net reduction** in blast radius; not zero.

---

## Option 3: Rootless Docker / Sysbox (Isolate the In-Container Daemon)

### How it works (for Voltron)

Stop sharing the host daemon at all. Two sub-variants:

- **Rootless Docker:** run the host-side Voltron daemon rootless, so the socket the agent
  receives maps to an **unprivileged host user** inside a user namespace. "Root in the
  container" is a non-root UID on the host, so a `--privileged -v /:/host` escape lands in a
  remapped, unprivileged view rather than true host root.
- **Sysbox runtime:** run each agent container with `--runtime=sysbox-runc`, which lets a
  container run its **own** Docker daemon (real Docker-in-Docker, "DinD") without
  `--privileged` and without sharing the host socket. Nested `docker run` then targets the
  container's private daemon; the host daemon is never exposed.

For Voltron, Sysbox fits the nesting model most cleanly: each agent gets a self-contained
inner daemon, so DooD becomes DinD and the host stays out of reach entirely.

### Exact change surface

- **Host setup (outside the repo)** -- install/configure rootless Docker or the Sysbox
  runtime (kernel/namespace prerequisites, `~/.config/docker`, systemd user services, or
  `/etc/docker/daemon.json` runtime registration). This is operator setup, not a code edit,
  and it is the dominant cost. It also raises the bar for every user who runs Voltron.
- `src/index.js:1940-1965` -- for Sysbox, drop the socket bind entirely and add
  `--runtime=sysbox-runc`; each agent runs its own daemon, so `--volumes-from <ownId>` for
  the socket goes away and nested dispatch points at the local daemon. For rootless, the
  socket path moves to the rootless location (e.g. `$XDG_RUNTIME_DIR/docker.sock`) and
  `dockerSocketHostPath` must be derived from the rootless context, not hardcoded
  `/var/run/docker.sock`.
- `Dockerfile.voltron:48-63` -- the `sudo`/`docker` GID shim is **no longer needed** under
  either variant; for Sysbox the image may need a bundled `dockerd` and `docker-ce` (not just
  `docker-ce-cli`) so the inner daemon exists.
- `scripts/voltron-run.sh` -- mirror the runtime flag / rootless socket path; document the
  host prerequisite check.
- Docs -- a substantial setup section; this changes Voltron's "works on a stock Docker
  install" story.

### Effort / Risk

- **Effort: L (largest).** Most of the cost is host/runtime setup and support burden, plus
  bundling an inner daemon (Sysbox) or rewiring the rootless socket path. Touches the same
  fragile dispatch core as the others.
- **Risk:** Medium-to-high, concentrated in portability and support. Rootless Docker has
  known feature gaps and its own 2025 namespace CVE history; Sysbox requires a compatible
  kernel and is an extra runtime users must install. Inner-daemon DinD also adds per-dispatch
  startup cost and disk (nested image pulls).

### Nesting compatibility

**Best of the three, by design.** Sysbox makes nesting first-class: each container nests into
its own daemon with no host exposure, so DooD-as-DinD removes the very thing that makes S1
critical. Rootless preserves the current DooD shape but with a remapped, unprivileged socket.
`run_agent_in_docker_batch` works under both, though batch fan-out under Sysbox multiplies
inner-daemon overhead.

### Residual risk

**Lowest of the three.** Under Sysbox a container escape lands in an isolated inner daemon,
not the host; under rootless it lands as an unprivileged host user. Residual concerns are
kernel/namespace CVEs and runtime-specific bugs rather than "trivially host-root." The cost is
paid in setup complexity and reduced "runs anywhere" portability, not in residual privilege.

---

## Comparison Matrix

| Dimension | Opt 1: Default-Deny + Opt-In | Opt 2: Socket-Proxy | Opt 3: Rootless / Sysbox |
|---|---|---|---|
| What it changes | *Who* gets the socket | *What API* the socket exposes | *What the socket maps to* |
| Effort | **S** | **L** | **L (largest, host setup)** |
| Primary risk | Wave forgets to opt in -> inner dispatch fails | Allowlist too tight (breaks nesting) or too wide (re-enables escape) | Host portability + support burden; runtime install |
| Code surface | `:1941` condition + schema field + 5 template flags | `:1940-1965` rework + new proxy container + network + lifecycle | `:1940-1965` runtime flag/path + Dockerfile inner daemon + host setup |
| Dockerfile shim (`:48-63`) | Unchanged | Removable | Removable |
| Nesting still works? | Yes, for opt-in dispatchers (unchanged path) | Only after `--volumes-from` reworked | Yes (Sysbox: first-class DinD; rootless: remapped socket) |
| Batch dispatch OK? | Yes | Yes, once create calls allowlisted | Yes (Sysbox multiplies inner-daemon overhead) |
| Residual risk | Socket still full host-root **when granted** (now ~5 templates / opt-in waves) | No `--privileged`/`exec`/arbitrary binds, but container-create + project bind remains | Escape contained to inner daemon (Sysbox) or unprivileged user (rootless) |
| Reversibility | Trivial | Moderate | Hard (host-level) |
| Portability impact | None | Low (extra container) | High (changes "stock Docker" story) |

---

## Recommendation (Advisory; The Choice Is Yours)

**Sequence them; do not treat them as mutually exclusive.**

1. **Adopt Option 1 now.** It is an `S`-effort change that removes the socket from ~9 of the
   14 agents that hold it for no reason and makes the remaining grant explicit and auditable.
   It is the highest security-per-effort move and pairs naturally with the S3 confinement
   flags. This alone retires most of S1's *breadth*.
2. **Layer Option 2 (socket-proxy) next** if nested dispatch must stay broadly available to
   untrusted prompts. It cuts the API surface for the agents that still nest, on top of
   Option 1's reduced population.
3. **Reserve Option 3 (Sysbox) for the strongest posture** -- e.g. if Voltron is ever pointed
   at untrusted input, public webhooks, or shared CI (the exact scenario `README.md:287` warns
   against). It is the only option that makes a container escape *not* host-root, but it costs
   the most in setup and portability.

The pivot question is **OD-2: is broad nested DooD a required feature?** If nesting is rare
(the orchestrator fans out from the host anyway), Option 1 alone is nearly sufficient and the
proxy/Sysbox investment is hard to justify. If nesting is core and exposed to untrusted
prompts, escalate toward Option 2 then Option 3. That trade -- security strength vs. setup
complexity vs. preserving nested dispatch -- is the decision this document exists to surface,
and it is yours to make.

---

## References

- Voltron code: `src/index.js:1940-1965` (socket mount + nesting), `:2166-2172` (depth cap),
  `Dockerfile.voltron:23-63` (docker CLI + sudo shim), `README.md:279-287` (disclosure),
  `src/templates.js` (nestable flags), `.claude/commands/scrum-master.md` (host-side dispatch model).
- `planning/tooling-security/upgrade-plan.md` -- S1 finding and OD-1/OD-2.
- External (per upgrade-plan citations): 11notes/Tecnativa docker-socket-proxy; OWASP Docker
  Security Cheat Sheet; Ken Muse, "Rootless Docker and its hidden security trade-offs"; Sysbox docs.
