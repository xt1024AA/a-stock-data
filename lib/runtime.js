/**
 * dsh-a-stock-data —— Python 桥。
 *
 * 这一层只干三件事：找到能用的 Python、把 astock_cli.py 跑起来、把它的单行 JSON 解析回来。
 * 判据与业务无关的东西（哪个端点在做什么）一律留给 Python 侧，这里不重复实现。
 *
 * 两个来自真机的硬约束（都踩过）：
 *
 * 1. **解释器探测必须真的跑一次**。Windows 上 `python3.exe` 常常是 Microsoft Store 的
 *    占位程序：`find`/`where` 能找到它，执行却弹商店并返回 9009。所以探测方式是
 *    `-c` 打印一段 JSON，能解析出 >= 3.9 的版本号才算数。
 * 2. **受限沙箱下开不了命名管道**。DSH 的受限模式下 Node 用默认 `stdio: "pipe"` 拉子进程
 *    会 EPERM。这里在管道失败时自动退到「stdout/stderr 各写一个临时文件」的等价模式，
 *    而不是把错误直接抛给模型。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 插件根目录（本文件在 <root>/lib/runtime.js）。 */
export const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** 随包 skills 根目录 —— 与 lib/ 同级，供 skill-filesystem 提供方按 rank 600 扫描。 */
export const BUNDLED_SKILL_DIR = fileURLToPath(new URL("../skills/", import.meta.url));

/** 随包技能目录（<root>/skills/a-stock-data/）。 */
export const SKILL_DIR = join(BUNDLED_SKILL_DIR, "a-stock-data");

/** 端点实现的生成运行时（由 scripts/build_runtime.py 写出）。 */
export const RUNTIME_PY = join(SKILL_DIR, "runtime", "astock_runtime.py");

/** 工具面调用的命令行入口。 */
export const CLI_PY = join(SKILL_DIR, "scripts", "astock_cli.py");

/** 探测脚本：打印解释器身份，用来同时验「能跑」与「版本够」。 */
const PROBE_CODE =
  "import json,sys;print(json.dumps({'v':list(sys.version_info[:3]),'exe':sys.executable,'impl':sys.implementation.name}))";

/** 需要的最低 Python 版本（SKILL.md 自己承诺 3.9+）。 */
const MIN_PYTHON = [3, 9];

/** Windows 上按顺序试；`py -3` 是官方启动器，能绕开 Store 占位程序。 */
const CANDIDATES = process.platform === "win32"
  ? [["py", ["-3"]], ["python", []], ["python3", []]]
  : [["python3", []], ["python", []]];

/**
 * 跑一个子进程并收集输出。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string,string>, timeoutMs?: number, signal?: AbortSignal, maxBytes?: number}} opts
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, viaFiles: boolean, error?: string}>}
 */
export function runProcess(command, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    const attempt = (viaFiles) => {
      let dir = null;
      let outFd = "pipe";
      let errFd = "pipe";
      if (viaFiles) {
        try {
          dir = mkdtempSync(join(tmpdir(), "astock-"));
          outFd = join(dir, "out.txt");
          errFd = join(dir, "err.txt");
        } catch {
          dir = null;
        }
      }

      let child;
      try {
        child = spawn(command, args, {
          cwd: opts.cwd,
          env: opts.env,
          windowsHide: true,
          stdio: viaFiles && dir ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        if (viaFiles) return finish({ code: null, stdout: "", stderr: "", viaFiles: true, error: String(err?.message ?? err) });
        return finish({ code: null, stdout: "", stderr: "", viaFiles: false, error: String(err?.message ?? err) });
      }

      const outChunks = [];
      const errChunks = [];
      let outBytes = 0;
      let truncated = false;

      child.stdout?.on("data", (c) => {
        outBytes += c.length;
        if (outBytes <= maxBytes) outChunks.push(c);
        else truncated = true;
      });
      child.stderr?.on("data", (c) => {
        if (errChunks.length < 200) errChunks.push(c);
      });

      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* 已经退了 */ }
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结果 */ } }
      };

      child.on("error", (err) => {
        cleanup();
        // 管道模式失败（受限沙箱 EPERM）时退到文件模式重试一次
        if (!viaFiles && /EPERM|ENOTSUP|EACCES/i.test(String(err?.code ?? err?.message ?? ""))) {
          settled = false;
          return attempt(true);
        }
        finish({ code: null, stdout: "", stderr: "", viaFiles, error: String(err?.message ?? err) });
      });

      child.on("close", (code) => {
        cleanup();
        let stdout = Buffer.concat(outChunks).toString("utf8");
        let stderr = Buffer.concat(errChunks).toString("utf8");
        if (viaFiles && dir) {
          try { stdout = readFileSync(outFd, "utf8"); } catch { /* 保持空串 */ }
          try { stderr = readFileSync(errFd, "utf8"); } catch { /* 保持空串 */ }
        }
        finish({ code, stdout, stderr, viaFiles, truncated });
      });
    };

    attempt(false);
  });
}

/**
 * 从可能夹着噪声的 stdout 里取出最后一个合法 JSON 对象。
 *
 * 为什么不能直接 `JSON.parse(stdout)`：SKILL.md 里的实现会在 stderr 打告警，但第三方库
 * 偶尔也往 stdout 写字。逐行从后往前试，取第一个能解析的对象，比「假定 stdout 干净」稳。
 *
 * @param {string} text
 * @returns {object|null}
 */
export function parseLastJson(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line || (line[0] !== "{" && line[0] !== "[")) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object") return value;
    } catch {
      // 不是 JSON 就继续往前找
    }
  }
  return null;
}

/**
 * 创建 runtime。
 *
 * @param {{env?: Record<string,string|undefined>, logger?: object}} [options]
 */
export function createRuntime(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.logger ?? null;

  /** 解释器探测结果（进程内缓存：探测要起子进程，不能每次调用都做）。 */
  let pythonProbe = null;

  function log(level, ...args) {
    try {
      const fn = logger?.[level];
      if (typeof fn === "function") fn.call(logger, ...args);
    } catch {
      // 日志失败不影响工具结果
    }
  }

  /**
   * 探测可用的 Python 解释器。
   *
   * @param {{force?: boolean}} [opts]
   * @returns {Promise<{ok: boolean, bin?: string, prefixArgs?: string[], version?: number[], executable?: string, impl?: string, attempts: object[], note?: string}>}
   */
  async function probePython(opts = {}) {
    if (pythonProbe && !opts.force) return pythonProbe;

    const attempts = [];
    const override = String(env.ASTOCK_PYTHON ?? "").trim();
    // ASTOCK_PYTHON 优先：用户明确指定时不再猜
    const candidates = override ? [[override, []]] : CANDIDATES;

    for (const [bin, prefixArgs] of candidates) {
      const res = await runProcess(bin, [...prefixArgs, "-c", PROBE_CODE], {
        env, timeoutMs: 20_000,
      });
      const info = parseLastJson(res.stdout);
      if (res.error) {
        attempts.push({ bin, prefixArgs, ok: false, reason: res.error });
        continue;
      }
      if (!info?.v) {
        const hint = (res.stderr || res.stdout || "").trim().split("\n")[0]?.slice(0, 120) ?? "";
        attempts.push({ bin, prefixArgs, ok: false, code: res.code, reason: `探测输出不是 JSON（${hint}）` });
        continue;
      }
      const ok = info.v[0] > MIN_PYTHON[0]
        || (info.v[0] === MIN_PYTHON[0] && info.v[1] >= MIN_PYTHON[1]);
      attempts.push({ bin, prefixArgs, ok, version: info.v, reason: ok ? "" : "版本低于 3.9" });
      if (!ok) continue;
      pythonProbe = {
        ok: true, bin, prefixArgs, version: info.v,
        executable: info.exe, impl: info.impl, attempts,
      };
      log("info", `[dsh-a-stock-data] Python 解释器：${bin} ${prefixArgs.join(" ")} → ${info.v.join(".")}`);
      return pythonProbe;
    }

    pythonProbe = {
      ok: false,
      attempts,
      note: override
        ? `ASTOCK_PYTHON=${override} 不可用。`
        : "在 PATH 里没找到 >= 3.9 的 Python（试过 " + candidates.map((c) => c[0]).join(", ")
          + "）。Windows 上请装 python.org 的发行版；Microsoft Store 的 python3.exe 是占位程序，"
          + "执行会弹商店而不报可用版本。也可用 ASTOCK_PYTHON 指定解释器绝对路径。",
    };
    log("warn", `[dsh-a-stock-data] ${pythonProbe.note}`);
    return pythonProbe;
  }

  /**
   * 调 astock_cli.py。
   *
   * @param {string[]} cliArgs 子命令与参数
   * @param {{timeoutMs?: number, signal?: AbortSignal, stdin?: string}} [opts]
   * @returns {Promise<{ok: boolean, value?: object, error?: string, errorKind?: string, raw?: string, stderr?: string, probe?: object}>}
   */
  async function runCli(cliArgs, opts = {}) {
    if (!existsSync(CLI_PY)) {
      return {
        ok: false,
        errorKind: "cli_missing",
        error: `随包命令行脚本缺失：${CLI_PY}。安装包可能被裁剪。`,
      };
    }

    const probe = await probePython();
    if (!probe.ok) {
      return { ok: false, errorKind: "python_unavailable", error: probe.note, probe };
    }

    const res = await runProcess(
      probe.bin,
      [...probe.prefixArgs, CLI_PY, ...cliArgs],
      {
        env: { ...env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
        timeoutMs: opts.timeoutMs ?? 180_000,
        signal: opts.signal,
      },
    );

    if (res.truncated) {
      return {
        ok: false, errorKind: "output_too_large",
        error: "端点的输出超过了工具面的读取上限。缩小查询范围（加日期区间 / 调小 --limit）后重试。",
        stderr: res.stderr,
      };
    }
    if (res.error) {
      return { ok: false, errorKind: "spawn_failed", error: res.error, stderr: res.stderr, probe };
    }

    const value = parseLastJson(res.stdout);
    if (!value) {
      return {
        ok: false, errorKind: "bad_output",
        error: "命令行没有输出可解析的 JSON。",
        raw: String(res.stdout ?? "").slice(-800),
        stderr: String(res.stderr ?? "").slice(-800),
        probe,
      };
    }
    return { ok: value.ok !== false, value, stderr: res.stderr, probe, code: res.code };
  }

  return {
    env,
    log,
    probePython,
    runCli,
    paths: { PACKAGE_ROOT, BUNDLED_SKILL_DIR, SKILL_DIR, RUNTIME_PY, CLI_PY },
  };
}