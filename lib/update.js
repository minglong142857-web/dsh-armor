/**
 * 持续更新：manifest.json 驱动的自更新。
 *
 * manifest 形状（放在仓库根，随 tag 发布）：
 *   { "name":"dsh-armor", "version":"0.2.1", "tarball":"https://.../dsh-armor-0.2.1.tgz",
 *     "sha256":"<tgz sha256>", "patchesSha256":"<patches/host.json sha256>",
 *     "notes":"...", "releasedAt":"2026-11-19T00:00:00Z", "minHost":"0.2.0" }
 *
 * 更新通道两条：
 *   1) 包更新：整包 tarball，校验 sha256 → 解到 profile/node_modules/dsh-armor → 重新 apply
 *   2) 补丁表更新：只换 patches/host.json（宿主小版本漂移时最常用，不用重装）
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { compare } from "./semver.js";
import { REPO_ROOT, loadPatches } from "./apply.js";

const sha256File = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

export function currentVersion() {
  return installedVersion(REPO_ROOT) || "0.0.0";
}

/** 指定安装目录里的版本（自更新时判定"当前版本"要用被更新的那份，而不是跑代码的这份） */
export function installedVersion(dir = REPO_ROOT) {
  try {
    const raw = fs.readFileSync(path.join(dir, "package.json"), "utf8").replace(/^\uFEFF/, ""); // 去 BOM
    return JSON.parse(raw).version || null;
  } catch {
    return null;
  }
}

export function defaultFeed() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).armor?.feed || null;
  } catch {
    return null;
  }
}

/**
 * 取 JSON：先 fetch；fetch 在这台机器上会连不上（undici IPv6/路径问题），退回 curl.exe。
 */
async function fetchJson(url, timeoutMs = 15000) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { "user-agent": "dsh-armor-updater" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    const text = curlText(url, timeoutMs);
    if (text == null) throw e;
    return JSON.parse(text);
  }
}

/** curl.exe 兜底（Windows 10+ 自带；其它平台用 curl） */
export function curlText(url, timeoutMs = 15000) {
  try {
    const r = spawnSync("curl", ["-sS", "-L", "--max-time", String(Math.ceil(timeoutMs / 1000)), url], { encoding: "utf8" });
    if (r.status === 0 && r.stdout) return r.stdout;
    return null;
  } catch {
    return null;
  }
}

export async function check({ feed = defaultFeed(), current = currentVersion() } = {}) {
  if (!feed) throw new Error("no feed configured (package.json armor.feed)");
  // raw.githubusercontent 有 CDN 缓存：加时间戳绕开，否则刚发的版本要等几分钟才可见
  const bust = feed.includes("?") ? `${feed}&cb=${Date.now()}` : `${feed}?cb=${Date.now()}`;
  const remote = await fetchJson(bust);
  const behind = !current || compare(remote.version, current) > 0; // 认不出版本时按"可更新"处理
  return { feed, current: current || "(未知)", remoteVersion: remote.version, updateAvailable: behind, notes: remote.notes || "", raw: remote };
}

export async function apply({ feed = defaultFeed(), current, target = REPO_ROOT, dryRun = false } = {}) {
  const info = await check({ feed, current: current || installedVersion(target) || currentVersion() });
  if (!info.updateAvailable) return { ...info, applied: false, reason: "already up to date" };

  const remote = info.raw;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-armor-upd-"));
  const tgz = path.join(tmpDir, "pkg.tgz");
  const res = await fetch(remote.tarball);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));

  const got = sha256File(tgz);
  if (remote.sha256 && got !== remote.sha256) throw new Error(`sha256 mismatch: ${got} != ${remote.sha256}`);

  const stage = path.join(tmpDir, "stage");
  fs.mkdirSync(stage, { recursive: true });
  const tar = spawnSync("tar", ["-xzf", tgz, "-C", stage], { encoding: "utf8" });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr || tar.stdout}`);
  const root = fs.readdirSync(stage).map((n) => path.join(stage, n)).find((p) => fs.statSync(p).isDirectory()) || stage;

  if (dryRun) return { ...info, applied: false, reason: "dry-run", staged: root, verifiedSha: got };

  // 覆盖安装（保留 .armor.bak 与用户配置）
  for (const name of fs.readdirSync(root)) {
    if (name === "node_modules" || name === ".git") continue;
    fs.cpSync(path.join(root, name), path.join(target, name), { recursive: true, force: true });
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { ...info, applied: true, verifiedSha: got, target };
}

/** 只更新补丁表（宿主小版本漂移场景） */
export async function refreshPatches({ feed = defaultFeed(), patchesFile, dryRun = false } = {}) {
  if (!feed) throw new Error("no feed configured");
  const base = feed.replace(/\/[^/]*$/, "");
  const url = `${base}/patches/host.json`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15000);
  let text;
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    text = curlText(url, 15000);
    if (text == null) throw e;
  } finally {
    clearTimeout(t);
  }
  const list = JSON.parse(text);
  if (!Array.isArray(list) || !list.length) throw new Error("remote patch table invalid");
  for (const p of list) for (const k of ["id", "file", "find", "replace", "marker"]) if (typeof p[k] !== "string") throw new Error(`remote patch ${p.id} missing ${k}`);

  const target = patchesFile || path.join(REPO_ROOT, "patches", "host.json");
  const local = loadPatches(target).map((p) => p.id);
  const remoteIds = list.map((p) => p.id);
  const added = remoteIds.filter((id) => !local.includes(id));
  const removed = local.filter((id) => !remoteIds.includes(id));

  if (!dryRun) {
    if (!fs.existsSync(`${target}.armor.bak`)) fs.copyFileSync(target, `${target}.armor.bak`);
    fs.writeFileSync(target, JSON.stringify(list, null, 1), "utf8");
  }
  return { url, dryRun, count: list.length, added, removed, target };
}
