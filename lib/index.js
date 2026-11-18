/**
 * dsh-armor — cordis 插件入口 + 公共 API。
 *
 * 启动时（config.applyOnStart 默认 true）：
 *   1) 对解开目录打补丁（立刻影响 `dsh web` / CLI / shim 启动的进程）
 *   2) 若 config.asar 为 true，再对 app.asar 重建（影响桌面端 Electron 进程）
 *   3) 漂移不猜：只报告，写日志
 *
 * 兼容 scripts/apply.mjs 的旧 API：applyAll / revertAll / detectHost。
 */
import { applyAll, revertAll, status, loadPatches, summarize, REPO_ROOT } from "./apply.js";
import { detectHost, detectSurface } from "./host.js";
import { patchAsar, verifyAsar } from "./asar.js";
import { diagnoseAll } from "./drift.js";
import * as shim from "./shim.js";
import { route, pickPrompt } from "./prompt-router.js";

export { applyAll, revertAll, status, loadPatches, summarize, REPO_ROOT, detectHost, detectSurface, patchAsar, verifyAsar, diagnoseAll, shim, route, pickPrompt };

export const name = "dsh-armor";

export const inject = ["systemPrompt"];

export function apply(ctx, config = {}) {
  const log = (m) => ctx?.logger?.info?.(m);
  const warn = (m) => ctx?.logger?.warn?.(m);

  const surface = detectSurface(config.host);
  if (!surface) {
    warn("[dsh-armor] host not found; nothing applied");
    return;
  }

  if (config.applyOnStart !== false) {
    try {
      const { results, summary } = applyAll({ host: surface.host, patchesFile: config.patchesFile });
      log(`[dsh-armor] tree ${summary.applied}/${results.length} applied (host ${surface.desktopVersion || "?"})`);
      const drift = results.filter((r) => r.state === "DRIFT");
      for (const d of drift) warn(`[dsh-armor] drift: ${d.id} — run \`armor resync\``);
    } catch (e) {
      warn(`[dsh-armor] tree apply failed: ${e.message}`);
    }
  }

  if (config.asar && surface.asar) {
    try {
      const patches = loadPatches(config.patchesFile);
      const r = patchAsar(surface.asar, patches, { backup: config.asarBackup !== false, log });
      const ok = r.results.filter((x) => x.state === "APPLIED").length;
      log(`[dsh-armor] asar ${ok}/${r.results.length} applied${r.verify ? ` (verify ${r.verify.ok ? "ok" : "FAIL"})` : ""}`);
    } catch (e) {
      warn(`[dsh-armor] asar apply failed: ${e.message}`);
    }
  }

  // 提示词路由：把选中的文本登记到 systemPrompt 的注入上下文里（若宿主提供 service）
  try {
    const byModel = config.promptRouter?.byModel || {};
    const policy = config.promptRouter?.policy || "fallback";
    const svc = ctx?.get?.("systemPrompt");
    if (svc && typeof svc.addContext === "function" && config.promptRouter?.model) {
      const picked = pickPrompt(config.promptRouter.model, byModel);
      if (picked.file) svc.addContext("dsh-armor.prompt", { file: picked.file, policy });
    }
  } catch {
    /* 宿主 API 差异：路由失败不影响补丁 */
  }
}

export default { name, inject, apply };
