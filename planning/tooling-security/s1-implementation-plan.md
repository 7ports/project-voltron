# S1 Implementation Plan: Default-Deny Opt-In + Socket-Proxy

> **Status:** Implementation plan. Approved direction, ready for scrum-master decomposition into
> harness-engineer tasks. No code is changed by this document.
> **Decision locked (OD-1):** Adopt **Option 1 (default-deny + opt-in)** first, then layer
> **Option 2 (socket-proxy)** on top. Remove the host Docker socket from agents that do not need
> it; route the agents that do (the genuine nesters) through a filtering socket-proxy that
> allowlists only the Docker API calls Voltron actually uses. **Hard constraint: do not disrupt
> any existing feature** (nested dispatch, `run_agent_in_docker_batch`, `--volumes-from` mount
> inheritance, the shared image-layer cache, host `docker ps` visibility).
> **Grounded in:** `src/index.js` (`dispatchOneAgent` `:1763`, socket mount `:1945-1946`,
> nested `--volumes-from` `:1957-1960`, MCP-config gating `:1909`, `ensureVoltronImage` `:132`,
> depth cap `:2166-2173`, batch tool `:2239-2350`), `Dockerfile.voltron:23-63`,
> `src/templates.js` (nestable flags), and `planning/tooling-security/docker-socket-options.md`.

---

## Overview

Voltron bind-mounts the host Docker socket into every container launched from a `nestable`
template so that an in-container agent can dispatch further agents (Docker-out-of-Docker). The
socket is host-root-equivalent. Two facts make this an over-grant:

1. Of **70 agent templates, 14 are nestable** and receive the socket; only **5** of those ever
   call the dispatch tools. The other **9** hold host-root for nothing.
2. The socket is the *raw* daemon API. Even the 5 genuine nesters only need a tiny slice of that
   API (container create/start/wait/attach/remove, image inspect). They never need `build`,
   `exec`, `--privileged`, swarm, or arbitrary host binds.

Phase A attacks fact 1 (who gets access). Phase B attacks fact 2 (what the access can do). The
two phases are independent and compose: Phase A narrows the population, Phase B narrows the API
surface for the population that remains. Phase A is the quick, low-risk win and ships first.

This plan keeps host-daemon access (now proxied) deliberately, because that access is what
uniquely preserves the **shared image-layer cache** and **host `docker ps` visibility** the
fleet depends on. Sysbox (Option 3) is explicitly out of scope here and is the separate
stronger-posture path tracked under OD-2.

---

## Agent Inventory: Who Keeps Access, Who Loses It

Derived live from `src/templates.js` (agents whose `nestable !== false`):

**Currently nestable (14, all receive the socket today):**
`project-planner`, `scene-architect`, `csharp-dev`, `shader-artist`, `build-validator`,
`asset-manager`, `fullstack-dev`, `devops-engineer`, `ui-designer`, `qa-tester`,
`harness-engineer`, `researcher`, `code-analyst`, `doc-writer`.

**KEEP socket/proxy access after Phase A (the 5 genuine sub-manager dispatchers):**

| Agent | Why it genuinely dispatches |
|---|---|
| `fullstack-dev` | Composes micro-agents (committer, pr-opener, test-runner) for a feature wave |
| `csharp-dev` | Same sub-manager pattern for Unity/C# waves |
| `qa-tester` | Fans out test/validation micro-agents |
| `harness-engineer` | Dispatches micro-agents for multi-file Voltron edits |
| `code-analyst` | Drives batch analysis waves across a codebase |

**LOSE socket access after Phase A (the 9 over-granted templates):**
`project-planner`, `scene-architect`, `shader-artist`, `build-validator`, `asset-manager`,
`devops-engineer`, `ui-designer`, `researcher`, `doc-writer`.
These are research/design/single-file/validation roles. None call `run_agent_in_docker` or
`run_agent_in_docker_batch`; they were flagged `nestable` only as a side effect of the
default-allow rule. The remaining **56** templates already carry `nestable: false` and never
received the socket; they are unaffected.

> Note: `devops-engineer` and `scene-architect` appear in the nestable list but are not in the
> genuine-dispatcher set. If a future wave proves either one truly needs to nest, it opts in via
> the per-call `allow_nested` flag (Phase A) without re-broadening the template default. That is
> the safety valve that makes the narrowing reversible per call.

---

## Phase A: Default-Deny + Opt-In Socket Mount

**Goal:** Mount the socket only for an explicit, auditable set of dispatchers, not for every
nestable template. Highest security-per-effort move; ships independently of Phase B.

### Mechanism

Replace the single broad gate with a two-part **opt-in** rule. The socket mounts only when
`canDispatch && !isNested`, where `canDispatch` is true if **either**:

1. **Template capability flag** `dispatches: true`, set on the 5 sub-manager templates only. This
   is the steady-state default and covers the known recursive roles.
2. **Per-call override** `allow_nested: true`, a new boolean on `run_agent_in_docker` and
   `run_agent_in_docker_batch`, defaulting to `false`. The scrum-master sets it true only for a
   wave it knows will recurse, even for a template without the flag.

So `const canDispatch = (template.dispatches === true) || allow_nested === true;` and the mount
condition at `src/index.js:1946` changes from `(nestable && !isNested)` to
`(canDispatch && !isNested)`. Everything downstream (depth cap, `--volumes-from` inheritance for
genuine nesters, `VOLTRON_HOST_ROOT` propagation) is untouched.

### Tasks (ordered, with file/function anchors)

- **A1. Add the `dispatches` capability flag to templates.** In `src/templates.js`, add
  `dispatches: true` to exactly these 5 entries: `fullstack-dev`, `csharp-dev`, `qa-tester`,
  `harness-engineer`, `code-analyst`. Do not add it to any other template. (Anchor: each
  template object; the 5 currently have no `nestable: false`, so they are nestable today.)
- **A2. Thread `allow_nested` through the dispatch signature.** In `dispatchOneAgent`
  (`src/index.js:1763-1769`), destructure `allow_nested` from `spec` (default `false`). Compute
  `const canDispatch = (template.dispatches === true) || (allow_nested === true);` next to the
  existing `const nestable = template.nestable !== false;` at `:1781`.
- **A3. Change the socket-mount gate.** At `src/index.js:1946`, change
  `const socketMount = (nestable && !isNested) ? [...] : [];` to use `canDispatch` in place of
  `nestable`. This is the single security-critical line of Phase A.
- **A4. Add `allow_nested` to both tool schemas.** In the `run_agent_in_docker` Zod schema
  (`src/index.js:2142-2161`) add `allow_nested: z.boolean().optional().describe("Opt in to
  nested dispatch by mounting the Docker socket. Default false. Set true only for a wave that
  will itself call run_agent_in_docker.")`. Mirror it in each `dispatches[]` entry of
  `run_agent_in_docker_batch` (`src/index.js:2242-2249`). Pass the value into the `spec` object
  handed to `dispatchOneAgent` (`:2192-2196` and the batch `runDispatch` at `:2304-2308`).
- **A5. Gate the nested-MCP-config injection on `canDispatch`.** Today the container-local MCP
  config (which exposes the nested `run_agent_in_docker` tool) is written whenever `nestable` is
  true (`src/index.js:1909`). Change that guard to `canDispatch` so a non-dispatcher cannot even
  see the nested-dispatch tool. This keeps the opt-in coherent: no socket AND no dispatch tool
  for the 9 narrowed roles.
- **A6. Add a clear "socket missing" failure path.** When a nested `run_agent_in_docker` runs but
  no socket is present (a wave that forgot to opt in), the in-container `docker` call fails with a
  raw daemon-connection error. Add a preflight in the tool handler: if `isNested` is false-path
  unreachable, this is fine; the real guard is at dispatch time. Emit guidance in the handler
  result so the orchestrator sees "re-dispatch the parent with allow_nested: true or add
  dispatches:true to the template" rather than a cryptic socket error. (Anchor: the existing
  depth-cap guard at `:2166-2173` is the model for this message.)
- **A7. Tests.** Add a unit/integration assertion (the T3 dispatch-arg suite) that `dockerArgs`
  contains the socket mount **only** when `canDispatch` is true: one case with `dispatches:true`
  template, one with `allow_nested:true` override, one negative case (plain nestable template,
  no opt-in) asserting the mount is absent.

### Phase A verification (no nesting flow breaks)

- A `dispatches:true` template dispatched at top level still gets the socket (mount present in
  `dockerArgs`). Confirm via the A7 test and one live dispatch.
- A genuine nester still recurses: dispatch `fullstack-dev` with a task that calls
  `run_agent_in_docker` for a micro-agent; the child spawns via `--volumes-from` exactly as
  today (that path is unchanged).
- The 9 narrowed templates no longer carry the socket: dispatch `researcher` and assert no
  `docker.sock` bind in `dockerArgs` and no `container-mcp.json` written for it.
- `run_agent_in_docker_batch` of mixed entries: a `dispatches:true` entry gets the socket, a
  plain entry does not, both run to completion. Staggered cache fan-out (`:2318-2348`) is
  untouched.

---

## Phase B: Socket-Proxy (Filter the API Surface)

**Goal:** For the agents that still get daemon access after Phase A, stop handing them the raw
socket. Put a filtering **socket-proxy** sidecar in front of the host daemon and point nesting
agents at it via `DOCKER_HOST`, allowlisting only the calls Voltron makes. Ships after Phase A.

### Mechanism

Run one long-lived proxy container that holds the real `/var/run/docker.sock` and exposes a TCP
endpoint on a private Docker network. Dispatched nesters receive
`DOCKER_HOST=tcp://voltron-socket-proxy:2375` plus `--network voltron-proxy-net` instead of a
socket bind. The in-container `docker` CLI then speaks TCP to the proxy, which forwards only the
allowlisted calls to the host daemon and rejects everything else.

The host-side MCP server (`src/index.js` running on the host) continues to talk to the host
daemon **directly** and is unchanged; it is trusted host code, not an untrusted agent. Only the
in-container `docker` CLI used by nesting agents is rerouted through the proxy.

### The allowlist (derived from the Docker API calls Voltron actually makes)

| Call site in code | Docker API endpoint | Proxy decision |
|---|---|---|
| `checkDockerAvailable` (daemon ping) | `GET /_ping`, `GET /version` | **ALLOW** |
| `ensureVoltronImage` image inspect `:134-138` | `GET /images/voltron-agent/json` | **ALLOW** (images, read) |
| `ensureVoltronImage` build `:148-151` | `POST /build` | **DENY** (rely on shared cache; see B-feature note) |
| `docker run` create `:1980-1991` | `POST /containers/create` | **ALLOW** |
| `docker run` start | `POST /containers/{id}/start` | **ALLOW** |
| `docker run` attach (streamed stdout) | `POST /containers/{id}/attach`, `/wait` | **ALLOW** |
| `--volumes-from <ownId>` resolution `:1959` | `GET /containers/{id}/json` (inspect) | **ALLOW** (containers, read) |
| `--rm` cleanup | `DELETE /containers/{id}` | **ALLOW** |
| host glimpse `docker ps` (host-side only) | `GET /containers/json` | **ALLOW** (read) |
| sibling tamper, escape primitives | `POST /exec`, `/commit`, swarm, networks-create, `POST /build` | **DENY** |

Translated to a Tecnativa-style `docker-socket-proxy` env config (coarse, endpoint-level):
`PING=1`, `VERSION=1`, `IMAGES=1` (read), `CONTAINERS=1` (read), `POST=1` (needed for
create/start), `BUILD=0`, `EXEC=0`, `COMMIT=0`, `SWARM=0`, `NETWORKS=0`, `VOLUMES=0`,
`SERVICES=0`, `SECRETS=0`, `CONFIGS=0`, `PLUGINS=0`, `SYSTEM=0`, `INFO=0`.

> **Key engineering decision (call out for the user):** A coarse endpoint-level proxy (Tecnativa)
> with `POST=1` allows *all* POST bodies, so it cannot by itself reject `--privileged` or a
> `-v /:/host` bind inside `POST /containers/create`. To actually block those request *bodies*
> you need a **body-filtering proxy** (for example `wollomatic/socket-proxy` or
> `11notes/docker-socket-proxy` with allow/deny regex on the create payload). The allowlist above
> assumes the body-filtering variant so that `containers/create` is permitted **only** for
> Voltron's exact mount shape (the `${hostRoot}:/workspace` bind and `--volumes-from`) while
> `--privileged`, `--pid=host`, and binds outside the project are rejected. Choosing the proxy
> image (coarse vs body-filtering) is the first task of Phase B and gates the rest.

### Tasks (ordered, with file/function anchors)

- **B1. Select and pin the proxy image.** Decide between coarse (Tecnativa) and body-filtering
  (`wollomatic/socket-proxy`). The hard constraint "block `--privileged` but allow Voltron's own
  bind" requires body filtering; recommend `wollomatic/socket-proxy` pinned by digest. Record the
  choice and the exact allow/deny regex set as committed config under
  `planning/tooling-security/` or a new `voltron/socket-proxy/` config dir. Update Alexandria with
  a reusable docker-socket-proxy guide (non-project-specific findings only).
- **B2. Proxy lifecycle in the MCP server.** Add `ensureSocketProxy(cwd)` near
  `ensureVoltronImage` (`src/index.js:132`): create the private network `voltron-proxy-net` if
  absent (`docker network create`), then start (or reuse) a long-lived container
  `voltron-socket-proxy` bound to the real socket with the allowlist env, attached to that
  network, with a health check (`GET /_ping` through the proxy). Idempotent: inspect-then-start,
  mirroring `ensureVoltronImage`'s inspect-then-build. Call it once before fan-out in both tool
  handlers (`run_agent_in_docker` `:2189`, batch `:2296`), right after `ensureVoltronImage`.
- **B3. Reroute the outer dispatch from socket bind to proxy.** In `dispatchOneAgent`, when
  `canDispatch && !isNested`, replace `socketMount` (`:1946`) with: attach `--network
  voltron-proxy-net` and inject `-e DOCKER_HOST=tcp://voltron-socket-proxy:2375`. Keep the
  `${hostRoot}:/workspace` bind and other mounts as-is. The socket bind goes away.
- **B4. Propagate proxy reachability to nested children.** The nested branch (`:1957-1960`,
  `isNested`) today inherits the socket via `--volumes-from`. Under the proxy there is no socket
  file to inherit, so add to the nested branch: `--network voltron-proxy-net` and
  `-e DOCKER_HOST=tcp://voltron-socket-proxy:2375`. Add `DOCKER_HOST` to `voltronEnvArgs`
  (`:1948-1953`) for the nested case so the child's in-container `docker` CLI finds the proxy.
  `--volumes-from <ownId>` stays for `/workspace`, tmp, and creds inheritance; only the socket
  dependency is removed from it.
- **B5. Remove the now-unnecessary sudo/docker shim.** With TCP transport there is no socket-GID
  problem, so `Dockerfile.voltron:48-63` (sudo + the `docker` wrapper that re-execs as root) is
  no longer needed and should be removed; keep `docker-ce-cli` (`:23-33`). This slims the image
  and removes a standing root-escalation primitive. Update the build comment to reference the
  proxy. (Documentation rule: update `docs/index.html` and `README.md:279-287` in the same
  commit.)
- **B6. Mirror the proxy wiring in `scripts/voltron-run.sh`.** If the MCP server itself is run in
  a container by that script, ensure it can still reach the host daemon to manage the proxy.
  (Current `voltron-run.sh` has no socket references; confirm the host-run path still works and
  document any new network/proxy prerequisite.)
- **B7. Proxy allow/deny tests + docs.** Add an integration test that asserts an allowed call
  (`containers/create` with Voltron's bind) succeeds and a denied call (`--privileged`, or
  `-v /:/host`, or `docker build`) is rejected through the proxy. Document the allowed/denied API
  matrix in `README.md` and `docs/index.html`.

### Phase B verification

- A nesting agent has **no** `docker.sock` bind and instead has `DOCKER_HOST` + the proxy
  network; confirm in `dockerArgs` and inside a live container.
- Nested dispatch through the proxy still spawns a child (B4 path).
- `docker run --privileged` / `-v /:/host` / `docker build` from inside a nesting container are
  **rejected** by the proxy.
- The shared image cache still hits (image inspect through the proxy returns the host-built image
  fresh, so no rebuild).

---

## Feature-Preservation Checklist

For every existing feature: how the plan keeps it working, and how to test it.

| Feature | Code anchor | How the plan preserves it | How to test |
|---|---|---|---|
| **Nested DooD dispatch** (sub-manager spawns micro-agents) | socket mount `:1946`, child inherits `:1959` | Phase A keeps the socket for the 5 dispatchers + any `allow_nested` wave; Phase B swaps the socket for `DOCKER_HOST`+proxy on both outer (B3) and nested (B4) branches, so the dispatch chain is intact | Dispatch `fullstack-dev` with a task that calls `run_agent_in_docker` for `committer`; assert child container runs and returns |
| **`run_agent_in_docker_batch`** | tool `:2239-2350`, stagger `:2318-2348` | Each batch entry carries its own `allow_nested`; image-ensure and proxy-ensure happen once before fan-out; stagger/cache logic untouched | Run a 3-entry batch mixing a `dispatches:true` agent and two plain agents; assert all complete and only the dispatcher got daemon access |
| **`--volumes-from` mount inheritance** (child reuses `/workspace`, tmp, creds) | `:1957-1960` | Unchanged in Phase A. In Phase B, `--volumes-from <ownId>` stays for filesystem inheritance; only the socket dependency is removed and replaced by `DOCKER_HOST`+network (B4) | In a nested child, assert `/workspace`, `.voltron/tmp`, and creds are visible exactly as before |
| **Shared image-layer cache** (one `voltron-agent` image for the whole fleet) | `ensureVoltronImage` `:132-171` | Preserved by keeping host-daemon access (proxied, not Sysbox-isolated). The proxy ALLOWs image inspect so nested `ensureVoltronImage` finds the host-built image fresh and skips `build`; `POST /build` is DENIED precisely because the cache makes it unnecessary | Time a cold top-level build, then a nested dispatch; assert the nested run does **not** rebuild (inspect hits, no `POST /build`) |
| **Host `docker ps` glimpse visibility** | all containers on the one shared host daemon | Preserved: every container is still created on the host daemon (top-level directly by the MCP server, nested via the proxy that forwards to the same host daemon), so `voltron-*` containers including nested ones remain host-visible | On the host, run `docker ps` during a nested wave; assert nested `voltron-*` containers appear |
| **Depth cap (3) + `VOLTRON_HOST_ROOT` propagation** | `:2166-2173`, env `:1948-1953` | Untouched by both phases | Attempt a 4th-level dispatch; assert the existing depth-cap refusal still fires |
| **GitHub auth / creds bootstrap** | `:1972-1978`, creds mount `:1894` | Untouched; not socket-dependent | Dispatch a publish agent; assert `git push` still authenticates |

---

## Sequencing and Dependencies

```
Phase A (default-deny + opt-in)   <- ships first, S-effort, low risk
  A1 template dispatches flags
  A2 thread allow_nested  ──┐
  A3 socket-mount gate      ├─ A2 must land before A3/A5 (canDispatch source)
  A4 tool schemas        ───┘
  A5 MCP-config gate (depends A2)
  A6 socket-missing message
  A7 tests (depends A1-A5)
        │
        ▼  Phase A merged + verified before Phase B starts
Phase B (socket-proxy)            <- ships second, L-effort, medium risk
  B1 choose/pin proxy image  ── gates B2-B7 (coarse vs body-filtering)
  B2 ensureSocketProxy lifecycle (depends B1)
  B3 outer dispatch -> proxy (depends B2)
  B4 nested dispatch -> proxy (depends B3)
  B5 remove sudo/docker shim (depends B3/B4 proven; image change)
  B6 voltron-run.sh mirror (depends B2)
  B7 allow/deny tests + docs (depends B3-B5)
```

Phase A is fully shippable and valuable on its own (it retires most of S1's breadth by removing
the socket from 9 of 14 agents). Phase B is gated on Phase A being merged and verified, and B1
(proxy image choice) gates the rest of B. Each lettered task is sized for a single
harness-engineer dispatch with the anchors above.

---

## Validation Strategy (proving the four claims)

- **(a) A non-nesting agent no longer has the socket.** Dispatch `researcher` (one of the 9
  narrowed roles). Assert `dockerArgs` contains no `type=bind,...docker.sock` entry (Phase A) and
  no `DOCKER_HOST`/proxy network (Phase B), and that no `container-mcp.json` is written for it
  (A5). Inside the live container, `docker ps` fails with no-daemon, confirming zero access.
- **(b) Nested dispatch still works.** Dispatch `fullstack-dev` (a `dispatches:true` template)
  with a task that itself calls `run_agent_in_docker` for a micro-agent. Assert the child
  container is created, runs, and returns, and that `VOLTRON_DEPTH` increments correctly. Run
  once under Phase A (socket path) and again under Phase B (proxy path).
- **(c) A disallowed Docker API call is blocked by the proxy.** From inside a nesting container,
  run `docker run --privileged ...`, `docker run -v /:/host ...`, and `docker build .`. Assert
  each is rejected by the proxy (403/denied) while a normal `docker run` of `voltron-agent`
  succeeds. This is the B7 test.
- **(d) The shared cache still hits.** Trigger a top-level build, then a nested dispatch. Assert
  `ensureVoltronImage`'s inspect returns the host-built image as fresh (no rebuild) inside the
  nested run, and that the proxy logged an allowed image-inspect and **no** `POST /build`.

Add these as committed tests where feasible (T3 dispatch-arg assertions for a/b mount shape; an
integration harness for c/d that needs a live Docker daemon). Where a check requires a live
daemon the CI cannot provide, mark it as a manual gate in the task's acceptance criteria and hand
off to a human/qa-tester run rather than silently skipping.

---

## Risks and Rollback

| Risk | Likelihood | Mitigation | Rollback |
|---|---|---|---|
| A wave expected to nest but forgot to opt in -> inner dispatch fails | Medium | A6 clear "re-dispatch with allow_nested" message; the 5 known dispatchers carry `dispatches:true` so common waves are covered | Per-call: add `allow_nested:true`. Global: revert A3 gate to `nestable` |
| Coarse proxy (`POST=1`) still allows `--privileged` in the create body | Medium-High | B1 selects a body-filtering proxy; B7 explicitly tests `--privileged` is rejected | If body filtering proves too brittle, fall back to coarse proxy (still blocks exec/build/swarm) and document residual risk; ultimate fallback is Phase A alone |
| Proxy allowlist too tight -> nested create/`--volumes-from` silently breaks | Medium | Allowlist derived directly from the code's call sites (table above); B7 positive test asserts a normal nested run succeeds | Widen the specific endpoint, or revert B3/B4 to the socket bind while keeping Phase A |
| Proxy becomes a new single point of failure / lifecycle bug | Medium | B2 health-checks the proxy before fan-out and is idempotent (inspect-then-start) | Disable proxy wiring (feature flag / env) to fall back to Phase A socket bind |
| Removing the sudo/docker shim breaks an unforeseen in-container `docker` use | Low | B5 lands only after B3/B4 prove TCP transport works end to end | Restore `Dockerfile.voltron:48-63` from git |
| Shared cache regression (nested rebuilds) | Low | Feature-preservation test (d); proxy ALLOWs image inspect by design | Re-allow `POST /build` on the proxy as a stopgap |

**Reversibility:** Phase A is trivially reversible (one condition + flags + schema field). Phase B
is moderately reversible (revert the dispatch wiring to the socket bind and restore the shim);
the proxy container and network are additive infrastructure that can be torn down without code
changes. Both phases are guarded so that a failure in Phase B does not regress Phase A's gains.

---

## Open Questions (need human input before Phase B)

1. **Proxy image choice (B1):** body-filtering (`wollomatic/socket-proxy`, blocks `--privileged`
   in the create body) versus coarse endpoint proxy (Tecnativa, simpler but cannot block
   `--privileged`). The hard "block privileged but allow Voltron's own bind" constraint argues for
   body filtering; confirm before B2.
2. **`devops-engineer` / `scene-architect`:** confirmed as non-dispatchers and narrowed in Phase
   A? If either is expected to nest in normal operation, decide whether to give it `dispatches:true`
   or rely on per-call `allow_nested`.
3. **Proxy scope vs host glimpse:** the glimpse `docker ps` runs host-side and is unaffected, but
   if any in-container tooling is later expected to call `docker ps`/`docker stats` through the
   proxy, the allowlist must add read endpoints; flag any such future need now.

---

## References

- `planning/tooling-security/docker-socket-options.md` (Options 1/2/3, layering, host-daemon
  feature analysis).
- `src/index.js`: `dispatchOneAgent` `:1763`, socket mount `:1945-1946`, nested `--volumes-from`
  `:1957-1960`, MCP-config gating `:1909`, `voltronEnvArgs` `:1948-1953`, `ensureVoltronImage`
  `:132-171`, depth cap `:2166-2173`, `run_agent_in_docker` `:2139-2199`,
  `run_agent_in_docker_batch` `:2239-2350`.
- `Dockerfile.voltron:23-33` (docker-ce-cli), `:48-63` (sudo/docker shim).
- `src/templates.js` (nestable flags; 14 nestable, 5 genuine dispatchers).
- External: `wollomatic/socket-proxy`, `11notes/docker-socket-proxy`, Tecnativa
  `docker-socket-proxy`; OWASP Docker Security Cheat Sheet.
