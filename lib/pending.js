/**
 * 延迟应用队列：asar 面必须在宿主退出时才能重写（Windows 锁文件）。
 * 拿不到锁就记一条 pending，下次宿主没起来时补跑。
 *
 *   $DSH_HOME/armor/pending.json = { items:[{task:"asar", at, host, version}] }
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function stateDir() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "armor");
}
export function pendingFile() {
  return path.join(stateDir(), "pending.json");
}

export function readPending() {
  try {
    return JSON.parse(fs.readFileSync(pendingFile(), "utf8"));
  } catch {
    return { items: [] };
  }
}

export function writePending(state) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(pendingFile(), JSON.stringify(state, null, 2), "utf8");
  return pendingFile();
}

export function defer({ task = "asar", host, version, reason = "", surface }) {
  const state = readPending();
  state.items = state.items.filter((i) => i.task !== task);
  state.items.push({ task, host, version, reason, surface: surface || null, at: new Date().toISOString() });
  return writePending(state);
}

export function clearPending(task) {
  const state = readPending();
  const before = state.items.length;
  state.items = task ? state.items.filter((i) => i.task !== task) : [];
  writePending(state);
  return { removed: before - state.items.length, left: state.items.length };
}

/** 宿主是否在跑（Windows 用 tasklist；其它平台靠调用方自己判断） */
export function hostRunning() {
  if (process.platform !== "win32") return { running: false, detail: "non-windows: 由调用方保证宿主已退出" };
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq DeepSeek Harness.exe", "/NH"], { encoding: "utf8" });
  const text = `${r.stdout || ""}`;
  const running = /DeepSeek Harness\.exe/i.test(text) && !/no tasks are running/i.test(text);
  const pids = [...text.matchAll(/DeepSeek Harness\.exe\s+(\d+)/gi)].map((m) => m[1]);
  return { running, pids, detail: running ? `运行中 pids=${pids.join(",")}` : "未运行" };
}

/**
 * 补跑队列。applyAsar 由调用方注入（避免 lib 循环依赖）。
 * @returns {{ran:boolean, reason?:string, tasks?:string[]}}
 */
export function runPending({ applyAsar, force = false } = {}) {
  const state = readPending();
  if (!state.items.length) return { ran: false, reason: "队列为空" };
  const h = hostRunning();
  if (h.running && !force) return { ran: false, reason: `宿主仍在运行（${h.detail}），等它退出再跑` };

  const done = [];
  for (const item of state.items) {
    if (item.task === "asar") {
      applyAsar(item);
      done.push("asar");
    }
  }
  clearPending();
  return { ran: true, tasks: done };
}

/** 注册"登录时补跑"的计划任务（Windows） */
export function scheduleLogon(armorEntry) {
  if (process.platform !== "win32") return { ok: false, reason: "仅 Windows" };
  const node = process.execPath;
  const tr = `"${node}" "${armorEntry}" pending run`;
  const r = spawnSync("schtasks", ["/Create", "/TN", "dsh-armor-pending", "/SC", "ONLOGON", "/TR", tr, "/F"], { encoding: "utf8" });
  return { ok: r.status === 0, detail: `${r.stdout || ""}${r.stderr || ""}`.trim() };
}

export function unscheduleLogon() {
  if (process.platform !== "win32") return { ok: false, reason: "仅 Windows" };
  const r = spawnSync("schtasks", ["/Delete", "/TN", "dsh-armor-pending", "/F"], { encoding: "utf8" });
  return { ok: r.status === 0, detail: `${r.stdout || ""}${r.stderr || ""}`.trim() };
}
