import sys, json
sys.path.insert(0, r"$ROOT\tools")
import agy_api

tok = agy_api.get_token()
raw = agy_api.call("/v1internal:fetchAvailableModels", {"metadata": {"ideName": "antigravity"}}, tok)
d = json.loads(raw)
ms = d.get("models", {})
print("可用模型数:", len(ms))
for k in sorted(ms):
    v = ms[k]
    q = (v.get("quotaInfo") or {}).get("remainingFraction")
    name = str(v.get("displayName") or "")[:30]
    print("  %-34s %-30s quota=%s" % (k, name, q))
print()
print("默认 agent 模型:", d.get("defaultAgentModelId"))
print("agentModelSorts:", json.dumps(d.get("agentModelSorts"), ensure_ascii=False)[:300])
