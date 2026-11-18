import sys, json
sys.path.insert(0, r"$ROOT\tools")
import agy_api
tok = agy_api.get_token()
def trycall(path, bodies):
    for b in bodies:
        try:
            raw = agy_api.call(path, b, tok)
            return b, json.loads(raw)
        except Exception as e:
            last = str(e)[:80]
    return None, {"err": last}

b, d = trycall("/v1internal:loadCodeAssist", [{}, {"metadata": {"ideName": "hub"}}, {"metadata": {"ideName": "antigravity", "pluginVersion": "2.32.2"}}])
print("loadCodeAssist body:", b)
if "err" in d: print(" err", d)
else:
    print(" currentTier:", (d.get("currentTier") or {}).get("id"))
    print(" paidTier   :", (d.get("paidTier") or {}).get("id"))
    print(" allowed    :", [t.get("id") for t in d.get("allowedTiers") or []])
    print(" project    :", d.get("cloudaicompanionProject"))

b2, d2 = trycall("/v1internal:fetchAvailableModels", [{}, {"metadata": {"ideName": "hub"}}, {"metadata": {"ideName": "antigravity", "pluginVersion": "2.32.2"}}])
print("\nfetchAvailableModels body:", b2)
if "err" in d2: print(" err", d2)
else:
    ms = d2.get("models", {})
    print(" models:", len(ms))
    for k in sorted(ms):
        v = ms[k]
        print("   %-32s quota=%s tier=%s" % (k, (v.get("quotaInfo") or {}).get("remainingFraction"), v.get("model")))