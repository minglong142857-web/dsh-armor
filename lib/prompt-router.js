/**
 * 提示词路由：按模型挑注入文本 + 工作区 baseline 策略（对齐 purge 的三档）。
 *
 *   byModel: { "deepseek-*": "prompts/deepseek.md", "claude-*": "prompts/claude.md" }
 *   policy : "strict"   —— 去掉宿主 workspace baseline 段
 *            "fallback" —— 有用户注入内容时去掉 baseline（默认）
 *            "always"   —— 保留 baseline
 *
 * 本模块只做"选哪份文本 + 要不要 baseline"，纯函数，便于测试。
 */

export function globMatch(pattern, value) {
  if (!pattern) return false;
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
    "i"
  );
  return re.test(value);
}

export function pickPrompt(modelId, byModel = {}) {
  const keys = Object.keys(byModel).sort((a, b) => b.length - a.length);
  for (const k of keys) if (globMatch(k, modelId || "")) return { source: "model", pattern: k, file: byModel[k] };
  return { source: "default", pattern: null, file: byModel["*"] || byModel.default || null };
}

export function stripBaseline(systemPrompt, baselineMarkers = ["<workspace", "WORKSPACE_CONTEXT", "[workspace]"]) {
  let out = systemPrompt;
  for (const m of baselineMarkers) {
    const i = out.indexOf(m);
    if (i >= 0) out = out.slice(0, i) + out.slice(out.indexOf("\n", i) + 1 || out.length);
  }
  return out;
}

/**
 * @returns {{text:string, chosen:{source,pattern,file}, dropBaseline:boolean, reason:string}}
 */
export function route({ modelId, promptText, byModel = {}, policy = "fallback", userInject = "", baselinePresent = true }) {
  const chosen = pickPrompt(modelId, byModel);
  const hasUser = Boolean((userInject || "").trim());
  let dropBaseline;
  let reason;
  switch (policy) {
    case "strict":
      dropBaseline = true;
      reason = "policy=strict";
      break;
    case "always":
      dropBaseline = false;
      reason = "policy=always";
      break;
    default:
      dropBaseline = hasUser;
      reason = hasUser ? "policy=fallback + user inject present" : "policy=fallback + no user inject";
  }
  return {
    text: promptText || "",
    chosen,
    dropBaseline: dropBaseline && baselinePresent,
    reason,
  };
}
