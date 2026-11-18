#!/usr/bin/env node
/**
 * 把仓库地址从占位符换成真的（发布前一步）。
 *
 *   node scripts/set-repo.mjs --repo https://github.com/<you>/dsh-armor
 *   node scripts/set-repo.mjs --repo <url> --dry-run
 *
 * 会改：package.json(armor.feed / armor.repo / dsh.install.*)、install.ps1、README*.md、release.mjs、
 *       .github/workflows/test-and-release.yml
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (n) => {
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3);
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] || null : null;
};
const raw = opt("repo");
const dryRun = argv.includes("--dry-run");

if (!raw) {
  console.error("usage: node scripts/set-repo.mjs --repo https://github.com/<owner>/<repo> [--dry-run]");
  process.exit(2);
}

const url = raw.replace(/\.git$/, "").replace(/\/$/, "");
const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(url);
if (!m) {
  console.error("[set-repo] 只支持 https://github.com/<owner>/<repo>");
  process.exit(2);
}
const [, owner, repo] = m;
const branch = opt("branch") || "main";

const subs = [
  // 旧的 OWNER 占位
  [/https:\/\/github\.com\/OWNER\/dsh-armor/g, url],
  [/https:\/\/codeload\.github\.com\/OWNER\/dsh-armor\/tar\.gz\/refs\/heads\/main/g, `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${branch}`],
  [/https:\/\/codeload\.github\.com\/OWNER\/dsh-armor\/zip\/refs\/heads\/main/g, `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`],
  [/https:\/\/raw\.githubusercontent\.com\/OWNER\/dsh-armor\/main/g, `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`],
  // 已替换过一次后再次执行也要幂等
  [/https:\/\/(raw\.githubusercontent\.com|codeload\.github\.com|github\.com)\/[^/\s"']+\/[^/\s"']+(?=\/)/g, (all) => all],
];

const files = [
  "package.json",
  "install.ps1",
  "README.md",
  "README.zh-CN.md",
  "scripts/release.mjs",
  ".github/workflows/test-and-release.yml",
  "manifest.json",
].map((f) => path.join(ROOT, f));

let changed = 0;
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  const src = fs.readFileSync(f, "utf8");
  let out = src;
  for (const [re, rep] of subs.slice(0, 4)) out = out.replace(re, rep);
  if (out === src) continue;
  changed++;
  console.log(`  ${path.relative(ROOT, f)}`);
  if (!dryRun) fs.writeFileSync(f, out, "utf8");
}

// package.json 里补 armor.repo（给 set-repo / release 用）
if (!dryRun) {
  const pf = path.join(ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pf, "utf8"));
  pkg.armor = pkg.armor || {};
  pkg.armor.repo = url;
  pkg.armor.branch = branch;
  pkg.repository = { type: "git", url: `git+${url}.git` };
  pkg.bugs = { url: `${url}/issues` };
  pkg.homepage = `${url}#readme`;
  fs.writeFileSync(pf, JSON.stringify(pkg, null, 2) + "\n", "utf8");
}

console.log(`\n[set-repo] ${dryRun ? "dry-run，" : ""}改了 ${changed} 个文件 -> ${url} (${branch})`);
if (!dryRun) console.log("[set-repo] 下一步：node scripts/release.mjs --version <x.y.z> && git tag v<x.y.z> && git push --tags");
