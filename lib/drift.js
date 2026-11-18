/**
 * 漂移定位：锚点找不到时，从当前宿主文本里生成候选 find 片段，供人一眼确认。
 * 不做自动改写——自动猜锚点是补丁包最容易出事的地方。
 */
import fs from "node:fs";
import path from "node:path";

const KEYWORDS = new Set(["const", "await", "async", "return", "function", "throw", "new", "this", "true", "false", "void", "null", "undefined"]);

function probes(find) {
  const out = new Set();
  for (const m of find.matchAll(/"([^"\\]{4,80})"/g)) out.add(m[1]);
  for (const m of find.matchAll(/'([^'\\]{4,80})'/g)) out.add(m[1]);
  for (const m of find.matchAll(/`([^`]{4,80})`/g)) out.add(m[1]);
  for (const m of find.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]{4,})\b/g)) {
    const t = m[1];
    if (KEYWORDS.has(t)) continue;
    out.add(t);
  }
  // 兜底：没有独有 token 时，用最长的那一行当锚点提示
  if (!out.size) {
    const longest = find.split("\n").map((l) => l.trim()).sort((a, b) => b.length - a.length)[0];
    if (longest && longest.length >= 4) out.add(longest.slice(0, Math.min(60, longest.length)));
  }
  return [...out];
}

function countOccurrences(hay, needle) {
  let n = 0;
  let i = 0;
  while (true) {
    i = hay.indexOf(needle, i);
    if (i < 0) return n;
    n++;
    i += needle.length;
  }
}

/**
 * @returns {{id,file,state,probes:string[],candidates:{line:number,text:string,score:number}[]}}
 */
export function diagnose(host, patch) {
  const file = path.join(host, patch.file);
  if (!fs.existsSync(file)) return { id: patch.id, file: patch.file, state: "MISSING", probes: [], candidates: [] };
  const src = fs.readFileSync(file, "utf8");
  if (src.includes(patch.marker)) return { id: patch.id, file: patch.file, state: "APPLIED", probes: [], candidates: [] };

  const lines = src.split("\n");
  const cands = [];
  for (const probe of probes(patch.find)) {
    const occ = countOccurrences(src, probe);
    if (occ === 0 || occ > 6) continue; // 太多命中说明没有定位价值
    let idx = -1;
    for (let ln = 0; ln < lines.length; ln++) {
      idx = lines[ln].indexOf(probe);
      if (idx < 0) continue;
      const from = Math.max(0, ln - 1);
      const to = Math.min(lines.length - 1, ln + 2);
      const text = lines.slice(from, to + 1).join("\n");
      if (text.length > 1200) continue;
      cands.push({ line: from + 1, text, score: 100 - occ * 10 + Math.min(probe.length, 40) });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const unique = cands.filter((c) => (seen.has(c.text) ? false : (seen.add(c.text), true))).slice(0, 3);
  return {
    id: patch.id,
    file: patch.file,
    state: src.includes(patch.find) ? "PENDING" : "DRIFT",
    probes: probes(patch.find).slice(0, 6),
    candidates: unique,
  };
}

export function diagnoseAll(host, patches) {
  return patches.map((p) => diagnose(host, p));
}
