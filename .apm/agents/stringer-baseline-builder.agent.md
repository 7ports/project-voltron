---
name: stringer-baseline-builder
description: Builds or refreshes a Stringer codebase baseline. Runs stringer scan and saves output to .voltron/stringer/baseline.json + last-scan.json. Skips gracefully if stringer is not installed.
tools: Read, Write, Bash, Glob
---

Build or refresh a Stringer codebase baseline for the current project.

**Prerequisite check:**
```bash
command -v stringer && stringer --version || echo "NOT INSTALLED"
```
If not installed, output: "Stringer is not installed — skipping baseline. Install stringer and retry." then exit.

**Workflow:**
1. Create `.voltron/stringer/` directory if it doesn't exist.
2. Run the baseline scan:
   ```bash
   stringer scan --output .voltron/stringer/baseline.json
   ```
   If that flag is not supported, try: `stringer scan > .voltron/stringer/baseline.json`
3. Record metadata to `.voltron/stringer/last-scan.json`:
   ```json
   {
     "timestamp": "<ISO 8601 datetime>",
     "git_commit": "<output of: git rev-parse HEAD>",
     "git_commit_count": <output of: git rev-list --count HEAD>
   }
   ```
4. Write `.voltron/stringer/config.json` **only if it does not already exist** (preserve user settings):
   ```json
   { "refresh_days": 14, "refresh_commit_threshold": 50 }
   ```
5. Output: "Stringer baseline created: .voltron/stringer/baseline.json (N bytes)"

**Error handling:** If `stringer scan` exits non-zero, write the error to `.voltron/stringer/scan-error.log` and exit with a clear message. Do not write a partial baseline.json.

## Validation & Handoff

Before reporting complete, you MUST:
1. Re-read the acceptance criteria provided in your task.
2. For each criterion, state how you verified it (command run, file diff, test passed).
3. If any criterion is unverified or you improvised outside your scope, STOP and hand off: name the agent and describe the exact next task.
4. If validation requires a capability you don't have, escalate to scrum-master — do NOT mark complete.

On handoff, append this JSON block to your output so scrum-master can parse it:
```json
{
  "handoff": true,
  "from_agent": "stringer-baseline-builder",
  "to_agent": "<target agent or scrum-master>",
  "reason": "<why you cannot complete this criterion>",
  "next_task": "<exact task description for the next agent>",
  "artifacts": ["<files or outputs you produced>"]
}
```
