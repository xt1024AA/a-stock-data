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
  // 技能提供方登记：0.1.2 起插件走 ctx.get("skills").registerProvider()，
  // 所以假 ctx 必须提供这两个口，否则「技能挂载」这一节测的永远是失败路径。
  const skillProviders = [];

  const ctx = {
    logger: {
      info: (...a) => logs.push(["info", a.join(" ")]),
      warn: (...a) => logs.push(["warn", a.join(" ")]),
      error: (...a) => logs.push(["error", a.join(" ")]),
    },
    // 宿主服务读取口（cordis Context.get）
    get(kind) {
      if (kind === "skills") return skills;
      if (kind === "logger") return ctx.logger;
      return undefined;
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

  const skills = {
    registerProvider(create) {
      skillProviders.push(create);
      return () => {
        const i = skillProviders.indexOf(create);
        if (i >= 0) skillProviders.splice(i, 1);
      };
    },
  };

  return { ctx, skills, skillProviders, tools, cleanups, injected, plugins, logs };
}

async function callTool(tools, toolName, args) {
  const def = tools.get(toolName);
  if (!def) throw new Error(`工具 ${toolName} 不在工具面上`);
  const value = await def.execute(args ?? {});
  const lossy = findLossyPath(value);
  if (lossy) {
    throw new Error(`${toolName} 的返回值里有不能无损 JSON 化的值：${lossy}`);
  }
  return value;
}

/**
 * 找一个会让「无损 JSON」校验失败的值，返回它的路径；干净就返回 null。
 *
 * 为什么必须有这条：宿主对工具结果的要求是**无损 JSON**，而 `JSON.stringify`
 * 会把 `undefined`、函数、Symbol 静默丢掉，把 NaN/Infinity 变成 null——
 * 于是「本地看着好好的、宿主直接拒收」，报错还是一句没头没尾的
 * `value is not lossless JSON`。astock_probe 真机上就这么翻过车：
 * 探测成功时 `note` 不存在、调用方没传 `echo`，两个 `undefined` 一起把结果判死。
 *
 * 这条检查把宿主的契约搬进自测，让同类问题在本地就暴露。
 */
function findLossyPath(value, path = "$", seen = new Set()) {
  if (value === undefined) return `${path} 是 undefined`;
  if (typeof value === "function") return `${path} 是函数`;
  if (typeof value === "symbol") return `${path} 是 Symbol`;
  if (typeof value === "number" && !Number.isFinite(value)) return `${path} 是 ${value}`;
  if (typeof value === "bigint") return `${path} 是 BigInt`;
  if (value === null || typeof value !== "object") return null;

  if (seen.has(value)) return `${path} 循环引用`;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const hit = findLossyPath(value[i], `${path}[${i}]`, seen);
        if (hit) return hit;
      }
      return null;
    }
    for (const [k, v] of Object.entries(value)) {
      const hit = findLossyPath(v, `${path}.${k}`, seen);
      if (hit) return hit;
    }
    return null;
  } finally {
    seen.delete(value);
  }
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
  // 0.1.2 起：插件改为 ctx.get("skills").registerProvider()，不再运行时 import
  // `@deepseek-ai/dsh-skill-filesystem`（那个包只存在于宿主自己的解析树里，
  // 从插件目录恒为 ERR_MODULE_NOT_FOUND）。所以假 ctx 现在能提供 skills 服务，
  // 这一节就可以硬断言「真的挂上了」，而不是旧版的「失败也算通过」。

  console.log("\n=== 2. effect 语义回归（注册即注销事故）===");
  const probe0 = await callTool(env.tools, "astock_probe", {});
  check("探针回读到 4 个工具在册",
    probe0.toolSurface.registryReadable && probe0.toolSurface.visibleAtCall === 4,
    JSON.stringify(probe0.toolSurface));
  check("探针没有装配失败", probe0.toolSurface.failures.length === 0,
    JSON.stringify(probe0.toolSurface.failures));
  check("探针带回了 echo", (await callTool(env.tools, "astock_probe", { echo: "ping" })).echo === "ping");

  // 宿主的硬要求：工具结果必须是无损 JSON。callTool 已经对每次调用做了检查，
  // 这里再把 probe 的两个具体翻车点钉死（真机上报的是 "value is not lossless JSON"）。
  check("探针不传 echo 时不出现 echo 键（不是 undefined）",
    !("echo" in probe0), Object.keys(probe0).join(","));
  check("探针 python.note 是确定值（null 或字符串，不能 undefined）",
    probe0.python.note === null || typeof probe0.python.note === "string",
    String(probe0.python.note));
  check("探针 python.ok 不在时字段落成 null 而不是 undefined",
    ["bin", "prefixArgs", "version", "executable", "note"].every((k) => k in probe0.python),
    Object.keys(probe0.python).join(","));

  console.log("\n=== 3. 随包技能与路径 ===");
  check("attempted 了随包技能挂载", probe0.skillsMount.attempted === true);
  // 硬断言：挂载必须成功。旧版这里写的是「ok 或 至少给了原因」，
  // 结果是挂载全挂也判通过 —— 30 通过 / 0 失败 的假绿就是这么来的。
  check("随包技能挂载成功（不再是失败也算过）",
    probe0.skillsMount.ok === true, probe0.skillsMount.detail);
  check("登记了技能提供方", env.skillProviders.length === 1, `实际 ${env.skillProviders.length}`);
  console.log(`    （本次挂载：${probe0.skillsMount.ok ? "成功" : "未成功"} — ${probe0.skillsMount.detail}）`);
  check("随包 skills 目录存在", probe0.paths.bundledSkillDir.exists, probe0.paths.bundledSkillDir.path);
  check("随包 SKILL.md 所在技能目录存在", probe0.paths.skillDir.exists, probe0.paths.skillDir.path);
  check("生成的运行时存在", probe0.paths.runtimePy.exists, probe0.paths.runtimePy.path);
  check("命令行脚本存在", probe0.paths.cliPy.exists, probe0.paths.cliPy.path);
  check("SKILL.md 真的在技能目录里",
    existsSync(`${probe0.paths.skillDir.path}/SKILL.md`));

  // 提供方契约回归：list/get 的字段是宿主拼技能目录用的，
  // 少一个 locator 或名字对不上目录名，宿主就会静默不收录这个技能。
  {
    const create = env.skillProviders[0];
    const provider = create({ signal: new AbortController().signal, invalidate() {} });
    check("提供方自称 astock-bundled", provider.name === "astock-bundled", provider.name);

    const listed = await provider.list({});
    check("list 出且仅出 1 个技能", listed.length === 1, JSON.stringify(listed.map((s) => s.name)));
    const one = listed[0];
    check("技能名与目录名一致", one?.name === "a-stock-data", String(one?.name));
    check("candidate 带 locator", typeof one?.locator?.path === "string", JSON.stringify(one?.locator));
    check("candidate 带 resourceBase", one?.resourceBase?.kind === "directory", JSON.stringify(one?.resourceBase));
    check("candidate 带 rank/source/provider",
      one?.rank === 600 && one?.source === "bundled" && one?.provider === "astock-bundled",
      `rank=${one?.rank} source=${one?.source} provider=${one?.provider}`);

    const full = await provider.get(one, {});
    check("get 读回正文", (full?.content?.length ?? 0) > 1000, String(full?.content?.length));
    check("get 的 invocation 形态正确",
      full?.invocation?.modelInvocable === true && full?.invocation?.userInvocable === true,
      JSON.stringify(full?.invocation));
    check("get 对不存在的文件返回 undefined 而不是抛错",
      (await provider.get({ name: "nope", locator: { path: "Z:/__missing__/SKILL.md" } }, {})) === undefined);
  }

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