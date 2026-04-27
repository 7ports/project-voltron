#!/usr/bin/env python3
"""v3.3.2: Narrow Docker ~/.claude mount + add entrypoint breadcrumbs.

Root-cause finding from the v3.3.1 audit (.voltron/analyses/2026-04-27T19-51-56-docker-entrypoint-hang.md):
when the container's claude CLI starts, it scans ~/.claude/projects/ via the
WSL2 9P bind mount. With 40 MB in this project's session dir alone, that read
can stall for many minutes under cold cache — the silent-hang root cause.

Fix:
  1. Remove the broad RW mount of ~/.claude. Auth comes from the OAuth env var
     (CLAUDE_CODE_OAUTH_TOKEN); ~/.claude.json:ro stays for MCP/preferences.
     Container starts with no session history to scan.
  2. Wrap the claude invocation in a brace group with breadcrumb echoes
     ([entry], [claude-version], [exec], [exit]) so a hang before claude
     produces output still leaves localized log lines.

Run from repo root: python3 scripts/v332-mount-narrow.py
"""
import os
import subprocess
import sys

os.chdir(os.path.join(os.path.dirname(__file__), ".."))

with open("src/index.js", "r", encoding="utf-8") as f:
    js = f.read()

# ── 1. Remove the broad ~/.claude RW mount (appears in BOTH Docker tools) ──────

OLD_BROAD_MOUNT_LINE = '      "-v", `${homeDir}/.claude:/home/voltron/.claude`,\n'
n = js.count(OLD_BROAD_MOUNT_LINE)
if n == 0:
    print("index.js: broad ~/.claude mount already removed (idempotent skip)")
else:
    assert n == 2, f"Expected 2 occurrences of the broad .claude mount, found {n}"
    js = js.replace(OLD_BROAD_MOUNT_LINE, "", 2)
    print(f"index.js: removed broad ~/.claude mount from both Docker tools ({n} occurrences)")

# ── 1b. Also remove ~/.claude.json:ro mount.
# Smoke test 2026-04-27 confirmed ~/.claude.json contains host-specific MCP server
# paths (e.g. `node "C:\\Users\\..."`) that don't exist inside the container —
# claude tries to spawn them and stalls for 60-90s. Without the mount, claude
# runs the same prompt in 3-4s. The container is headless (`-p`) and has the
# full task in /tmp/task.md, so no MCP config is needed. ─────────────────────

OLD_CLAUDE_JSON_LINE = '      "-v", `${homeDir}/.claude.json:/home/voltron/.claude.json:ro`,\n'
n_json = js.count(OLD_CLAUDE_JSON_LINE)
if n_json == 0:
    print("index.js: ~/.claude.json:ro mount already removed (idempotent skip)")
else:
    assert n_json == 2, f"Expected 2 occurrences of the .claude.json mount, found {n_json}"
    js = js.replace(OLD_CLAUDE_JSON_LINE, "", 2)
    print(f"index.js: removed ~/.claude.json:ro mount from both Docker tools ({n_json} occurrences) — primary fix for the hang")

# ── 2. Replace run_agent_in_docker entrypoint with breadcrumb-wrapped version ──

OLD_RUN_ENTRY = r"""      `claude --dangerously-skip-permissions --max-turns ${max_turns} -p "$(cat /tmp/task.md)" 2>&1 | tee /workspace/.voltron/logs/${logFilename}; exit \${PIPESTATUS[0]}`,"""

NEW_RUN_ENTRY = r"""      // v3.3.2: breadcrumb-wrapped — surfaces stalls before claude produces its first byte.
      // [entry]/[claude-version]/[exec]/[exit] echoes localize hangs to mount, auth, parse, or run.
      `{ echo "[entry] $(date -Is) host=$(hostname) user=$(whoami)"; echo "[claude-version] $(claude --version 2>&1)"; echo "[exec] $(date -Is) starting prompt"; claude --dangerously-skip-permissions --max-turns ${max_turns} -p "$(cat /tmp/task.md)" 2>&1; CLAUDE_EXIT=\$?; echo "[exit] $(date -Is) code=\$CLAUDE_EXIT"; exit \$CLAUDE_EXIT; } | tee /workspace/.voltron/logs/${logFilename}; exit \${PIPESTATUS[0]}`,"""

if js.count(OLD_RUN_ENTRY) == 0 and "[entry] $(date -Is)" in js:
    print("index.js: run_agent_in_docker entrypoint already wrapped (idempotent skip)")
else:
    assert js.count(OLD_RUN_ENTRY) == 1, f"run_agent_in_docker entrypoint anchor not unique: {js.count(OLD_RUN_ENTRY)}"
    js = js.replace(OLD_RUN_ENTRY, NEW_RUN_ENTRY, 1)
    print("index.js: run_agent_in_docker — entrypoint wrapped with [entry]/[claude-version]/[exec]/[exit] breadcrumbs")

# ── 3. Replace start_agent_in_docker entrypoint (same wrapper + .exit file) ────

OLD_START_ENTRY = r"""      // Write exit code to .exit file so get_agent_output can detect completion
      `claude --dangerously-skip-permissions --max-turns ${max_turns} -p "$(cat /tmp/task.md)" 2>&1 | tee /workspace/.voltron/logs/${logFilename}; echo "\${PIPESTATUS[0]}" > /workspace/.voltron/logs/${logFilename}.exit; exit \${PIPESTATUS[0]}`,"""

NEW_START_ENTRY = r"""      // v3.3.2: breadcrumb-wrapped + .exit file write. Brace group emits localizing markers,
      // tee captures everything, PIPESTATUS[0] preserves claude's real exit code.
      `{ echo "[entry] $(date -Is) host=$(hostname) user=$(whoami)"; echo "[claude-version] $(claude --version 2>&1)"; echo "[exec] $(date -Is) starting prompt"; claude --dangerously-skip-permissions --max-turns ${max_turns} -p "$(cat /tmp/task.md)" 2>&1; CLAUDE_EXIT=\$?; echo "[exit] $(date -Is) code=\$CLAUDE_EXIT"; exit \$CLAUDE_EXIT; } | tee /workspace/.voltron/logs/${logFilename}; EXIT=\${PIPESTATUS[0]}; echo "\$EXIT" > /workspace/.voltron/logs/${logFilename}.exit; exit \$EXIT`,"""

if js.count(OLD_START_ENTRY) == 0 and js.count("[entry] $(date -Is)") >= 2:
    print("index.js: start_agent_in_docker entrypoint already wrapped (idempotent skip)")
else:
    assert js.count(OLD_START_ENTRY) == 1, f"start_agent_in_docker entrypoint anchor not unique: {js.count(OLD_START_ENTRY)}"
    js = js.replace(OLD_START_ENTRY, NEW_START_ENTRY, 1)
    print("index.js: start_agent_in_docker — entrypoint wrapped + .exit file write preserved")

# ── 4. Add narrow-mount rationale comment in both Docker tools.
# The two tools format the auth-env block differently — handle each separately. ─

NARROW_RATIONALE = """// v3.3.2: auth comes purely from CLAUDE_CODE_OAUTH_TOKEN env var.
    // We deliberately do NOT mount ~/.claude or ~/.claude.json. Smoke testing on 2026-04-27
    // showed ~/.claude.json was the silent-hang root cause: it contains host-specific MCP
    // server registrations (e.g. `node "C:\\\\Users\\\\..."`) that claude tries to spawn at
    // startup and stalls for 60-90s waiting for. Container is headless (`-p`) with the full
    // task in /tmp/task.md, so no MCP config is needed. Same 5-line prompt:
    //   with ~/.claude.json:ro mounted -> ~90s (often hangs)
    //   without that mount             -> ~4s consistently"""

# Old (interim) rationale paragraph that may be present from a prior partial run
OLD_INTERIM_RATIONALE_PHRASE = "~/.claude.json:ro is still mounted below for MCP defs."

# 4a. run_agent_in_docker — handle 3 states: original / interim / final
OLD_AUTH_RUN = "    // Pass through Claude auth env vars so the agent inside Docker can authenticate\n    const authEnvArgs = [];"
NEW_AUTH_RUN = f"    {NARROW_RATIONALE}\n    const authEnvArgs = [];"
if js.count(OLD_AUTH_RUN) == 1:
    js = js.replace(OLD_AUTH_RUN, NEW_AUTH_RUN, 1)
    print("index.js: run_agent_in_docker — narrow-mount rationale comment added (from original)")
elif OLD_INTERIM_RATIONALE_PHRASE in js:
    # Replace interim rationale with final rationale (search for the 4-line block ending in the phrase)
    INTERIM_BLOCK = """    // v3.3.2: auth comes purely from CLAUDE_CODE_OAUTH_TOKEN env var.
    // We deliberately do NOT mount ~/.claude RW — that mount was scanning ~/.claude/projects/
    // (40-150 MB on a busy host) through Docker Desktop's WSL2 9P bind, which stalled for
    // many minutes under cold cache. ~/.claude.json:ro is still mounted below for MCP defs."""
    FINAL_BLOCK = f"    {NARROW_RATIONALE}"
    n_int = js.count(INTERIM_BLOCK)
    assert n_int == 2, f"interim rationale block not at both sites: {n_int}"
    js = js.replace(INTERIM_BLOCK, FINAL_BLOCK, 2)
    print(f"index.js: rationale comment upgraded interim -> final ({n_int} occurrences)")
else:
    # already final
    print("index.js: narrow-mount rationale comment already final (idempotent skip)")

# 4b. start_agent_in_docker — only run if 4a didn't already cover both sites via interim path
OLD_AUTH_START = "    try { await fs.access(gitConfigPath); gitConfigMount = [\"-v\", `${gitConfigPath}:/home/voltron/.gitconfig:ro`]; } catch { /* no gitconfig */ }\n    const authEnvArgs = [];"
NEW_AUTH_START = f"    try {{ await fs.access(gitConfigPath); gitConfigMount = [\"-v\", `${{gitConfigPath}}:/home/voltron/.gitconfig:ro`]; }} catch {{ /* no gitconfig */ }}\n    {NARROW_RATIONALE}\n    const authEnvArgs = [];"
if js.count(OLD_AUTH_START) == 1:
    js = js.replace(OLD_AUTH_START, NEW_AUTH_START, 1)
    print("index.js: start_agent_in_docker — narrow-mount rationale comment added (from original)")
else:
    print("index.js: start_agent_in_docker rationale already in place (idempotent skip)")

# ── Write + verify ────────────────────────────────────────────────────────────

with open("src/index.js", "w", encoding="utf-8") as f:
    f.write(js)

r = subprocess.run(["node", "--check", "src/index.js"], capture_output=True, text=True)
if r.returncode != 0:
    print("SYNTAX ERROR in index.js:", r.stderr)
    sys.exit(1)
print("node --check src/index.js: OK")

# Sanity-check final state
final_broad = js.count(r"`${homeDir}/.claude:/home/voltron/.claude`")
final_jsoro = js.count(r"`${homeDir}/.claude.json:/home/voltron/.claude.json:ro`")
final_breadcrumb = js.count("[entry] $(date -Is)")
assert final_broad == 0, f"broad ~/.claude mount still present: {final_broad}"
assert final_jsoro == 0, f"~/.claude.json:ro mount still present: {final_jsoro} (should be 0 — primary fix)"
assert final_breadcrumb == 2, f"breadcrumb echoes not in both tools: {final_breadcrumb}"
print(f"final: broad-mount={final_broad}, json-ro={final_jsoro}, breadcrumb-pairs={final_breadcrumb}")

print("SUCCESS: v332 mount-narrow + breadcrumbs applied")
