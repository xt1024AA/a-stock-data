#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""a-stock-data 运行时命令行入口 —— DSH 工具面与 SKILL.md 端点之间的桥。

DSH 插件（Node 侧）不 import Python，而是以子进程方式调用本脚本，拿单行 JSON 回去。
这样职责干净：Python 负责取数与出表，Node 负责工具面与审批。

子命令：
  list                          列出全部端点（名称 / 签名 / 摘要）
  call <endpoint> [--args JSON] 调用一个端点，结果序列化成 JSON
  env                           环境体检：解释器、依赖、运行时指纹

约定：
  * stdout **只**输出一行 JSON（工具面直接 JSON.parse）；诊断信息走 stderr。
  * 失败也是 JSON：{"ok": false, "error": "...", "errorKind": "..."}，退出码非 0。
  * 出入参一律 JSON，避免命令行转义把中文参数弄坏。

为什么结果要截断：`tdx_daily_package()` 一次返回 5 万行日线，全塞进工具结果会炸上下文。
默认最多回 200 行并在 meta 里写明 truncated，调用方要全量可以调大 --limit。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import sys
import traceback
from datetime import date, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
#: 运行时与本脚本同装在一个包内：<skill>/scripts/astock_cli.py 与 <skill>/runtime/astock_runtime.py
RUNTIME_CANDIDATES = (
    HERE.parent / "runtime" / "astock_runtime.py",
    HERE / "astock_runtime.py",
)

#: 缺了会挡路的运行期依赖（mootdx 故意不列：它与宿主 httpx 需求冲突，只能当可选）
REQUIRED_DEPS = ("requests", "pandas")
OPTIONAL_DEPS = ("numpy", "mootdx", "baostock", "stockstats", "xlrd", "openpyxl")


# --------------------------------------------------------------------------- #
# 输出
# --------------------------------------------------------------------------- #
def emit(payload: dict, code: int = 0) -> int:
    """把结果作为单行 JSON 写到 stdout。"""
    text = json.dumps(payload, ensure_ascii=False, default=str)
    sys.stdout.write(text + "\n")
    sys.stdout.flush()
    return code


def fail(message: str, kind: str = "error", hint: str = "", code: int = 1) -> int:
    return emit({"ok": False, "error": message, "errorKind": kind, "hint": hint}, code)


# --------------------------------------------------------------------------- #
# 序列化
# --------------------------------------------------------------------------- #
def to_jsonable(value, limit: int = 200):
    """把端点返回值压成可 JSON 化的结构，并回带截断信息。

    DataFrame 走 records；NaN/Inf → None（JSON 没有这两个字面量）；
    numpy 标量走 .item()；datetime/date → ISO 字符串。
    返回 (值, meta)，meta 里记 totalRows / shownRows / truncated。
    """
    meta: dict = {}

    try:
        import pandas as pd
    except ImportError:  # 没有 pandas 时按普通对象处理
        pd = None

    if pd is not None and isinstance(value, pd.DataFrame):
        total = int(len(value))
        shown = value.head(limit) if limit and total > limit else value
        records = json.loads(shown.to_json(orient="records", date_format="iso",
                                           default_handler=str, force_ascii=False))
        meta.update(totalRows=total, shownRows=int(len(shown)),
                    truncated=bool(limit and total > limit),
                    columns=[str(c) for c in value.columns])
        return records, meta

    if pd is not None and isinstance(value, pd.Series):
        return to_jsonable(value.to_frame(), limit)

    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            out[str(k)], sub = to_jsonable(v, limit)
            if sub:
                meta.setdefault("nested", {})[str(k)] = sub
        return out, meta

    if isinstance(value, (list, tuple, set)):
        items = list(value)
        total = len(items)
        shown = items[:limit] if limit and total > limit else items
        out = []
        for v in shown:
            jv, _ = to_jsonable(v, limit)
            out.append(jv)
        if total and any(isinstance(v, (dict, list)) for v in shown):
            meta.update(totalRows=total, shownRows=len(shown),
                        truncated=bool(limit and total > limit))
        return out, meta

    if isinstance(value, (datetime, date)):
        return value.isoformat(), meta
    if isinstance(value, float):
        return (None if (math.isnan(value) or math.isinf(value)) else value), meta
    if hasattr(value, "item") and getattr(value, "shape", None) == ():  # numpy 标量
        try:
            return to_jsonable(value.item(), limit)
        except Exception:
            pass
    if value is None or isinstance(value, (str, int, float, bool)):
        return value, meta
    return str(value), meta


# --------------------------------------------------------------------------- #
# 运行时装载
# --------------------------------------------------------------------------- #
def find_runtime() -> Path:
    for cand in RUNTIME_CANDIDATES:
        if cand.exists():
            return cand
    raise FileNotFoundError(
        f"找不到 astock_runtime.py（试过 {[str(c) for c in RUNTIME_CANDIDATES]}）。"
        f"请在仓库根目录跑 `python scripts/build_runtime.py` 重新生成。")


_RUNTIME_CACHE: dict = {}


def load_runtime():
    """装载生成的运行时（进程内缓存一次）。"""
    if "mod" in _RUNTIME_CACHE:
        return _RUNTIME_CACHE["mod"], _RUNTIME_CACHE["path"]
    path = find_runtime()
    spec = importlib.util.spec_from_file_location("astock_runtime", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["astock_runtime"] = mod
    spec.loader.exec_module(mod)
    _RUNTIME_CACHE.update(mod=mod, path=path)
    return mod, path


def endpoint_names(mod) -> list[str]:
    """运行时里可对外调用的端点名（非下划线、可调用、且定义在本模块）。"""
    import inspect
    names = []
    for name, obj in vars(mod).items():
        if name.startswith("_"):
            continue
        if not (inspect.isfunction(obj) or inspect.isclass(obj)):
            continue
        if getattr(obj, "__module__", None) != "astock_runtime":
            continue
        names.append(name)
    return sorted(names)


# --------------------------------------------------------------------------- #
# 子命令
# --------------------------------------------------------------------------- #
def cmd_list(args) -> int:
    import inspect
    mod, path = load_runtime()
    out = {}
    for name in endpoint_names(mod):
        obj = getattr(mod, name)
        try:
            sig = str(inspect.signature(obj))
        except (TypeError, ValueError):
            sig = "(…)"
        doc = (inspect.getdoc(obj) or "").strip().split("\n")[0]
        out[name] = {"signature": sig, "summary": doc[:200]}
    return emit({"ok": True, "runtime": str(path), "count": len(out), "endpoints": out})


def cmd_env(args) -> int:
    """环境体检：解释器、依赖、运行时指纹、软依赖 stub 情况。"""
    import platform

    report: dict = {
        "ok": True,
        "python": {
            "version": platform.python_version(),
            "executable": sys.executable,
            "implementation": platform.python_implementation(),
        },
        "deps": {},
        "runtime": {},
        "notes": [],
    }

    for name in REQUIRED_DEPS:
        report["deps"][name] = {"required": True,
                                "installed": importlib.util.find_spec(name) is not None}
    for name in OPTIONAL_DEPS:
        report["deps"][name] = {"required": False,
                                "installed": importlib.util.find_spec(name) is not None}

    missing_required = [n for n in REQUIRED_DEPS if not report["deps"][n]["installed"]]
    if missing_required:
        report["ok"] = False
        report["notes"].append(
            f"缺少必需依赖 {missing_required}。安装：pip install "
            + " ".join(missing_required))

    try:
        mod, path = load_runtime()
        report["runtime"] = {
            "path": str(path),
            "exists": True,
            "softStubs": list(getattr(mod, "SOFT_STUBS", [])),
            "endpointCount": len(endpoint_names(mod)),
        }
        if report["runtime"]["softStubs"]:
            report["notes"].append(
                "已为未安装的可选依赖装 stub：" + ", ".join(report["runtime"]["softStubs"])
                + "。相关端点会明确报错，不会静默返回空。")
    except Exception as exc:
        report["ok"] = False
        report["runtime"] = {"exists": False, "error": f"{type(exc).__name__}: {exc}"}
        report["notes"].append("运行时装载失败——先在仓库根目录跑 python scripts/build_runtime.py。")

    if not report["deps"]["mootdx"]["installed"]:
        report["notes"].append(
            "mootdx 未安装（这是刻意的）：它要求 httpx<0.26，而宿主 litellm/mcp 需要 httpx>=0.27，"
            "装上会互相破坏。通达信公开服务器的行情命令自 2026-09 起已普遍返回空，"
            "K 线请改用 tencent_kline() / tdx_daily_package()，逐笔用 tencent_ticks()。")

    return emit(report, 0 if report["ok"] else 1)


def _check_arg_types(fn, kwargs: dict) -> str | None:
    """按签名注解做**浅层**类型体检，返回错误说明或 None。

    为什么值得单独做：`tencent_quote(codes: list[str])` 拿到字符串不会报错，
    它会按字符迭代、拼出一串无意义的代码，最后**静默返回空字典**。
    而「静默返回空」正是 SKILL.md 反复警告、调用方最容易误读成「这只票没数据」的失败模式。
    这里在进端点之前就把类型错拦住，错误信息带上正确的调用样例。

    只做浅层判断（str/list/int/bool 这几类），拿不准就放行——不做运行时类型系统的活。
    """
    import inspect
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return None

    for key, value in kwargs.items():
        param = params.get(key)
        if param is None:
            continue
        ann = param.annotation
        if ann is inspect.Parameter.empty:
            continue
        text = ann if isinstance(ann, str) else getattr(ann, "__name__", str(ann))

        if text.startswith("list") and not isinstance(value, (list, tuple)):
            return (f"参数 {key} 需要列表，收到 {type(value).__name__}。"
                    f'例：--args \'{{"{key}": ["600519"]}}\'')
        if text == "str" and not isinstance(value, str):
            return f"参数 {key} 需要字符串，收到 {type(value).__name__}。"
        if text == "bool" and not isinstance(value, bool):
            return f"参数 {key} 需要布尔值，收到 {type(value).__name__}。"
        if text == "int" and (isinstance(value, bool) or not isinstance(value, int)):
            return f"参数 {key} 需要整数，收到 {type(value).__name__}。"
        if text == "float" and (isinstance(value, bool) or not isinstance(value, (int, float))):
            return f"参数 {key} 需要数值，收到 {type(value).__name__}。"
    return None


def cmd_call(args) -> int:
    mod, path = load_runtime()
    name = args.endpoint

    if not hasattr(mod, name):
        close = [n for n in endpoint_names(mod) if name.lower() in n.lower()][:8]
        return fail(f"未知端点 {name!r}", "unknown_endpoint",
                    hint=("相近的端点：" + ", ".join(close)) if close
                    else "用 `astock_cli.py list` 看全部端点。")

    fn = getattr(mod, name)
    if not callable(fn):
        return fail(f"{name} 不是可调用的端点", "not_callable")

    raw = args.args
    if raw in (None, ""):
        kwargs = {}
    else:
        if raw == "-":  # 从 stdin 读，避开命令行长度与转义
            raw = sys.stdin.read()
        try:
            kwargs = json.loads(raw)
        except json.JSONDecodeError as exc:
            return fail(f"--args 不是合法 JSON：{exc}", "bad_args",
                        hint='例：--args \'{"codes": ["600519"]}\'')
        if not isinstance(kwargs, dict):
            return fail("--args 必须是 JSON 对象（关键字参数表）", "bad_args",
                        hint='例：--args \'{"codes": ["600519"]}\'')

    type_problem = _check_arg_types(fn, kwargs)
    if type_problem:
        return fail(type_problem, "bad_args", hint=f"{name}{_signature(fn)}")

    try:
        result = fn(**kwargs)
    except TypeError as exc:
        return fail(f"参数不匹配：{exc}", "bad_args",
                    hint=f"{name}{_signature(fn)}")
    except Exception as exc:
        return emit({
            "ok": False,
            "endpoint": name,
            "error": f"{type(exc).__name__}: {exc}",
            "errorKind": "endpoint_error",
            "traceback": traceback.format_exc(limit=4) if args.verbose else "",
        }, 1)

    value, meta = to_jsonable(result, args.limit)
    return emit({
        "ok": True,
        "endpoint": name,
        "runtime": str(path),
        "meta": meta,
        "result": value,
    })


def _signature(fn) -> str:
    import inspect
    try:
        return str(inspect.signature(fn))
    except (TypeError, ValueError):
        return "(…)"
    return "(…)"


# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="astock_cli.py",
        description="a-stock-data 运行时命令行入口（供 DSH 插件工具面调用）")
    ap.add_argument("--verbose", action="store_true", help="失败时附 traceback")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="列出全部端点")

    p_env = sub.add_parser("env", help="环境体检")
    p_env.set_defaults(func=cmd_env)

    p_call = sub.add_parser("call", help="调用一个端点")
    p_call.add_argument("endpoint", help="端点名，如 tencent_quote")
    p_call.add_argument("--args", default=None,
                        help='JSON 对象形式的关键字参数；用 "-" 表示从 stdin 读')
    p_call.add_argument("--limit", type=int, default=200,
                        help="最多返回多少行 / 条（默认 200，0 表示不限）")
    p_call.set_defaults(func=cmd_call)
    return ap


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")

    ap = build_parser()
    args = ap.parse_args(argv)
    if args.cmd == "list":
        args.func = cmd_list
    try:
        return args.func(args)
    except FileNotFoundError as exc:
        return fail(str(exc), "runtime_missing")
    except Exception as exc:  # 兜底：任何意外都以 JSON 形式回，别让工具面拿到空 stdout
        return emit({
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "errorKind": "internal",
            "traceback": traceback.format_exc(limit=4) if getattr(args, "verbose", False) else "",
        }, 1)


if __name__ == "__main__":
    raise SystemExit(main())