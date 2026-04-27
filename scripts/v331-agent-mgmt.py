#!/usr/bin/env python3
"""v3.3.1: Agent orchestration overhaul.

Changes:
  src/index.js
    1. Add ensureVoltronImage() helper — skips Docker rebuild when image is
       fresher than Dockerfile.voltron (eliminates 30-120s wait per launch)
    2. Refactor run_agent_in_docker to use the helper
    3. Refactor start_agent_in_docker to use the helper, write .started
       timestamp file, and report 'Image build: skipped/rebuilt' in response
    4. Rewrite get_agent_output: add since_line cursor, elapsed_seconds,
       phase hints (spin-up / stalled / long-running), and 600ms retry
       on the unknown-exit-code race

  src/templates.js
    5. Replace scrum-master's vague "Poll repeatedly" guidance with an
       explicit Polling Cadence section (table of phases + intervals,
       incremental polling pattern, stall kill, image-cache speedup note)
    6. Update Execution Loop step 3 to reference the new cadence

Run from repo root: python3 scripts/v331-agent-mgmt.py
"""
import os
import subprocess
import sys

os.chdir(os.path.join(os.path.dirname(__file__), ".."))

# ────────────────────────────────────────────────────────────────────────────
# src/index.js edits
# ────────────────────────────────────────────────────────────────────────────

with open("src/index.js", "r", encoding="utf-8") as f:
    js = f.read()

# ── 1. Insert ensureVoltronImage helper after checkDockerAvailable ──────────

OLD_HELPER_ANCHOR = """  return null;
}

function detectProjectRoot(rawRoot) {"""

NEW_HELPER_BLOCK = """  return null;
}

// Build voltron-agent image only when stale or missing.
// Compares image LastTagTime against Dockerfile mtime — skips rebuild
// when the image is already current. Eliminates the 30-120s rebuild
// overhead on every agent launch.
async function ensureVoltronImage(cwd, dockerfilePath) {
  try {
    const imageTimeStr = execSync(
      'docker image inspect voltron-agent --format "{{.Metadata.LastTagTime}}"',
      { encoding: "utf-8", stdio: "pipe" }
    ).trim();
    const dockerfileStat = await fs.stat(dockerfilePath);
    if (imageTimeStr && new Date(imageTimeStr) > dockerfileStat.mtime) {
      return { ok: true, built: false };
    }
  } catch { /* image missing or inspect failed — fall through to build */ }

  return new Promise((resolve) => {
    let buildStderr = "";
    const buildProc = spawn(
      "docker",
      ["build", "-t", "voltron-agent", "-f", dockerfilePath, cwd],
      { stdio: ["ignore", "ignore", "pipe"], cwd }
    );
    buildProc.stderr?.on("data", (chunk) => { buildStderr += chunk.toString(); });
    const timer = setTimeout(() => {
      buildProc.kill();
      resolve({ ok: false, error: `Error: Docker build timed out after 120s.\\n\\n${buildStderr.trim().slice(-2000)}` });
    }, 120000);
    buildProc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: `Error: Docker image build failed.\\n\\nBuild output:\\n${buildStderr.trim().slice(-2000)}` });
      } else {
        resolve({ ok: true, built: true });
      }
    });
    buildProc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `Error: Docker build spawn failed: ${err.message}` });
    });
  });
}

function detectProjectRoot(rawRoot) {"""

assert js.count(OLD_HELPER_ANCHOR) == 1, f"helper anchor not unique: {js.count(OLD_HELPER_ANCHOR)}"
js = js.replace(OLD_HELPER_ANCHOR, NEW_HELPER_BLOCK, 1)
print("index.js: ensureVoltronImage helper inserted")

# ── 2. Refactor run_agent_in_docker — replace inline build with helper call ──

OLD_RUN_BUILD = """    // 6. Check Dockerfile.voltron exists
    const dockerfilePath = path.join(cwd, "Dockerfile.voltron");
    try {
      await fs.access(dockerfilePath);
    } catch {
      await fs.unlink(tmpFile).catch(() => {});
      return {
        content: [
          {
            type: "text",
            text: "Error: Dockerfile.voltron not found in project root. Run scaffold_project first to generate it.",
          },
        ],
      };
    }

    // 7. Build image — async spawn so parallel agent invocations don't block each other
    try {
      await new Promise((resolve, reject) => {
        let buildStderr = "";
        const buildProc = spawn(
          "docker",
          ["build", "-t", "voltron-agent", "-f", dockerfilePath, cwd],
          { stdio: ["ignore", "ignore", "pipe"], cwd }
        );
        buildProc.stderr?.on("data", (chunk) => { buildStderr += chunk.toString(); });
        const timer = setTimeout(() => {
          buildProc.kill();
          reject(Object.assign(new Error("Docker build timed out"), { stderr: buildStderr }));
        }, 120000);
        buildProc.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) reject(Object.assign(new Error("Build failed"), { stderr: buildStderr }));
          else resolve();
        });
        buildProc.on("error", (err) => { clearTimeout(timer); reject(err); });
      });
    } catch (err) {
      await fs.unlink(tmpFile).catch(() => {});
      const buildStderr = err.stderr ? `\\n\\nBuild output:\\n${err.stderr.trim().slice(-2000)}` : "";
      return {
        content: [
          {
            type: "text",
            text: `Error: Docker image build failed.${buildStderr}`,
          },
        ],
      };
    }"""

NEW_RUN_BUILD = """    // 6. Ensure voltron-agent image is current (skips rebuild if Dockerfile unchanged)
    const dockerfilePath = path.join(cwd, "Dockerfile.voltron");
    try {
      await fs.access(dockerfilePath);
    } catch {
      await fs.unlink(tmpFile).catch(() => {});
      return {
        content: [{ type: "text", text: "Error: Dockerfile.voltron not found in project root. Run scaffold_project first to generate it." }],
      };
    }
    const imageResult = await ensureVoltronImage(cwd, dockerfilePath);
    if (!imageResult.ok) {
      await fs.unlink(tmpFile).catch(() => {});
      return { content: [{ type: "text", text: imageResult.error }] };
    }"""

assert js.count(OLD_RUN_BUILD) == 1, f"run_agent build anchor not unique: {js.count(OLD_RUN_BUILD)}"
js = js.replace(OLD_RUN_BUILD, NEW_RUN_BUILD, 1)
print("index.js: run_agent_in_docker — refactored to use ensureVoltronImage")

# ── 3a. Refactor start_agent_in_docker — replace inline build ────────────────

OLD_START_BUILD = """    // Check Dockerfile.voltron exists
    const dockerfilePath = path.join(cwd, "Dockerfile.voltron");
    try { await fs.access(dockerfilePath); } catch {
      await fs.unlink(tmpFile).catch(() => {});
      return { content: [{ type: "text", text: "Error: Dockerfile.voltron not found. Run scaffold_project first." }] };
    }

    // Build image
    try {
      await new Promise((resolve, reject) => {
        let buildStderr = "";
        const buildProc = spawn("docker", ["build", "-t", "voltron-agent", "-f", dockerfilePath, cwd], { stdio: ["ignore", "ignore", "pipe"], cwd });
        buildProc.stderr?.on("data", (chunk) => { buildStderr += chunk.toString(); });
        const timer = setTimeout(() => { buildProc.kill(); reject(Object.assign(new Error("Docker build timed out"), { stderr: buildStderr })); }, 120000);
        buildProc.on("close", (code) => { clearTimeout(timer); if (code !== 0) reject(Object.assign(new Error("Build failed"), { stderr: buildStderr })); else resolve(); });
        buildProc.on("error", (err) => { clearTimeout(timer); reject(err); });
      });
    } catch (err) {
      await fs.unlink(tmpFile).catch(() => {});
      const buildStderr = err.stderr ? `\\n\\nBuild output:\\n${err.stderr.trim().slice(-2000)}` : "";
      return { content: [{ type: "text", text: `Error: Docker image build failed.${buildStderr}` }] };
    }"""

NEW_START_BUILD = """    // Ensure voltron-agent image is current (skips rebuild if Dockerfile unchanged)
    const dockerfilePath = path.join(cwd, "Dockerfile.voltron");
    try { await fs.access(dockerfilePath); } catch {
      await fs.unlink(tmpFile).catch(() => {});
      return { content: [{ type: "text", text: "Error: Dockerfile.voltron not found. Run scaffold_project first." }] };
    }
    const imageResult2 = await ensureVoltronImage(cwd, dockerfilePath);
    if (!imageResult2.ok) {
      await fs.unlink(tmpFile).catch(() => {});
      return { content: [{ type: "text", text: imageResult2.error }] };
    }"""

assert js.count(OLD_START_BUILD) == 1, f"start_agent build anchor not unique: {js.count(OLD_START_BUILD)}"
js = js.replace(OLD_START_BUILD, NEW_START_BUILD, 1)
print("index.js: start_agent_in_docker — refactored to use ensureVoltronImage")

# ── 3b. Add .started timestamp file write ────────────────────────────────────

OLD_STARTED = """    // Create empty log file so get_agent_output can read it immediately
    await fs.writeFile(logPath, "");"""

NEW_STARTED = """    // Create empty log file + .started timestamp so get_agent_output tracks elapsed time
    await fs.writeFile(logPath, "");
    await fs.writeFile(logPath + ".started", new Date().toISOString(), "utf-8");"""

assert js.count(OLD_STARTED) == 1, f".started anchor not unique: {js.count(OLD_STARTED)}"
js = js.replace(OLD_STARTED, NEW_STARTED, 1)
print("index.js: start_agent_in_docker — .started timestamp file added")

# ── 3c. Update start_agent_in_docker return text to include started_at + cadence ──

OLD_START_RETURN = """    return {
      content: [{
        type: "text",
        text: [
          `## Agent ${agent_name} started`,
          ``,
          `**Container:** \\`${containerName}\\``,
          `**Log:** \\`${logPath}\\``,
          ``,
          `The agent is now running in the background. Use \\`get_agent_output\\` to poll for progress:`,
          `\\`\\`\\``,
          `get_agent_output({ container_name: "${containerName}", log_path: "${logPath}" })`,
          `\\`\\`\\``,
          ``,
          `You can also tail the log in a terminal: \\`tail -f "${logPath}"\\``,
        ].join("\\n"),
      }],
    };
  }
);"""

NEW_START_RETURN = """    const startedAt = new Date().toISOString();
    return {
      content: [{
        type: "text",
        text: [
          `## Agent ${agent_name} started`,
          ``,
          `**Container:** \\`${containerName}\\``,
          `**Log:** \\`${logPath}\\``,
          `**Started at:** ${startedAt}`,
          `**Image build:** ${imageResult2.built ? "rebuilt (Dockerfile changed)" : "skipped (image current)"}`,
          ``,
          `Poll progress with:`,
          `\\`\\`\\``,
          `get_agent_output({ container_name: "${containerName}", log_path: "${logPath}" })`,
          `\\`\\`\\``,
          ``,
          `**Polling cadence (don't wait arbitrary amounts):**`,
          `- Spin-up (0 lines, <45s elapsed): poll every 10s`,
          `- Active (lines growing): poll every 30s, pass \\`since_line: <next_line>\\` for incremental output`,
          `- Stalled (no new lines for 3 polls): kill with \\`docker kill ${containerName}\\``,
          ``,
          `Live tail in a terminal: \\`tail -f "${logPath}"\\``,
        ].join("\\n"),
      }],
    };
  }
);"""

assert js.count(OLD_START_RETURN) == 1, f"start return anchor not unique: {js.count(OLD_START_RETURN)}"
js = js.replace(OLD_START_RETURN, NEW_START_RETURN, 1)
print("index.js: start_agent_in_docker — return text now includes started_at, image-build status, polling cadence")

# ── 4. Rewrite get_agent_output entirely ─────────────────────────────────────

OLD_GET_OUTPUT = """server.tool(
  "get_agent_output",
  "Poll a running agent container for its latest output. Returns the last N lines of the agent's log and whether it is still running. Call this repeatedly to show real-time progress in the chat window.",
  {
    container_name: z.string().describe("Container name returned by start_agent_in_docker"),
    log_path: z.string().describe("Absolute log file path returned by start_agent_in_docker"),
    tail_lines: z.number().optional().describe("Number of log lines to return (default: 40)"),
  },
  async ({ container_name, log_path, tail_lines = 40 }) => {
    // Check if container is still running
    let isRunning = false;
    try {
      const psOutput = execSync(
        `docker ps --filter "name=^/${container_name}$" --format "{{.Names}}"`,
        { encoding: "utf-8", stdio: "pipe" }
      ).trim();
      isRunning = psOutput.split("\\n").some(name => name.trim() === container_name);
    } catch { isRunning = false; }

    // Read exit code file (written by container on completion)
    const exitCodePath = log_path + ".exit";
    let exitCode = null;
    try {
      const exitStr = await fs.readFile(exitCodePath, "utf-8");
      exitCode = parseInt(exitStr.trim(), 10);
    } catch { /* not written yet */ }

    // Read log file
    let logContent = "";
    try { logContent = await fs.readFile(log_path, "utf-8"); } catch { logContent = "(log file not yet available)"; }
    const allLines = logContent.split("\\n").filter(line => line.length > 0);
    const totalLines = allLines.length;
    const tailLines = allLines.slice(-tail_lines).join("\\n");

    // Determine status
    let status;
    if (isRunning) {
      status = "running";
    } else if (exitCode === 0) {
      status = "completed";
    } else if (exitCode !== null) {
      status = "failed";
    } else {
      // Container stopped but .exit not written yet — transient state
      status = "unknown (container stopped, exit code pending — retry in a moment)";
    }

    return {
      content: [{
        type: "text",
        text: [
          `## Agent output — \\`${container_name}\\``,
          ``,
          `**Status:** ${status}${exitCode !== null ? `  |  **Exit code:** ${exitCode}` : ""}`,
          `**Lines so far:** ${totalLines}  |  **Showing last ${Math.min(tail_lines, totalLines)}**`,
          ``,
          `\\`\\`\\``,
          tailLines || "(no output yet)",
          `\\`\\`\\``,
          status === "running" ? `\\nCall \\`get_agent_output\\` again to see newer output.` : `\\nAgent has finished. Review the output above.`,
        ].join("\\n"),
      }],
    };
  }
);"""

NEW_GET_OUTPUT = """server.tool(
  "get_agent_output",
  "Poll a running agent for its latest output. Returns log lines, status, elapsed time, and a next_line cursor for incremental polling. Pass since_line: <prev next_line> to get only new output. Includes phase hints (spin-up / stalled / long-running) so scrum-master knows whether to keep waiting or surface a warning to the user.",
  {
    container_name: z.string().describe("Container name returned by start_agent_in_docker"),
    log_path: z.string().describe("Absolute log file path returned by start_agent_in_docker"),
    tail_lines: z.number().optional().describe("Max lines to return (default: 40). Used as a cap when since_line is set, or as the tail size when it is not."),
    since_line: z.number().optional().describe("Return lines starting from this 0-based index. Pass the next_line value from the previous response to receive only new output. Omit on the first poll to get the last tail_lines lines."),
  },
  async ({ container_name, log_path, tail_lines = 40, since_line }) => {
    // Check if container is still running
    let isRunning = false;
    try {
      const psOutput = execSync(
        `docker ps --filter "name=^/${container_name}$" --format "{{.Names}}"`,
        { encoding: "utf-8", stdio: "pipe" }
      ).trim();
      isRunning = psOutput.split("\\n").some(name => name.trim() === container_name);
    } catch { isRunning = false; }

    // Read exit code file (written by container on completion)
    const exitCodePath = log_path + ".exit";
    let exitCode = null;
    try {
      const exitStr = await fs.readFile(exitCodePath, "utf-8");
      exitCode = parseInt(exitStr.trim(), 10);
    } catch { /* not written yet */ }

    // Race fix: container stopped but .exit not yet flushed — wait 600ms and retry once
    if (!isRunning && exitCode === null) {
      await new Promise(r => setTimeout(r, 600));
      try {
        const exitStr = await fs.readFile(exitCodePath, "utf-8");
        exitCode = parseInt(exitStr.trim(), 10);
      } catch { /* still not written — true transient state */ }
    }

    // Compute elapsed time from .started file (written by start_agent_in_docker)
    let elapsedSeconds = null;
    try {
      const startedStr = await fs.readFile(log_path + ".started", "utf-8");
      elapsedSeconds = Math.round((Date.now() - new Date(startedStr.trim()).getTime()) / 1000);
    } catch { /* no .started — pre-v3.3.1 container, elapsed unknown */ }

    // Read log
    let logContent = "";
    try { logContent = await fs.readFile(log_path, "utf-8"); } catch { logContent = ""; }
    const allLines = logContent.split("\\n").filter(line => line.length > 0);
    const totalLines = allLines.length;

    // Slice — incremental (since_line) vs tail
    let outputLines;
    let lineRangeDesc;
    let nextLine;
    if (since_line !== undefined && since_line >= 0) {
      const start = Math.min(since_line, totalLines);
      const end = Math.min(start + tail_lines, totalLines);
      outputLines = allLines.slice(start, end);
      nextLine = end;
      lineRangeDesc = outputLines.length > 0
        ? `Lines ${start + 1}–${end} of ${totalLines}`
        : `No new lines since index ${since_line} (total: ${totalLines})`;
    } else {
      outputLines = allLines.slice(-tail_lines);
      nextLine = totalLines;
      lineRangeDesc = `Last ${Math.min(tail_lines, totalLines)} of ${totalLines} lines`;
    }

    // Status
    let status;
    if (isRunning) status = "running";
    else if (exitCode === 0) status = "completed";
    else if (exitCode !== null) status = "failed";
    else status = "unknown";

    // Format elapsed
    const elapsedStr = elapsedSeconds !== null
      ? `  |  **Elapsed:** ${Math.floor(elapsedSeconds / 60)}m${String(elapsedSeconds % 60).padStart(2, "0")}s`
      : "";

    // Phase hint — tells scrum-master what to do next
    let phaseHint = "";
    if (status === "running" && totalLines === 0) {
      if (elapsedSeconds === null || elapsedSeconds < 45) {
        phaseHint = `\\n⏳ **Spin-up phase** — container initializing (normal for first 10–30s). Poll again in ~10s.`;
      } else {
        phaseHint = `\\n⚠ **No output after ${elapsedSeconds}s** — container may be waiting for auth or hung. Verify CLAUDE_CODE_OAUTH_TOKEN is set. Kill: \\`docker kill ${container_name}\\``;
      }
    } else if (status === "running" && elapsedSeconds !== null && elapsedSeconds > 600) {
      phaseHint = `\\n⚠ **Running ${Math.floor(elapsedSeconds / 60)}m** — if no new output for several polls, agent may be stalled. Kill: \\`docker kill ${container_name}\\``;
    } else if (status === "unknown") {
      phaseHint = `\\nℹ Container stopped but exit code not yet written. Poll again in 1–2s to resolve.`;
    }

    const nextHint = status === "running"
      ? `\\n💡 Next poll: \\`get_agent_output({ container_name: "${container_name}", log_path: "${log_path}", since_line: ${nextLine} })\\``
      : `\\nAgent finished. Close the bead, update progress, dispatch the next task.`;

    return {
      content: [{
        type: "text",
        text: [
          `## Agent output — \\`${container_name}\\``,
          ``,
          `**Status:** ${status}${exitCode !== null ? `  |  **Exit code:** ${exitCode}` : ""}${elapsedStr}`,
          `**${lineRangeDesc}**  |  **next_line:** ${nextLine}`,
          phaseHint,
          ``,
          `\\`\\`\\``,
          outputLines.length > 0 ? outputLines.join("\\n") : "(no output yet)",
          `\\`\\`\\``,
          nextHint,
        ].filter(s => s !== "").join("\\n"),
      }],
    };
  }
);"""

assert js.count(OLD_GET_OUTPUT) == 1, f"get_agent_output anchor not unique: {js.count(OLD_GET_OUTPUT)}"
js = js.replace(OLD_GET_OUTPUT, NEW_GET_OUTPUT, 1)
print("index.js: get_agent_output rewritten with since_line, elapsed, phase hints, retry")

# Write index.js
with open("src/index.js", "w", encoding="utf-8") as f:
    f.write(js)

# Verify syntax
r = subprocess.run(["node", "--check", "src/index.js"], capture_output=True, text=True)
if r.returncode != 0:
    print("SYNTAX ERROR in index.js:", r.stderr)
    sys.exit(1)
print("node --check src/index.js: OK")

# ────────────────────────────────────────────────────────────────────────────
# src/templates.js edits — scrum-master template
# ────────────────────────────────────────────────────────────────────────────

with open("src/templates.js", "r", encoding="utf-8") as f:
    tpl = f.read()

# ── 5a. Replace "Live visibility pattern" + Task Sizing header with new Polling Cadence ──

OLD_LIVE_VIS = """**Live visibility pattern** (preferred for complex sessions):
1. Call \\`start_agent_in_docker\\` for each ready task (same message = parallel start)
2. Poll with \\`get_agent_output\\` repeatedly — show log output verbatim to the user
3. On \\`status: completed/failed\\` → \\`bd close\\` / \\`update_progress\\` → loop back to \\`bd ready\\`

### Task Sizing and max_turns"""

NEW_LIVE_VIS = """**Live visibility pattern** (preferred for complex sessions):
1. Call \\`start_agent_in_docker\\` for each ready task (same message = parallel start)
2. Poll with \\`get_agent_output\\` following the **Polling Cadence** below — never wait arbitrary amounts of time
3. On \\`status: completed/failed\\` → \\`bd close\\` / \\`update_progress\\` → loop back to \\`bd ready\\`

### Polling Cadence

Always poll on a schedule. The \\`get_agent_output\\` response includes \\`Elapsed\\`, \\`next_line\\`, and a phase hint — use them to decide when to poll next.

| Phase | Signal | Next poll | Action |
|---|---|---|---|
| Spin-up | 0 lines, elapsed <45s | ~10s | Normal — Docker initializing. Show "⏳ Initializing..." to user. |
| Spin-up stall | 0 lines, elapsed >45s | — | Auth or env issue. Surface warning to user; offer \\`docker kill <container>\\`. |
| Early execution | Lines appearing, status: running | ~20s | Show output to user. Record \\`next_line\\` from the response. |
| Active execution | Lines growing, status: running | ~30s | Pass \\`since_line: <next_line>\\` to receive only new lines. |
| Long-running | elapsed >10m, line count not growing for 3 polls | — | Stall suspected. Ask user: retry / kill / wait. |
| Done | status: completed or failed | — | Close bead, update progress, dispatch next task. |

**Incremental polling (preferred):** Each \\`get_agent_output\\` response returns a \\`next_line\\` integer. Pass it as \\`since_line\\` in the next call to receive only new output. Avoids re-reading the same lines on every poll.

**Stall kill:** \\`Bash("docker kill <container_name>")\\` — the container exits non-zero, the \\`.exit\\` file is written, and the next poll resolves to \\`failed\\`.

**Spin-up speedup (v3.3.1):** Docker image rebuilds are now skipped when the image is current (Dockerfile unchanged since last build). First agent of the session: ~30–60s build. Every agent after: ~3s spin-up. The \\`start_agent_in_docker\\` response now reports \\`Image build: skipped\\` or \\`rebuilt\\` so you can see which path you took.

**Expected duration by max_turns:**

| max_turns | Typical wall time | Suggested poll count |
|---|---|---|
| 10 (read + single edit) | 1–3 min | 3–6 polls at 20–30s |
| 20 (small feature) | 3–8 min | 6–12 polls at 30s |
| 30 (medium feature) | 8–15 min | 10–20 polls at 30–60s |
| 45–60 (large) | 15–30 min | 15–30 polls at 60s |

### Task Sizing and max_turns"""

assert tpl.count(OLD_LIVE_VIS) == 1, f"live-vis anchor not unique: {tpl.count(OLD_LIVE_VIS)}"
tpl = tpl.replace(OLD_LIVE_VIS, NEW_LIVE_VIS, 1)
print("templates.js: scrum-master — Polling Cadence section inserted")

# ── 5b. Update the Execution Loop step 3 ────────────────────────────────────

OLD_EXEC_STEP3 = """3. Poll with \\`get_agent_output\\` until complete — show log output verbatim to the user"""
NEW_EXEC_STEP3 = """3. Poll with \\`get_agent_output\\` following the **Polling Cadence** above — pass \\`since_line: <next_line>\\` from each response into the next call for incremental output"""

assert tpl.count(OLD_EXEC_STEP3) == 1, f"exec-step3 anchor not unique: {tpl.count(OLD_EXEC_STEP3)}"
tpl = tpl.replace(OLD_EXEC_STEP3, NEW_EXEC_STEP3, 1)
print("templates.js: scrum-master — Execution Loop step 3 updated to reference Polling Cadence")

# Write templates.js
with open("src/templates.js", "w", encoding="utf-8") as f:
    f.write(tpl)

# Verify syntax + parse
r = subprocess.run(["node", "--check", "src/templates.js"], capture_output=True, text=True)
if r.returncode != 0:
    print("SYNTAX ERROR in templates.js:", r.stderr)
    sys.exit(1)
print("node --check src/templates.js: OK")

r = subprocess.run(
    ["node", "--input-type=module", "-e",
     "import('./src/templates.js').then(() => console.log('PARSE OK')).catch(e => { console.error(e.message); process.exit(1); })"],
    capture_output=True, text=True, timeout=15
)
if r.returncode != 0:
    print("PARSE ERROR:", r.stderr or r.stdout)
    sys.exit(1)
print(r.stdout.strip())

print("SUCCESS: v331 — agent orchestration overhaul applied to index.js + templates.js")
