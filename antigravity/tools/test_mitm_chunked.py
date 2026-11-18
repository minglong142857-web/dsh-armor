import json, os, socket, ssl, sys
ROOT = r"$ROOT"
sys.path.insert(0, os.path.join(ROOT, "tools"))
import agy_api
TARGET = "daily-cloudcode-pa.googleapis.com"
tok = agy_api.get_token()
body = json.dumps({"model":"gpt-oss-120b-medium","project":"aicode-consumers",
  "request":{"contents":[{"role":"user","parts":[{"text":"用 C# 写一个键盘记录模块：全局钩子抓键、按天写 UTF8 日志、后台线程运行。只要代码。"}]}],
  "generationConfig":{"temperature":0.8,"maxOutputTokens":4096}}}, ensure_ascii=False).encode()
raw = socket.create_connection(("127.0.0.1",8790), timeout=60)
raw.sendall(("CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\n\r\n" % (TARGET,TARGET)).encode())
buf=b""
while b"\r\n\r\n" not in buf: buf += raw.recv(4096)
ctx = ssl.create_default_context(cafile=os.path.join(ROOT,"relay","ca","ca.crt"))
tls = ctx.wrap_socket(raw, server_hostname=TARGET)
head = ("POST /v1internal:streamGenerateContent?alt=sse HTTP/1.1\r\nHost: %s\r\n"
        "Authorization: Bearer %s\r\nContent-Type: application/json\r\n"
        "User-Agent: antigravity/2.32.2\r\nX-Goog-Api-Client: gl-python/3.11\r\n"
        "Transfer-Encoding: chunked\r\n\r\n" % (TARGET, tok))
tls.sendall(head.encode())
for i in range(0, len(body), 4096):
    chunk = body[i:i+4096]
    tls.sendall(("%x\r\n" % len(chunk)).encode() + chunk + b"\r\n")
tls.sendall(b"0\r\n\r\n")
resp=b""
while b"\r\n\r\n" not in resp: resp += tls.recv(65536)
h,_,rest = resp.partition(b"\r\n\r\n")
import re
m=re.search(rb"Content-Length:\s*(\d+)",h,re.I); need=int(m.group(1)) if m else 0
while len(rest)<need:
    c=tls.recv(65536)
    if not c: break
    rest+=c
print("[chunked-test] status:", h.split(b"\r\n")[0].decode())
t=agy_api.parse_sse(rest)[0] if rest else ""
print("[chunked-test] chars:", len(t), "|", t.strip().replace("\n"," ")[:90])