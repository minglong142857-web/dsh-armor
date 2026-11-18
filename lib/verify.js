/**
 * 行为断言：不只看 marker 在不在，而是断言"被改掉的那段代码确实不见了、替换后的语义确实在"。
 * 每条补丁带 verify:{ absent:[...], present:[...] }，两个面（tree / asar）都能跑。
 *
 * 这是"代码是补丁版"的证据，不是"运行进程加载了它"的证据——后者要看进程命令行 + asar 面状态。
 */
import fs from "node:fs";
import path from "node:path";
import { walk, readLayout, readEntry } from "./asar.js";

/** 内置断言：id -> {absent, present}（对文本做包含判断） */
export const ASSERTIONS = {
  // 注意：错误码 SANDBOX_ESCALATION_* 仍被"入参配对/空理由"那条校验用着，不能当残留判据。
  // 只断言被删掉的那两句原文。
  "SBX-LADDER": {
    absent: ["is not strictly wider than this call's current", "requires approval, but no approval service is composed"],
    present: ["every escalation request is granted"],
  },
  "SBX-GRANT": {
    absent: ['await approval.approver.request({'],
    present: ['const outcome = "allowed-once"'],
  },
  "REMINDER-OFF": {
    absent: ["prependContext(reminder, downstream.additionalContexts)"],
    present: ["repeat reminder disabled"],
  },
  "APPROVAL-FAILOPEN": {
    absent: ['approvalDenial(ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)`'],
    present: ['// [armor] fail-open'],
  },
  "PROMPT-KEEP-CONTEXTS": {
    absent: ["runtimeContextSuppressed ? transformed.contexts.filter"],
    present: ["keep every context"],
  },
  "DELIVERABLE-PROHIBITION": {
    absent: ["Do not call present just to list edited source files"],
    present: ["spaces. Use present"],
  },
  "PTC-APPROVAL-SENTENCE": {
    absent: ["requires justification and approval."],
  },
  "PTC-REASON-SENTENCE": {
    absent: ["wider sandbox mode"],
  },
  "LOOP-MESSAGES-GUARD": {
    present: ["[armor]"],
  },
};

function checkText(text, rule) {
  const missing = (rule.absent || []).filter((s) => text.includes(s));
  const absentPresent = (rule.present || []).filter((s) => !text.includes(s));
  return {
    ok: missing.length === 0 && absentPresent.length === 0,
    leftover: missing,
    missingExpected: absentPresent,
  };
}

/** tree 面 */
export function verifyTree(host, patches) {
  return patches.map((p) => {
    const file = path.join(host, p.file);
    if (!fs.existsSync(file)) return { id: p.id, surface: "tree", state: "MISSING", ok: false };
    const text = fs.readFileSync(file, "utf8");
    const rule = ASSERTIONS[p.id];
    if (!rule) return { id: p.id, surface: "tree", state: "NO-ASSERTION", ok: text.includes(p.marker) };
    const r = checkText(text, rule);
    return { id: p.id, surface: "tree", state: r.ok ? "PATCHED" : "VANILLA", ...r };
  });
}

/** asar 面 */
export function verifyAsarSurface(asarFile, patches) {
  const { fd, header, dataStart } = readLayout(asarFile);
  try {
    const byPath = new Map(walk(header).map((e) => [e.path, e]));
    return patches.map((p) => {
      const rel = "dsh/node_modules/@deepseek-ai/" + String(p.file).replace(/\\/g, "/");
      const hit = byPath.get(rel);
      if (!hit) return { id: p.id, surface: "asar", state: "MISSING", ok: false };
      const buf = readEntry(fd, dataStart, hit.entry);
      const text = buf ? buf.toString("utf8") : "";
      const rule = ASSERTIONS[p.id];
      if (!rule) return { id: p.id, surface: "asar", state: "NO-ASSERTION", ok: text.includes(p.marker) };
      const r = checkText(text, rule);
      return { id: p.id, surface: "asar", state: r.ok ? "PATCHED" : "VANILLA", ...r };
    });
  } finally {
    fs.closeSync(fd);
  }
}

export function summarizeVerify(rows) {
  const s = { patched: 0, vanilla: 0, missing: 0, noAssertion: 0, total: rows.length };
  for (const r of rows) {
    if (r.state === "PATCHED") s.patched++;
    else if (r.state === "VANILLA") s.vanilla++;
    else if (r.state === "MISSING") s.missing++;
    else s.noAssertion++;
  }
  return s;
}
