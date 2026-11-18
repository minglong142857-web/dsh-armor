import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import agy_api  # noqa: E402

tok = agy_api.get_token()
data = json.loads(agy_api.call("/v1internal:fetchAvailableModels", {}, tok))
models = data.get("models", {})
print("%d,%s" % (len(models), ",".join(sorted(models)[:6])))
