// voltron-evals/lib/shape-loader.js
//
// Stage 5: resolves Broad-layer instance YAMLs that use the
//   kind: broad
//   extends: <shape-rel-path>
//   parameters: { ... }
// schema. Loads the referenced shape, merges shape defaults with the
// instance's parameters, and emits a job-shaped object the runner can drive
// through the existing dispatch pipeline (judge routing, programmatic
// scorers, artifact capture).
//
// The runner stays shape-agnostic — all prompt-template knowledge lives
// here, keyed by shape id. Adding a 7th shape later means adding one entry
// to PROMPT_BUILDERS plus a matching shape YAML; no runner edits required.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

// Per-shape prompt builders. Each takes the resolved `parameters` block from
// an instance and returns a single string the AUT receives as its task. The
// builders deliberately echo the instance's parameter values verbatim so the
// AUT prompt is reproducible from the instance YAML alone.

function asList(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function joinPaths(paths) {
  return asList(paths).map(p => `  - ${p}`).join("\n");
}

const PROMPT_BUILDERS = {
  micro_single_file_edit(p) {
    const pi = p.prompt_inputs || {};
    const lines = [
      `Task: ${pi.verb_spec || "(no verb spec supplied)"}`,
      "",
      `Target file: ${pi.target_file || "(no target supplied)"}`,
    ];
    if (pi.anchor) lines.push(`Anchor in target: ${pi.anchor}`);
    if (pi.signature) lines.push(`Required signature: ${pi.signature}`);
    lines.push("");
    lines.push("Constraints:");
    lines.push("- Change ONLY the target file. No edits elsewhere.");
    lines.push("- Stay within the line caps the harness enforces (defaults: +60 / -30).");
    lines.push("- Emit one `[STEP N]` line before every tool call and finish with `[DONE]`.");
    if (Array.isArray(p.expected_files) && p.expected_files.length) {
      lines.push("");
      lines.push("Expected changed file set:");
      lines.push(joinPaths(p.expected_files));
    }
    return lines.join("\n");
  },

  micro_test_writer(p) {
    const pi = p.prompt_inputs || {};
    const lines = [
      `Task: write tests covering: ${pi.behaviour_spec || "(no behaviour spec)"}`,
      "",
      `Implementation under test: ${pi.implementation_path || "(none)"}`,
      `Test file path (must create at this exact path): ${pi.test_path || "(none)"}`,
    ];
    if (pi.framework_hint) lines.push(`Framework: ${pi.framework_hint}`);
    lines.push("");
    lines.push("Constraints:");
    lines.push("- Do NOT edit the implementation file — write tests only.");
    lines.push(`- The test runner (\`${p.test_command || "(test command tbd)"}\`) must exit 0 against your tests.`);
    lines.push("- Emit one `[STEP N]` line before every tool call and finish with `[DONE]`.");
    return lines.join("\n");
  },

  micro_validator(p) {
    const pi = p.prompt_inputs || {};
    const verdictTerms = pi.verdict_terms || { pass: "PASS", fail: "FAIL" };
    const fixtures = asList(p.fixture?.fixtures);
    const lines = [
      `Task: run the validator command across each fixture below and report a verdict per fixture.`,
      "",
      `Validator command: ${pi.command_hint || "(unspecified — pick the appropriate tool for the AUT)"}`,
      `Verdict terms: emit \"${verdictTerms.pass}\" for passing fixtures, \"${verdictTerms.fail}\" for failing fixtures.`,
      "",
      "Fixtures:",
    ];
    for (const f of fixtures) {
      lines.push(`- id=${f.id} dir=${f.dir} expected=${f.expected_verdict}`);
    }
    lines.push("");
    lines.push("Constraints:");
    lines.push("- READ-ONLY: do NOT modify any file in any fixture directory.");
    lines.push("- Emit each fixture's verdict in your final `[STEP]` block using the exact verdict terms above.");
    lines.push("- End with `[DONE]`.");
    return lines.join("\n");
  },

  micro_committer(p) {
    const pi = p.prompt_inputs || {};
    const action = p.canonical_action || "(unspecified)";
    const lines = [
      `Task: perform exactly one publish action: ${action}.`,
      "",
      `Workspace: ${p.fixture?.dir || "(no fixture dir)"}`,
    ];
    if (pi.commit_message_hint) lines.push(`Commit subject hint: ${pi.commit_message_hint}`);
    if (pi.branch_name) lines.push(`Branch name: ${pi.branch_name}`);
    if (pi.pr_title) lines.push(`PR title: ${pi.pr_title}`);
    if (pi.pr_body_hint) lines.push(`PR body hint: ${pi.pr_body_hint}`);
    if (pi.target_env) lines.push(`Target env: ${pi.target_env}`);
    if (pi.entry_summary) lines.push(`Changelog entry: ${pi.entry_summary} (section: ${pi.section || "Added"})`);
    lines.push("");
    lines.push("Constraints:");
    lines.push("- Take ONLY the canonical action above. No source edits, no pushes unless the action is push.");
    lines.push("- Emit one `[STEP N]` line before every tool call and finish with `[DONE]`.");
    return lines.join("\n");
  },

  tier1_coordinator(p) {
    const pi = p.prompt_inputs || {};
    const lines = [
      `Task: ${pi.request_summary || "(no request)"}`,
      "",
      `Expected artifact kind: ${pi.expected_artifact_kind || "(unspecified)"}`,
    ];
    if (Array.isArray(pi.artifact_anchors) && pi.artifact_anchors.length) {
      lines.push("");
      lines.push("The produced artifact MUST contain each of these literal substrings:");
      for (const a of pi.artifact_anchors) lines.push(`- ${JSON.stringify(a)}`);
    }
    if (Array.isArray(p.expected_files) && p.expected_files.length) {
      lines.push("");
      lines.push("Expected artifact file(s):");
      lines.push(joinPaths(p.expected_files));
    }
    lines.push("");
    lines.push("Constraints:");
    lines.push("- Do NOT edit source code (paths under `src/`, `server/`, `client/`, `lib/`, language-specific source).");
    lines.push("- Use beads for any planning artifacts the request implies.");
    lines.push("- Emit `[STEP N]` lines and finish with `[DONE]`.");
    return lines.join("\n");
  },

  tier2_submanager(p) {
    const pi = p.prompt_inputs || {};
    const lines = [
      `Task: ${pi.task_summary || "(no task summary)"}`,
    ];
    if (Array.isArray(pi.acceptance_signals) && pi.acceptance_signals.length) {
      lines.push("");
      lines.push("Acceptance signals (the harness will check each):");
      for (const a of pi.acceptance_signals) lines.push(`- ${a}`);
    }
    const floor = p.dispatch_floor ?? 2;
    lines.push("");
    lines.push(`Sub-dispatch floor: dispatch at least ${floor} micro-agent(s) — do NOT edit substantive source yourself.`);
    if (Array.isArray(p.fixture?.expected_dispatch_targets) && p.fixture.expected_dispatch_targets.length) {
      lines.push(`Likely dispatch targets (advisory, not gating): ${p.fixture.expected_dispatch_targets.join(", ")}`);
    }
    lines.push("");
    lines.push("Constraints:");
    lines.push("- Compose micro-agents via `run_agent_in_docker`. Sub-managers that edit source directly fail tier discipline.");
    lines.push("- Submit a reflection at the end of the run.");
    lines.push("- Emit `[STEP N]` lines and finish with `[DONE]`.");
    return lines.join("\n");
  },
};

function readShape(extendsPath, repoRoot) {
  if (!extendsPath || typeof extendsPath !== "string") {
    throw new Error("Broad instance is missing required field 'extends' (path to shape YAML).");
  }
  const abs = path.isAbsolute(extendsPath) ? extendsPath : path.join(repoRoot, extendsPath);
  if (!existsSync(abs)) throw new Error(`Shape file not found: ${extendsPath}`);
  const raw = readFileSync(abs, "utf-8");
  const shape = parseYaml(raw);
  if (!shape || !shape.id) throw new Error(`Shape ${extendsPath} missing 'id' field.`);
  return { shape, shapePath: abs };
}

// Resolve a parsed instance YAML into a job-shaped object the runner can
// drive. Supports two schemas:
//   1. New (Stage 5+):  kind: broad,  extends: <shape-rel-path>,  parameters: {...}
//   2. Legacy (Stage 4 placeholder): flat instance with `shape:` and `agent_under_test:`
//
// Returns: {
//   agent_under_test, shape, prompt, max_turns, rubric, rubric_version_expected,
//   programmatic_signals, category, parameters, _shape_path, kind
// }
export function resolveBroadInstance(rawInstance, instancePath, repoRoot) {
  // §5.7: model-pinning rule — no instance is allowed to set a model.
  if (Object.prototype.hasOwnProperty.call(rawInstance, "model") ||
      Object.prototype.hasOwnProperty.call(rawInstance, "model_override")) {
    throw new Error(`Instance ${instancePath} contains a forbidden 'model' field (model-pinning rule, §5.7)`);
  }

  // Legacy flat instance — keep working until generator-produced ones replace them.
  const isNewSchema = (rawInstance.kind === "broad") && rawInstance.extends;
  if (!isNewSchema) {
    if (!rawInstance.agent_under_test || !rawInstance.shape) {
      throw new Error(`Instance ${instancePath}: legacy schema missing 'agent_under_test' or 'shape', and not a 'kind: broad' + 'extends:' instance either.`);
    }
    return {
      agent_under_test: rawInstance.agent_under_test,
      shape: rawInstance.shape,
      prompt: rawInstance.prompt || "",
      max_turns: rawInstance.max_turns || 10,
      rubric: rawInstance.rubric || `voltron-evals/rubrics/shapes/${rawInstance.shape}.md`,
      rubric_version_expected: rawInstance.rubric_version_expected || "1.0.0",
      programmatic_signals: rawInstance.programmatic_signals || {},
      category: rawInstance.category || rawInstance.shape,
      parameters: rawInstance,
      kind: "shape-instance",
      _shape_path: null,
    };
  }

  const { shape, shapePath } = readShape(rawInstance.extends, repoRoot);
  const params = rawInstance.parameters || {};

  const agent = params.agent_under_test || rawInstance.agent_under_test;
  if (!agent) {
    throw new Error(`Instance ${instancePath}: 'parameters.agent_under_test' is required for kind=broad.`);
  }

  // Pull defaults from shape — its `parameters` block declares defaults
  // (declarative, per Stage 4) under each key's `default:` field.
  const shapeParams = shape.parameters || {};
  const defaultMaxTurns = shapeParams.max_turns?.default ?? 10;
  const defaultLineCaps = shapeParams.line_caps?.default ?? null;

  const resolved = {
    agent_under_test: agent,
    prompt_inputs: params.prompt_inputs || {},
    fixture: params.fixture || {},
    expected_files: params.expected_files ?? [],
    forbidden_files: params.forbidden_files ?? [],
    canonical_action: params.canonical_action,
    test_command: params.test_command,
    expected_beads_floor: params.expected_beads_floor ?? shapeParams.expected_beads_floor?.default ?? 0,
    source_globs: params.source_globs ?? shapeParams.source_globs?.default,
    line_caps: params.line_caps ?? defaultLineCaps,
    dispatch_floor: params.dispatch_floor ?? shapeParams.dispatch_floor?.default,
    max_turns: params.max_turns ?? defaultMaxTurns,
  };

  // Build the prompt from shape-keyed builders.
  const builder = PROMPT_BUILDERS[shape.id];
  if (!builder) {
    throw new Error(`No prompt builder registered for shape '${shape.id}'.`);
  }
  const prompt = builder(resolved);

  return {
    agent_under_test: agent,
    shape: shape.id,
    prompt,
    max_turns: resolved.max_turns,
    rubric: shape.rubric || `voltron-evals/rubrics/shapes/${shape.id}.md`,
    rubric_version_expected: shape.rubric_version_expected || "1.0.0",
    programmatic_signals: shape.programmatic_signals || {},
    category: shape.id,
    parameters: resolved,
    kind: "shape-instance",
    _shape_path: shapePath,
  };
}

export function loadShapeYaml(extendsPath, repoRoot) {
  return readShape(extendsPath, repoRoot).shape;
}
