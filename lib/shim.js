/**
 * shim：让 `dsh` 命令跑"解开目录"里那份代码（绕过 app.asar），
 * 这样提示词层/代码层补丁对 CLI 与 `dsh web` 立刻生效。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const MARK = "# managed-by: dsh-armor";

export function defaultBinDir() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "bin");
}

function bodies(surface) {
  const node = surface.nodeBin || "node";
  const bin = surface.dshBin;
  const cmd = `@echo off\r
rem ${MARK}\r
setlocal\r
if not defined DSH_HOME set "DSH_HOME=%USERPROFILE%\\.dsh"\r
"${node}" "${bin}" %*\r
`;
  const ps1 = `${MARK}
if (-not $env:DSH_HOME) { $env:DSH_HOME = Join-Path $HOME '.dsh' }
& "${node}" "${bin}" @args
exit $LASTEXITCODE
`;
  const sh = `#!/usr/bin/env bash
${MARK}
export DSH_HOME="\${DSH_HOME:-$HOME/.dsh}"
exec "${node.replace(/\\/g, "\\\\")}" "${bin.replace(/\\/g, "/")}" "$@"
`;
  const armorEntry = path.join(REPO_ROOT, "bin", "armor.mjs");
  const armorCmd = `@echo off\r
rem ${MARK}\r
"${node}" "${armorEntry}" %*\r
`;
  return { dsh: cmd, "dsh.ps1": ps1, dshShell: sh, "armor.cmd": armorCmd };
}

export function installShim(surface, { binDir = defaultBinDir(), dryRun = false } = {}) {
  const b = bodies(surface);
  const written = [];
  if (!dryRun) fs.mkdirSync(binDir, { recursive: true });
  const put = (name, content) => {
    const p = path.join(binDir, name);
    if (!dryRun) fs.writeFileSync(p, content, "utf8");
    written.push(p);
  };
  put("dsh.cmd", b.dsh);
  put("dsh.ps1", b["dsh.ps1"]);
  put("dsh", b.dshShell);
  put("armor.cmd", b["armor.cmd"]);
  return { binDir, written, pathHint: `把 ${binDir} 加进 PATH（当前会话：$env:PATH="${binDir};" + $env:PATH）` };
}

export function shimStatus(binDir = defaultBinDir()) {
  const names = ["dsh.cmd", "dsh.ps1", "dsh", "armor.cmd"];
  return names.map((n) => {
    const p = path.join(binDir, n);
    let ours = false;
    try {
      ours = fs.readFileSync(p, "utf8").includes(MARK);
    } catch {
      /* absent */
    }
    return { name: n, path: p, exists: fs.existsSync(p), managed: ours };
  });
}

export function removeShim(binDir = defaultBinDir()) {
  const removed = [];
  for (const s of shimStatus(binDir)) {
    if (s.exists && s.managed) {
      fs.rmSync(s.path, { force: true });
      removed.push(s.path);
    }
  }
  return { binDir, removed };
}
