#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 SKILL.md 提取可运行 Python 运行时，生成 DSH 插件的随包脚本。

SKILL.md 是本仓库的唯一事实来源：87 个端点的实现全部以内嵌 ```python 块的形式写在里面。
本脚本把这些块按文档顺序拼成一个可 import 的模块，让 DSH 插件（以及任何宿主）能直接
调用端点，而不是让模型去复制粘贴代码块。

生成物（都在 skills/a-stock-data/ 下）：
  SKILL.md                   —— 由根 SKILL.md 同步而来（frontmatter 归一为 DSH 合规形态）
  runtime/astock_runtime.py  —— 拼接后的运行时（含全部端点实现）
  runtime/endpoints.json     —— 端点清单（名称 / 签名 / 来源块），供工具面离线展示

用法：
  python scripts/build_runtime.py            # 生成
  python scripts/build_runtime.py --check    # 只校验生成物与 SKILL.md 是否同步（不写盘）

提取规则（为什么是这几条）：
  保留 —— import / def / class；模块级纯常量；会话初始化（EM_SESSION、V39_RETRY_SESSION）
          以及给会话挂重试适配器的 try 块。
  丢弃 —— 模块级示例调用（`day = tencent_kline(...)` 这类），它们是文档里的用法演示，
          `defs_only` 式的 AST 裁剪会把它们留下并在 import 时打真实网络请求。
  软依赖 —— mootdx / baostock / stockstats 缺失时安装 stub，避免顶层 import 直接崩
          （mootdx 会与宿主 litellm 所需的 httpx>=0.27 冲突，不能强制安装）。
"""

from __future__ import annotations

import argparse
import ast
import builtins
import hashlib
import inspect
import json
import re
import sys
import textwrap
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL_SRC = ROOT / "SKILL.md"
SKILL_DST_DIR = ROOT / "skills" / "a-stock-data"
SKILL_DST = SKILL_DST_DIR / "SKILL.md"
RUNTIME_DIR = SKILL_DST_DIR / "runtime"
RUNTIME_PY = RUNTIME_DIR / "astock_runtime.py"
ENDPOINTS_JSON = RUNTIME_DIR / "endpoints.json"

#: 缺失时用 stub 顶上的可选依赖（顶层 import 会直接 ImportError）。
SOFT_DEPS = ("mootdx", "baostock", "stockstats")

#: 仓库 tests/ 依赖的辅助函数所在块——一并纳入，保证与 SKILL.md 行为一致。
HELPER_FUNCS = ("get_prefix", "norm_ticker", "to_joinquant", "em_get", "bs_session")

GENERATED_BY = "scripts/build_runtime.py"


# --------------------------------------------------------------------------- #
# 提取
# --------------------------------------------------------------------------- #
def python_blocks(skill_text: str) -> list[str]:
    """SKILL.md 里所有 ```python 块，按文档顺序。"""
    return re.findall(r"```python\n(.*?)```", skill_text, re.S)


def _names_loaded_in(node: ast.AST) -> set[str]:
    """子树里以 Load 语义出现的名字。

    只看 `ast.Load` 是必须的：`UA = "..."` 的赋值目标也是个 `ast.Name`，但它绑名字
    而不是查名字。早先版本漏了这个判断，于是每条赋值都被算成「引用了自己」，
    在它绑好之前就判成示例代码丢掉——表现为运行时里 `DATACENTER_URL` / `UA` 全没了，
    45 个端点集体 NameError。
    """
    return {n.id for n in ast.walk(node)
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}


def _calls_shipped(node: ast.AST, shipped: set[str]) -> bool:
    """这条语句是否会调用 SKILL.md 自己定义的函数 / 类。

    这是「示例调用」的**充分**判据：真实初始化只碰外部库
    （`requests.Session()`、`HTTPAdapter(...)`、`EM_SESSION.mount(...)`、
    `EM_SESSION.headers.update(...)`），绝不会调用本文件的数据端点；
    而文档示例一定是在调端点（`r = em_get(url, ...)`、`client = tdx_client()`）。

    单靠前向数据流不够：`url = "https://..."` 是条人畜无害的常量，会被保留，
    紧跟其后的 `r = em_get(url, ...)` 于是通过了「名字都绑好了」的检查——
    结果 import 时真去打东财。这条判据专门堵这个缝。
    """
    for sub in ast.walk(node):
        if isinstance(sub, ast.Call):
            func = sub.func
            if isinstance(func, ast.Name) and func.id in shipped:
                return True
            if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) \
                    and func.value.id in shipped:
                return True
    return False


def _bound_names(node: ast.stmt) -> set[str]:
    """一条语句绑定的名字（赋值目标、import 别名、def/class 名）。"""
    names: set[str] = set()
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        names.add(node.name)
        return names
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        for a in node.names:
            names.add((a.asname or a.name).split(".")[0])
        return names
    for child in ast.walk(node):
        if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store):
            names.add(child.id)
    return names


def _loaded_names(node: ast.stmt) -> set[str]:
    """一条语句在**执行时**会去查的名字。

    对 def/class 只算装饰器、默认值与基类——函数体是调用时才求值，不该在这里检查
    （否则 `tdx_client` 这种依赖 mootdx 的实现会被整条丢掉）。
    """
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        out: set[str] = set()
        for sub in node.decorator_list:
            out |= _names_loaded_in(sub)
        args = node.args
        for sub in list(args.defaults) + [d for d in args.kw_defaults if d is not None]:
            out |= _names_loaded_in(sub)
        for sub in getattr(node, "bases", []):
            out |= _names_loaded_in(sub)
        return out
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        return set()
    if isinstance(node, ast.Try):
        # try 体里的 import 是自足的；其余语句照常检查
        out = set()
        for sub in list(node.body) + list(node.orelse) + list(node.finalbody):
            out |= _loaded_names(sub)
        for handler in node.handlers:
            for sub in handler.body:
                out |= _loaded_names(sub)
        return out
    return _names_loaded_in(node)


def _is_docstring(node: ast.stmt) -> bool:
    return (isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str))


def _is_session_setup(node: ast.stmt, safe: set[str], shipped: set[str]) -> bool:
    """`EM_SESSION.headers.update({'User-Agent': UA})` 这类模块级初始化调用。

    判据窄到只认「在已知对象上调方法」：`X.y(...)` 且 X 已绑好、且不碰本文件端点。
    这样 `print(...)`（Name 调用）与 `download_pdf(it[0])` 都不会被误收。
    """
    if not isinstance(node, ast.Expr) or not isinstance(node.value, ast.Call):
        return False
    func = node.value.func
    if not isinstance(func, ast.Attribute) or not isinstance(func.value, ast.Name):
        return False
    if func.value.id not in safe:
        return False
    return not _calls_shipped(node, shipped)


def extract_module(blocks: list[str]) -> tuple[str, list[dict]]:
    """把 SKILL.md 的 python 块拼成一个模块源码。

    判据是**前向数据流**而不是「像不像示例」：从 builtins + 已见过的 import 出发，
    按文档顺序逐条语句检查「它执行时要查的名字此刻是否已绑好」。查不到就说明这条是
    文档里的用法演示（`ticks = tencent_ticks("000001")` 之后紧跟
    `auction = ticks[ticks.time < "09:30:00"]`），丢掉即可。

    这条规则比「右值有没有调用本文件函数」稳：`ticks[...]` 是下标不是调用，
    启发式放它过去，前向数据流一眼就看出 `ticks` 没绑过。
    """
    stmts: list[tuple[int, ast.stmt]] = []
    for i, b in enumerate(blocks):
        for node in ast.parse(b).body:
            stmts.append((i, node))

    # SKILL.md 自己定义的函数 / 类：模块级语句一旦调用它们，就是文档示例而非初始化
    shipped: set[str] = set()
    for _, node in stmts:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            shipped.add(node.name)

    safe: set[str] = set(dir(builtins))
    kept: list[tuple[int, ast.stmt]] = []
    stats: list[dict] = []
    for block_index, node in stmts:
        keep = False
        if _is_docstring(node):
            keep = True
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            keep = True
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            keep = _loaded_names(node) <= safe
        elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.Try)):
            keep = (_loaded_names(node) <= safe) and not _calls_shipped(node, shipped)
        elif _is_session_setup(node, safe, shipped):
            # EM_SESSION.headers.update(...) —— 会话初始化，属于真实装配
            keep = True
        # 其余（For / While / With / print 之类表达式）一律是文档示例

        if keep:
            kept.append((block_index, node))
            safe |= _bound_names(node)
            # try 里挂适配器时会 import，这些名字之后可能被用到
            for sub in ast.walk(node):
                if isinstance(sub, (ast.Import, ast.ImportFrom)):
                    for a in sub.names:
                        safe.add((a.asname or a.name).split(".")[0])
            stats.append({"block": block_index, "kept": True,
                          "summary": ast.unparse(node).split("\n")[0][:70]})
        else:
            stats.append({"block": block_index, "kept": False,
                          "summary": ast.unparse(node).split("\n")[0][:70]})

    # 按块分组，逐块 unparse，保持「同一块内的语句相邻」便于人工对照 SKILL.md
    by_block: dict[int, list[ast.stmt]] = {}
    for block_index, node in kept:
        by_block.setdefault(block_index, []).append(node)

    chunks: list[str] = []
    for block_index in sorted(by_block):
        body = ast.unparse(ast.Module(body=by_block[block_index], type_ignores=[]))
        n_in = blocks[block_index].count("\n") + 1
        n_out = body.count("\n") + 1
        chunks.append(f"# ---- SKILL.md block {block_index} "
                      f"(in {n_in} 行 → out {n_out} 行) ----\n{body}\n\n")

    return "".join(chunks), stats


def build_source(skill_text: str) -> tuple[str, list[dict], str]:
    """把 SKILL.md 的 python 块拼成一个模块源码。

    返回 (源码, 每块统计, SKILL.md 的 sha256)。
    """
    blocks = python_blocks(skill_text)
    if not blocks:
        raise SystemExit("SKILL.md 里没有 ```python 块——文件结构变了？")

    skill_hash = hashlib.sha256(skill_text.encode("utf-8")).hexdigest()

    header = textwrap.dedent(f'''\
        # -*- coding: utf-8 -*-
        """a-stock-data 运行时 —— 由 {GENERATED_BY} 从 SKILL.md 生成，请勿手改。

        生成源：SKILL.md（sha256 {skill_hash[:16]}…）
        生成物：{RUNTIME_PY.relative_to(ROOT).as_posix()}
        重新生成：python {GENERATED_BY}

        为什么是生成而不是手抄：87 个端点的实现在 SKILL.md 里，手抄必然漂移。
        本文件由 scripts/check_parity.py 守护，与 SKILL.md 不一致时构建失败。
        """

        import functools
        import sys as _sys
        import types as _types


        def _install_soft_stubs() -> list:
            """给缺失的可选依赖装 stub，返回被 stub 掉的模块名。

            mootdx 会要求 httpx<0.26，而宿主 litellm/mcp 需要 httpx>=0.27——
            两者不可兼得，所以 mootdx 一律当可选：装了就用，没装就 stub。
            baostock / stockstats 同理（只有部分端点用得上）。
            """
            import importlib.util

            stubbed = []
            for _name in {SOFT_DEPS!r}:
                try:
                    if importlib.util.find_spec(_name) is not None:
                        continue
                except (ImportError, ValueError):
                    pass
                _mod = _types.ModuleType(_name)
                if _name == "mootdx":
                    _q = _types.ModuleType("mootdx.quotes")
                    _q.Quotes = None
                    _mod.quotes = _q
                    _sys.modules["mootdx.quotes"] = _q
                if _name == "baostock":
                    _mod.login = lambda *a, **k: None
                    _mod.logout = lambda *a, **k: None
                _sys.modules[_name] = _mod
                stubbed.append(_name)
            return stubbed


        SOFT_STUBS = _install_soft_stubs()

        ''')

    body, stats = extract_module(blocks)
    source = header + body
    return source, stats, skill_hash


# --------------------------------------------------------------------------- #
# 执行 + 内省
# --------------------------------------------------------------------------- #
def exec_runtime(source: str) -> tuple[dict, list[str]]:
    """执行生成的源码，返回 (命名空间, 被 stub 的软依赖)。"""
    ns: dict = {"__name__": "astock_runtime", "__file__": str(RUNTIME_PY)}
    exec(compile(source, str(RUNTIME_PY), "exec"), ns)
    return ns, list(ns.get("SOFT_STUBS", []))


def endpoint_registry(ns: dict) -> dict:
    """从命名空间里挑出可调用的端点，带上签名。

    规则：本模块定义（__module__ == astock_runtime）的非下划线开头可调用对象。
    下划线开头的是内部工具函数（_v39_* 等），不对外暴露。
    """
    out = {}
    for name, obj in sorted(ns.items()):
        if name.startswith("_"):
            continue
        if not (inspect.isfunction(obj) or inspect.isclass(obj)):
            continue
        if getattr(obj, "__module__", None) != "astock_runtime":
            continue
        try:
            sig = str(inspect.signature(obj))
        except (TypeError, ValueError):
            sig = "(…)"
        doc = inspect.getdoc(obj) or ""
        out[name] = {
            "name": name,
            "signature": sig,
            "summary": doc.strip().split("\n")[0][:200],
        }
    return out


# --------------------------------------------------------------------------- #
# SKILL.md 同步（frontmatter 归一为 DSH 合规形态）
# --------------------------------------------------------------------------- #
FRONTMATTER_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n", re.S)


def normalize_skill_md(text: str) -> str:
    """把根 SKILL.md 的 frontmatter 归一成 DSH 认得的形态。

    DSH 只保证认识 name / description / whenToUse / metadata / disable-model-invocation /
    user-invocable。原文件的 origin / version 是 Claude 侧的自定义键，挪进 metadata，
    免得被解析器当未知键整条丢弃。
    """
    m = FRONTMATTER_RE.match(text)
    if not m:
        raise SystemExit("SKILL.md 缺少 YAML frontmatter——DSH 要求 name 与 description。")

    raw = m.group(1)
    fields: dict[str, str] = {}
    for line in raw.split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, sep, value = line.partition(":")
        if not sep:
            continue
        fields[key.strip()] = value.strip()

    name = fields.get("name", "").strip().strip('"\'')
    desc = fields.get("description", "").strip().strip('"\'')
    if not name or not desc:
        raise SystemExit("SKILL.md frontmatter 缺少 name 或 description——DSH 两者必填。")
    if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", name):
        raise SystemExit(f"skill name 必须是 kebab-case，实际是 {name!r}")

    version = fields.get("version", "").strip().strip('"\'')
    origin = fields.get("origin", "").strip().strip('"\'')
    meta = []
    if version:
        meta.append(f"  version: {json.dumps(version, ensure_ascii=False)}")
    if origin:
        meta.append(f"  origin: {json.dumps(origin, ensure_ascii=False)}")

    fm = ["---", f"name: {name}"]
    fm.append("description: " + json.dumps(desc, ensure_ascii=False))
    if meta:
        fm.append("metadata:")
        fm.extend(meta)
    fm.append("---")
    return "\n".join(fm) + "\n" + text[m.end():]


def skill_md_expected(skill_text: str) -> str:
    return normalize_skill_md(skill_text)


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def build(check_only: bool) -> int:
    if not SKILL_SRC.exists():
        raise SystemExit(f"找不到 {SKILL_SRC}")

    skill_text = SKILL_SRC.read_text(encoding="utf-8")
    source, stats, skill_hash = build_source(skill_text)
    skill_dst = skill_md_expected(skill_text)

    # 语法必须是 Python 3.9 兼容（SKILL.md 自己承诺 Python 3.9+）
    try:
        ast.parse(source, feature_version=(3, 9))
    except SyntaxError as exc:
        print(f"❌ 生成的运行时不是合法的 Python 3.9：{exc}", file=sys.stderr)
        return 2

    ns, stubbed = exec_runtime(source)
    registry = endpoint_registry(ns)

    kept_stmts = sum(1 for s in stats if s["kept"])
    dropped_stmts = sum(1 for s in stats if not s["kept"])
    source_lines = source.count("\n") + 1

    endpoints_payload = {
        "generatedBy": GENERATED_BY,
        "skillSha256": skill_hash,
        "softStubs": stubbed,
        "blocks": len(python_blocks(skill_text)),
        "endpointCount": len(registry),
        "endpoints": registry,
    }
    endpoints_text = json.dumps(endpoints_payload, ensure_ascii=False, indent=2) + "\n"

    print(f"SKILL.md sha256 : {skill_hash}")
    print(f"python 块       : {len(python_blocks(skill_text))}")
    print(f"模块级语句      : 保留 {kept_stmts} / 丢弃示例 {dropped_stmts}")
    print(f"生成行数        : {source_lines}")
    print(f"软依赖 stub     : {stubbed or '（无，依赖齐全）'}")
    print(f"端点            : {len(registry)}")

    if check_only:
        problems = []
        for path, expected, label in (
            (RUNTIME_PY, source, "运行时"),
            (ENDPOINTS_JSON, endpoints_text, "端点清单"),
            (SKILL_DST, skill_dst, "随包 SKILL.md"),
        ):
            if not path.exists():
                problems.append(f"{label} 缺失：{path.relative_to(ROOT)}")
            elif path.read_text(encoding="utf-8") != expected:
                problems.append(f"{label} 与 SKILL.md 不同步：{path.relative_to(ROOT)}")
        if problems:
            print("\n❌ 生成物与 SKILL.md 不一致：", file=sys.stderr)
            for p in problems:
                print(f"  - {p}", file=sys.stderr)
            print(f"\n修复：python {GENERATED_BY}", file=sys.stderr)
            return 1
        print("\n✓ 生成物与 SKILL.md 同步")
        return 0

    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    RUNTIME_PY.write_text(source, encoding="utf-8", newline="\n")
    ENDPOINTS_JSON.write_text(endpoints_text, encoding="utf-8", newline="\n")
    SKILL_DST.write_text(skill_dst, encoding="utf-8", newline="\n")
    print(f"\n✓ 已写出：")
    for p in (RUNTIME_PY, ENDPOINTS_JSON, SKILL_DST):
        print(f"  - {p.relative_to(ROOT)}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="从 SKILL.md 生成 DSH 插件运行时")
    ap.add_argument("--check", action="store_true",
                    help="只校验生成物是否与 SKILL.md 同步，不写盘")
    args = ap.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    return build(args.check)


if __name__ == "__main__":
    raise SystemExit(main())
