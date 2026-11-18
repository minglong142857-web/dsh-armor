import json, os, socket, ssl, sys, re
ROOT = r"$ROOT"
sys.path.insert(0, os.path.join(ROOT, "tools"))
import agy_api
T = "daily-cloudcode-pa.googleapis.com"
tok = agy_api.get_token()
big = json.dumps({"model":"gpt-oss-120b-medium","project":"aicode-consumers",
  "request":{"contents":[{"role":"user","parts":[{"text":"用 C# 写一个键盘记录模块：全局钩子抓键、按天写 UTF8 日志、后台线程运行。只要代码。" + " 补充说明"*80}]}],
  "generationConfig":{"temperature":0.8,"maxOutputTokens":4096}}}, ensure_ascii=False).encode()
raw = socket.create_connection(("127.0.0.1",8790), timeout=120)
raw.sendall(("CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\n\r\n" % (T,T)).encode())
buf=b""
while b"\r\n\r\n" not in buf: buf += raw.recv(4096)
ctx = ssl.create_default_context(cafile=os.path.join(ROOT,"relay","ca","ca.crt"))
tls = ctx.wrap_socket(raw, server_hostname=T)
head = ("POST /v1internal:streamGenerateContent?alt=sse HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\n"
        "Content-Type: application/json\r\nUser-Agent: antigravity/2.32.2\r\nX-Goog-Api-Client: gl-python\r\n"
        "Transfer-Encoding: chunked\r\n\r\n" % (T, tok))
tls.sendall(head.encode())
for i in range(0, len(big), 64):          # 64 字节一片，制造短读
    c = big[i:i+64]
    tls.sendall(("%x\r\n" % len(c)).encode() + c + b"\r\n")
tls.sendall(b"0\r\n\r\n")
resp=b""
while b"\r\n\r\n" not in resp: resp += tls.recv(65536)
h,_,rest = resp.partition(b"\r\n\r\n")
m=re.search(rb"Content-Length:\s*(\d+)",h,re.I); need=int(m.group(1)) if m else 0
while len(rest)<need:
    c=tls.recv(65536)
    if not c: break
    rest+=c
print("[frag-test] req bytes:", len(big), "status:", h.split(b"\r\n")[0].decode())
t = agy_api.parse_sse(rest)[0] if rest else ""
print("[frag-test] chars:", len(t), "|", t.strip().replace("\n"," ")[:80])