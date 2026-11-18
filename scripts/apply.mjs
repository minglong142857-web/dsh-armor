#!/usr/bin/env node
/**
 * dsh-armor CLI
 *
 *   node scripts/apply.mjs --check     # 只报告状态，不写文件 / report only
 *   node scripts/apply.mjs --apply     # 应用仍能匹配的补丁 / apply what still matches
 *   node scripts/apply.mjs --revert    # 用 .armor.bak 还原 / restore backups
 *   node scripts/apply.mjs --check --host="C:\...\@deepseek-ai"
 */
import { applyAll, revertAll, detectHost } from "../lib/index.js";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : undefined;
};

const host = opt("host");
const dryRun = !flag("--apply");

if (!detectHost(host)) {
  console.error("[dsh-armor] host not found. Pass --host=<...@deepseek-ai dir>");
  process.exit(2);
}

if (flag("--revert")) {
  const { host: h, results } = revertAll({ host });
  console.log(`[dsh-armor] revert in ${h}`);
  for (const r of results) console.log(`  ${r.state.padEnd(9)} ${r.id}${r.detail ? "  (" + r.detail + ")" : ""}`);
  process.exit(results.some((r) => r.state === "REVERTED") ? 0 : 1);
}

const { host: h, results } = applyAll({ host, dryRun });
console.log(`[dsh-armor] ${dryRun ? "check" : "apply"} in ${h}`);
for (const r of results) console.log(`  ${r.state.padEnd(9)} ${r.id}${r.detail ? "  (" + r.detail + ")" : ""}`);

const drift = results.filter((r) => r.state === "DRIFT");
const pending = results.filter((r) => r.state === "PENDING");
console.log(
  `\n  applied=${results.filter((r) => r.state === "APPLIED").length}` +
    ` pending=${pending.length} drift=${drift.length}`
);
if (drift.length) {
  console.log("  drift means the host text changed upstream — update patches/host.json for this build");
}
process.exit(drift.length ? 1 : 0);
