/**
 * app.asar 读写：解析 header、逐文件读取、整体重建并重算 integrity。
 *
 * 格式（实测校准，Electron asar）：
 *   [u32 = 4][u32 = 8 + padded][u32 = 4 + padded][json, 4 字节对齐][data...]
 *   dataStart = 16 + padded；文件内容首尾相接，无对齐填充。
 *   entry.integrity = { algorithm:"SHA256", hash: sha256(content),
 *                       blockSize, blocks: [sha256(每 blockSize 字节)] }
 *
 * 重建后可自校验：entries 数量、每个 entry 的 sha256 与 header 一致、data 尾部等于文件大小。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

export function readLayout(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (head.readUInt32LE(0) !== 4) throw new Error("not an asar archive (bad magic)");
    const pickleSize = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonLen);
    fs.readSync(fd, json, 0, jsonLen, 16);
    const header = JSON.parse(json.toString("utf8"));
    return { fd, header, dataStart: 8 + pickleSize, size: fs.fstatSync(fd).size };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

export function walk(header) {
  const out = [];
  const rec = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (entry.files) rec(entry, p);
      else out.push({ path: p, entry });
    }
  };
  rec(header, "");
  return out;
}

export function readEntry(fd, dataStart, entry) {
  if (entry.unpacked) return null;
  const size = Number(entry.size) || 0;
  const buf = Buffer.alloc(size);
  if (size) fs.readSync(fd, buf, 0, size, dataStart + Number(entry.offset || 0));
  return buf;
}

function integrityFor(buf, blockSize) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += blockSize) blocks.push(sha256(buf.subarray(i, i + blockSize)));
  if (!blocks.length) blocks.push(sha256(Buffer.alloc(0)));
  return { algorithm: "SHA256", hash: sha256(buf), blockSize, blocks };
}

/**
 * 重建 asar。mutator(relPath, contentBuffer) -> Buffer|null
 * 返回 { written, changed:[], backup, verify }
 */
export function rebuildAsar(file, mutator, { backup = true, dryRun = false } = {}) {
  const { fd, header, dataStart, size } = readLayout(file);
  let entries;
  try {
    entries = walk(header);
  } finally {
    // fd 会在下面继续用，读到末尾再关
  }

  const items = [];
  const changed = [];
  for (const { path: rel, entry } of entries) {
    const content = readEntry(fd, dataStart, entry);
    let next = content;
    if (content) {
      const mutated = mutator(rel, content);
      if (mutated && !mutated.equals(content)) {
        next = mutated;
        changed.push(rel);
      }
    }
    items.push({ rel, entry, content: next });
  }

  // 校验原 archive 布局（顺带证明读得对）：data 区尾部应等于文件大小
  const originalEnd = dataStart + items.reduce((s, it) => Math.max(s, Number(it.entry.offset || 0) + Number(it.entry.size || 0)), 0);
  if (originalEnd !== size) {
    fs.closeSync(fd);
    throw new Error(`asar layout mismatch: computed end ${originalEnd} != file size ${size}`);
  }
  fs.closeSync(fd);

  if (dryRun || !changed.length) {
    return { written: false, changed, backup: null, verify: null };
  }

  // 写新 header：offset 顺序即原 header 中的出现顺序（与原归档一致）
  let offset = 0;
  const nextHeader = structuredClone(header);
  const byPath = new Map(items.map((it) => [it.rel, it]));
  const assign = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (entry.files) {
        assign(entry, p);
        continue;
      }
      const it = byPath.get(p);
      if (!it || !it.content) continue;
      entry.size = it.content.length;
      entry.offset = String(offset);
      offset += it.content.length;
      const bs = entry.integrity?.blockSize || 4194304;
      entry.integrity = integrityFor(it.content, bs);
    }
  };
  assign(nextHeader, "");

  const json = Buffer.from(JSON.stringify(nextHeader), "utf8");
  const padded = Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(8 + padded, 4);
  prefix.writeUInt32LE(4 + padded, 8);
  prefix.writeUInt32LE(json.length, 12); // 未对齐的 JSON 实际长度（Electron 读这个）
  const jsonPad = Buffer.concat([json, Buffer.alloc(padded - json.length)]);
  const dataStartNew = 16 + padded;

  const tmp = `${file}.armor.tmp`;
  const bak = `${file}.armor.bak`;
  const out = fs.openSync(tmp, "w");
  let written = 0;
  try {
    fs.writeSync(out, prefix);
    fs.writeSync(out, jsonPad);
    written = dataStartNew;
    for (const it of items) {
      if (!it.content) continue;
      fs.writeSync(out, it.content);
      written += it.content.length;
    }
    fs.fsyncSync(out);
  } finally {
    fs.closeSync(out);
  }
  if (written !== dataStartNew + offset) throw new Error(`write size mismatch: ${written} != ${dataStartNew + offset}`);

  // 自校验：重新解析并逐文件比对 header 里的 integrity
  const verify = verifyAsar(tmp, { expectEntries: items.length });

  if (!verify.ok) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`asar verify failed: ${verify.error}`);
  }

  if (backup && !fs.existsSync(bak)) fs.copyFileSync(file, bak);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // 宿主还在跑时 Windows 会 EPERM/EBUSY：别留垃圾，也别动原件
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return { written: true, changed, backup: backup ? bak : null, verify };
}

/** 独立校验：entry 数、每个 entry 的 content sha256 == header integrity.hash、尾部对齐 */
export function verifyAsar(file, { expectEntries } = {}) {
  let fd;
  try {
    const layout = readLayout(file);
    fd = layout.fd;
    const entries = walk(layout.header);
    if (expectEntries && entries.length !== expectEntries) {
      return { ok: false, error: `entry count ${entries.length} != ${expectEntries}`, entries: entries.length };
    }
    let end = layout.dataStart;
    for (const { entry } of entries) {
      const buf = readEntry(fd, layout.dataStart, entry);
      if (!buf) continue;
      const want = entry.integrity?.hash;
      const got = sha256(buf);
      if (want && want !== got) return { ok: false, error: `hash mismatch on entry`, entries: entries.length };
      end += buf.length;
    }
    if (end !== layout.size) return { ok: false, error: `tail mismatch ${end} != ${layout.size}`, entries: entries.length };
    return { ok: true, entries: entries.length, size: layout.size, dataStart: layout.dataStart };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (fd) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * 对 asar 内的宿主文件打补丁。patches: [{id, file, find, replace, marker}]
 */
export function patchAsar(file, patches, { dryRun = false, backup = true, log = () => {} } = {}) {
  const relToPatches = new Map();
  for (const p of patches) {
    const rel = "dsh/node_modules/@deepseek-ai/" + String(p.file).replace(/\\/g, "/");
    if (!relToPatches.has(rel)) relToPatches.set(rel, []);
    relToPatches.get(rel).push(p);
  }

  const results = new Map();
  for (const list of relToPatches.values()) for (const p of list) results.set(p.id, { id: p.id, state: "SKIP", detail: "not found in asar" });

  const out = rebuildAsar(
    file,
    (rel, buf) => {
      const list = relToPatches.get(rel);
      if (!list) return null;
      let text = buf.toString("utf8");
      let touched = false;
      for (const p of list) {
        const r = results.get(p.id);
        if (text.includes(p.marker)) {
          r.state = "APPLIED";
          r.detail = "already present in asar";
          continue;
        }
        if (!text.includes(p.find)) {
          r.state = "DRIFT";
          r.detail = "anchor not found in asar";
          continue;
        }
        text = text.replace(p.find, p.replace);
        r.state = dryRun ? "PENDING" : "APPLIED";
        r.detail = dryRun ? "would patch asar" : "patched in asar";
        touched = true;
      }
      return touched || list.some((p) => text.includes(p.marker)) ? Buffer.from(text, "utf8") : null;
    },
    { dryRun, backup }
  );

  log(`[asar] ${out.written ? "rewritten" : "unchanged"} entries-changed=${out.changed.length}${out.verify ? ` verify=${out.verify.ok ? "ok" : "FAIL"}` : ""}`);
  return { ...out, results: [...results.values()] };
}

export function listAsarHostFiles(file) {
  const { fd, header } = readLayout(file);
  try {
    return walk(header)
      .map((e) => e.path)
      .filter((p) => p.startsWith("dsh/node_modules/@deepseek-ai/"));
  } finally {
    fs.closeSync(fd);
  }
}
