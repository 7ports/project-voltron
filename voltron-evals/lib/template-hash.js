// voltron-evals/lib/template-hash.js
//
// Content-hash incremental caching helper (design §6.1, §7.6). Computes a
// sha256 over the behaviorally-relevant subset of an agent's entry in
// `src/templates.js` — content, description, tools, model, name. Other fields
// (filename, destination, tags) are deliberately excluded so they can change
// without invalidating every cache entry.

import crypto from "node:crypto";
import { TEMPLATES } from "../../src/templates.js";

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const keys = Object.keys(value).sort();
  const out = {};
  for (const k of keys) out[k] = canonicalize(value[k]);
  return out;
}

export function canonicalJSON(value) {
  return JSON.stringify(canonicalize(value));
}

export function templateHashFor(agentName) {
  const entry = TEMPLATES[agentName];
  if (!entry) throw new Error(`templateHashFor: unknown agent '${agentName}'`);
  const payload = {
    templateContent: entry.content ?? "",
    templateDescription: entry.description ?? "",
    templateTools: entry.tools ?? null,
    templateModel: entry.model ?? null,
    templateName: entry.name ?? agentName,
  };
  const hash = crypto.createHash("sha256").update(canonicalJSON(payload)).digest("hex");
  return `sha256:${hash}`;
}

export function listAgentNames() {
  return Object.keys(TEMPLATES).filter(k => TEMPLATES[k].category === "agent");
}
