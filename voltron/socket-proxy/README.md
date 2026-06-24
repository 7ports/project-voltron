# Voltron Docker socket-proxy (S1 Phase B, Task B1)

Selection, pinning, and exact allow/deny ruleset for the Docker socket-proxy
sidecar that fronts the real Docker daemon for nesting Voltron agents.

## TL;DR

- **Image:** `wollomatic/socket-proxy`, pinned **by digest** (tag `1.12.2`).
- **Config format:** there is **no JSON/YAML config file**. wollomatic is
  configured purely by command-line flags or `SP_*` environment variables.
  The two artifacts in this directory are the real config:
  - `docker-compose.socket-proxy.yml` (flag form, canonical)
  - `socket-proxy.env` (env-var form, identical ruleset)
- **Body filtering:** wollomatic does limited body inspection. It enforces
  **bind-mount sources** (`-allowbindmountfrom`) on `POST /containers/create`.
  It does **NOT** inspect `Privileged` or `PidMode`. See the honest correction
  below and the optional `opa-authz/voltron-authz.rego` for that gap.

## Pinned image

| Field | Value |
|---|---|
| Repository | `wollomatic/socket-proxy` |
| Tag | `1.12.2` (latest stable, released 2026-06-09) |
| Manifest-list digest | `sha256:ad9df81849436b5ddae36396e2aefd6562d4cd587d1b65fcb5ac71e4578c9da3` |
| amd64 digest | `sha256:97056713dfb49f32e140fa23a7ad412552c8d4b600a3284438dfad4ae45c35a0` |
| arm64 digest | `sha256:271737ed139cf3a8bf6fbeb4a761f2712007018cf1357d1238008ff775cff2ff` |
| arm/v7 digest | `sha256:792d6134dde233beb0c2c19eb48d7e32fd27b2522a1505b5c5a5bf33c4fc7e12` |

Pin in compose with the manifest-list digest (multi-arch safe):

```
image: wollomatic/socket-proxy:1.12.2@sha256:ad9df81849436b5ddae36396e2aefd6562d4cd587d1b65fcb5ac71e4578c9da3
```

> Digest resolution: read from the Docker Hub registry for tag `1.12.2` on
> 2026-06-24. Before shipping, re-verify with
> `docker buildx imagetools inspect wollomatic/socket-proxy:1.12.2` (or
> `docker pull` then `docker inspect --format '{{index .RepoDigests 0}}'`),
> since a maintainer could in principle overwrite a tag. If your verification
> returns a different digest, trust your live result over this document.

## Why wollomatic over Tecnativa (and an honest correction)

The S1 decision is to use a body-filtering proxy rather than a coarse one. The
practical reality, confirmed against the upstream README and source:

- **Tecnativa/docker-socket-proxy** is coarse. It is HAProxy with per-section
  ACLs. To allow container creation you set `POST=1`, which opens the entire
  `POST` surface. It cannot look inside the `POST /containers/create` body, so
  it cannot distinguish a benign create from one requesting `Privileged: true`
  or a host bind. With `POST=1` an agent can mount `/` and escape.

- **wollomatic/socket-proxy** is finer in two ways:
  1. **Per-method, per-path regex allowlist** (secure-by-default: anything not
     explicitly allowed is denied). This already lets us allow
     `POST /containers/create` while denying `POST /build`, `/commit`,
     `/containers/<id>/exec`, `/networks/create`, `/volumes/create`, swarm,
     etc., which Tecnativa's section toggles cannot express at this
     granularity.
  2. **Bind-mount source body inspection** via `-allowbindmountfrom`
     (added in v1.8). For container-create requests it parses the body and
     rejects any bind whose host source is outside the allowed directory list,
     covering both `-v host:container` (`Binds`) and the modern `Mounts`
     syntax. This is genuine request-body filtering that Tecnativa with
     `POST=1` cannot do.

**Honest correction to the task premise.** wollomatic's body filtering is
limited to bind-mount sources. It does **NOT** inspect or reject
`HostConfig.Privileged`, `HostConfig.PidMode`, capabilities, or device mounts.
No off-the-shelf Docker socket *proxy* (wollomatic, Tecnativa, linuxserver)
filters those fields. The only mechanism in the Docker ecosystem that inspects
arbitrary `HostConfig` body fields is a **daemon-side authorization (AuthZ)
plugin** (OPA, Casbin, Prisma/Twistlock). That is a different control surface
(it runs in `dockerd`, not as a sidecar) and it carries its own bypass
(CVE-2026-34040, see threat model). So:

- The bind-source half of the Voltron create-body spec (`Binds` limited to the
  workspace, no `:/host`, no root `/` source) **is** enforced by the proxy via
  `-allowbindmountfrom`.
- The `Privileged == false` and no-`PidMode=host` half is **not** enforceable
  by the proxy. To meet it you must add the optional OPA AuthZ plugin
  (`opa-authz/voltron-authz.rego`) on the host daemon, or accept the residual
  risk documented below.

This is reported as a gap rather than papered over: there is no wollomatic flag
or config syntax that rejects `Privileged` in the body, so none was invented.

## Role in Voltron

```
            real socket (rw, host only)
 dockerd ───/var/run/docker.sock───► voltron-socket-proxy  (this sidecar)
                                         │  allowlist + bind-source filter
                                         │  listens tcp 0.0.0.0:2375
                       voltron-proxy-net │  (private, internal: true)
            ┌────────────────────────────┼────────────────────────────┐
            ▼                            ▼                             ▼
     nesting agent A              nesting agent B               nesting agent C
   DOCKER_HOST=tcp://             DOCKER_HOST=tcp://            DOCKER_HOST=tcp://
   voltron-socket-proxy:2375      voltron-socket-proxy:2375     ...
   (NO docker.sock bind)          (NO docker.sock bind)
```

- The proxy is a **long-lived sidecar**. It is the only container that
  bind-mounts the real `/var/run/docker.sock`.
- It exposes the filtered API at `tcp://voltron-socket-proxy:2375` on the
  private network **`voltron-proxy-net`** (`internal: true`, no host/internet
  route).
- Nesting agents get **`DOCKER_HOST=tcp://voltron-socket-proxy:2375`** instead
  of a socket bind. Agents never see `/var/run/docker.sock`.

## The allowlist (what each rule is for)

Secure-by-default: socket-proxy denies anything not explicitly allowed, and
auto-anchors every path regex with `^` and `$`. Matching includes the query
string, so rules end with `(\?.*)?` where the endpoint takes query params. The
optional `(/v1\.[0-9]{1,2})?` prefix covers both versioned (`/v1.47/...`) and
unversioned calls.

| Method | Path regex | Purpose |
|---|---|---|
| GET | `(/v1\.[0-9]{1,2})?/_ping` | daemon liveness ping |
| GET | `(/v1\.[0-9]{1,2})?/version` | API/version negotiation |
| GET | `(/v1\.[0-9]{1,2})?/images/.+/json(\?.*)?` | image inspect (read) |
| GET | `(/v1\.[0-9]{1,2})?/containers/json(\?.*)?` | list containers (host glimpse, `--volumes-from` resolution) |
| GET | `(/v1\.[0-9]{1,2})?/containers/[a-zA-Z0-9][a-zA-Z0-9_.-]*/json(\?.*)?` | inspect one container (`--volumes-from` resolution) |
| POST | `(/v1\.[0-9]{1,2})?/containers/create(\?.*)?` | create (bind sources filtered by `-allowbindmountfrom`) |
| POST | `(/v1\.[0-9]{1,2})?/containers/[a-zA-Z0-9][a-zA-Z0-9_.-]*/start(\?.*)?` | start container |
| POST | `(/v1\.[0-9]{1,2})?/containers/[a-zA-Z0-9][a-zA-Z0-9_.-]*/attach(\?.*)?` | attach to stdio |
| POST | `(/v1\.[0-9]{1,2})?/containers/[a-zA-Z0-9][a-zA-Z0-9_.-]*/wait(\?.*)?` | wait for exit |
| DELETE | `(/v1\.[0-9]{1,2})?/containers/[a-zA-Z0-9][a-zA-Z0-9_.-]*(\?.*)?` | `--rm` cleanup |

Body filter on create:
`-allowbindmountfrom=/srv/voltron/workspace` (replace with the host-side
workspace path). Binds with source `/` or any path outside this prefix are
rejected. `VolumesFrom` is not a bind, so it passes through unfiltered, which
is intended for `--volumes-from`.

### Implicit deny (NOT in the allowlist, therefore blocked)

No allow rule is written for any of these, so default-deny blocks them:

- `POST /build` (image build)
- `POST /containers/<id>/exec` and `POST /exec/<id>/start` (exec into siblings)
- `POST /commit` (snapshot a container to an image)
- `POST /networks/create`, `POST /volumes/create`
- Anything under `/swarm`, `/services`, `/secrets`, `/configs`, `/plugins`
- image push/pull/load, `/containers/<id>/update`, `/containers/<id>/exec`, etc.

Do not add allow rules for these.

## THREAT MODEL

Assume a nesting agent is fully compromised or escapes its own container and
can speak freely to `tcp://voltron-socket-proxy:2375`.

### What it CAN still do (residual risk, be honest)

- **Create and run containers from any image the daemon can pull/has cached,
  on the shared host daemon.** The allowlist permits `containers/create` +
  `start` + `attach` + `wait` + `delete`. An attacker can launch arbitrary
  containers (subject to the bind-source filter). Those containers share the
  host kernel and the host daemon. This is the core residual risk of giving any
  agent container-create rights on a shared daemon. Hardening the
  `voltron-agent` image does not constrain what *image* a create request names.
- **Request `Privileged: true` or `PidMode: host` in the create body.** The
  proxy does NOT inspect these fields. Unless the optional OPA AuthZ plugin is
  deployed on the daemon, such a create succeeds. A privileged container is a
  direct host-root path. **This is the most serious residual risk and the main
  reason to deploy `opa-authz/voltron-authz.rego` if the threat model demands
  it.**
- **Read host posture** via `GET /containers/json` and `/containers/<id>/json`
  (names, mounts, env on other containers): an information-disclosure glimpse,
  intentionally allowed for `--volumes-from` resolution.
- **Defeat the body filters** in extreme cases: see CVE-2026-34040 below if the
  OPA plugin is in use; bind-source checks rely on path-prefix logic that
  normalization tricks have historically evaded (opa-docker-authz issue #34).

### What it now CANNOT do (gains over a raw socket or coarse proxy)

- **Build images** (`POST /build` denied) so no Dockerfile-based escape or
  cache poisoning.
- **Exec into sibling containers** (`/containers/<id>/exec`,
  `/exec/<id>/start` denied) so it cannot hijack another agent's running
  container.
- **Mount host root or arbitrary host paths.** `-allowbindmountfrom` restricts
  bind sources to the workspace prefix; `/` and `:/host` style binds are
  rejected at create time. (Coarse Tecnativa with `POST=1` cannot do this.)
- **`commit`** a container into a new image (`POST /commit` denied).
- **Create networks or volumes** (`/networks/create`, `/volumes/create`
  denied) so it cannot fabricate a writable named volume or a bridge to pivot.
- **Touch swarm / services / secrets / configs / plugins** (all denied).
- **Reach the real `docker.sock` directly** or the host/internet:
  `voltron-proxy-net` is `internal: true` and only the proxy holds the socket.

### CVE-2026-34040 (AuthZ-plugin body-size bypass)

If you deploy the optional OPA AuthZ plugin to cover `Privileged`/`PidMode`,
know that every Docker AuthZ plugin that inspects the request body can be
bypassed by padding the `containers/create` body past ~1MB: the daemon drops
the body before the plugin evaluates it, and the request is allowed. Mitigation
is to keep `dockerd` patched (the fix enforces the size check before the plugin
hook) and to treat the plugin as defense-in-depth layered on the proxy, not as
a sole control. The proxy's own `-allowbindmountfrom` runs in the sidecar
(separate process, not the daemon authz hook) and is not subject to this
specific daemon-side bug, but it only covers bind sources, not `Privileged`.

## Files in this directory

| File | What it is |
|---|---|
| `docker-compose.socket-proxy.yml` | Canonical proxy config (flag form) + sidecar hardening + `voltron-proxy-net`. |
| `socket-proxy.env` | Identical ruleset as `SP_*` env vars (for `--env-file` deployments). |
| `opa-authz/voltron-authz.rego` | OPTIONAL daemon-side AuthZ policy that closes the `Privileged`/`PidMode` gap the proxy cannot. Carries CVE-2026-34040. |

## Things to fill in before deploying

1. **Host docker GID** in `user: "65534:<GID>"` (the proxy must read the real
   socket).
2. **`-allowfrom` CIDR** to the actual `voltron-proxy-net` subnet.
3. **`-allowbindmountfrom` / `SP_ALLOWBINDMOUNTFROM`** to the real host-side
   workspace path (and the matching prefix in the rego policy).
4. Decide whether the `Privileged`/`PidMode` guarantee is required; if so,
   deploy the OPA plugin, otherwise document acceptance of that residual risk.

## Sources

- wollomatic/socket-proxy README and flag reference:
  https://github.com/wollomatic/socket-proxy and
  https://raw.githubusercontent.com/wollomatic/socket-proxy/main/README.md
- `-allowbindmountfrom` (v1.8+) bind-source body filtering: project README /
  DeepWiki https://deepwiki.com/wollomatic/socket-proxy
- Releases (1.12.2, 2026-06-09): https://github.com/wollomatic/socket-proxy/releases
- Image digests: Docker Hub registry, tag 1.12.2
  https://hub.docker.com/r/wollomatic/socket-proxy
- Tecnativa coarse proxy (POST section toggle):
  https://github.com/Tecnativa/docker-socket-proxy
- OPA Docker authorization (body field inspection of HostConfig.Privileged /
  Binds): https://www.openpolicyagent.org/docs/docker-authorization and
  https://github.com/open-policy-agent/opa-docker-authz
- opa-docker-authz Binds/Mounts evasion: issue #34
  https://github.com/open-policy-agent/opa-docker-authz/issues/34
- CVE-2026-34040 (AuthZ body-size bypass): Cyera research writeup
  https://www.cyera.com/research/one-megabyte-to-root-how-a-size-check-broke-dockers-last-line-of-defense
