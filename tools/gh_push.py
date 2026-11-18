#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通过 GitHub Contents API 提交文件（绕开 git 传输层）。

用途：这台机器到 github.com 的直连被阻断，git 走代理也过不去（openssl 不认本地 CA、
schannel 握手失败），但 REST API 走系统代理是通的。所以用 API 写文件。

用法:
  set GH_TOKEN=ghp_xxx
  python gh_push.py --repo owner/name --branch main README.md docs/x.md ...

说明:
  · 已存在的文件会带上 sha 做更新，不存在则新建
  · 每个文件一次提交（Contents API 的限制）
  · .github/workflows/* 需要 token 具备 workflow scope，否则返回 404
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.github.com"


def req(method: str, url: str, token: str, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Authorization", "token " + token)
    r.add_header("User-Agent", "gh-push")
    r.add_header("Accept", "application/vnd.github+json")
    if data:
        r.add_header("Content-Type", "application/json; charset=utf-8")
    with urllib.request.urlopen(r, timeout=90) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="owner/name")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--message", default="")
    ap.add_argument("files", nargs="+")
    args = ap.parse_args()

    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        print("缺少 GH_TOKEN", file=sys.stderr)
        return 2

    ok = 0
    for path in args.files:
        if not os.path.exists(path):
            print("跳过（不存在）:", path)
            continue
        api_path = path.replace("\\", "/")
        url = "%s/repos/%s/contents/%s" % (API, args.repo, api_path)
        payload = {"message": args.message or ("update " + api_path),
                   "content": base64.b64encode(open(path, "rb").read()).decode()}
        try:
            cur = req("GET", url + "?ref=" + args.branch, token)
            if isinstance(cur, dict) and cur.get("sha"):
                payload["sha"] = cur["sha"]
        except urllib.error.HTTPError:
            pass
        try:
            out = req("PUT", url, token, payload)
            print("OK  %-46s commit=%s" % (api_path, out["commit"]["sha"][:8]))
            ok += 1
        except urllib.error.HTTPError as e:
            print("FAIL %-46s %s %s" % (api_path, e.code, e.read().decode()[:120]))
    print("\n完成 %d/%d" % (ok, len(args.files)))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
