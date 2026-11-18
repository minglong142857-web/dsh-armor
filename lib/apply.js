/**
 * 补丁引擎（解开目录面）
 *  - 幂等：marker 已在则 APPLIED
 *  - 可回滚：首次写入前留 <file>.armor.bak
 *  - 诚实：锚点不匹配就是 DRIFT，不猜
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");
export const DEFAULT_PATCHES = path.join(REPO_ROOT, "patches", "host.json");

export function loadPatches(patchesFile) {
  const list = JSON.parse(fs.readFileSync(patchesFile || DEFAULT_PATCHES, "utf8"));
  if (!Array.isArray(list)) throw new Error("patch table must be an array");
  for (const p of list) {
    for (const k of ["id", "file", "find", "replace", "marker"])
      if (typeof p[k] !== "string") throw new Error(`patch ${p.id || "?"} missing ${k}`);
  }
  return list;
}

const bak = (f) => `${f}.armor.bak`;

export function runPatch(host, patch, { dryRun = false } = {}) {
  const file = path.join(host, patch.file);
  if (!fs.existsSync(file)) return { id: patch.id, state: "MISSING", detail: "host file not found" };
  const src = fs.readFileSync(file, "utf8");
  if (src.includes(patch.marker)) return { id: patch.id, state: "APPLIED", detail: "marker present" };
  if (!src.includes(patch.find)) return { id: patch.id, state: "DRIFT", detail: "anchor not found" };
  if (dryRun) return { id: patch.id, state: "PENDING", detail: "would patch" };
  if (!fs.existsSync(bak(file))) fs.copyFileSync(file, bak(file));
  fs.writeFileSync(file, src.replace(patch.find, patch.replace), "utf8");
  return { id: patch.id, state: "APPLIED", detail: "patched now" };
}

export function applyAll({ host, patchesFile, dryRun = false } = {}) {
  if (!host) throw new Error("host not given");
  const patches = loadPatches(patchesFile);
  const results = patches.map((p) => runPatch(host, p, { dryRun }));
  return { host, results, summary: summarize(results) };
}

export function revertAll({ host, patchesFile } = {}) {
  if (!host) throw new Error("host not given");
  const patches = loadPatches(patchesFile);
  const files = [...new Set(patches.map((p) => path.join(host, p.file)))];
  const results = [];
  for (const file of files) {
    const b = bak(file);
    if (!fs.existsSync(b)) {
      results.push({ id: path.basename(file), state: "SKIP", detail: "no backup" });
      continue;
    }
    fs.copyFileSync(b, file);
    fs.rmSync(b);
    results.push({ id: path.basename(file), state: "REVERTED", detail: "" });
  }
  return { host, results, summary: summarize(results) };
}

export function status(host, patchesFile) {
  return applyAll({ host, patchesFile, dryRun: true });
}

export function summarize(results) {
  const s = { applied: 0, pending: 0, drift: 0, missing: 0, reverted: 0, skip: 0 };
  for (const r of results) s[r.state.toLowerCase()] = (s[r.state.toLowerCase()] || 0) + 1;
  return s;
}
