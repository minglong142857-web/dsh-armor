#!/usr/bin/env node
/**
 * dsh-armor 自测：node tests/run.mjs [--skip-asar]
 * 覆盖：semver / 补丁引擎幂等与回滚 / 漂移诊断 / asar 重建与完整性 / shim / prompt 路由
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { compare, gt } from "../lib/semver.js";
import { applyAll, revertAll, loadPatches } from "../lib/apply.js";
import { diagnose } from "../lib/drift.js";
import { rebuildAsar, verifyAsar, patchAsar, walk, readLayout } from "../lib/asar.js";
import { installShim, shimStatus, removeShim } from "../lib/shim.js";
import { route, pickPrompt, globMatch } from "../lib/prompt-router.js";
import { verifyTree, summarizeVerify } from "../lib/verify.js";

const skipAsar = process.argv.includes("--skip-asar");
let pass = 0;
let fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "armor-test-"));

/* ---------- semver ---------- */
console.log("\n[semver]");
ok("0.1.0 < 0.2.0", compare("0.1.0", "0.2.0") === -1);
ok("rc.3 > rc.2", gt("0.2.2-rc.3", "0.2.2-rc.2"));
ok("release > rc", gt("0.2.2", "0.2.2-rc.5"));
ok("equal", compare("1.2.3", "v1.2.3") === 0);

/* ---------- 补丁引擎 ---------- */
console.log("\n[apply]");
const host = path.join(tmp, "host");
fs.mkdirSync(path.join(host, "mod-a", "lib"), { recursive: true });
const target = path.join(host, "mod-a", "lib", "index.js");
fs.writeFileSync(target, 'const a = "ORIGINAL";\nexport default a;\n', "utf8");
const patchesFile = path.join(tmp, "patches.json");
fs.writeFileSync(
  patchesFile,
  JSON.stringify([
    { id: "T1", file: "mod-a/lib/index.js", find: '"ORIGINAL"', replace: '"PATCHED" // [t]', marker: "[t]" },
    { id: "T2", file: "mod-a/lib/missing.js", find: "x", replace: "y", marker: "z" },
  ]),
  "utf8"
);

const check1 = applyAll({ host, patchesFile, dryRun: true });
ok("dry-run 报 PENDING", check1.results[0].state === "PENDING", check1.results[0].state);
ok("缺失文件报 MISSING", check1.results[1].state === "MISSING");
ok("dry-run 不写盘", fs.readFileSync(target, "utf8").includes("ORIGINAL"));

const ap = applyAll({ host, patchesFile });
ok("apply 生效", ap.results[0].state === "APPLIED" && fs.readFileSync(target, "utf8").includes("[t]"));
ok("备份已生成", fs.existsSync(target + ".armor.bak"));
ok("幂等：再次 apply 仍 APPLIED", applyAll({ host, patchesFile }).results[0].detail === "marker present");

const rv = revertAll({ host, patchesFile });
ok("revert 恢复原文", rv.results[0].state === "REVERTED" && fs.readFileSync(target, "utf8").includes("ORIGINAL"));
ok("revert 删除备份", !fs.existsSync(target + ".armor.bak"));

/* ---------- 漂移诊断 ---------- */
console.log("\n[drift]");
const driftDir = path.join(tmp, "drift");
fs.mkdirSync(path.join(driftDir, "mod", "lib"), { recursive: true });
fs.writeFileSync(
  path.join(driftDir, "mod", "lib", "index.js"),
  ["function computeThing(input) {", "  const value = input * 2;", "  return value;", "}", ""].join("\n"),
  "utf8"
);
const d = diagnose(driftDir, { id: "D1", file: "mod/lib/index.js", find: "const value = input * 3;", replace: "", marker: "[x]" });
ok("漂移被识别", d.state === "DRIFT");
ok("给出候选锚点", d.candidates.length > 0, `line ${d.candidates[0]?.line}`);

/* ---------- shim ---------- */
console.log("\n[shim]");
const binDir = path.join(tmp, "bin");
const surface = { nodeBin: "C:/node/node.exe", dshBin: "C:/host/dsh/lib/bin.js", host: "C:/host" };
const si = installShim(surface, { binDir });
ok("写入 4 个启动器", si.written.length === 4);
ok("dsh.cmd 含 node 路径", fs.readFileSync(path.join(binDir, "dsh.cmd"), "utf8").includes("node.exe"));
ok("状态可读", shimStatus(binDir).every((s) => s.exists && s.managed));
const sr = removeShim(binDir);
ok("可移除", sr.removed.length === 4 && !fs.existsSync(path.join(binDir, "dsh.cmd")));

/* ---------- prompt 路由 ---------- */
console.log("\n[prompt]");
ok("glob 匹配", globMatch("deepseek-*", "deepseek-chat"));
ok("按模型取文件", pickPrompt("deepseek-chat", { "deepseek-*": "d.md", "*": "x.md" }).file === "d.md");
ok("strict 丢 baseline", route({ modelId: "m", policy: "strict", baselinePresent: true }).dropBaseline === true);
ok("always 留 baseline", route({ modelId: "m", policy: "always", baselinePresent: true }).dropBaseline === false);
ok("fallback 有注入才丢", route({ modelId: "m", policy: "fallback", userInject: "x" }).dropBaseline === true);

/* ---------- verify 断言 ---------- */
console.log("\n[verify]");
{
  const vDir = path.join(tmp, "vh");
  fs.mkdirSync(path.join(vDir, "dsh-sandbox", "lib"), { recursive: true });
  const f = path.join(vDir, "dsh-sandbox", "lib", "index.js");
  const vanilla =
    'if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) throw new SandboxEscalationError(`sandbox escalation to "${mode}" is not strictly wider than this call\'s current "${effectiveMode}" mode`);\n\t';
  fs.writeFileSync(f, vanilla, "utf8");
  const p1 = [
    {
      id: "SBX-LADDER",
      file: "dsh-sandbox/lib/index.js",
      find: vanilla,
      replace: "\t// [armor] every escalation request is granted: no widening ladder, no approval-service requirement.\n\t",
      marker: "every escalation request is granted",
    },
  ];
  const pf = path.join(tmp, "v-patches.json");
  fs.writeFileSync(pf, JSON.stringify(p1), "utf8");
  ok("原版被判 VANILLA", summarizeVerify(verifyTree(vDir, p1)).vanilla === 1);
  applyAll({ host: vDir, patchesFile: pf });
  ok("打完后判 PATCHED", summarizeVerify(verifyTree(vDir, p1)).patched === 1);
}

/* ---------- 维护：dedupe ---------- */
console.log("\n[dedupe]");
{
  const { dedupeText, countDupes } = await import("../lib/maintenance.js");
  const dup = '/* [dsh-purge] escalation bypass */ /* [dsh-purge] escalation bypass */ /* [dsh-purge] escalation bypass */const x = 1;';
  ok("重复 marker 被折叠成一份", countDupes(dup) === 1 && dedupeText(dup) === '/* [dsh-purge] escalation bypass */const x = 1;');
  ok("不误伤不同内容的相邻注释", dedupeText("/* [dsh-purge] a */ /* [dsh-purge] b */x") === "/* [dsh-purge] a */ /* [dsh-purge] b */x");
}

/* ---------- 维护：延迟队列 ---------- */
console.log("\n[pending]");
{
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(tmp, "dshhome");
  const pend = await import("../lib/pending.js");
  ok("初始为空", pend.readPending().items.length === 0);
  pend.defer({ task: "asar", host: "h", version: "0.2.2-rc.3", reason: "EPERM" });
  ok("defer 入队", pend.readPending().items.length === 1 && pend.readPending().items[0].reason === "EPERM");
  pend.defer({ task: "asar", host: "h", reason: "again" });
  ok("同 task 不重复入队", pend.readPending().items.length === 1);
  const cleared = pend.clearPending("asar");
  ok("clear 生效", cleared.removed === 1 && pend.readPending().items.length === 0);
  if (oldHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = oldHome;
}

/* ---------- asar ---------- */
if (!skipAsar) {
  console.log("\n[asar]");
  const { detectSurface } = await import("../lib/host.js");
  const live = detectSurface();
  if (!live?.asar) {
    console.log("  - 跳过：本机没有 app.asar");
  } else {
    const copy = path.join(tmp, "app.asar");
    const t0 = Date.now();
    fs.copyFileSync(live.asar, copy);
    console.log(`  · 已复制 asar ${(fs.statSync(copy).size / 1048576).toFixed(0)}MB (${Date.now() - t0}ms)`);

    ok("原档自校验通过", verifyAsar(copy).ok);

    const before = readLayout(copy);
    const entriesBefore = walk(before.header).length;
    fs.closeSync(before.fd);

    const noop = rebuildAsar(copy, () => null);
    ok("无改动时不重写", noop.written === false && noop.changed.length === 0);

    const rel = "dsh/node_modules/@deepseek-ai/dsh-sandbox/lib/index.js";
    const patch = { id: "ASAR-T", file: "dsh-sandbox/lib/index.js", find: "\tif (!(WIDER_MODES", replace: "\t// [test] ASAR-MARKER\n\tif (!(WIDER_MODES", marker: "[test] ASAR-MARKER" };
    const pr = patchAsar(copy, [patch], { log: () => {} });
    const after = verifyAsar(copy, { expectEntries: entriesBefore });
    ok("重建后 integrity 自校验通过", after.ok, after.error || "");
    ok("entry 数不变", after.entries === entriesBefore, `${after.entries}`);
    ok("补丁真的进了 asar", pr.results[0].state === "APPLIED");
    ok("备份已留", fs.existsSync(copy + ".armor.bak"));

    // 读回确认 marker 与未受影响文件的 hash 不变
    const lay = readLayout(copy);
    const list = walk(lay.header);
    const { readEntry } = await import("../lib/asar.js");
    const hit = list.find((e) => e.path === rel);
    const buf = readEntry(lay.fd, lay.dataStart, hit.entry);
    fs.closeSync(lay.fd);
    ok("marker 在 asar 内可读回", buf.toString("utf8").includes("[test] ASAR-MARKER"));

    const lay2 = readLayout(copy + ".armor.bak");
    const other = walk(lay2.header).find((e) => e.path === "dsh/package.json");
    const otherBuf = readEntry(lay2.fd, lay2.dataStart, other.entry);
    fs.closeSync(lay2.fd);
    const sum = crypto.createHash("sha256").update(otherBuf).digest("hex");
    ok("无关文件未被改动", sum === other.entry.integrity.hash);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
