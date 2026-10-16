/**
 * dsh-a-stock-data —— DSH 插件装配入口。
 *
 * 这份文件只做装配：建 runtime、注册 4 个工具、挂随包技能。业务逻辑全在
 * lib/runtime.js 与 lib/tools/*.js 里，这里不写判定。
 *
 * 工具面（`astock_*` 前缀）：
 *
 *   | 工具               | 只读/破坏性 | 说明 |
 *   | ---                | ---        | --- |
 *   | astock_probe       | 只读        | 装机探针：版本、随包技能挂载、解释器、工具面在册数 |
 *   | astock_env         | 只读        | 环境体检：解释器 + 依赖 + 运行时指纹，缺依赖给 pip 命令 |
 *   | astock_endpoints   | 只读        | 端点清单检索（纯本地，不联网） |
 *   | astock_call        | 只读        | 调用一个端点取数（联网；不写文件、不改状态） |
 *
 * 全部只读，没有审批闸门 —— 这四个工具都不写文件、不改环境。
 *
 * 装配三条硬规矩（参考 DSH 生态里踩过的真机事故，改这里之前先读）：
 *
 * 1. **`ctx.effect(callback)` 会立刻调用 callback，并把它的返回值当清理函数**（Cordis 约定）。
 *    所以必须是 `ctx.effect(() => () => 清理())`；写成 `ctx.effect(() => { 清理() })`
 *    会在**注册当刻**就把刚注册的工具全注销，而 `register()` 照样返回成功。
 * 2. **`register()` 成功 ≠ 工具留在工具面上**。只能靠回读注册表判断，
 *    `astock_probe` 的 `toolSurface.visibleAtCall` 就是干这个的。
 * 3. **任一工具工厂抛错不许拖垮其余**：工厂构造与注册各自独立 try/catch，
 *    失败记进 `state.failures` 由探针带回（宿主日志不落盘，光靠日志排查等于没有证据）。
 */

import { existsSync } from "node:fs";
import { createRuntime, BUNDLED_SKILL_DIR } from "./runtime.js";
import { createProbeTool } from "./tools/probe.js";
import { createEnvTool } from "./tools/env.js";
import { createEndpointsTool } from "./tools/endpoints.js";
import { createCallTool } from "./tools/call.js";

/** 插件行名。必须与 cordis.patch.yml 的 id / name 以及包名一致。 */
export const name = "dsh-a-stock-data";

/** 工具注册是硬依赖：缺少 tools 服务时本插件不激活。 */
export const inject = ["tools"];

const TAG = "[dsh-a-stock-data]";
/** 与 package.json 的 version 保持一致。0.1.1 起：修 astock_probe 输出含 undefined 被宿主拒收。 */
const VERSION = "0.1.1";
/** 与 package.json 的 peerDependencies 保持一致（探针里报出来，便于核对装载环境）。 */
const DSH_RUNTIME_EXPECTED = "0.2.0-rc.2";

/** 随包技能提供方名。 */
const SKILL_PROVIDER = "astock-bundled";

/**
 * 装配期记账。每次 apply 重置，只记「这一次装配」的事实。
 * 探针在调用时读它 + 回读注册表，两者合起来才是装机真相。
 */
function freshState() {
  return {
    pluginName: name,
    version: VERSION,
    dshRuntimeExpected: DSH_RUNTIME_EXPECTED,
    /** 尝试装配的工具名（按装配顺序）。 */
    names: [],
    /** register() 返回成功、且拿到 disposer 的名字。 */
    registered: [],
    /** 装配期失败：{ tool, stage: "factory" | "register", message }。 */
    failures: [],
    /** 随包技能的挂载结果（可观测状态，探针原样带回）。 */
    skillsMount: {
      attempted: false,
      ok: false,
      provider: SKILL_PROVIDER,
      detail: "尚未尝试挂载",
    },
  };
}

/** 每个 apply 一份记账；探针闭包持有它。 */
let state = freshState();

/** 记一条装配失败（探针会带回给模型，避免「日志没落盘 = 没证据」）。 */
function recordFailure(state, tool, stage, err) {
  state.failures.push({
    tool,
    stage,
    message: err?.message ? String(err.message) : String(err),
  });
}

/**
 * 挂载随包技能。
 *
 * 用官方的 `@deepseek-ai/dsh-skill-filesystem` 提供方按 rank 600 扫描 `skills/`，
 * 而不是自造发现逻辑。`includeDefaultRoots: false` 让它只服务本插件自带的根。
 *
 * 刻意不 await：装配不该因为技能这一半慢或失败而卡住工具注册。
 */
async function mountBundledSkills(ctx, state) {
  state.skillsMount.attempted = true;

  if (!existsSync(BUNDLED_SKILL_DIR)) {
    state.skillsMount.detail = `安装包里缺少 skills 目录 ${BUNDLED_SKILL_DIR}`;
    ctx.logger?.warn?.(`${TAG} 随包技能未挂载：${state.skillsMount.detail}`);
    return;
  }

  let skillFilesystem;
  try {
    skillFilesystem = await import("@deepseek-ai/dsh-skill-filesystem");
  } catch (err) {
    state.skillsMount.detail = `无法解析 @deepseek-ai/dsh-skill-filesystem —— ${err?.message ?? err}`;
    ctx.logger?.warn?.(`${TAG} 随包技能未挂载：${state.skillsMount.detail}`);
    return;
  }

  if (typeof ctx.inject !== "function" || typeof ctx.plugin !== "function") {
    state.skillsMount.detail = "宿主缺少 inject/plugin 能力，请核对 DSH 版本";
    ctx.logger?.warn?.(`${TAG} 随包技能未挂载：${state.skillsMount.detail}`);
    return;
  }

  try {
    ctx.inject(["skills"], (scope) => {
      scope.plugin(skillFilesystem, {
        providerName: SKILL_PROVIDER,
        includeDefaultRoots: false,
        bundledSkillDir: BUNDLED_SKILL_DIR,
      });
      state.skillsMount.ok = true;
      state.skillsMount.detail =
        `已登记提供方 ${SKILL_PROVIDER}，根目录 ${BUNDLED_SKILL_DIR}（rank 600）`;
      ctx.logger?.info?.(`${TAG} 随包技能已挂载：${BUNDLED_SKILL_DIR}`);
    });
  } catch (err) {
    state.skillsMount.detail = `inject/plugin 挂载抛错 —— ${err?.message ?? err}`;
    ctx.logger?.warn?.(`${TAG} 随包技能未挂载：${state.skillsMount.detail}`);
  }
}

/**
 * 注册全部工具。
 *
 * @param {object} ctx
 * @param {object} runtime
 * @returns {number} 注册成功的工具数
 */
function registerTools(ctx, runtime) {
  const factories = [
    ["astock_probe", () => createProbeTool(ctx, runtime, state)],
    ["astock_env", () => createEnvTool(runtime)],
    ["astock_endpoints", () => createEndpointsTool(runtime)],
    ["astock_call", () => createCallTool(runtime)],
  ];

  const disposers = [];
  let count = 0;

  for (const [label, factory] of factories) {
    state.names.push(label);

    if (typeof ctx.tools?.register !== "function") {
      recordFailure(state, label, "register", new Error("ctx.tools.register 不可用（宿主版本不符？）"));
      continue;
    }

    let def;
    try {
      def = factory();
    } catch (err) {
      recordFailure(state, label, "factory", err);
      ctx.logger?.warn?.(`${TAG} 工具 ${label} 构造失败：${err?.message ?? err}`);
      continue;
    }

    try {
      const off = ctx.tools.register({
        name: def.name,
        description: def.description,
        // 深拷贝参数表：防注册表反过来改到模块常量
        parameters: structuredClone(def.parameters),
        output: def.output,
        execute: (args, exec) => def.execute(args, exec),
      });
      if (typeof off === "function") disposers.push(off);
      state.registered.push(def.name);
      count += 1;
      ctx.logger?.info?.(`${TAG} 已注册工具 ${def.name}`);
    } catch (err) {
      recordFailure(state, def.name, "register", err);
      ctx.logger?.warn?.(`${TAG} 工具 ${def.name} 注册失败：${err?.message ?? err}`);
    }
  }

  if (disposers.length > 0 && typeof ctx.effect === "function") {
    // 正确形态：callback 立刻执行并**返回**清理函数（不是自己执行清理）。
    // 写成 ctx.effect(() => { disposers.forEach(off => off()) }) 会在注册当刻全部注销。
    ctx.effect(() => () => {
      for (const off of [...disposers].reverse()) {
        try {
          off();
        } catch {
          // 单个 disposer 失败不影响其余清理
        }
      }
    });
  }

  ctx.logger?.info?.(`${TAG} 工具注册完成：${count}/${factories.length}`);
  return count;
}

/**
 * cordis 插件入口（`export function apply` 形态）。
 *
 * @param {object} ctx cordis 上下文
 * @param {object} _config 来自 cordis.patch.yml 中该条目的 config（未声明 Config，不使用）
 */
export function apply(ctx, _config) {
  ctx.logger?.info?.(`${TAG} 插件已加载（v${VERSION}）`);

  // 每次 apply 重置记账：HMR 重新 apply 同一插件时，旧记账不能累加到新一次上
  state = freshState();

  let runtime = null;
  try {
    runtime = createRuntime({ ctx, logger: ctx.logger });
  } catch (err) {
    recordFailure(state, "runtime", "runtime", err);
    ctx.logger?.warn?.(`${TAG} createRuntime 失败：${err?.message ?? err}`);
  }

  // 探针在 factories 里排第一，所以后面任何一步抛错都不影响装机自检入口
  if (runtime) {
    registerTools(ctx, runtime);
  } else {
    // runtime 起不来时至少把探针挂上，让失败原因有出口
    state.names.push("astock_probe");
    try {
      const probe = createProbeTool(ctx, {
        paths: {
          PACKAGE_ROOT: "",
          BUNDLED_SKILL_DIR,
          SKILL_DIR: "",
          RUNTIME_PY: "",
          CLI_PY: "",
        },
        probePython: async () => ({ ok: false, note: "runtime 未建立" }),
        runCli: async () => ({ ok: false, error: "runtime 未建立" }),
      }, state);
      if (typeof ctx.tools?.register === "function") {
        ctx.tools.register({
          name: probe.name,
          description: probe.description,
          parameters: structuredClone(probe.parameters),
          output: probe.output,
          execute: (args) => probe.execute(args ?? {}),
        });
        state.registered.push(probe.name);
      }
    } catch (err) {
      recordFailure(state, "astock_probe", "register", err);
    }
  }

  // 刻意不 await：装配不应该因为 skills 这一半慢或失败而卡住
  mountBundledSkills(ctx, state).catch((err) => {
    state.skillsMount.detail = `随包技能挂载异常 —— ${err?.message ?? err}`;
    ctx.logger?.warn?.(`${TAG} ${state.skillsMount.detail}`);
  });
}