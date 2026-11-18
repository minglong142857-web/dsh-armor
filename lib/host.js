/**
 * 宿主定位：官方桌面安装的解开目录 + app.asar + node 运行时 + dsh CLI 入口。
 * 版本号取自 <resources>/app/package.json（存在）或 asar 内的 dsh/package.json。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();

/** 可能的 resources/ 目录（官方桌面安装位置） */
export const RESOURCES_CANDIDATES = [
  process.env.DSH_RESOURCES,
  path.join(process.env.LOCALAPPDATA || "", "Programs/DeepSeek Harness/resources"),
  path.join(HOME, "AppData/Local/Programs/DeepSeek Harness/resources"),
  "/Applications/DeepSeek Harness.app/Contents/Resources",
  "/usr/lib/deepseek-harness/resources",
].filter(Boolean);

/** 老的直连式宿主（没有 asar 分层，只有解开目录） */
export function detectHost(explicit) {
  if (explicit) return explicit;
  for (const r of RESOURCES_CANDIDATES) {
    const p = path.join(r, "app", "dsh", "node_modules", "@deepseek-ai");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * @returns {{resources:string, host:string, unpackedApp:string, asar:string|null,
 *            nodeBin:string|null, dshBin:string, desktopVersion:string|null}|null}
 */
export function detectSurface(explicitHost) {
  for (const r of RESOURCES_CANDIDATES) {
    const host = explicitHost || path.join(r, "app", "dsh", "node_modules", "@deepseek-ai");
    if (!fs.existsSync(host)) continue;
    const asar = path.join(r, "app.asar");
    const nodeBin = ["runtime/bin/node.exe", "runtime/bin/node"].map((x) => path.join(r, x)).find((x) => fs.existsSync(x)) || null;
    const dshPkg = path.join(host, "dsh", "package.json");
    let ver = null;
    try {
      ver = JSON.parse(fs.readFileSync(dshPkg, "utf8")).version || null;
    } catch {
      /* ignore */
    }
    return {
      resources: r,
      host,
      unpackedApp: path.join(r, "app", "dsh"),
      asar: fs.existsSync(asar) ? asar : null,
      nodeBin,
      dshBin: path.join(host, "dsh", "lib", "bin.js"),
      desktopVersion: ver,
    };
  }
  return null;
}

/** asar 里 dsh 子树的包路径前缀 */
export const ASAR_PREFIX = "dsh/node_modules/@deepseek-ai/";

export function hostFileToAsarPath(hostFile) {
  return ASAR_PREFIX + String(hostFile).replace(/\\/g, "/");
}
