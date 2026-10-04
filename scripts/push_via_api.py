#!/usr/bin/env python3
"""
git 推送不可用时，用 GitHub Git Data API 推送。

背景：本机 curl 直连 github.com 失败（000），git 的 TLS 握手也被中断，
但 gh api 可用（走的是另一条通道）。此时用 API 走 blob → tree → commit → ref
四步，既能推送，又只产生一个提交、不改写历史。

用法：
    python push_via_api.py --dry-run    # 演练，不创建任何对象
    python push_via_api.py              # 真推
"""
import argparse
import base64
import json
import subprocess
import sys
from pathlib import Path

OWNER = "Liiiyonx"
REPO = "Hearth"
BRANCH = "main"
# 本脚本在 scripts/ 下，仓库根是它的上一级
ROOT = Path(__file__).resolve().parent.parent

# 本次要推送的文件（相对仓库根）
FILES = [
    "README.md",
    "electron-builder.config.js",
    "electron.vite.config.ts",
    "package.json",
    "scripts/prepare-win-codesign.mjs",
    "scripts/probe-packaged.mjs",
    "scripts/prune-locales.mjs",
    "src/main/index.ts",
    "src/main/regression/index.ts",
    "src/main/services/selection.ts",
    "src/main/services/win32.ts",
    "src/main/smoke/index.ts",
    "src/preload/index.ts",
    "src/renderer/bubble.html",
    "src/renderer/src/bubble/bubble.css",
    "src/renderer/src/bubble/main.tsx",
    "scripts/push_via_api.py",
]

COMMIT_MESSAGE = "docs: 更新 README，补充划词即译、打包体积与环境问题"


def api(method, path, payload=None):
    """调用 gh api。方法用 -X 传，body 走 stdin 避免超长命令行。"""
    cmd = ["gh", "api", "-X", method, path]
    if payload is not None:
        cmd += ["--input", "-"]
    proc = subprocess.run(
        cmd,
        input=json.dumps(payload) if payload is not None else None,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if proc.returncode != 0:
        raise RuntimeError(f"{method} {path} 失败：{proc.stderr.strip()}")
    out = proc.stdout.strip()
    return json.loads(out) if out else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    # 0) 权限与默认分支
    info = api("GET", f"repos/{OWNER}/{REPO}")
    if not info["permissions"]["push"]:
        print("没有写权限，终止")
        return 1
    print(f"仓库 {info['full_name']}（{info['private'] and '私有' or '公开'}）")
    print(f"默认分支 {info['default_branch']}，本地 commit {len(FILES)} 个文件待推")

    # 1) 取当前 head 与 base_tree
    ref = api("GET", f"repos/{OWNER}/{REPO}/git/ref/heads/{BRANCH}")
    head_sha = ref["object"]["sha"]
    base_tree = api("GET", f"repos/{OWNER}/{REPO}/git/commits/{head_sha}")["tree"]["sha"]
    print(f"远端 head {head_sha[:8]}，base_tree {base_tree[:8]}")

    if args.dry_run:
        for f in FILES:
            p = ROOT / f
            print(f"  {'OK ' if p.exists() else 'MISS'} {f} "
                  f"({p.stat().st_size if p.exists() else 0} B)")
        print("\n[dry-run] 未创建任何对象")
        return 0

    # 2) 建 blob
    entries = []
    for i, rel in enumerate(FILES, 1):
        p = ROOT / rel
        if not p.exists():
            print(f"  跳过（本地不存在）：{rel}")
            continue
        b64 = base64.b64encode(p.read_bytes()).decode("ascii")
        blob = api(
            "POST",
            f"repos/{OWNER}/{REPO}/git/blobs",
            {"content": b64, "encoding": "base64"},
        )
        entries.append({
            "path": rel,
            "mode": "100644",
            "type": "blob",
            "sha": blob["sha"],
        })
        print(f"  [{i}/{len(FILES)}] blob {blob['sha'][:8]}  {rel}")

    # 3) 建 tree（未列出的文件保持在 base_tree 里）
    tree = api(
        "POST",
        f"repos/{OWNER}/{REPO}/git/trees",
        {"base_tree": base_tree, "tree": entries},
    )
    print(f"tree {tree['sha'][:8]}")

    # 4) 建 commit
    commit = api(
        "POST",
        f"repos/{OWNER}/{REPO}/git/commits",
        {
            "message": COMMIT_MESSAGE,
            "tree": tree["sha"],
            "parents": [head_sha],
        },
    )
    print(f"commit {commit['sha'][:8]}")

    # 5) 动 ref。force:false 是乐观锁——若远端期间被别人推过会失败而非覆盖
    api(
        "PATCH",
        f"repos/{OWNER}/{REPO}/git/refs/heads/{BRANCH}",
        {"sha": commit["sha"], "force": False},
    )
    print(f"已推送到 {BRANCH}：{commit['sha'][:8]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
