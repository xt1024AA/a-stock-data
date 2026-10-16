#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""校验随包 SKILL.md 是否满足 DSH 的 skill 发现契约。

DSH 的 skill 发现规则（`@deepseek-ai/dsh-skill-filesystem` 提供方，rank 600）：
  * 深度**只有一层**：`<root>/<name>/SKILL.md` 或 `<root>/<name>.md`；
    刻意不支持嵌套 `**/SKILL.md`，所以子目录里再放 SKILL.md 不会被发现。
  * frontmatter **必填 `name`（kebab-case）与 `description`**。
  * 可选 `whenToUse` / `metadata` / `disable-model-invocation` / `user-invocable`；
    未知顶层键有被整条丢弃的风险，自定义信息请收进 `metadata`。
  * 两个调用开关按严格布尔语法解析（`true/false`、`yes/no`、`on/off`、`1/0`）；
    **拼错或写成非布尔值会让整个 skill 随警告一起被丢弃**，所以这里也校验。

用法：python scripts/check_skill_contract.py
退出码：0 全部通过；1 有失败项。
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

try:
    import yaml  # type: ignore
except ImportError:  # 没装 PyYAML 时退到逐行解析（够用，因为我们只查键的存在与形态）
    yaml = None

ROOT = Path(__file__).resolve().parents[1]
SKILLS_DIR = ROOT / "skills"
SKILL_DIR = SKILLS_DIR / "a-stock-data"
SKILL_MD = SKILL_DIR / "SKILL.md"
ROOT_SKILL_MD = ROOT / "SKILL.md"

ALLOWED_KEYS = {"name", "description", "whenToUse", "metadata",
                "disable-model-invocation", "user-invocable"}

_failures: list[str] = []


def check(label: str, cond: bool, detail: str = "") -> bool:
    mark = "✓" if cond else "✗"
    line = f"  {mark} {label}" + (f" — {detail}" if detail else "")
    print(line)
    if not cond:
        _failures.append(label)
    return cond


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    print("=== 发现深度（只有一层）===")
    check("bundledSkillDir（skills/）存在", SKILLS_DIR.is_dir(), str(SKILLS_DIR))
    if SKILLS_DIR.is_dir():
        entries = sorted(p.name for p in SKILLS_DIR.iterdir())
        print(f"    skills/ 下的条目：{entries}")
    check("skill 目录 a-stock-data/ 存在", SKILL_DIR.is_dir())
    check("a-stock-data/SKILL.md 存在", SKILL_MD.is_file())

    if not SKILL_MD.is_file():
        return report()

    nested = list(SKILLS_DIR.glob("**/SKILL.md"))
    check("没有嵌套的 SKILL.md（嵌套目录不会被发现）",
          all(p.parent == SKILL_DIR for p in nested),
          str([str(p.relative_to(SKILLS_DIR)) for p in nested]))

    print("\n=== frontmatter ===")
    text = SKILL_MD.read_text(encoding="utf-8")
    m = re.match(r"\A---\r?\n(.*?)\r?\n---\r?\n", text, re.S)
    check("有 YAML frontmatter", bool(m))
    if not m:
        return report()

    raw = m.group(1)
    if yaml is not None:
        fm = yaml.safe_load(raw) or {}
        print(f"    解析出的键：{sorted(fm)}")
    else:
        fm = {}
        for line in raw.split("\n"):
            key, sep, value = line.partition(":")
            if sep:
                fm[key.strip()] = value.strip()

    name = str(fm.get("name", ""))
    desc = str(fm.get("description", ""))
    check("name 必填", bool(name), repr(name))
    check("name 是 kebab-case", bool(re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", name)), repr(name))
    check("name 与目录名一致", name == SKILL_DIR.name, f"{name} vs {SKILL_DIR.name}")
    check("description 必填且非空", len(desc) > 20, f"{len(desc)} 字符")

    print("\n=== 可选键的形态 ===")
    unknown = sorted(set(fm) - ALLOWED_KEYS)
    check("没有未知顶层键", not unknown, str(unknown))
    check("自定义信息收在 metadata 里（不是顶层散键）",
          fm.get("metadata") is None or isinstance(fm.get("metadata"), dict),
          json.dumps(fm.get("metadata"), ensure_ascii=False) if yaml is not None else "(未装 PyYAML)")
    for key in ("disable-model-invocation", "user-invocable"):
        if key in fm:
            check(f"{key} 是布尔值（写错会丢整个 skill）",
                  isinstance(fm[key], bool), repr(fm[key]))

    print("\n=== 与根 SKILL.md 的关系 ===")
    check("根 SKILL.md 仍在（Claude / Codex 等宿主继续可用）", ROOT_SKILL_MD.is_file())
    if ROOT_SKILL_MD.is_file():
        src = re.sub(r"\A---\r?\n.*?\r?\n---\r?\n", "",
                     ROOT_SKILL_MD.read_text(encoding="utf-8"), count=1, flags=re.S)
        dst = text[m.end():]
        check("随包 SKILL.md 正文与根文件逐字一致（差异只在 frontmatter）", dst == src,
              f"{len(dst)} vs {len(src)} 字符")

    return report()


def report() -> int:
    if _failures:
        print(f"\n❌ 有 {len(_failures)} 项失败：")
        for f in _failures:
            print(f"  - {f}")
        return 1
    print("\n✓ 全部通过：随包 SKILL.md 满足 DSH 的 skill 发现契约")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())