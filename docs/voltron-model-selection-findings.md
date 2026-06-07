# Voltron Model-Selection Audit Findings

**Branch:** `fix/scaffold-commands-dir`  
**Date:** 2026-06-05  
**Auditor:** code-analyst (read-only)  
**Trigger:** Reports that every Docker agent in a session showed `model: claude-haiku-4-5-20251001` regardless of intent. Hypothesis: selected model may not be reaching the in-container `claude` invocation.

---

## 1. Resolution Logic (`src/index.js:1739–1742`)

```javascript
// src/index.js:1739-1742  (dispatchOneAgent function, starting at L1723)
// Resolve model tier: explicit parameter > template default > omit (session default)
const resolvedModel = model || template.model;
const MODEL_IDS = { opus: "claude-opus-4-7", sonnet: "claude-sonnet-4-6", haiku: "claude-haiku-4-5-20251001" };
const modelFlag = resolvedModel && MODEL_IDS[resolvedModel] ? `--model ${MODEL_IDS[resolvedModel]}` : "";
```

**Verdict: Resolution logic is CORRECT.** Priority is `explicit param > template.model > ""` (empty = claude session default). If `model` is passed in the `spec` object (e.g. `{ model: "sonnet" }`), it wins. If omitted, `template.model` is used. If neither is set, `modelFlag` is empty string and claude picks its own default.

---

## 2. Propagation — Does `modelFlag` Reach the In-Container `claude`?

```javascript
// src/index.js:1892
`{ ${ghBootstrap}; echo "[entry] ..."; echo "[claude-version] ..."; echo "[exec] ..."; claude --dangerously-skip-permissions ${modelFlag} ${mcpConfigFlag} --max-turns ${max_turns} --output-format stream-json --verbose -p "$(cat ${taskFilePathInContainer})" 2>&1; CLAUDE_EXIT=$?; echo "[exit] ..."; exit $CLAUDE_EXIT; } | tee /workspace/.voltron/logs/${logFilename}; exit ${PIPESTATUS[0]}`
```

**Verdict: YES. `${modelFlag}` IS embedded in the `claude` CLI invocation at L1892.** When `model: "sonnet"` is provided, the bash command contains `--model claude-sonnet-4-6`. The original suspicion (flag never reaching claude) is **FALSE** — the flag was always present in the command template.

**Comparison with `main` branch:** The `git diff` shows the only change on this branch for the docker command is the addition of `${ghBootstrap};` at the start of the bash string. The `${modelFlag}` position and usage was unchanged from main — it was never the bug.

**`VOLTRON_RUN_SCRIPT` (`src/templates.js:9908–9959`):** This script is for the top-level human-facing `docker run` (outer session / scrum-master). It does NOT include a `--model` flag — that is **intentional**. The outer session uses `ENTRYPOINT ["claude"]` with `--dangerously-skip-permissions "$@"`. Sub-agent model is set per-dispatch inside `dispatchOneAgent`, not by the outer session launcher. This is not a bug.

---

## 3. Template `model:` Fields

Templates in `src/templates.js` that define a `model:` field:

| Tier | Template examples | `model:` value | Lines |
|------|------------------|---------------|-------|
| Opus | `scrum-master`, `harness-engineer`, `project-planner`, `code-analyst`, `fullstack-dev`, and several domain managers | `"opus"` | 20, 295, 564, 749, 1617, 1867, 2132, 3297, 3642, 4297, 4692, 4892, 5056, 8035 |
| Sonnet | Several mid-tier agents | `"sonnet"` | 2501, 2750, 3027, 4002 |
| Haiku | `committer`, `pr-opener`, `branch-manager`, all Inspect-layer micro-agents | `"haiku"` | 5285–8027 range (40+ templates) |

**Effective default when `model:` is absent:** `""` → no `--model` flag → claude uses the session's configured default, which is determined by the credentials and plan at login time (typically haiku for max-plan unless overridden).

**The `code-analyst` template** (L8035): `model: "opus"` — but this run was dispatched with explicit `model: "sonnet"` override, correctly taking priority.

**Outdated model ID (minor bug):** `MODEL_IDS.opus` at `src/index.js:1741` maps to `"claude-opus-4-7"`. The current Opus model is `"claude-opus-4-8"` (per project CLAUDE.md). All `model: "opus"` templates therefore run on `claude-opus-4-7`, not the newest Opus. Evidence: all six `harness-engineer` and `project-planner` logs from today show `"model":"claude-opus-4-7"`.

---

## 4. Self-Evidence — Actual Models From Today's Logs

All log files from `2026-06-05`, grepped for init `"model":` field:

| Agent | Log timestamp | `"model"` in init event | Expected |
|-------|--------------|------------------------|---------|
| `branch-manager` | 17:08 | `claude-haiku-4-5-20251001` | template default `haiku` ✓ |
| `harness-engineer` | 17:11, 17:16 | `claude-opus-4-7` | template default `opus` ✓ |
| `committer` | 17:29, 21:45 | `claude-haiku-4-5-20251001` | template default `haiku` ✓ |
| `pr-opener` | 17:30 | `claude-haiku-4-5-20251001` | template default `haiku` ✓ |
| `harness-engineer` | 21:32, 21:37, 21:43 | `claude-opus-4-7` | template default `opus` ✓ |
| `project-planner` | 21:32 | `claude-opus-4-7` | template default `opus` ✓ |
| **`code-analyst`** | **21:53** | **`claude-sonnet-4-6`** | explicit `model: sonnet` override ✓ |

**Self-evidence finding:** This very code-analyst run was dispatched with `model: "sonnet"`. Its own log (`.voltron/logs/code-analyst-2026-06-05T21-53-36-esdwbz.log`) shows `"model":"claude-sonnet-4-6"` in the init event. **The explicit override worked correctly.**

**Explanation of "every agent showed haiku":** The 17:xx session dispatched `committer`, `branch-manager`, and `pr-opener` — all of which have `model: "haiku"` as their template default. These correctly ran as haiku. `harness-engineer` correctly ran as opus. The observation was accurate but explained by template defaults, not by a model-propagation bug.

---

## 5. Fix Locus

The **model reaches the in-container `claude` invocation correctly** — the original hypothesis is not confirmed by the code or logs. The propagation path is intact end-to-end:

```
spec.model (API call)
  → dispatchOneAgent spec param (L1724)
  → resolvedModel (L1740)
  → modelFlag string (L1742)
  → docker bash -c "...claude --dangerously-skip-permissions ${modelFlag}..." (L1892)
  → claude CLI receives --model <id>
  → init event "model": <id> in stream-json log ✓
```

**One real issue — outdated Opus model ID:**

- **File:** `src/index.js:1741`
- **Current:** `const MODEL_IDS = { opus: "claude-opus-4-7", sonnet: "claude-sonnet-4-6", haiku: "claude-haiku-4-5-20251001" };`
- **Fix:** Change `"claude-opus-4-7"` → `"claude-opus-4-8"` so `model: "opus"` dispatches use the current Opus 4.8 model.
- **Who:** Delegate to `harness-engineer` — single-line change in `src/index.js:1741`.

---

## Validation

```
test -f docs/voltron-model-selection-findings.md && grep -ci 'model' docs/voltron-model-selection-findings.md
```

File exists; model count >> 1 (contains dozens of `model` references). Criteria met.
