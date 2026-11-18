#!/usr/bin/env node
/**
 * 发布到 GitHub：建仓 + 首次 push + 校验。不落盘 token（只在 push 的 URL 里用一次）。
 *
 *   GH_TOKEN=... node tools/publish-github.mjs --src dist/oss/dsh-armor --repo owner/name \
 *        [--visibility public|private] [--description "..."] [--push]
 *
 * 约定：--src 目录会成为仓库根；根下 .git 会被重建；`dist/` 忽略，根目录的 *.tgz 保留（给 raw 自更新用）。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3);
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] || d : d;
};
const has = (f) => argv.includes(f);

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const repo = opt("repo");
const src = path.resolve(opt("src", "."));
const visibility = opt("visibility", "public");
const description = opt("description", "DeepSeek Harness 破甲补丁包：tree + asar 双面、行为断言、漂移自诊断、自更新");
const doPush = has("--push");

if (!token) { console.error("缺 GH_TOKEN"); process.exit(2); }
if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) { console.error("用法: --repo owner/name"); process.exit(2); }
if (!fs.existsSync(src)) { console.error(`目录不存在: ${src}`); process.exit(2); }

const [owner, name] = repo.split("/");
const api = async (method, url, body) => {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      authorization: `token ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "dsh-armor-publish",
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
};

// 0) 先扫一遍要发的东西，别把机密推上去
const SECRET = /(^|\/)(\.env$|\.credentials\.yaml$|ca\.key$|[^/]*\.key\.pem$|last_token\.json$)/;
const leakRx = /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|ya29\.[A-Za-z0-9_-]{20,}|BEGIN (RSA |EC )?PRIVATE KEY)/;
const problems = [];
const walk = (dir, out = []) => {
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    if (it.name === ".git" || it.name === "node_modules") continue;
    const p = path.join(dir, it.name);
    if (it.isDirectory()) { walk(p, out); continue; }
    out.push(p);
  }
  return out;
};
const files = walk(src);
for (const f of files) {
  const rel = path.relative(src, f).replace(/\\/g, "/");
  if (SECRET.test(rel)) problems.push(`${rel} (机密文件名)`);
  if (/\.(js|mjs|json|ps1|yml|yaml|md|txt|py|sh)$/i.test(f) && fs.statSync(f).size < 2_000_000) {
    const text = fs.readFileSync(f, "utf8");
    if (leakRx.test(text)) problems.push(`${rel} (疑似凭据：${(text.match(leakRx) || [])[0].slice(0, 12)}…)`);
    if (text.includes(token)) problems.push(`${rel} (含本次使用的 token！)`);
  }
}
console.log(`[publish] 待发 ${files.length} 文件，扫描问题 ${problems.length} 条`);
for (const p of problems) console.log(`  ! ${p}`);
if (problems.length) {
  console.error("[publish] 中止：先处理上面的问题");
  process.exit(1);
}

// 1) 建仓（已存在就复用）
const create = await api("POST", "/user/repos", { name, private: visibility !== "public", description, has_issues: true, has_wiki: false, auto_init: false });
if (create.status === 201) console.log(`[publish] 已建仓 ${repo} (${visibility})`);
else if (create.status === 422) console.log(`[publish] 仓库已存在，复用 ${repo}`);
else { console.error(`[publish] 建仓失败 HTTP ${create.status}: ${create.text.slice(0, 300)}`); process.exit(1); }

// 2) git init + commit
const git = (args, cwd = src) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败: ${r.stderr || r.stdout}`);
  return `${r.stdout || ""}${r.stderr || ""}`.trim();
};
if (!fs.existsSync(path.join(src, ".git"))) git(["init", "-b", "main"]);
git(["config", "user.name", owner]);
git(["config", "user.email", `${owner}@users.noreply.github.com"`.replace('"', "")]);

const gi = path.join(src, ".gitignore");
const baseIgnore = ["dist/", "node_modules/", "*.armor.bak", "*.armor.dedupe.bak", "__pycache__/", "*.pyc", ".DS_Store"];
const cur = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
const merged = [...new Set([...cur.split(/\r?\n/).filter(Boolean), ...baseIgnore])].join("\n") + "\n";
fs.writeFileSync(gi, merged, "utf8");

git(["add", "-A"]);
const status = git(["status", "--porcelain"]);
console.log(`[publish] 变更 ${status.split(/\r?\n/).filter(Boolean).length} 个文件`);
git(["commit", "-m", `feat: dsh-armor v${JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8")).version}`]);

// 3) push（token 只在这一次的 URL 里）
if (!doPush) {
  console.log("[publish] 未带 --push，停在本地提交。");
  process.exit(0);
}
git(["remote", "remove", "origin"], src);
git(["remote", "add", "origin", `https://github.com/${repo}.git`]);
const pushUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
git(["push", pushUrl, "HEAD:refs/heads/main", "--force"]);
git(["remote", "set-url", "origin", `https://github.com/${repo}.git`]); // 不把 token 留在 config 里
console.log(`[publish] 已推送 https://github.com/${repo}`);

// 4) 校验
const info = await api("GET", `/repos/${repo}`);
console.log(`[publish] 仓库可见性=${info.json.private ? "private" : "public"} 默认分支=${info.json.default_branch}`);
const tgz = files.map((f) => path.relative(src, f)).find((f) => f.endsWith(".tgz"));
if (tgz) {
  const rawUrl = `https://raw.githubusercontent.com/${repo}/main/${tgz}`;
  const r = await fetch(rawUrl);
  const buf = Buffer.from(await r.arrayBuffer());
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  const manifest = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8"));
  console.log(`[publish] raw ${tgz}: HTTP ${r.status}  sha256 ${sha.slice(0, 12)}…  与 manifest ${sha === manifest.sha256 ? "一致" : "不一致!"}`);
}
