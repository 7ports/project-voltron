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

## Layering Sysbox + socket-proxy

**Short answer for Voltron: in the design Option 3 actually proposes (drop the host socket,
DooD -> DinD), they are effectively one-or-the-other, not a useful stack. They live at
different layers and *could* compose in the abstract, but in Voltron's topology a host-side
proxy guards a door no agent walks through once Sysbox is in.**

### 1. Same layer or different? Different.

They protect different things and do not overlap:

- **Socket-proxy = an API-surface filter.** It sits in front of *a* daemon and allowlists
  which Docker API calls reach it (permit `containers/create`/`start`/`wait`/`DELETE`, deny
  `--privileged`, `exec`, arbitrary host binds, build, swarm). It does not change what the
  daemon *is* or what root means; it narrows the verbs.
- **Sysbox = a runtime swap.** It changes how the agent container runs so the nested
  container talks to its **own isolated `dockerd`** instead of the host daemon at all. It
  does not filter API calls; it removes the host daemon from the path and makes a container
  escape land in an unprivileged, host-isolated namespace rather than as host root.

So one cuts *which calls* reach a daemon; the other changes *which daemon, at what
privilege*. Orthogonal axes -- which is exactly why "can I layer them?" is a fair question.

### 2. Is a host-proxy still in the path under Sysbox? No -- it goes moot.

This is the decisive point for Voltron. Today the danger is the host socket bind at
`src/index.js:1940-1941` plus its `--volumes-from` inheritance down the ~5 real nesters
(`fullstack-dev`, `csharp-dev`, `qa-tester`, `harness-engineer`, `code-analyst`). Option 3
Sysbox **removes that bind entirely** (`:1940-1965` drops the socket mount, adds
`--runtime=sysbox-runc`) and nested `docker run` retargets the container's private daemon.
Once that is true, the host daemon is no longer reachable from any agent, so a **host-side**
socket-proxy is filtering traffic that no longer exists. It does not add a second wall; it
guards an empty corridor. That is the "moot" case: belt-and-suspenders with no second belt.

Conversely, what residual risk does each still cover if you pick only one?

- **Proxy alone (host daemon still shared):** cuts the API surface so a compromised agent
  cannot `--privileged`, `exec` into siblings, or bind arbitrary host paths. But per Option 2's
  residual-risk note, `containers/create` + the `/workspace` bind it must still permit is
  itself a real primitive, and an escape that the daemon honors is still *host* root. Proxy
  does **not** contain a daemon-level escape.
- **Sysbox alone:** an escape lands in the inner daemon / unprivileged user, never host root.
  But within that private daemon the nested agent can still issue any Docker call it likes
  (`--privileged`, mount its sandbox, spawn siblings) -- Sysbox does **not** filter API verbs,
  it only bounds the blast radius to the sandbox.

### 3. Recommendation: redundant for the host path, complementary only if relocated.

They are **not** complementary as "host-proxy + Sysbox." They become complementary only if you
**move the proxy in front of the inner daemon** -- i.e. run the socket-proxy *inside* the
Sysbox sandbox so the nested agent's calls to its own private `dockerd` are also API-filtered.
That stack buys exactly one extra thing: it caps what a nested child can do *within its
already-host-isolated sandbox* (limiting sibling-to-sibling moves among one agent's own
nested children). Given Sysbox has already cut the escape down from "host root" to
"unprivileged, sandbox-local," that increment is low-value for Voltron's threat model.

**Decision rule:**

- **Pick one (they are alternatives), if** you are solving the S1 host-socket grant. Sysbox if
  the goal is "an escape must not be host-root"; proxy if you must keep DooD against the shared
  host daemon but want its verbs narrowed. Do not pay for both to protect the same host path.
- **Layer them, only if** (a) you run a **hybrid** where some flows still reach the host daemon
  (e.g. partial migration, or rootless rather than full Sysbox-DinD) -- then a host-proxy
  still has live traffic to filter and Sysbox/rootless covers the escape it cannot; or (b) you
  specifically want API limits on the **inner** daemon, in which case the proxy belongs inside
  the sandbox, not on the host.
- **Otherwise it is belt-and-suspenders with no benefit:** full Sysbox-DinD + host-proxy =
  the proxy filters a path nothing uses.

This refines the sequenced recommendation above: Option 2 then Option 3 is a sensible
*migration order*, but the **end state is one mechanism**, not both running against the host
daemon. Option 1 (default-deny) composes cleanly with either and should be kept regardless --
it reduces *who* nests, which is orthogonal to both the proxy and Sysbox.

---

## Direct benefit of host-daemon access (and the proxy)

> Answers the user's question directly: if Voltron keeps in-container access to the **host**
> daemon (raw or proxied) instead of going to full Sysbox-DinD (each agent runs its own inner
> daemon), what feature does it actually gain? Grounded in the real socket wiring
> (`src/index.js:1945-1968`) and the Glimpse roadmap (`planning/glimpse-integration/upgrade-plan.md`).

### 1. Existing features that depend on in-container host-daemon access

| Capability today | Where in code | Needs the **host** daemon, or any daemon? | Survives Sysbox-DinD? |
|---|---|---|---|
| Nested DooD dispatch (sub-manager spawns micro-agents) | socket mount `:1946`; child inherits via `--volumes-from <ownId>` `:1959` | The *act* of nesting needs **a** daemon, not the host one | **Yes** as DinD: child lands in the sub-manager's own inner daemon instead of the host one |
| `--volumes-from <ownId>` mount inheritance (child reuses `/workspace`, tmp, creds, socket of parent) `:1957-1960` | parent and child must be **on the same daemon** to reference a container by ID | **Host-coupled today** | **No, as written.** Inner daemon does not know the parent container; the `/workspace` bind must be re-expressed as an explicit bind from the agent's own filesystem (the rework Option 3 already flags at `:215-220`) |
| One shared, pre-built `voltron` image + layer cache for the **whole fleet** | `ensureVoltronImage` builds once on the host; every top-level **and** nested container reuses the cached image with no re-pull | **Host daemon** (single shared image store) | **No.** Each agent's inner daemon starts with an empty store, so nested runs re-pull/rebuild (the per-dispatch "nested image pulls" cost called out at Option 3 residual-risk `:237`) |
| Flat, host-visible container namespace: host `docker ps` sees every `voltron-*` container, nested ones included | all containers are created on the one shared host daemon | **Host daemon** | **No for nested.** Top-level agent containers stay host-visible (Sysbox is just their runtime), but **nested** children move into per-agent inner daemons and vanish from host `docker ps` |

Net: the only thing that *strictly requires* the host daemon is the **shared image cache** and the
**single flat container namespace**. Nesting itself (the headline DooD feature, and OD-2's subject)
does **not** require the host daemon; Sysbox-DinD preserves it.

### 2. Future features uniquely enabled by host-daemon access

Evaluated concretely against Voltron's roadmap:

| Candidate future feature | Needs host daemon specifically? | Notes for Voltron |
|---|---|---|
| **Shared image-layer cache across agents** (faster cold builds) | **Yes** | An inner daemon can only share if you bolt on a pull-through registry or a shared overlay. On the host it is free. Directly addresses the Chromium-build pain in the tooling roadmap: a heavy image built once is reused by all; under Sysbox every inner daemon rebuilds it |
| **Glimpse node liveness for nested containers via host `docker ps`** | **Yes** for the *nested* tier | Glimpse polls the host daemon for `voltron-*` (`glimpse upgrade-plan.md:16,57,100`). The planned `dispatches.jsonl` makes *edges* authoritative under either runtime, but **node liveness still comes from `docker ps`** (`:57,100`). Under Sysbox-DinD nested nodes leave the host daemon, so Glimpse loses live presence for them (it would see edges with no live node) |
| **Cross-agent visibility / attach / `exec` / `logs` into a sibling agent** | **Yes** | Sibling containers exist only on a shared daemon. Under Sysbox each agent sees only its own inner-daemon children, never another agent's |
| **Host resource/quota visibility** (`docker stats`, `system df` over the fleet) | **Yes** | An inner daemon only reports its own slice |
| **Reuse one warm base image / warm container** | **Yes** | Host keeps one warm image for all dispatches; inner daemons cold-start per agent |
| Depth-bounded recursion, build-and-run an image, run micro-agents | **No** | An inner daemon does all of this; only the *sharing* across the fleet is host-specific |

The pattern: host-daemon access uniquely buys **fleet-wide sharing and observability** (one image
store, one `docker ps`, sibling reachability). It does **not** uniquely buy the ability to nest.

### 3. The direct benefit of the proxy specifically

**None that is a capability.** A socket-proxy is a pure *risk-reduction wrapper* around host-daemon
access you would otherwise grant raw. It cannot enable anything that default-deny or Sysbox cannot;
it only **narrows the verbs** reaching the host daemon. If anything it is in tension with section 2:
a strict allowlist that blocks `exec`, `attach`, and `stats` (Option 2 denies exactly these, `:140`)
removes the cross-agent-visibility and host-stat features that are the main reason to want host
access at all. So the proxy is justified **only** if you have already decided to keep host-daemon
access for the features in (1)/(2) and want its blast radius cut. It is a wrapper, not a feature.

### 4. Bottom line (ties to OD-2)

Is there a direct, feature-driven reason to keep host-daemon access (proxied) rather than isolate
with Sysbox? **Yes, but a narrow and optimization-shaped one, not a correctness one.**

- **Broad nested DooD is *not* a required capability in the sense OD-2 asks.** The orchestrator
  fans out flat from the host (scrum-master runs on the host, not in a container), so the fleet is
  mostly top-level and host-visible **regardless** of runtime. Genuine in-container recursion is
  rare (~5 sub-manager roles) and Sysbox-DinD preserves it. Nesting alone does not justify host
  coupling.
- **What host-daemon access uniquely enables and Sysbox would not** is **fleet-wide sharing and
  observability**: a single shared `voltron` image/layer cache and one flat host `docker ps` that
  covers nested children too. The **single most important** is the **shared image-layer cache** -
  it directly attacks the cold-build / Chromium-build cost and the per-dispatch inner-daemon pull
  penalty that Sysbox would reintroduce. The runner-up is **host-visible nested-container liveness
  for Glimpse**, which Sysbox-DinD breaks while the `dispatches.jsonl` edge log keeps working.
- **The proxy adds zero features.** It is a safety wrapper around access kept for the above.

Therefore: keep host-daemon access only if the shared-image-cache speedup and whole-fleet Glimpse
visibility are judged worth the residual risk; if they are, a proxy is the right way to hold that
access safely. If they are not, Sysbox loses nothing that OD-2 calls "required" - it costs you the
cache and nested-container `docker ps` visibility, and nothing else.

---

## References

- Voltron code: `src/index.js:1940-1965` (socket mount + nesting), `:2166-2172` (depth cap),
  `Dockerfile.voltron:23-63` (docker CLI + sudo shim), `README.md:279-287` (disclosure),
  `src/templates.js` (nestable flags), `.claude/commands/scrum-master.md` (host-side dispatch model).
- `planning/tooling-security/upgrade-plan.md` -- S1 finding and OD-1/OD-2.
- External (per upgrade-plan citations): 11notes/Tecnativa docker-socket-proxy; OWASP Docker
  Security Cheat Sheet; Ken Muse, "Rootless Docker and its hidden security trade-offs"; Sysbox docs.
