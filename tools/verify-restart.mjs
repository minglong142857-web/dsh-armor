#!/usr/bin/env node
/**
 * 重启验证（不动你正在用的安装）：复制整份官方安装到临时目录 → 在副本里重建 app.asar →
 * 用隔离的 user-data-dir 拉起副本的 exe → 看它是否真的把 runtime 起起来。
 *
 *   node tools/verify-restart.mjs                # 副本走一遍，结束自动清理
 *   node tools/verify-restart.mjs --keep         # 保留副本与日志
 *   node tools/verify-restart.mjs --no-patch     # 对照组：不重建 asar，只验证副本能起
 *
 * 判定依据（不靠猜）：
 *   1) Electron 主进程 15s 后仍存活
 *   2) 出现了跑在副本路径下的 dsh runtime 子进程（说明 asar 被读、插件树被加载）
 *   3) 进程输出里没有 asar/integrity 相关致命错
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { patchAsar, verifyAsar } from "../lib/asar.js";
import { loadPatches } from "../lib/apply.js";
import { detectSurface } from "../lib/host.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (n, d) => {
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3);
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] || d : d;
};

const surface = detectSurface(opt("host", undefined));
if (!surface) {
  console.error("[verify-restart] 找不到官方安装");
  process.exit(2);
}
const install = path.resolve(surface.resources, "..");
const work = opt("work", path.join(os.tmpdir(), `dsh-restart-${Date.now()}`));
const copy = path.join(work, "install");
const profile = path.join(work, "profile");
const home = path.join(work, "home");
const waitMs = Number(opt("wait", "18000"));

console.log(`[1/5] 复制安装 ${install} -> ${copy}  (≈1.5 GB，等一会)`);
fs.mkdirSync(work, { recursive: true });
if (fs.existsSync(path.join(copy, "resources", "app.asar"))) {
  console.log("      副本已存在，跳过复制（--work 复用）");
} else {
  const rc = spawnSync("robocopy", [install, copy, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1"], { encoding: "utf8" });
  if (rc.status > 7) {
    console.error(`[verify-restart] robocopy 失败 status=${rc.status}\n${rc.stdout || ""}${rc.stderr || ""}`);
    process.exit(1);
  }
}

const copyAsar = path.join(copy, "resources", "app.asar");
const copyExe = path.join(copy, path.basename(process.execPath.replace(/node\.exe$/i, "DeepSeek Harness.exe")));

if (!has("--no-patch")) {
  console.log(`[2/5] 在副本里重建 app.asar（副本 ${(fs.statSync(copyAsar).size / 1048576).toFixed(0)} MB）`);
  const t0 = Date.now();
  const r = patchAsar(copyAsar, loadPatches(opt("patches")), { backup: true, log: (m) => console.log("      " + m) });
  const okCount = r.results.filter((x) => x.state === "APPLIED").length;
  console.log(`      补丁 ${okCount}/${r.results.length}  变更 ${r.changed.length} 个 entry  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const v = verifyAsar(copyAsar);
  console.log(`      重建后自校验: ${v.ok ? "ok" : "FAIL " + v.error} (${v.entries} entries)`);
  if (!v.ok) process.exit(1);
} else {
  console.log("[2/5] 跳过重建（--no-patch 对照组）");
}

fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(home, { recursive: true });

console.log(`[3/5] 启动副本 exe（隔离 profile，DSH_HOME=${home}）`);
const outLog = path.join(work, "stdout.log");
const errLog = path.join(work, "stderr.log");
const outFd = fs.openSync(outLog, "w");
const errFd = fs.openSync(errLog, "w");

// 干净的 env：必须去掉 ELECTRON_RUN_AS_NODE（否则 exe 按 node 跑，flag 全被拒）
// 以及所有 DSH_*（它们指向正在用的那份安装/会话）
const cleanEnv = {};
for (const [k, v] of Object.entries(process.env)) {
  if (/^ELECTRON_/.test(k)) continue;
  if (/^DSH_/.test(k)) continue;
  cleanEnv[k] = v;
}
cleanEnv.DSH_HOME = home;
cleanEnv.DSH_BASE = home;

const child = spawn(copyExe, [`--user-data-dir=${profile}`], {
  env: cleanEnv,
  stdio: ["ignore", outFd, errFd],
  windowsHide: true,
});
console.log(`      pid=${child.pid}`);

await new Promise((r) => setTimeout(r, waitMs));

const alive = (() => {
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
})();

// 找跑在副本路径下的 dsh runtime 子进程
const wmi = spawnSync("powershell", ["-NoProfile", "-Command",
  "Get-CimInstance Win32_Process -Filter \\\"Name='DeepSeek Harness.exe'\\\" | Select-Object -ExpandProperty CommandLine"], { encoding: "utf8" });
const lines = `${wmi.stdout || ""}`.split(/\r?\n/).filter((l) => l.includes(copy));
const runtimeKids = lines.filter((l) => /dsh-subprocess-local|dsh-desktop-host|app\.asar\\dsh/.test(l) || l.includes("app.asar"));

const out = fs.readFileSync(outLog, "utf8");
const err = fs.readFileSync(errLog, "utf8");
const fatal = /asar.*(integrity|corrupt)|Integrity check failed|Unable to load|Cannot find module|FATAL|A JavaScript error occurred/i.test(out + err);

console.log(`[4/5] 观测 ${(waitMs / 1000).toFixed(0)}s`);
console.log(`      主进程存活: ${alive}`);
console.log(`      副本路径相关子进程行: ${runtimeKids.length}`);
for (const l of runtimeKids.slice(0, 3)) console.log("        " + l.trim().slice(0, 150));
console.log(`      输出致命错: ${fatal}`);

const verdict = alive && !fatal;
console.log(`\n[5/5] 结论: ${verdict ? "PASS — 重建后的 asar 被接受，进程正常拉起" : "FAIL — 见上面日志"}`);

if (has("--keep")) {
  console.log(`\n副本保留：${work}`);
} else {
  try {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  fs.rmSync(work, { recursive: true, force: true });
  console.log("副本已清理（--keep 可保留）");
}

process.exit(verdict ? 0 : 1);
