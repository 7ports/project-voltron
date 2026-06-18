# Voltron Eval-Parity Methodology — opus→sonnet Demotion Gate (Tier C1)

> **Scope:** Project Voltron, `main`. **DESIGN ONLY** — this document specifies a reproducible
> methodology. It runs no eval and edits no template. It is the blueprint `/scrum-master`
> decomposes into eval-run tasks (assigned to a runner/operator) and template-demotion tasks
> (assigned to `@agent-harness-engineer`).
> **Authority on intent:** `docs/voltron-cost-optimization-plan.md` §C1 — the largest theoretical
> $ lever, *deliberately gated* behind eval-parity proof. No `model:` field changes until the bar
> below is met, and demotion is presented to a human as an **option with evidence**, never a
> unilateral decision.
> **Harness ground truth:** verified against `voltron-evals/runner.js`,
> `voltron-evals/lib/template-hash.js`, the task/instance YAMLs, and `src/templates.js` as they
> exist today (see line/locus citations throughout).

---

## 0. The load-bearing constraint that shapes this entire methodology

`voltron-evals/runner.js` **refuses to override an agent-under-test's model**. `buildAutArgs`
(`runner.js:348-358`) constructs the AUT dispatch with `{agent_name, task, max_turns}` and then
*throws* if a `model` or `model_override` key is present:

```js
if ("model" in args || "model_override" in args) {
  throw new Error("AUT dispatch args contain a forbidden 'model' key (§5.7 model-pinning rule violated)");
}
```

This is by design (DESIGN §0, §5.7): the harness must test *the agent as shipped*, on its
template-pinned tier. **Consequence:** you cannot test "researcher on sonnet" with a runner flag.
The only way to evaluate a candidate on sonnet is to **change its `model:` field in
`src/templates.js`** and re-run. That single edit *is* the experiment and *is* the eventual
production change — so the methodology is "edit on a throwaway branch → measure → keep or revert."

**The one exception is the judge.** The runner *does* expose `--judge-model=opus|sonnet|haiku`
(`runner.js:63`, default `opus`, applied to the Deep-layer judge at `runner.js:525`). This gives
`voltron-judge` a parity path that needs **no template edit at all** (see §4.3) — re-grade the same
artifacts under each judge tier and measure scorecard agreement.

**Cache safety (the linchpin).** `templateHashFor` (`lib/template-hash.js:25-37`) hashes a payload
that *includes* `templateModel: entry.model`. Therefore editing a `model:` field changes the
`template_hash`, so a sonnet run can **never** cache-hit an opus baseline scorecard
(`shouldSkip`/`findLastPassingScorecard`, `runner.js:283-294`). Both scorecards coexist on disk
under different hashes — exactly what we need to compare arms.

---

## 1. Candidate set & rationale

The cost-opt plan (§C1) and baseline (`docs/voltron-cost-baseline.md:128`) nominate **code-analyst,
voltron-judge, researcher**. Confirmed, with one refinement: each has a *different* coverage
posture, which dictates a *different* parity procedure. None should be demoted on the same evidence.

| Candidate | `model:` locus (`src/templates.js`) | What "quality" means for this agent | Eval coverage today | Parity procedure |
|---|---|---|---|---|
| **code-analyst** | **line 8093** (`model: "opus"`) | Correct *decomposition*: well-formed work-plan table, acyclic beads dep graph, correct tier assignment, no source edits, dispatches inspect micro-agents rather than editing. Reasoning quality is judged, not just measured. | **Strong.** Deep task **T3-002** (Opus `voltron-judge`, 7 criteria, evidence-cited) **+** Broad instance `instances/tier1_coordinator/code-analyst.yaml` (programmatic-only). | §4.1 AUT-tier swap. Best-instrumented candidate — start here. |
| **researcher** | **line 5092** (`model: "opus"`) | *Research* quality: source coverage, finding accuracy, synthesis, honest citation. Hard to capture programmatically (artifact-presence ≠ research quality). | **Weak.** Only the Broad instance `instances/tier1_coordinator/researcher.yaml` (programmatic-only: checks `## Sources`/`## Findings` anchors + file presence). **No Deep task.** | §4.2 — needs a judged signal first (new Deep task **or** Haiku-subjective opt-in). Programmatic-only cannot detect a quality regression. |
| **voltron-judge** | **line 4928** (`model: "opus"`) | *Grading* quality: does the cheaper judge assign the **same verdicts** an Opus judge does on the same artifacts? A sloppy judge silently corrupts the `harness-engineer` feedback loop. | **Special.** Excluded from the Broad layer by the anti-self-grading guard (`runner.js:44`, DESIGN §3.5); it *is* the Deep-layer judge. | §4.3 — judge-tier swap via `--judge-model=sonnet` on **frozen** Deep artifacts. No template edit needed to measure; subject to the §5 anti-loop guard. |

**No additions.** The other opus agents (`fullstack-dev`, `csharp-dev`, `qa-tester`,
`devops-engineer`, `scene-architect`, `harness-engineer`, `project-planner`,
`docs/voltron-cost-baseline.md:46-59`) do genuine multi-file reasoning/implementation — exactly the
regime where the Opus→Sonnet uplift is largest. They are out of scope for *this* campaign; revisit
only if these three pass and the bar proves trustworthy.

**Honest caveat for researcher and voltron-judge:** both are *low-determinism* outputs (free-form
research; subjective grading). The parity bar is correspondingly softer and needs more trials. If
the evidence is ambiguous, the correct outcome is **"keep Opus,"** not "demote on a coin-flip."

---

## 2. Representative task sample

### 2.1 code-analyst — ready to run as-is
- **Deep (judged):** `voltron-evals/tasks/T3-002-decompose-trello.yaml` (AUT = `code-analyst`,
  `max_turns: 30`, rubric `rubrics/T3-002.md` v1.0.0). This is the quality signal.
- **Broad (programmatic):** `instances/tier1_coordinator/code-analyst.yaml`. Regression net only —
  confirms the sonnet run still emits `[DONE]`, stays in budget, and produces required artifacts.
- **Sample size:** **N = 5 trials per arm** (opus baseline, sonnet candidate) as the default; bump
  the *failing-or-borderline* arm to **N = 10** before any final call. Rationale: the judge and AUT
  are both stochastic; a single trial per arm is noise. 5 is the cost-bounded floor that lets you
  see a distribution; 10 is the tie-breaker. (This is explicitly *directional*, not a powered
  statistical test — see §3.4.)

### 2.2 researcher — coverage gap must be closed first
The only existing job is programmatic-only, which checks *artifact shape*, not *research quality* —
it literally cannot distinguish a great brief from a hollow one. **Minimal options (human picks one
in §7):**
- **(A) Add a Deep task** `T2-00x-research-brief.yaml` (AUT = `researcher`, `kind: deep`) with a
  rubric scoring source coverage, finding accuracy against a known-answer prompt, and citation
  honesty — graded by the Opus `voltron-judge`. Highest-fidelity, most work (~1 task + 1 rubric;
  a `@agent-harness-engineer` job, mirrors the T3-002 pattern).
- **(B) Opt the existing Broad shape into a narrow Haiku-subjective criterion**
  (`subjective_judge: "haiku"` on `rubrics/shapes/tier1_coordinator.md`, DESIGN §4.4) covering
  "do the findings substantively answer the request?". Cheapest; lower fidelity; **note:** Haiku
  judging Sonnet-vs-Opus research quality is a weak instrument — acceptable only as a screen.
- **(C) Human spot-grade** 5 sonnet briefs vs 5 opus briefs blind. Most honest for a fuzzy output;
  doesn't scale, but this is a one-time gate.
- **Sample size:** N = 5 per arm for (A)/(B); N = 3–5 blind pairs for (C).

### 2.3 voltron-judge — judge a frozen artifact corpus
Do **not** re-run AUTs to test the judge (AUT nondeterminism would confound judge variance). Instead
**freeze a corpus of already-captured Deep run directories** (the bundles already on disk under
`voltron-evals/results/T1-001/…`, `T2-001/…`, `T3-001/…`, `T3-002/…`, `T3-003/…`) and re-grade each
*fixed* artifact set under both judge tiers. **Sample:** all **7 Deep tasks × ≥3 re-grades per judge
tier** (judge stochasticity is the only variable; artifacts are constant). See §4.3 for the
mechanism and its one harness caveat.

---

## 3. Parity metric & pass threshold

### 3.1 The scorecard is the measurement instrument
Every run writes `results/<id>/<ts>/scorecard.json` (`runner.js:574`). The fields that matter
(confirmed against `results/T3-002/2026-05-26T18-35-54-594/scorecard.json`):
- `aggregates` — per-dimension score in **[0,1]** (`correctness`, `decomposition`,
  `tier_discipline`, `reflection_honesty`, `doc_hygiene`, `alexandria_usage`; `null` = N/A,
  excluded from aggregation).
- `criteria[]` — each with `verdict ∈ {MET, UNMET, PARTIAL, CANNOT_ASSESS}` and `score ∈ {0, 0.5, 1, null}`.
- `judge_model`, `template_hash`, `scored_via` — provenance; used to bucket arms.

### 3.2 Define the overall score
For a scorecard, compute the **rubric-weighted overall**:

```
overall = Σ_d ( weight_d × aggregate_d )   over dimensions d where aggregate_d ≠ null
          ───────────────────────────────
                 Σ_d weight_d  (same d)
```

Weights come from the pinned rubric's "Dimensions and weights" table (e.g. `rubrics/T3-002.md`).
`overall ∈ [0,1]`. Report **mean and spread** of `overall` across the N trials in each arm.

### 3.3 Pass threshold (numeric, non-inferiority)
Let `ε = 0.05` (5% of the 0–1 scale) be the non-inferiority margin. **Sonnet PASSES for an agent
iff ALL of:**

1. **Overall non-inferiority:** `mean(overall_sonnet) ≥ mean(overall_opus) − ε`.
2. **No criterion regression:** for every rubric criterion, the sonnet arm's **majority verdict**
   is **not worse** than the opus arm's majority verdict, where the verdict order is
   `UNMET < PARTIAL < MET` (`CANNOT_ASSESS` is neutral — ignored unless it *replaces* a prior MET,
   which counts as a regression). "Majority" = strict majority of that arm's trials.
3. **Broad/programmatic floor (deterministic):** every programmatic signal the agent's Broad
   instance checks stays green on the sonnet arm — `done_line_present: true`, budget respected
   (`budget_utilization ≤ 1.0`, no `max_turns` truncation), and the expected-artifact / no-source-edit
   checks pass exactly as on opus. These are model-agnostic measurements of behavior; any flip here
   is an automatic fail regardless of the judged score.
4. **No ungradeable runs:** zero `cannot_grade` and zero parse failures in the sonnet arm.

**Ties/regressions handling:** condition 1 treats a difference within ±ε as a tie → that condition
passes. Condition 2 is the guardrail that stops an "averages-look-fine" pass from hiding a specific
capability someone relies on (e.g. tier assignment going from MET→PARTIAL). A regression on **any**
of 2/3/4 fails the candidate even if the overall mean is higher.

### 3.4 Statistical honesty
N = 5 (even 10) is **directional, not a powered significance test**. Do not report p-values. Report:
mean ± min/max per arm, the per-criterion majority-verdict table, and the raw scorecard paths so a
human can audit. Where arms are within ε *and* show no criterion regression, the honest statement is
"no detectable quality difference at this sample size," and demotion becomes a reasonable
*cost-driven* option — surfaced to a human, per §5.

---

## 4. Run procedure (concrete — executable without further design)

> Pre-flight (all candidates): `node voltron-evals/runner.js --doctor` (coverage check), and confirm
> a clean tree so `git diff`-based scorers attribute changes to the AUT only. The runner spawns the
> MCP server (`src/index.js`) over stdio itself (`runner.js:321-331`); just ensure Docker is up
> (`scripts/voltron-run.sh` prerequisites).

### 4.1 code-analyst (AUT-tier swap) — the reference procedure

**Arm A — Opus baseline (no edit):**
```bash
# Deep (judged) — 5 trials. Single --task implies --cache=off (runner.js:77-79),
# so every invocation really runs; it never short-circuits to a cached scorecard.
for i in 1 2 3 4 5; do node voltron-evals/runner.js --task=T3-002 --judge-model=opus; done
# Broad (programmatic regression net) — 1 trial is enough (deterministic):
node voltron-evals/runner.js --instance=code-analyst
```
Scorecards land in `voltron-evals/results/T3-002/<ts>/scorecard.json` (and
`results/tier1_coordinator/code-analyst/<ts>/…` for the Broad run), each stamped with
`judge_model: "claude-opus-…"`, `template_hash: <H_opus>`, `agent_under_test: "code-analyst"`.

**Swap to sonnet (a `@agent-harness-engineer` task — NOT this planner, NOT the operator):**
On a throwaway branch `evalparity/code-analyst-sonnet`, change **`src/templates.js:8093`** from
`model: "opus",` to `model: "sonnet",`. Nothing else. This flips `template_hash` to `<H_sonnet>`
(via `lib/template-hash.js:32`), guaranteeing a cache miss against Arm A.

**Arm B — Sonnet candidate (same commands, judge held on opus):**
```bash
for i in 1 2 3 4 5; do node voltron-evals/runner.js --task=T3-002 --judge-model=opus; done
node voltron-evals/runner.js --instance=code-analyst
```
> **Hold the judge constant.** Keep `--judge-model=opus` on *both* arms — the judge is the measuring
> instrument; only the AUT's tier is the independent variable.

**Compare:** bucket scorecards by `template_hash` (`<H_opus>` vs `<H_sonnet>`), compute §3.2 overall
per scorecard, then apply the §3.3 gate. A tiny read-only compare script (no LLM) is a reasonable
`@agent-harness-engineer` helper, but the comparison can also be done by hand from the JSON.

**Revert:** discard the throwaway branch (or `git checkout src/templates.js`). The edit only persists
if the candidate **passes** and a human approves the demotion (§5). The hash change means the next
sweep re-evaluates automatically — no manual cache bust.

### 4.2 researcher
Identical mechanics to §4.1 (swap **`src/templates.js:5092`** `opus → sonnet` on a throwaway branch),
**but** the judged signal must exist first (§2.2). If option (A): run `--task=T2-00x-research-brief`
×5 per arm. If option (B): run `--instance=researcher` ×5 per arm (the Haiku subjective criterion
fires automatically once the shape rubric opts in). If option (C): dispatch the researcher 5×/arm
and hand the briefs to a human for blind scoring. Same §3.3 gate; for (C) the "overall" is the human
rubric mean.

### 4.3 voltron-judge (judge-tier swap on frozen artifacts) — no template edit to measure
The clean experiment holds AUT artifacts fixed and varies only the judge. The runner couples AUT +
judge inside `runJob`, and there is **no existing "re-grade an existing run_dir" flag** — so use one
of:

- **Preferred (small harness affordance, a `@agent-harness-engineer` task):** add a
  `--judge-only=<run_dir>` mode that skips `buildAutArgs`/AUT dispatch and calls `dispatchJudge`
  (`runner.js:415-436`) against the artifacts already in `<run_dir>`, honoring `--judge-model`. Then:
  ```bash
  # For each frozen Deep run_dir, 3 re-grades per judge tier:
  node voltron-evals/runner.js --judge-only=results/T3-002/<frozen-ts> --judge-model=opus
  node voltron-evals/runner.js --judge-only=results/T3-002/<frozen-ts> --judge-model=sonnet
  ```
- **Zero-code fallback:** dispatch `voltron-judge` directly via `run_agent_in_docker`
  (`model: "opus"` vs `model: "sonnet"`) with the *same* `buildJudgePrompt` inputs
  (`runner.js:387-413`) pointed at one frozen `run_dir`, and diff the two emitted scorecards by hand.

**Metric for the judge specifically — verdict concordance, not overall score.** What matters is
whether sonnet *agrees with opus on the same evidence*:
- **Per-criterion verdict agreement ≥ 0.90** across all criteria over all 7 frozen tasks
  (exact-match on the `MET/UNMET/PARTIAL/CANNOT_ASSESS` bucket).
- **Aggregate delta:** `|overall_sonnet − overall_opus| ≤ ε (0.05)` per task.
- **No evidence degradation:** sonnet scorecards still cite `file:line`/log-line evidence per
  criterion (the judge's whole value; a sonnet judge that hand-waves `CANNOT_ASSESS` fails even at
  high numeric agreement).
- If it passes, the production change is editing **`src/templates.js:4928`** `opus → sonnet` — but
  see the §5 **anti-loop guard**: `voltron-judge` is human-change-control only, and harness-produced
  reflections must never tune it.

---

## 5. Decision rule, escalation & rollback

| Outcome | Definition | Action |
|---|---|---|
| **PASS** | All §3.3 conditions (or §4.3 for the judge) hold on the larger-N arm. | **Recommend demotion as an option-with-evidence.** Hand the human: the per-criterion verdict table, overall means ± spread, Broad-floor confirmation, and raw scorecard paths. On approval, `@agent-harness-engineer` edits the named `model:` locus, bumps `package.json`, and updates `docs/index.html` + `README.md` (CLAUDE.md doc rule). **The planner/harness never demotes unilaterally.** |
| **FAIL** | Overall drops > ε, **or** any criterion regresses (§3.3.2), **or** a Broad signal flips (§3.3.3), **or** any `cannot_grade` (§3.3.4). | **Keep Opus.** Revert the throwaway branch. Record the failing criterion/signal in the handoff so the reason is durable. |
| **PARTIAL** | Arms within ε on average but a single criterion is borderline, or trials disagree across runs. | **Gather more evidence before deciding:** (a) raise that arm to N = 10; (b) for researcher, upgrade the signal from option (B)→(A) (real judged Deep task); (c) consider a **cascading-escalation** guard (cost-opt `principles §2`): ship sonnet but auto-re-run on opus when the scorecard/confidence is low — a behavior change that itself needs human sign-off. |

**Rollback note.** Demotion is a **one-line `model:` change**, so rollback is trivial: revert that
line and bump `package.json`. Because `template_hash` includes `model`, reverting changes the hash,
so the next sweep automatically re-evaluates the agent on opus — no stale cache to bust, no other
file touched. Keep the demotion commit isolated (one agent per commit) so a single revert is clean.

---

## 6. Cost-benefit framing (directional, honest)

**Pricing correction up front.** The baseline doc's phrase "opus ~5× sonnet"
(`docs/voltron-cost-baseline.md:74,128`) is a **misstatement**: per the verified pricing table
(`docs/cost-optimization-principles.md:20-22,73`), **5× is Opus-vs-*Haiku***. **Opus-vs-Sonnet is
~1.7×**: input **$5.00 → $3.00**, output **$25.00 → $15.00**. So a clean opus→sonnet demotion saves
**~40% of that agent's model spend** (`1 − 3/5` input, `1 − 15/25` output), **not ~80%**. Any
campaign sizing must use 1.7×/~40%, or it will over-promise by ~2×.

**Per-agent directional savings** (input sizes from `docs/voltron-cost-baseline.md:56-59`; output
dominates total $ at 5× the input rate, so treat these as floors):

| Agent | Input tok/dispatch (baseline) | Invocation frequency | Directional saving if demoted (~40% of its model $) |
|---|---|---|---|
| **researcher** | ~11,186 | Per research dispatch (moderate) | Largest of the three per-call (biggest prompt); but volume is bursty — worth it only if research quality holds, which is the *hardest* to prove. |
| **voltron-judge** | ~9,330 | **7× per full Deep sweep** + Track-B postmortems | Predictable, repeated spend on a fixed cadence → cleanest ROI *if* verdict concordance holds (§4.3). A sweep's judge bill drops ~40%. |
| **code-analyst** | ~6,073 | Per analysis-coordination dispatch | Smallest per-call prompt of the three; best-instrumented (T3-002) so cheapest to *prove*. Good first domino. |

**Three honesty caveats that bound the headline:**
1. **Tokenizer drift:** Opus 4.7+ count up to **+35% tokens** vs older generations
   (`cost-opt-plan §C1`); cross-tier $ math must be re-baselined with `count_tokens` before quoting
   a firm number.
2. **Output, not input, dominates** long runs (output is 5× input rate). The table's input sizes
   understate the win for output-heavy agents (researcher) and overstate it for terse ones.
3. **Caching interaction:** Tier-A caching already discounts the *static prefix*; tiering discounts
   the *whole call*. They stack but aren't additive — measure realized spend, don't sum percentages.

**Bottom line:** the realistic prize is **~40% off each demoted agent's per-call model spend**,
concentrated where the agent runs often and on a predictable cadence (**voltron-judge** is the
cleanest ROI; **code-analyst** the cheapest to prove; **researcher** the highest per-call but
hardest to certify). This is a real lever — just ~half the size the "5×" framing implied.

---

## 7. Open questions (need human input before the campaign runs)

1. **Non-inferiority margin ε.** This doc proposes **ε = 0.05** and a strict no-criterion-regression
   guard. Is 5% the right tolerance, or should a regression-sensitive agent (voltron-judge) use a
   tighter ε = 0.02? *(Recommend: 0.05 for AUTs, 0.02 for the judge.)*
2. **researcher's quality signal (§2.2).** Pick **(A)** new judged Deep task, **(B)** Haiku-subjective
   opt-in, or **(C)** human blind grade. Programmatic-only **cannot** gate this demotion. *(Recommend:
   (A) — a one-task harness-engineer job that mirrors T3-002, for a real signal.)*
3. **voltron-judge re-grade mechanism (§4.3).** Approve the small `--judge-only=<run_dir>` runner
   affordance (clean, ~20 LOC) or accept the manual zero-code fallback? *(Recommend: build the flag —
   it makes judge parity reproducible and is reusable for future judge changes.)*
4. **Anti-loop interaction.** The harness's own anti-loop guard (README + DESIGN §7.3) says
   harness-produced reflections must never tune `voltron-judge`. A judge demotion is a legitimate
   *human* change — confirm the demotion will be made by human change-control and **excluded** from
   the reflection-driven `harness-engineer` path.
5. **Sample size vs cost.** N = 5/arm default, N = 10 for borderline. Acceptable, or fund N = 10
   across the board for a firmer call? *(Each opus trial ≈ a few cents AUT + ~one Opus judge call;
   N=10 across 3 agents ≈ tens of judge invocations — small, but confirm.)*
6. **Escalation appetite (PARTIAL row).** Is a cascading "ship sonnet, auto-re-run on opus when
   low-confidence" guard (itself a behavior change) on the table, or is the decision strictly
   binary keep/demote? *(This is the only path that captures *most* of the savings while bounding
   the quality risk — but it changes runtime behavior, so it needs explicit approval.)*

---

## 8. Phased roadmap (milestone-level — `/scrum-master` decomposes into tasks)

> Each phase is independently checkpointable. The planner produces this blueprint; the scrum-master
> turns each phase into eval-run tasks (operator) and template-edit tasks (`@agent-harness-engineer`).

- **Phase 1 — Instrument & baseline.** Resolve §7 Q1–Q2. Establish Arm-A (opus) baselines for all
  three candidates (code-analyst on T3-002 + Broad; researcher per the chosen signal; voltron-judge
  frozen-corpus baseline). *Deliverable:* opus scorecards on disk + a compare script. *Depends on:*
  human answers to ε and researcher-signal. *Key decision:* §7 Q1, Q2.
- **Phase 2 — code-analyst parity (the reference run).** Execute §4.1 both arms; apply §3.3 gate.
  *Deliverable:* PASS/FAIL/PARTIAL verdict with evidence table. *Depends on:* Phase 1. *Decision:* none
  to start; demotion decision is human at the end.
- **Phase 3 — voltron-judge parity.** Build/approve the §4.3 re-grade path; run frozen-corpus
  concordance. *Deliverable:* per-criterion agreement table + evidence-degradation check.
  *Depends on:* §7 Q3, Q4.
- **Phase 4 — researcher parity.** Stand up the chosen quality signal (§7 Q2), run both arms.
  *Deliverable:* verdict with evidence. *Depends on:* Phase 1 decision on the signal.
- **Phase 5 — Demotion decisions & rollback safety.** For each PASS, surface the option-with-evidence
  to a human; on approval, `@agent-harness-engineer` edits the named `model:` locus (one commit per
  agent), bumps `package.json`, updates `docs/index.html` + `README.md`. *Deliverable:* merged
  demotions (only those approved) + documented keep/revert for the rest. *Depends on:* Phases 2–4.

---

## Appendix — verified facts this methodology relies on

| Claim | Evidence |
|---|---|
| Runner forbids overriding AUT model | `voltron-evals/runner.js:348-358` (`buildAutArgs` throws on `model`/`model_override`) |
| Judge tier *is* overridable | `runner.js:46-66` (`--judge-model`, default `opus`), applied at `runner.js:525` |
| Editing `model:` busts the cache (no false cache-hit) | `lib/template-hash.js:28-34` includes `templateModel: entry.model`; skip logic `runner.js:283-294` |
| Single `--task`/`--instance` implies `--cache=off` | `runner.js:77-80` |
| Scorecard carries `aggregates`, `criteria[].verdict`, `judge_model`, `template_hash` | `results/T3-002/2026-05-26T18-35-54-594/scorecard.json` |
| code-analyst Deep coverage | `voltron-evals/tasks/T3-002-decompose-trello.yaml` (`agent_under_test: code-analyst`) |
| researcher has only Broad (programmatic) coverage | `instances/tier1_coordinator/researcher.yaml`; no `researcher` task under `tasks/` |
| voltron-judge excluded from Broad layer | `runner.js:44` (`BROAD_LAYER_EXCLUDED`), DESIGN §3.5 |
| `model:` loci | `src/templates.js` — voltron-judge **:4928**, researcher **:5092**, code-analyst **:8093** |
| Opus↔Sonnet is ~1.7× (not 5×) | `docs/cost-optimization-principles.md:20-22,73`; baseline's "5× sonnet" (`voltron-cost-baseline.md:74`) is the Opus↔**Haiku** ratio |
| Anti-loop guard on voltron-judge | `voltron-evals/README.md` (Anti-loop guard), DESIGN §7.3 |

> **Alexandria note (research protocol):** my role mandates consulting Alexandria
> (`mcp__alexandria__*`) at the start of research. In this container those tools are **not
> connected** (ToolSearch returned no `mcp__alexandria__*` match), so no guide could be read or
> updated. Flagging honestly rather than fabricating guidance — if a future run has Alexandria
> available, record reusable, tool-general findings (e.g. "how to A/B model tiers in an MCP eval
> harness") there; the project-specific design above stays in this doc per the Alexandria content
> boundary.
