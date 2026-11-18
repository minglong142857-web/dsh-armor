/**
 * 维护：清理重复 marker。
 *
 * 背景：重锚 purge 补丁表时，多个 id（#13/#14/#35 等）会指向同一段文本，
 * 于是同一行被追加了多份 `/* [dsh-purge] ... *​/`。语义无害，但读起来是垃圾。
 * 这里只做一件事：把**连续且完全相同**的注释折叠成一份，其它字节不动。
 */
import fs from "node:fs";
import path from "node:path";

const PURGE = /(\/\* \[dsh-purge\][^*]*\*\/)(?:[ \t]*\1)+/g;

export function dedupeText(text) {
  let out = text;
  let rounds = 0;
  while (rounds++ < 5) {
    const next = out.replace(PURGE, "$1");
    if (next === out) break;
    out = next;
  }
  return out;
}

export function countDupes(text) {
  const m = text.match(PURGE);
  return m ? m.length : 0;
}

/**
 * @returns {{file:string, changed:boolean, before:number, after:number}[]}
 */
export function dedupeHost(host, patches, { dryRun = false } = {}) {
  const files = [...new Set(patches.map((p) => path.join(host, p.file)))];
  const out = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    const before = countDupes(src);
    if (!before) {
      out.push({ file, changed: false, before: 0, after: 0 });
      continue;
    }
    const next = dedupeText(src);
    const after = countDupes(next);
    if (!dryRun) {
      const bak = `${file}.armor.dedupe.bak`;
      if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
      fs.writeFileSync(file, next, "utf8");
    }
    out.push({ file, changed: next !== src, before, after });
  }
  return out;
}
