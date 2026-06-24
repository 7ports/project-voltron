# OPA AuthZ Plugin vs Proxy-Only: Installation & Distribution Impact (S1 Phase B)

Topic: opa-distribution-impact
Author: code-analyst (read-only analysis)
Date: 2026-06-24
Question: What are the consequences for INSTALLATION and DISTRIBUTION of Voltron if Phase B adds a daemon-side OPA AuthZ plugin (to block `--privileged` / `--pid=host`), versus the proxy-only option (no daemon plugin)?

---

## How Voltron is installed / distributed TODAY

Established from `README.md` (Installation/Docker sections), `package.json`, `scripts/setup.js`, `scripts/voltron-run.sh`, `Dockerfile.voltron`, and `src/index.js` (`ensureVoltronImage`, the dispatch path around `:1972-2000`, `get_auto_update_hook`, `setup_voltron`):

- **Pure user-space MCP server.** Install is `git clone` + `node scripts/setup.js`. Setup does three things only, all in the user's home dir: `npm install` (deps are just `@modelcontextprotocol/sdk` + `yaml`), `claude mcp add --scope user project-voltron -- node <path>` to register the server in `~/.claude` settings, and an allowlist merge into `~/.claude/settings.json`. Then "restart Claude Code." No system packages, no services.
- **The agent image is built locally on first dispatch.** `ensureVoltronImage` (`src/index.js:132`) runs `docker build -t voltron-agent -f Dockerfile.voltron` lazily (cached by Dockerfile mtime). The user never pulls or configures anything by hand; the MCP server shells out to the Docker the user already has.
- **Agents run as throwaway containers on the user's EXISTING Docker daemon.** Dispatch is plain `docker run --rm` (`src/index.js:2010+`) against the stock daemon. Voltron never installs, configures, or restarts `dockerd`. `setup.js` only probes `docker --version` and prints a "install Docker Desktop" hint if absent.
- **Zero host-daemon reconfiguration.** Nothing in the install touches `/etc/docker/daemon.json`, registers a runtime, or requires host root. The only socket interaction is a bind-mount of the existing `/var/run/docker.sock` into dispatcher agents (S1 Phase A made this default-deny, gated on the agent's `run_agent_in_docker` grant; `src/index.js:1976`).
- **Self-provisioning at runtime via the Docker API it already uses.** Image build, container creation, mounts, env injection, the per-run `container-settings.json` / `container-mcp.json`, and `--volumes-from` for nested dispatch are all created on the fly by the MCP server through the same Docker socket. No new host artifacts persist.
- **Updates are user-space too.** `get_auto_update_hook` installs a `UserPromptSubmit` hook that rewrites agent `.md` files / `Dockerfile.voltron` / `voltron-run.sh` in place; `setup_voltron` re-verifies the allowlist from inside a session. All file-level, no privilege.

**Net: Voltron today is a drop-in, zero-host-config MCP server. The strongest privilege it asks for is a bind-mount of a socket that already exists. It runs unmodified on Docker Desktop (Windows/macOS) and native Linux dockerd alike.**

---

## Phase B Option A: PROXY-ONLY (wollomatic/socket-proxy sidecar, no daemon plugin)

Per `planning/tooling-security/s1-implementation-plan.md` (Phase B, B1-B7) and `docker-socket-options.md` (Option 2), the proxy-only design is:

- A long-lived `voltron-socket-proxy` container (body-filtering proxy, e.g. `wollomatic/socket-proxy` pinned by digest) bound to the real `/var/run/docker.sock`, with an allow/deny ruleset that rejects `--privileged`, `--pid=host`, and binds outside the project on the `containers/create` body.
- A private `voltron-proxy-net` Docker network.
- Dispatcher agents get `-e DOCKER_HOST=tcp://voltron-socket-proxy:2375` + `--network voltron-proxy-net` instead of a raw socket bind.

**New install steps for the end user: effectively none.** Both the proxy container and the private network are ordinary Docker objects creatable at runtime by the MCP server through the **same Docker API it already drives** for `docker build` / `docker run`. This mirrors exactly how Voltron already self-provisions the agent image and per-run config files. No host-root config, no `dockerd` restart, no daemon edit, no second install command. The only distributable change is a few KB of proxy config plus a pinned image reference; the proxy image pulls on first use like any base image.

**Install/distribution burden: LOW (≈2/5).** It adds one always-on container and a network to a user's machine, but provisioning stays inside Voltron's existing capability envelope. The zero-host-config story is preserved. Works identically on Docker Desktop/Windows and native Linux because it relies only on the user-facing Docker API.

---

## Phase B Option B: PROXY + DAEMON-SIDE OPA AuthZ PLUGIN

A Docker authorization (AuthZ) plugin is a fundamentally different integration point from anything Voltron touches today. It is not a container Voltron can `docker run`; it is a daemon extension that `dockerd` itself loads and calls on every API request. Concretely, enabling one requires:

- **Editing the host `/etc/docker/daemon.json`** (the `"authorization-plugins"` array) or passing `--authorization-plugin` to `dockerd`. This is a host-root file outside any project and outside Voltron's reach via the Docker API. (Already flagged as "operator setup, not a code edit" in `docker-socket-options.md:213`.)
- **A `dockerd` RESTART** to load the plugin. Restarting the daemon **kills/stops all running containers** on that host (including any other work the developer has running), and is itself a root operation (`systemctl restart docker` / restarting Docker Desktop).
- **The plugin running as a privileged host-level service** — either a managed Docker plugin or a host daemon/socket-activated service registered with the daemon. OPA's `opa-docker-authz` is itself distributed as a Docker plugin / host service that the daemon talks to over a plugin socket. It is long-lived host infrastructure, not a throwaway sidecar.
- **Root on the host** for every one of the above (write `/etc/docker/daemon.json`, install/enable the plugin, restart the daemon). None of it is auto-provisionable by the unprivileged MCP server via the Docker API; the Docker API deliberately cannot register its own AuthZ plugin (that would defeat the control).

### Cross-platform crux: Docker Desktop (the user is on Windows)

This is where Option B breaks hardest:

- **Docker Desktop (Windows/macOS) does not expose a user-editable daemon for AuthZ plugins.** `dockerd` runs inside a Docker-managed LinuxKit/WSL2 VM. The `daemon.json` surfaced in Docker Desktop settings does **not** support the `authorization-plugins` field in any supported way, and there is no supported path to install a host AuthZ plugin into the managed VM. AuthZ plugins are a **native-Linux-dockerd feature in practice.**
- The user in this engagement is on **Windows** (WSL2 Docker Desktop). For them Option B is not merely a heavier install — it is **not viable on their platform at all** without abandoning Docker Desktop for a self-managed Linux dockerd.
- Even on native Linux, requiring users to hand-edit `daemon.json` and restart the daemon is a support-and-blast-radius liability (a typo in `daemon.json` can make `dockerd` fail to start).

**Install/distribution burden: HIGH (5/5).** Option B converts the install from "register an MCP server" into "reconfigure (and on Windows, replace) your Docker daemon as root."

---

## Comparison Table

| Dimension | Current | Proxy-only (A) | Proxy + OPA AuthZ (B) |
|---|---|---|---|
| New artifacts | none (agent image built locally) | 1 long-lived proxy container + 1 private network + pinned proxy config | proxy container/network **+** host AuthZ plugin service **+** `daemon.json` edit |
| Host `daemon.json` edit? | No | No | **Yes (required)** |
| `dockerd` restart? | No | No | **Yes (kills running containers)** |
| Host root required? | No (socket bind only) | No | **Yes** |
| Docker Desktop / Windows viable? | Yes | Yes | **No / unsupported** (managed VM, no AuthZ plugin path) |
| Runtime auto-provisionable by the MCP server? | Yes (build + run via Docker API) | **Yes** (container + network via same Docker API) | **No** (daemon extension; API cannot self-register a plugin) |
| Distribution burden (1-5) | 1 | **2** | **5** |

---

## BOTTOM LINE

A daemon-side OPA AuthZ plugin is **fundamentally incompatible with Voltron's current zero-host-config distribution model**, while the proxy-only option preserves it almost perfectly. Everything Voltron installs today lives in user space and is auto-provisioned at runtime through the ordinary Docker API the user already has; the socket-proxy sidecar plus private network fit entirely inside that envelope and can be stood up by the MCP server with no new install step, no host root, no `daemon.json` edit, and no `dockerd` restart, on Docker Desktop and native Linux alike. An AuthZ plugin, by contrast, is a daemon extension that the Docker API cannot register on its own: it demands a host-root edit to `/etc/docker/daemon.json`, a daemon restart that tears down all running containers, and a privileged long-lived host service, and it is effectively unsupported on Docker Desktop, which is exactly the platform this Windows user runs. Adopting Option B would turn Voltron from a drop-in MCP server into a "reconfigure your Docker daemon" product and would strand Docker Desktop users entirely. Recommendation: pursue the proxy-only path for Phase B; treat OPA/AuthZ only as an optional, documented hardening step for advanced native-Linux operators, never as a required part of the install.
