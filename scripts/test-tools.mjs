/**
 * dsh-a-stock-data —— 工具面自测（假 ctx，不依赖 DSH 宿主）。
 *
 * 为什么要有这份：真机装机一轮要重启 DSH，太慢；而装配这件事（`ctx.effect` 的返回值语义、
 * 注册即注销、工厂抛错拖垮全局）恰恰是最容易写错的地方。这里用假 ctx 把 Cordis 的两条关键
 * 语义如实复刻出来：
 *
 *   effect(callback)  —— 立刻调用 callback，把**返回值**当清理函数（不是让 callback 自己清理）
 *   register(def)     —— 收下定义，返回精确的注销器
 *
 * 于是「工具注册后被自己的 disposer 立刻注销」这个经典事故会被 `visibleAtCall` 直接抓出来。
 *
 * 用法：node scripts/test-tools.mjs [--live]
 *   --live 打开联网用例（默认只跑本地用例，避免把 CI 打成一个爬虫）
 */

import { existsSync } from "node:fs";
import { apply, name as pluginName } from "../lib/index.js";

const LIVE = process.argv.includes("--live");

let pass = 0;
let fail = 0;
const failures = [];

function check(label, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 造一个尽量贴近 Cordis 真实语义的假 ctx。 */
function makeCtx() {
  const tools = new Map();
  const cleanups = [];
  const injected = [];
  const plugins = [];
  const logs = [];

  const ctx = {
    logger: {
      info: (...a) => logs.push(["info", a.join(" ")]),
      warn: (...a) => logs.push(["warn", a.join(" ")]),
      error: (...a) => logs.push(["error", a.join(" ")]),
    },
    tools: {
      register(def) {
        if (tools.has(def.name)) throw new Error(`duplicate tool ${def.name}`);
        tools.set(def.name, def);
        return () => tools.delete(def.name);
      },
      get(n) {
        return tools.get(n);
      },
    },
    // Cordis 语义：立刻调用，返回值当清理函数
    effect(cb) {
      const c = cb();
      if (typeof c === "function") cleanups.push(c);
      return () => {};
    },
    inject(deps, cb) {
      injected.push(deps);
      cb(ctx);
    },
    plugin(mod, config) {
      plugins.push({ mod, config });
    },
  };
  return { ctx, tools, cleanups, injected, plugins, logs };
}

async function callTool(tools, toolName, args) {
  const def = tools.get(toolName);
  if (!def) throw new Error(`工具 ${toolName} 不在工具面上`);
  return def.execute(args ?? {});
}

/** effect 清理函数确实能被调用（且调用后工具真的消失）——验证 disposer 是真的。 */
function verifyDisposalWorks(tools, cleanups) {
  const before = tools.size;
  for (const c of [...cleanups].reverse()) c();
  const after = tools.size;
  return { before, after };
}

async function main() {
  console.log("=== 1. 装配 ===");
  const env = makeCtx();
  apply(env.ctx, {});

  // mountBundledSkills 是刻意不 await 的异步挂载，给它一拍
  await new Promise((r) => setTimeout(r, 300));

  check("插件名与包名一致", pluginName === "dsh-a-stock-data", pluginName);
  check("注册了 4 个工具", env.tools.size === 4, `实际 ${env.tools.size}`);
  for (const n of ["astock_probe", "astock_env", "astock_endpoints", "astock_call"]) {
    check(`工具在册：${n}`, env.tools.has(n));
  }
  // 注意：`@deepseek-ai/dsh-skill-filesystem` 是从 **DSH 安装目录**解析的，
  // 裸 node 跑本脚本时解析不到属于预期（参考插件同样如此）。所以这里只断言
  // 「确实尝试过挂载，且失败时给出了原因」；「挂载成功」这一条要在真机装机时验
  // （astock_probe 的 skillsMount.ok）。放在第 2 节之后，因为要用到 probe0。

  console.log("\n=== 2. effect 语义回归（注册即注销事故）===");
  const probe0 = await callTool(env.tools, "astock_probe", {});
  check("探针回读到 4 个工具在册",
    probe0.toolSurface.registryReadable && probe0.toolSurface.visibleAtCall === 4,
    JSON.stringify(probe0.toolSurface));
  check("探针没有装配失败", probe0.toolSurface.failures.length === 0,
    JSON.stringify(probe0.toolSurface.failures));
  check("探针带回了 echo", (await callTool(env.tools, "astock_probe", { echo: "ping" })).echo === "ping");

  console.log("\n=== 3. 随包技能与路径 ===");
  check("attempted 了随包技能挂载", probe0.skillsMount.attempted === true);
  check("挂载失败时给出了原因",
    probe0.skillsMount.ok === true || String(probe0.skillsMount.detail ?? "").length > 0,
    probe0.skillsMount.detail);
  console.log(`    （本次挂载：${probe0.skillsMount.ok ? "成功" : "未成功"} — ${probe0.skillsMount.detail}）`);
  check("随包 skills 目录存在", probe0.paths.bundledSkillDir.exists, probe0.paths.bundledSkillDir.path);
  check("随包 SKILL.md 所在技能目录存在", probe0.paths.skillDir.exists, probe0.paths.skillDir.path);
  check("生成的运行时存在", probe0.paths.runtimePy.exists, probe0.paths.runtimePy.path);
  check("命令行脚本存在", probe0.paths.cliPy.exists, probe0.paths.cliPy.path);
  check("SKILL.md 真的在技能目录里",
    existsSync(`${probe0.paths.skillDir.path}/SKILL.md`));

  console.log("\n=== 4. astock_env ===");
  const envRes = await callTool(env.tools, "astock_env", {});
  check("env 返回 ok", envRes.ok === true, JSON.stringify(envRes).slice(0, 300));
  check("探测到 Python >= 3.9", envRes.python?.ok === true, JSON.stringify(envRes.python?.note ?? ""));
  check("requests/pandas 已装",
    envRes.deps?.requests?.installed === true && envRes.deps?.pandas?.installed === true);
  check("运行时端点数为正", (envRes.runtime?.endpointCount ?? 0) > 50,
    String(envRes.runtime?.endpointCount));

  console.log("\n=== 5. astock_endpoints（本地检索）===");
  const all = await callTool(env.tools, "astock_endpoints", { limit: 300 });
  check("端点总数 > 90", all.total > 90, String(all.total));
  const kline = await callTool(env.tools, "astock_endpoints", { query: "kline", limit: 50 });
  check("按名字检索命中 tencent_kline", kline.endpoints.some((e) => e.name === "tencent_kline"),
    kline.endpoints.map((e) => e.name).join(","));
  const cn = await callTool(env.tools, "astock_endpoints", { query: "可转债" });
  check("按中文说明检索命中 convertible_bonds",
    cn.endpoints.some((e) => e.name === "convertible_bonds"),
    cn.endpoints.map((e) => e.name).join(","));

  console.log("\n=== 6. astock_call 错误路径（不联网）===");
  const unknown = await callTool(env.tools, "astock_call", { endpoint: "tencent_quot" });
  check("未知端点返回 ok:false", unknown.ok === false);
  check("未知端点给出相近建议", String(unknown.hint ?? "").includes("tencent_quote"),
    String(unknown.hint));
  const badArg = await callTool(env.tools, "astock_call",
    { endpoint: "tencent_quote", args: { codes: "600519" } });
  check("参数类型错被拦住", badArg.ok === false && badArg.errorKind === "bad_args",
    JSON.stringify(badArg).slice(0, 200));

  console.log("\n=== 7. disposer 真的能注销 ===");
  const disposal = verifyDisposalWorks(env.tools, env.cleanups);
  check("清理函数调用后工具被摘掉", disposal.after === 0,
    `${disposal.before} → ${disposal.after}`);

  if (LIVE) {
    console.log("\n=== 8. astock_call 联网用例 ===");
    const env2 = makeCtx();
    apply(env2.ctx, {});
    await new Promise((r) => setTimeout(r, 300));
    const quote = await callTool(env2.tools, "astock_call",
      { endpoint: "tencent_quote", args: { codes: ["600519"] } });
    check("tencent_quote 取到茅台", quote.ok === true && !!quote.result?.["600519"]?.name,
      JSON.stringify(quote).slice(0, 400));
    const k = await callTool(env2.tools, "astock_call",
      { endpoint: "tencent_kline", args: { code: "600519", count: 5 }, limit: 5 });
    check("tencent_kline 取到 5 行", k.ok === true && k.result?.length === 5,
      `len=${k.result?.length}`);
    check("kline meta 带列名", Array.isArray(k.meta?.columns) && k.meta.columns.includes("close"),
      JSON.stringify(k.meta));
    const big = await callTool(env2.tools, "astock_call",
      { endpoint: "tdx_daily_package", args: { date: "2026-09-18" }, limit: 2 });
    check("大表被截断且如实标注",
      big.ok === true && big.meta?.truncated === true && big.meta?.shownRows === 2,
      JSON.stringify(big.meta));
  }

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (failures.length) {
    console.log("\n失败项：");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("自测崩了：", err);
  process.exit(2);
});