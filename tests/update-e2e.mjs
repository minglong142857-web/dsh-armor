#!/usr/bin/env node
/**
 * 自更新端到端自测：起一个本地 http 服务当 feed，跑 check / apply(dry-run) / apply / patches。
 * node tests/update-e2e.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "armor-upd-e2e-"));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const tgzName = `dsh-armor-${pkg.version}.tgz`;
const tgzPath = path.join(ROOT, "dist", tgzName);

if (!fs.existsSync(tgzPath)) {
  // CI 里 dist/ 不入库：先本地出包（幂等，不 bump 版本）
  console.log(`[update-e2e] 缺 ${tgzName}，先跑 scripts/release.mjs`);
  const r = spawnSync("node", [path.join(ROOT, "scripts", "release.mjs"), `--version=${pkg.version}`], { encoding: "utf8" });
  if (r.status !== 0 || !fs.existsSync(tgzPath)) {
    console.error(`无法产出 ${tgzName}\n${r.stdout || ""}${r.stderr || ""}`);
    process.exit(2);
  }
}

// 目标安装目录：假装一个旧版本
const target = path.join(tmp, "installed");
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "dsh-armor", version: "0.1.0" }), "utf8");

// 本地 feed
const files = {
  "/manifest.json": null, // 稍后填
  [`/${tgzName}`]: fs.readFileSync(tgzPath),
};

const server = http.createServer((req, res) => {
  const pathOnly = new URL(req.url, "http://127.0.0.1").pathname; // 忽略 ?cb= 缓存穿透参数
  const body = files[pathOnly];
  if (!body) {
    res.writeHead(404).end("nope");
    return;
  }
  res.writeHead(200, { "content-type": pathOnly.endsWith(".json") ? "application/json" : "application/octet-stream" });
  res.end(body);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const feed = `http://127.0.0.1:${port}/manifest.json`;
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
manifest.tarball = `http://127.0.0.1:${port}/${tgzName}`;
files["/manifest.json"] = Buffer.from(JSON.stringify(manifest));
files[`/patches/host.json`] = fs.readFileSync(path.join(ROOT, "patches", "host.json"));

// 必须异步 spawn：spawnSync 会阻塞事件循环，本地 feed 服务就没法应答子进程
const run = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn("node", [path.join(ROOT, "bin", "armor.mjs"), ...args], { cwd: cwd || ROOT });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out: out.trim() }));
  });

let pass = 0;
let fail = 0;
const ok = (n, c, extra = "") => {
  c ? pass++ : fail++;
  console.log(`  ${c ? "✓" : "✗"} ${n}${extra ? " — " + extra : ""}`);
};

console.log(`\nfeed = ${feed}\n`);

const chk = await run(["update", "check", `--feed=${feed}`, `--target=${target}`]);
ok("check 发现可更新", chk.code === 0 && /可更新/.test(chk.out), chk.out.split("\n")[0]);

const dry = await run(["update", "apply", `--feed=${feed}`, "--dry-run", `--target=${target}`]);
ok("dry-run 不动盘", dry.code === 0 && /dry-run/.test(dry.out) && JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8")).version === "0.1.0");

const ap = await run(["update", "apply", `--feed=${feed}`, `--target=${target}`]);
ok("apply 覆盖安装", ap.code === 0 && /已更新/.test(ap.out), ap.out.split("\n")[0]);
ok("版本已变", JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8")).version === pkg.version);
ok("asar.js 已落地", fs.existsSync(path.join(target, "lib", "asar.js")));

// sha256 不匹配必须拒绝
const target2 = path.join(tmp, "installed2");
fs.mkdirSync(target2, { recursive: true });
fs.writeFileSync(path.join(target2, "package.json"), JSON.stringify({ name: "dsh-armor", version: "0.1.0" }), "utf8");
const bad = JSON.parse(JSON.stringify(manifest));
bad.sha256 = "0".repeat(64);
files["/manifest.json"] = Buffer.from(JSON.stringify(bad));
const badRun = await run(["update", "apply", `--feed=${feed}`, `--target=${target2}`]);
ok("sha256 不匹配时拒绝安装", /sha256 mismatch/.test(badRun.out), badRun.out.split("\n")[0]);

// 补丁表更新通道（同源目录下 /patches/host.json）
files["/manifest.json"] = Buffer.from(JSON.stringify(manifest));
const pj = fs.mkdtempSync(path.join(tmp, "patches-"));
const pf = path.join(pj, "host.json");
fs.writeFileSync(pf, JSON.stringify([{ id: "OLD", file: "a.js", find: "a", replace: "b", marker: "b" }]), "utf8");
const pr = await run(["update", "patches", `--feed=${feed}`], pj);
ok("patches 通道可用（+/- 统计）", /补丁表 9 条/.test(pr.out), pr.out.split("\n").pop());

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
