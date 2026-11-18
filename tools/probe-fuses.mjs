/**
 * 只读探测：Electron 的 fuse 位 + 是否把 asar 完整性根哈希烧进 exe。
 * 这决定了"重建 app.asar 之后，下一��启动会不会被拒"。
 */
import fs from "node:fs";

const exe = process.argv[2] || "C:\\Users\\32957\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe";
const MAGIC = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii"); // Electron fuse wire sentinel
const FUSES = [
  "RunAsNode",
  "EnableCookieEncryption",
  "EnableNodeOptionsEnvironmentVariable",
  "EnableNodeCliInspectArguments",
  "EnableEmbeddedAsarIntegrityValidation",
  "OnlyLoadAppFromAsar",
  "LoadBrowserProcessSpecificV8Snapshot",
  "GrantFileProtocolExtraPrivileges",
];

const buf = fs.readFileSync(exe);
console.log(`exe: ${exe}`);
console.log(`size: ${(buf.length / 1048576).toFixed(1)} MB`);

// fuses
let at = buf.indexOf(MAGIC);
if (at < 0) {
  console.log("fuse wire: 找不到 sentinel（可能被裁剪或不是标准 Electron）");
} else {
  const n = FUSES.length;
  const start = at - n * 2;
  const raw = buf.subarray(start, at);
  console.log(`fuse wire @${start}`);
  FUSES.forEach((name, i) => {
    const ver = raw[i * 2];
    const val = String.fromCharCode(raw[i * 2 + 1]);
    const on = val === "1";
    const mark = name.includes("Asar") || name.includes("OnlyLoad") ? "  <= 关键" : "";
    console.log(`  ${String(i).padStart(2)} ${name.padEnd(40)} = ${on ? "ON " : "OFF"} (ver ${ver})${mark}`);
  });
}

// asar 完整性根资源（Windows: PE 资源名 ELECTRONASAR）
const needle = Buffer.from("ELECTRONASAR", "ascii");
const hits = [];
let i = 0;
while ((i = buf.indexOf(needle, i)) >= 0) {
  hits.push(i);
  i += needle.length;
}
console.log(`\nELECTRONASAR 资源: ${hits.length} 处 ${hits.length ? "@" + hits.join(", @") : ""}`);
if (hits.length) {
  // 资源里紧跟一段 JSON（{"files":{...},"alg":"SHA256"}）
  for (const h of hits) {
    const slice = buf.subarray(h, h + 400).toString("latin1");
    const j = slice.indexOf("{");
    console.log("  片段:", (j >= 0 ? slice.slice(j, j + 160) : slice.slice(0, 160)).replace(/[^\x20-\x7e]/g, "."));
  }
}

console.log("\n判读：");
const integ = at >= 0 && String.fromCharCode(buf[at - FUSES.length * 2 + 4 * 2 + 1]) === "1";
console.log(`  EnableEmbeddedAsarIntegrityValidation = ${integ ? "ON" : "OFF"}`);
console.log(`  结论：${integ ? "重建 app.asar 后，exe 内根哈希对不上，启动可能被拒 → 需同时改 exe 资源或关掉该 fuse" : "无 exe 级根哈希校验，重建 app.asar 后应按 header 内 integrity 自校验放行"}`);
