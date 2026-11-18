import sys, json
sys.path.insert(0, r"$ROOT\tools")
import agy_api
tok = agy_api.get_token()
raw = agy_api.call("/v1internal:fetchAvailableModels", {}, tok)
d = json.loads(raw)
ms = d.get("models", {})
print("API 可用模型 %d 个（GUI 只放出 4 个）:" % len(ms))
for k in sorted(ms):
    print("   ", k)