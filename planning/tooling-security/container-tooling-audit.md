# Container Tooling Audit — Per-Agent Gaps (T0.4)

**Author:** code-analyst (read-only) · **Date:** 2026-06-23 · **Scope:** which Voltron agents need which container tools that the agent image (`DOCKERFILE_CONTENT` in `src/templates.js`) does not install today.

**Method:** Cross-referenced every agent template in the `TEMPLATES` object of `src/templates.js` against the tooling the image actually installs (`DOCKERFILE_CONTENT`, `src/templates.js:9909`). Every claim below cites a file path or template name + line.

---

## 1. What the image installs today

From `DOCKERFILE_CONTENT` (`src/templates.js:9909`–`10003`), base `node:20-slim`:

| Tool | Source line |
|---|---|
| node 20, npm, npx | `FROM node:20-slim` (9910) |
| git | apt (9914) |
| curl, wget | apt (9915–9916) |
| python3, python3-pip, python3-venv | apt (9917–9919) |
| ruby, ruby-dev | apt (9920–9921) |
| build-essential (gcc/make) | apt (9922) |
| zip, unzip, jq, ca-certificates | apt (9923–9926) |
| @anthropic-ai/claude-code | npm -g (9930) |
| docker-ce-cli (DooD, no daemon) | apt (9941) |
| gh (GitHub CLI) | apt (9954) |
| sudo (scoped to docker wrapper) | apt (9967) |
| @beads/bd | npm -g (9976) |
| stringer 1.7.0 | release tarball (9979) |

**Not present in the image (the gap surface):** no headless browser / Chromium and its shared libs; no .NET SDK (`dotnet`); no Rust toolchain (`cargo`); no Go (`go`); no `pip-audit`; no `ripgrep` (`rg`) despite being allow-listed. `npx`/`pip`/`gem` can *fetch* JS/Python/Ruby packages at runtime (network permitting), but cannot supply a native Chromium binary or a language SDK.

---

## 2. Per-agent gap table

Legend — **In image?** = is the required tool present in `DOCKERFILE_CONTENT` today.

| Agent (template) | Task type | Tool(s) it invokes | In image? | Impact if missing |
|---|---|---|---|---|
| `accessibility-auditor` (`src/templates.js:7491`) | WCAG audit of running app | `npx axe-cli <url>` / `npx pa11y <url>` | **No** — both drive headless Chromium | Audit cannot run; agent falls back to static grep for `alt`/`aria` (7492), which misses rendered-DOM violations. Core function disabled. |
| `lighthouse-runner` (`src/templates.js:7566`) | Perf/a11y/SEO audit | `npx lighthouse <url> --chrome-flags="--headless"` | **No** — needs Chromium | Lighthouse cannot launch Chrome; produces no scores. Core function fully disabled. |
| `qa-tester` (`src/templates.js:4486`, `4527`, `4569`) | E2E + Lighthouse quality gate | Playwright / Cypress E2E; Lighthouse audit | **No** — all need a browser | E2E suite and Lighthouse step of the quality gate cannot execute; only unit/typecheck/lint/bundle steps run. "Last gate before shipping" ships unverified UI. |
| `fullstack-dev` (`src/templates.js:3386`, `3629`) | Web feature dev + visual verify | dispatches `lighthouse-runner`; "📸 Visual change" screenshot verification | **No** | Cannot self-verify rendered UI in-container; visual verification is deferred to host/scrum-master. |
| `ui-designer` (`src/templates.js:4270`) | Responsive UI work | "browser DevTools responsive mode to verify breakpoints" | **No** | Cannot verify breakpoints/visuals in-container; relies on host. |
| `css-writer` (`src/templates.js:9002`) | CSS edits | (implied visual verification of rendered styles) | **No** | No way to render/confirm style output in-container; blind edits. |
| `test-config-writer` (`src/templates.js:9633`) | Writes jest/vitest/**playwright** config | writes config; downstream run needs browser | **No** (for the Playwright case) | Config can be written, but no agent can *execute* the Playwright config it produces. |
| `scrum-master` (`src/templates.js:1502`–`1504`) | Visual verification / screenshots | `mcp__Claude_in_Chrome__navigate` + `…__computer` screenshot | **No** — host-only MCP | The Claude-in-Chrome MCP is a host-side server; `scripts/voltron-run.sh` deliberately does **not** mount MCP registrations into the container (`src/templates.js:10014`), so this is unavailable in Docker. In-container screenshot verification is impossible without a real headless browser. |
| `researcher` (`src/templates.js:5120`) | Web research | `mcp__Claude_in_Chrome__*` navigation/read | **No** in Docker (same host-MCP reason) | Live-page navigation unavailable in-container; falls back to `WebFetch`/`WebSearch` only. |
| `build-runner` (`src/templates.js:2266`, `2329`; `7238`) | Build/compile validation | `dotnet build` for Unity/.NET projects | **No** — no .NET SDK | Cannot build/validate any C#/.NET or Unity project in-container; `dotnet` command not found. |
| `build-validator` (`src/templates.js:2764`) | Unity compile gate | Unity/.NET build (`dotnet`) | **No** | Unity build validation cannot run in Docker (also needs Unity Editor — host-only). |
| `csharp-dev` (`src/templates.js:2124`) | C# / Unity code | `dotnet` toolchain for compile checks | **No** | No in-container compile feedback for C#. |
| `dep-reader` (`src/templates.js:5358`) | Dependency inspection | `cargo metadata` for `Cargo.toml`; reads `go.mod` | **Partial** — `cargo`/`go` absent | Rust/Go *manifest reads* work (plain file reads), but `cargo metadata` and any Go tooling fail; degrades to text parsing. |
| `security-scanner` (`src/templates.js:7645`) | Dependency CVE scan | `npm audit` ✓; `cargo audit` / `pip-audit` | **Partial** — `npm audit` works; `cargo audit` (no Rust), `pip-audit` (not installed) fail | Rust and Python projects get no vuln scan unless tools are fetched at runtime; silent coverage gap. |
| `test-runner` (`src/templates.js:7093`) | Run test suite | jest/vitest/pytest ✓; `go test` / `cargo test` | **Partial** | JS/Python tests run; Go and Rust test suites cannot (`go`/`cargo` missing). |
| any agent relying on `rg` | search | `Bash(rg *)` is allow-listed (`src/templates.js:10067`) | **No** — ripgrep not apt-installed | `rg` invocations fail; agents fall back to `grep`. Low impact but a real allow-list/image mismatch. |

---

## 3. Focus areas

### A. Browser / rendering (PRIMARY — already in flight as T0.1)
No headless browser or Chromium is installed (`DOCKERFILE_CONTENT`, 9909–10003). This blocks the largest cluster of agents: `lighthouse-runner` (7566), `accessibility-auditor` (7491), `qa-tester` E2E + Lighthouse (4486/4527/4569), and degrades `fullstack-dev` (3386), `ui-designer` (4270), `css-writer`, and `test-config-writer`'s Playwright path. The host-side `mcp__Claude_in_Chrome__*` tools (used by `scrum-master` 1502 and `researcher` 5120) are explicitly *not* mounted into containers (`scripts/voltron-run.sh` rationale at 10014), so a real in-image browser is the only path to in-container UI verification. **Recommended fill:** Playwright with bundled Chromium + its OS shared libs (`npx playwright install --with-deps chromium`), which simultaneously satisfies Playwright E2E, Lighthouse (`--chrome-flags=--headless`), pa11y, and axe-cli (all Chromium-backed).

### B. .NET / Unity toolchain
`build-runner` (2266/2329), `build-validator` (2764), and `csharp-dev` (2124) assume `dotnet build`. No .NET SDK in the image → all C#/.NET build validation fails in-container. (Full Unity Editor builds remain host-only regardless; agents already escalate Play-Mode/Editor tasks per `1993`/`2328`.) **Fill:** .NET SDK, if Unity/C# projects are a supported target for in-container validation; otherwise document the limitation explicitly so these agents escalate rather than error.

### C. Additional language runtimes (Rust / Go)
Referenced by `dep-reader` (`cargo metadata`, 5358), `security-scanner` (`cargo audit`, 7645), and `test-runner` (`go test`/`cargo test`, 7093). Neither `cargo`/rustup nor `go` is installed. Polyglot repos get partial dependency, security, and test coverage with no loud failure. **Fill:** Rust toolchain + Go, OR document these as unsupported and have the agents report the gap.

### D. Python/Ruby audit CLIs
`pip` and `gem` exist (python3-pip 9918, ruby 9920) but `pip-audit` (security-scanner, 7645) is not pre-installed; it must be `pip install`-ed at runtime (network-dependent, slow, and fails offline). **Fill:** pre-install `pip-audit` (cheap) so Python CVE scanning is reliable.

### E. Allow-list vs image drift (`ripgrep`)
`Bash(rg *)` is allow-listed (`src/templates.js:10067`) but ripgrep is never apt-installed. Low-severity but a concrete mismatch; either install `ripgrep` or drop the allow-list entry.

---

## 4. Prioritized "close these gaps" list

1. **[P0 — in flight, T0.1] Headless browser (Playwright + Chromium + `--with-deps`).** Unblocks `lighthouse-runner`, `accessibility-auditor`, `qa-tester` (E2E + Lighthouse), and restores in-container visual verification for `fullstack-dev`/`ui-designer`/`css-writer`. Single highest-leverage fill — one install satisfies Playwright, Lighthouse, pa11y, and axe-cli.
2. **[P1] `pip-audit` pre-install.** Tiny image cost; closes the Python branch of `security-scanner` (7645) and removes a runtime-network dependency.
3. **[P1] `ripgrep`.** Resolves the allow-list/image mismatch (`10067`); trivial install.
4. **[P2] .NET SDK** (or an explicit "not supported in-container" doctrine). Decides whether `build-runner`/`build-validator`/`csharp-dev` (2266/2764/2124) validate C# in Docker or must escalate. Pick one and document it so these agents stop silently failing.
5. **[P2] Rust + Go toolchains** (or explicit unsupported doctrine). Closes the polyglot gaps in `dep-reader` (5358), `security-scanner` (7645), and `test-runner` (7093). Larger image cost — gate on whether these stacks are actually targeted.

---

## 5. Verification of acceptance criteria

- **(a) Audit table mapping agent → task → tool → present? → impact:** Section 2 — 16 rows, each citing a template name + line.
- **(b) Browser/rendering focus + other gaps enumerated:** Section 3.A (browser, primary) plus 3.B–E (.NET, Rust/Go, Python/Ruby audit CLIs, ripgrep drift).
- **(c) Prioritized close-the-gaps list with browser as #1:** Section 4, item 1 = browser (T0.1).
- Every claim grounded in `src/templates.js` paths/line numbers as required. No files edited; no commit made (committer is next).
