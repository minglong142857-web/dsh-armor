#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""relay 端到端测试：把一条 generateContent 请求打到本地 relay，看它改写/重试后返回什么。"""
from __future__ import annotations
import argparse, json, os, sys, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import agy_api


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--relay", default="http://127.0.0.1:8790")
    ap.add_argument("--model", default="gemini-3-flash")
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--system", default="none", help="none=不传 systemInstruction（让 relay 自己加）")
    args = ap.parse_args()

    tok = agy_api.get_token()
    body = {
        "model": args.model,
        "project": agy_api.PROJECT,
        "request": {
            "contents": [{"role": "user", "parts": [{"text": args.prompt}]}],
            "generationConfig": {"temperature": 0.8, "maxOutputTokens": 8192},
        },
    }
    if args.system != "none":
        body["request"]["systemInstruction"] = {"role": "user", "parts": [{"text": args.system}]}

    req = urllib.request.Request(
        args.relay + "/v1internal:streamGenerateContent?alt=sse",
        data=json.dumps(body).encode(), method="POST")
    req.add_header("Authorization", "Bearer " + tok)
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "antigravity/2.32.1 (Windows NT 10.0; Win64; x64)")
    req.add_header("X-Goog-Api-Client", "gl-python/3.11 grpc/1.60.0")
    req.add_header("X-Client-Name", "antigravity")
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            raw = r.read()
            print(f"[http] {r.status}  {len(raw)} bytes", file=sys.stderr)
    except urllib.error.HTTPError as e:
        print("[http] " + str(e.code) + " " + e.read().decode("utf-8", "replace")[:600], file=sys.stderr)
        return 1
    text = agy_api.parse_sse(raw)[0] if hasattr(agy_api, "parse_sse") else raw.decode("utf-8", "replace")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


