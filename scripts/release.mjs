#!/usr/bin/env node
/**
 * 发布：node scripts/release.mjs [--version 0.2.1] [--base https://github.com/minglong142857-web/dsh-armor/releases/download/v0.2.1]
 *
 * 产物：
 *   dist/dsh-armor-<version>.tgz      只有 package.json files 里列的东西
 *   manifest.json                     自更新 feed（version/tarball/sha256/patchesSha256）
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const pkgPath = path.join(ROOT, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const version = opt("version", pkg.version);
if (version !== pkg.version) {
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  console.log(`[release] 版本号已改为 ${version}`);
}

const files = pkg.files || ["lib", "bin", "patches", "install.ps1", "cordis.patch.yml", "README.md", "LICENSE", "NOTICE"];
const stage = fs.mkdtempSync(path.join(require_tmp(), "armor-rel-"));
const pkgDir = path.join(stage, "dsh-armor");
fs.mkdirSync(pkgDir, { recursive: true });
for (const f of files) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) continue;
  fs.cpSync(src, path.join(pkgDir, f), { recursive: true });
}
fs.copyFileSync(pkgPath, path.join(pkgDir, "package.json"));

const dist = path.join(ROOT, "dist");
fs.mkdirSync(dist, { recursive: true });
const tgzName = `dsh-armor-${version}.tgz`;
const tgz = path.join(dist, tgzName);
if (fs.existsSync(tgz)) fs.rmSync(tgz);
const tar = spawnSync("tar", ["-czf", tgz, "-C", stage, "dsh-armor"], { encoding: "utf8" });
if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
fs.rmSync(stage, { recursive: true, force: true });

const sha256 = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const patchesFile = path.join(ROOT, "patches", "host.json");
const base = opt("base", pkg.armor?.feed?.replace(/\/manifest\.json$/, "") || "https://raw.githubusercontent.com/minglong142857-web/dsh-armor/main");

const manifest = {
  name: pkg.name,
  version,
  tarball: opt("tarball", `${base}/${tgzName}`),
  sha256: sha256(tgz),
  patchesSha256: sha256(patchesFile),
  patchesCount: JSON.parse(fs.readFileSync(patchesFile, "utf8")).length,
  notes: opt("notes", ""),
  releasedAt: new Date().toISOString(),
  minHost: pkg.dsh?.targets?.[0] || "0.2.0",
  targets: pkg.dsh?.targets || [],
};
fs.writeFileSync(path.join(ROOT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

console.log(`[release] ${tgzName}  ${(fs.statSync(tgz).size / 1024).toFixed(1)} KB`);
console.log(`[release] sha256  ${manifest.sha256}`);
console.log(`[release] manifest.json 已更新（${manifest.patchesCount} 条补丁）`);
console.log(`[release] 发布后自更新入口：armor update check --feed=${manifest.tarball.replace(/\/[^/]*$/, "")}/manifest.json`);

function require_tmp() {
  return process.env.TEMP || process.env.TMPDIR || "/tmp";
}
