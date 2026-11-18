#!/usr/bin/env node
/**
 * 把 dsh-armor 注册成 profile 里的插件（这样宿主启动时按 bundle 加载，而不是只靠手工打补丁）。
 *
 *   node scripts/register.mjs [--profile desktop] [--repo <path>] [--dry-run]
 *
 * 走官方 CLI：`dsh plugin --profile <p> add <repo>`
 * 找不到 dsh CLI 时不改 profile 文件——半装状态会让宿主启动失败。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const profile = opt("profile", "desktop");
const repo = path.resolve(opt("repo", ROOT));
const dryRun = argv.includes("--dry-run");
const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const profileDir = path.join(home, "profiles", profile);

function findDsh() {
  const c = spawnSync("where", ["dsh"], { encoding: "utf8", shell: false });
  if (c.status === 0) return c.stdout.split(/\r?\n/)[0].trim();
  const c2 = spawnSync("which", ["dsh"], { encoding: "utf8" });
  if (c2.status === 0) return c2.stdout.trim();
  return null;
}

if (!fs.existsSync(profileDir)) {
  console.error(`[register] profile 不存在：${profileDir}`);
  console.error(`           先开一次宿主（它会创建 profile），或用 --profile 指定`);
  process.exit(2);
}

const dsh = findDsh();
if (!dsh) {
  console.log("[register] PATH 里没有 dsh CLI，未改动 profile（避免半装）");
  console.log("           装完 shim 后新开终端再跑：");
  console.log(`           armor shim install && dsh plugin --profile ${profile} add "${repo}"`);
  process.exit(3);
}

const args = ["plugin", "--profile", profile, "add", repo];
console.log(`[register] ${dsh} ${args.join(" ")}${dryRun ? "  [dry-run]" : ""}`);
if (dryRun) process.exit(0);

const r = spawnSync(dsh, args, { stdio: "inherit", shell: true });
if (r.status !== 0) {
  console.error(`[register] 安装失败（exit ${r.status}）。手工命令：\n  dsh plugin --profile ${profile} add "${repo}"`);
  process.exit(r.status || 1);
}

const pkgFile = path.join(profileDir, "package.json");
try {
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  const bundles = pkg.dsh?.profile?.bundles || [];
  console.log(`[register] 已装。bundles = ${bundles.join(", ")}`);
} catch {
  console.log("[register] 已装（未能读取 profile package.json）");
}
