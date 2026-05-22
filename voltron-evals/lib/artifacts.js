// voltron-evals/lib/artifacts.js
//
// Capture helpers used by runner.js per design §5.3. Each function is small,
// shells out to git/bd/fs, and returns the raw text or a parsed snapshot.
// Failures are non-fatal — the runner records what was captured and the judge
// flags any missing critical inputs via `cannot_grade: "missing_artifacts"`.

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = process.env.VOLTRON_REPO_ROOT || process.cwd();
const LOG_DIR = path.join(REPO_ROOT, ".voltron", "logs");
const REFLECTIONS_DIR = path.join(REPO_ROOT, "reflections");

function safe(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

export function mkRunDir(taskId, ts) {
  const dir = path.join(REPO_ROOT, "voltron-evals", "results", taskId, ts);
  return fs.mkdir(dir, { recursive: true }).then(() => dir);
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
}

export function gitHeadSha() {
  return safe(() => execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8" }).trim());
}

// Micro-agents under test do not commit; HEAD doesn't move during a run. To
// detect what the AUT changed we snapshot the working tree (tracked + untracked
// files in the dirty set) before and after, then diff by content hash.
export function workingTreeSnapshot() {
  const out = safe(() => execFileSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: REPO_ROOT, encoding: "utf-8" },
  ), "");
  const files = [];
  // -z output: "XY filename\0" with rename pairs separated by an extra \0.
  // We don't care about rename arrows here — collect every path that is
  // currently dirty (including untracked).
  const parts = out.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const xy = entry.slice(0, 2);
    const fname = entry.slice(3);
    if (!fname) continue;
    files.push(fname);
    // For "R " rename status the previous-name follows as the next entry.
    if (xy.startsWith("R")) { i++; }
  }
  const snap = {};
  for (const f of files) {
    snap[f] = safe(() => execFileSync("git", ["hash-object", "--", f], { cwd: REPO_ROOT, encoding: "utf-8" }).trim(), "deleted");
  }
  return snap;
}

// Files whose hash differs between two snapshots — i.e. the AUT's changes.
export function diffWorkingTreeSnapshots(pre, post) {
  const all = new Set([...Object.keys(pre), ...Object.keys(post)]);
  const changed = [];
  for (const f of all) {
    if ((pre[f] || null) !== (post[f] || null)) changed.push(f);
  }
  return changed.sort();
}

export function gitDiffPatch(preSha, postSha) {
  if (!preSha || !postSha) return "";
  return safe(() => execFileSync("git", ["diff", `${preSha}..${postSha}`], { cwd: REPO_ROOT, encoding: "utf-8" }), "");
}

// Patch of every dirty path (vs HEAD), including untracked files via no-index.
// Used to capture what the AUT did when it doesn't commit.
export function gitWorkingTreePatch() {
  return safe(() => execFileSync(
    "git", ["diff", "HEAD", "--"], { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
  ), "");
}

export function gitDiffNames(preSha, postSha) {
  if (!preSha || !postSha) return [];
  const out = safe(() => execFileSync("git", ["diff", "--name-only", `${preSha}..${postSha}`], { cwd: REPO_ROOT, encoding: "utf-8" }), "");
  return out.split("\n").filter(Boolean);
}

export function gitShortstat(preSha, postSha) {
  if (!preSha || !postSha) return { lines_added: 0, lines_deleted: 0 };
  const raw = safe(() => execFileSync("git", ["diff", "--shortstat", `${preSha}..${postSha}`], { cwd: REPO_ROOT, encoding: "utf-8" }), "");
  const ins = /(\d+)\s+insertion/.exec(raw); const del = /(\d+)\s+deletion/.exec(raw);
  return { lines_added: ins ? Number(ins[1]) : 0, lines_deleted: del ? Number(del[1]) : 0 };
}

export function fileListShortstat(files) {
  if (!files.length) return { lines_added: 0, lines_deleted: 0 };
  const raw = safe(() => execFileSync(
    "git", ["diff", "--shortstat", "HEAD", "--", ...files],
    { cwd: REPO_ROOT, encoding: "utf-8" },
  ), "");
  const ins = /(\d+)\s+insertion/.exec(raw); const del = /(\d+)\s+deletion/.exec(raw);
  return { lines_added: ins ? Number(ins[1]) : 0, lines_deleted: del ? Number(del[1]) : 0 };
}

export function beadsSnapshot() {
  const out = safe(() => execFileSync("bd", ["list", "--json"], { cwd: REPO_ROOT, encoding: "utf-8" }), "[]");
  return safe(() => JSON.parse(out), []);
}

export function listLogs() {
  if (!existsSync(LOG_DIR)) return [];
  return safe(() => readdirSync(LOG_DIR).map(f => ({ name: f, mtime: statSync(path.join(LOG_DIR, f)).mtimeMs })), []);
}

export function listReflections() {
  if (!existsSync(REFLECTIONS_DIR)) return [];
  return safe(() => readdirSync(REFLECTIONS_DIR).filter(f => f.endsWith(".json")), []);
}

// Find the most recent log file that mentions the AUT name and was created after `since`.
export function findAgentLog(agentName, since) {
  const candidates = listLogs()
    .filter(l => l.name.startsWith(`${agentName}-`) && l.mtime >= since)
    .sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) return null;
  return path.join(LOG_DIR, candidates[0].name);
}

export async function tailLog(logPath, maxBytes = 2_000_000) {
  if (!logPath || !existsSync(logPath)) return "";
  const stat = await fs.stat(logPath);
  const start = Math.max(0, stat.size - maxBytes);
  const fh = await fs.open(logPath, "r");
  const buf = Buffer.alloc(stat.size - start);
  try { await fh.read(buf, 0, buf.length, start); } finally { await fh.close(); }
  return buf.toString("utf-8");
}

export function findNewReflections(preList) {
  const post = new Set(listReflections());
  for (const f of preList) post.delete(f);
  return Array.from(post);
}

export async function capturePre() {
  return {
    gitSha: gitHeadSha(),
    beads: beadsSnapshot(),
    reflections: listReflections(),
    workingTree: workingTreeSnapshot(),
    timestamp: Date.now(),
  };
}

export async function capturePost(agentName, pre) {
  const gitSha = gitHeadSha();
  const beads = beadsSnapshot();
  const logPath = findAgentLog(agentName, pre.timestamp);
  const log = await tailLog(logPath);
  const newReflections = findNewReflections(pre.reflections);
  const workingTree = workingTreeSnapshot();
  return { gitSha, beads, logPath, log, newReflections, workingTree };
}

// Write the per-run artifact bundle into runDir. Returns the paths map so the
// runner can include them in the judge prompt.
export async function writeArtifacts(runDir, ctx) {
  const { task, taskYamlPath, rubricPath, pre, post, programmatic, journal } = ctx;
  const paths = {
    run_dir: runDir,
    task_yaml: path.join(runDir, "task.yaml"),
    rubric: path.join(runDir, "rubric.md"),
    log: path.join(runDir, "log.txt"),
    diff: path.join(runDir, "diff.patch"),
    beads_pre: path.join(runDir, "beads-pre.json"),
    beads_post: path.join(runDir, "beads-post.json"),
    journal: path.join(runDir, "journal-during.json"),
    programmatic: path.join(runDir, "programmatic.json"),
    reflection: post.newReflections.length ? path.join(runDir, "reflection.json") : null,
  };
  await fs.copyFile(taskYamlPath, paths.task_yaml).catch(() => {});
  await fs.copyFile(rubricPath, paths.rubric).catch(() => {});
  await fs.writeFile(paths.log, post.log || "", "utf-8");
  // Prefer the AUT-changed file list (uncommitted working-tree delta) — that's
  // what micro-agents do. Fall back to commit-range diff for tasks where the
  // AUT actually commits.
  const changedFiles = ctx.changedFiles || [];
  const aut_patch = changedFiles.length
    ? safe(() => execFileSync("git", ["diff", "HEAD", "--", ...changedFiles], { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }), "")
    : gitDiffPatch(pre.gitSha, post.gitSha);
  await fs.writeFile(paths.diff, aut_patch, "utf-8");
  await fs.writeFile(paths.beads_pre, JSON.stringify(pre.beads, null, 2), "utf-8");
  await fs.writeFile(paths.beads_post, JSON.stringify(post.beads, null, 2), "utf-8");
  await fs.writeFile(paths.journal, JSON.stringify(journal ?? [], null, 2), "utf-8");
  await fs.writeFile(paths.programmatic, JSON.stringify(programmatic, null, 2), "utf-8");
  if (paths.reflection) {
    const src = path.join(REFLECTIONS_DIR, post.newReflections[0]);
    await fs.copyFile(src, paths.reflection).catch(() => {});
  }
  return paths;
}
