#!/usr/bin/env node
/**
 * armor — dsh-armor CLI
 *
 *   armor check                    只报告（不写盘）
 *   armor apply [--asar]           打补丁（--asar 同时重建 app.asar）
 *   armor revert [--asar]          回滚（.armor.bak）
 *   armor doctor                   宿主/版本/两面状态总览（JSON: --json）
 *   armor resync [--write]         漂移诊断 + 候选锚点
 *   armor shim install|remove|status
 *   armor asar verify|patch
 *   armor update check|apply|patches [--feed=URL] [--dry-run]
 *   armor prompt pick --model <id> [--by-model=json] [--policy=strict|fallback|always]
 *
 * 退出码：0 全部命中 / 1 有 pending 或 drift / 2 宿主未找到
 */
import fs from "node:fs";
import path from "node:path";
import { applyAll, revertAll, loadPatches, summarize, REPO_ROOT } from "../lib/apply.js";
import { detectHost, detectSurface } from "../lib/host.js";
import { patchAsar, verifyAsar, listAsarHostFiles } from "../lib/asar.js";
import { diagnoseAll } from "../lib/drift.js";
import * as shim from "../lib/shim.js";
import * as update from "../lib/update.js";
import { route, pickPrompt } from "../lib/prompt-router.js";
import { verifyTree, verifyAsarSurface, summarizeVerify } from "../lib/verify.js";
import { dedupeHost } from "../lib/maintenance.js";
import * as pending from "../lib/pending.js";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const cmd = argv[0];
const sub = argv[1];
const json = has("--json");
const out = (o) => (json ? console.log(JSON.stringify(o, null, 2)) : null);

function needSurface() {
  const s = detectSurface(opt("host"));
  if (!s) {
    console.error("[armor] host not found. 用 --host=<…/app/dsh/node_modules/@deepseek-ai> 指定");
    process.exit(2);
  }
  return s;
}

function printResults(title, results) {
  const s = summarize(results);
  console.log(`[armor] ${title}: applied=${s.applied || 0} pending=${s.pending || 0} drift=${s.drift || 0} missing=${s.missing || 0}`);
  for (const r of results) if (r.state !== "APPLIED") console.log(`  ${r.state.padEnd(8)} ${r.id}${r.detail ? " — " + r.detail : ""}`);
}

switch (cmd) {
  case "check":
  case "status": {
    const s = needSurface();
    const r = applyAll({ host: s.host, patchesFile: opt("patches"), dryRun: true });
    if (json) out({ surface: s, ...r });
    else printResults(`tree check (${s.desktopVersion || "?"})`, r.results);
    process.exit(r.summary.drift ? 1 : 0);
  }

  case "apply": {
    const s = needSurface();
    const r = applyAll({ host: s.host, patchesFile: opt("patches") });
    printResults("tree apply", r.results);
    let asarReport = null;
    if (has("--asar") && s.asar) {
      try {
        asarReport = patchAsar(s.asar, loadPatches(opt("patches")), { log: (m) => !json && console.log(m) });
        if (!json) printResults("asar apply", asarReport.results);
      } catch (e) {
        const file = pending.defer({ host: s.host, version: s.desktopVersion, reason: e.message, surface: s.asar });
        console.error(`[armor] asar 面写入失败：${e.message}`);
        console.error(`[armor] 已记入延迟队列 ${file}`);
        console.error(`        宿主完全退出（含托盘）后跑：armor pending run`);
        console.error(`        想让它自动跑一次：armor pending schedule`);
      }
    }
    if (json) out({ surface: s, tree: r, asar: asarReport });
    process.exit(r.summary.drift || asarReport?.results?.some((x) => x.state === "DRIFT") ? 1 : 0);
  }

  case "revert": {
    const s = needSurface();
    const r = revertAll({ host: s.host, patchesFile: opt("patches") });
    printResults("tree revert", r.results);
    if (has("--asar") && s.asar && fs.existsSync(`${s.asar}.armor.bak`)) {
      fs.copyFileSync(`${s.asar}.armor.bak`, s.asar);
      console.log(`[armor] asar restored from ${path.basename(s.asar)}.armor.bak`);
    }
    if (json) out(r);
    process.exit(0);
  }

  case "doctor": {
    const s = needSurface();
    const tree = applyAll({ host: s.host, patchesFile: opt("patches"), dryRun: true });
    const asarFiles = s.asar ? listAsarHostFiles(s.asar) : [];
    const asarPatches = s.asar ? patchAsar(s.asar, loadPatches(opt("patches")), { dryRun: true }) : null;
    const report = {
      surface: s,
      treeSummary: tree.summary,
      treeIssues: tree.results.filter((r) => r.state !== "APPLIED"),
      asar: s.asar
        ? { present: true, hostFiles: asarFiles.length, backup: fs.existsSync(`${s.asar}.armor.bak`), summary: asarPatches ? summarize(asarPatches.results) : null }
        : { present: false },
      shim: shim.shimStatus(),
      version: update.currentVersion(),
      feed: update.defaultFeed(),
    };
    if (json) out(report);
    else {
      console.log(`host      : ${s.host}`);
      console.log(`version   : ${s.desktopVersion || "?"} / armor ${report.version}`);
      console.log(`asar      : ${report.asar.present ? `${report.asar.hostFiles} 个宿主文件, 备份=${report.asar.backup}` : "无"}`);
      console.log(`tree      : applied=${report.treeSummary.applied} pending=${report.treeSummary.pending} drift=${report.treeSummary.drift}`);
      if (report.asar.summary) console.log(`asar 面   : applied=${report.asar.summary.applied} pending=${report.asar.summary.pending} drift=${report.asar.summary.drift}`);
      console.log(`shim      : ${report.shim.map((x) => `${x.name}=${x.exists ? (x.managed ? "ok" : "foreign") : "missing"}`).join(" ")}`);
      console.log(`feed      : ${report.feed || "(未配置)"}`);
    }
    process.exit(0);
  }

  case "verify": {
    const s = needSurface();
    const patches = loadPatches(opt("patches"));
    const tree = verifyTree(s.host, patches);
    const asar = s.asar ? verifyAsarSurface(s.asar, patches) : [];
    const ts = summarizeVerify(tree);
    const as = s.asar ? summarizeVerify(asar) : null;
    if (json) out({ tree: ts, asar: as, treeRows: tree, asarRows: asar });
    else {
      console.log(`tree 面: ${ts.patched}/${ts.total} PATCHED${ts.vanilla ? `，${ts.vanilla} 条仍是原版` : ""}`);
      if (as) console.log(`asar 面: ${as.patched}/${as.total} PATCHED${as.vanilla ? `，${as.vanilla} 条仍是原版 → 桌面端此刻跑的仍是官方原版代码` : ""}`);
      for (const r of [...tree, ...asar]) if (r.state === "VANILLA") console.log(`  VANILLA  ${r.id} (${r.surface}) 残留=${JSON.stringify(r.leftover)}`);
    }
    const fail = ts.vanilla > 0 || Boolean(has("--strict") && as && as.vanilla > 0);
    process.exit(fail ? 1 : 0);
  }

  case "pending": {
    const s = detectSurface(opt("host"));
    if (sub === "status") {
      const st = pending.readPending();
      const h = pending.hostRunning();
      if (json) out({ ...st, host: h });
      else {
        console.log(`队列: ${st.items.length} 项  (${pending.pendingFile()})`);
        for (const i of st.items) console.log(`  ${i.task}  reason=${i.reason || "-"}  at=${i.at}`);
        console.log(`宿主: ${h.detail}`);
      }
      process.exit(0);
    }
    if (sub === "clear") {
      const r = pending.clearPending(argv[2] && !argv[2].startsWith("--") ? argv[2] : undefined);
      console.log(`[armor] 已清 ${r.removed} 项，剩 ${r.left}`);
      process.exit(0);
    }
    if (sub === "schedule") {
      const r = pending.scheduleLogon(path.join(REPO_ROOT, "bin", "armor.mjs"));
      console.log(`[armor] 计划任务 dsh-armor-pending: ${r.ok ? "已注册（登录时补跑）" : "失败 " + (r.detail || r.reason)}`);
      process.exit(r.ok ? 0 : 1);
    }
    if (sub === "unschedule") {
      const r = pending.unscheduleLogon();
      console.log(`[armor] ${r.ok ? "已删除计划任务" : "删除失败 " + (r.detail || r.reason)}`);
      process.exit(r.ok ? 0 : 1);
    }
    // run
    if (!s) {
      console.error("[armor] host not found");
      process.exit(2);
    }
    const r = pending.runPending({
      force: has("--force"),
      applyAsar: () => patchAsar(s.asar, loadPatches(opt("patches")), { log: (m) => console.log(m) }),
    });
    if (json) out(r);
    else if (!r.ran) console.log(`[armor] 未执行：${r.reason}`);
    else console.log(`[armor] 已补跑：${r.tasks.join(", ")}`);
    if (r.ran && s.asar) {
      const v = verifyAsarSurface(s.asar, loadPatches(opt("patches")));
      const sv = summarizeVerify(v);
      console.log(`[armor] asar 面复验：${sv.patched}/${sv.total} PATCHED`);
    }
    process.exit(r.ran ? 0 : 1);
  }

  case "dedupe": {
    const s = needSurface();
    const rows = dedupeHost(s.host, loadPatches(opt("patches")), { dryRun: has("--check") });
    const dirty = rows.filter((r) => r.before > 0);
    if (json) out(rows);
    else {
      console.log(`[armor] dedupe: ${dirty.length} 个文件有重复 marker${has("--check") ? "（只检查）" : ""}`);
      for (const r of dirty) console.log(`  ${r.file.replace(s.host, "…")}  重复组=${r.before} -> ${has("--check") ? "?" : r.after}`);
    }
    process.exit(0);
  }

  case "resync": {
    const s = needSurface();
    const patches = loadPatches(opt("patches"));
    const diag = diagnoseAll(s.host, patches);
    const drifting = diag.filter((d) => d.state === "DRIFT");
    if (json) out(diag);
    else {
      console.log(`[armor] resync: ${patches.length - drifting.length}/${patches.length} 命中，drift=${drifting.length}`);
      for (const d of drifting) {
        console.log(`\n  ${d.id}  (${d.file})`);
        console.log(`   probes: ${d.probes.join(", ") || "(无独有 token)"}`);
        for (const c of d.candidates) console.log(`   L${c.line}: ${c.text.replace(/\n/g, "⏎").slice(0, 200)}`);
      }
    }
    if (has("--write")) {
      const target = path.join(REPO_ROOT, "patches", "candidates.json");
      fs.writeFileSync(target, JSON.stringify(drifting, null, 2), "utf8");
      console.log(`[armor] 候选已写 ${target}`);
    }
    process.exit(drifting.length ? 1 : 0);
  }

  case "shim": {
    const s = needSurface();
    if (sub === "install") {
      const r = shim.installShim(s, { binDir: opt("bin") });
      (json ? out(r) : null) || console.log(`[armor] shim 已写入 ${r.binDir}\n  ${r.written.join("\n  ")}\n${r.pathHint}`);
      process.exit(0);
    }
    if (sub === "remove") {
      const r = shim.removeShim(opt("bin"));
      (json ? out(r) : null) || console.log(`[armor] 已移除 ${r.removed.length} 个 shim`);
      process.exit(0);
    }
    const st = shim.shimStatus(opt("bin"));
    (json ? out(st) : null) || st.forEach((x) => console.log(`${x.exists ? (x.managed ? "✓" : "!") : "✗"} ${x.name}  ${x.path}`));
    process.exit(0);
  }

  case "asar": {
    const s = needSurface();
    if (!s.asar) {
      console.error("[armor] 该安装没有 app.asar");
      process.exit(2);
    }
    if (sub === "verify") {
      const v = verifyAsar(s.asar);
      console.log(`[armor] asar verify: ${v.ok ? "ok" : "FAIL " + v.error} entries=${v.entries}`);
      process.exit(v.ok ? 0 : 1);
    }
    const r = patchAsar(s.asar, loadPatches(opt("patches")), { dryRun: has("--check"), log: (m) => console.log(m) });
    printResults("asar patch", r.results);
    process.exit(r.results.some((x) => x.state === "DRIFT") ? 1 : 0);
  }

  case "update": {
    try {
      if (sub === "check") {
        const r = await update.check({ feed: opt("feed"), current: update.installedVersion(opt("target", REPO_ROOT)) });
        (json ? out(r) : null) || console.log(`[armor] ${r.current} -> ${r.remoteVersion}  ${r.updateAvailable ? "可更新" : "已是最新"}`);
        process.exit(0);
      }
      if (sub === "apply") {
        const r = await update.apply({ feed: opt("feed"), dryRun: has("--dry-run"), target: opt("target", REPO_ROOT) });
        (json ? out(r) : null) || console.log(`[armor] update: ${r.applied ? `已更新到 ${r.remoteVersion}（sha256 ${r.verifiedSha.slice(0, 12)}…）` : r.reason}`);
        process.exit(0);
      }
      if (sub === "patches") {
        const r = await update.refreshPatches({ feed: opt("feed"), dryRun: has("--dry-run") });
        (json ? out(r) : null) || console.log(`[armor] 补丁表 ${r.count} 条 (+${r.added.length} / -${r.removed.length})${r.dryRun ? " [dry-run]" : ""}`);
        process.exit(0);
      }
    } catch (e) {
      console.error(`[armor] update ${sub || ""} failed: ${e.message}`);
      process.exit(1);
    }
    console.error("usage: armor update check|apply|patches");
    process.exit(2);
  }

  case "prompt": {
    if (sub === "pick") {
      const byModel = JSON.parse(opt("by-model", '{"*":"prompts/default.md"}'));
      const picked = pickPrompt(opt("model", ""), byModel);
      const r = route({ modelId: opt("model", ""), byModel, policy: opt("policy", "fallback"), userInject: "x" });
      (json ? out({ picked, route: r }) : null) ||
        console.log(`model=${opt("model", "?")} -> ${picked.file || "(none)"} (${picked.source}${picked.pattern ? ":" + picked.pattern : ""}) dropBaseline=${r.dropBaseline} [${r.reason}]`);
      process.exit(0);
    }
    console.error("usage: armor prompt pick --model <id>");
    process.exit(2);
  }

  default:
    console.log(fs.readFileSync(path.join(REPO_ROOT, "bin", "usage.txt"), "utf8"));
    process.exit(cmd ? 2 : 0);
}
