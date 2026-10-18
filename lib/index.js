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
/**
 * 与 package.json 的 version 保持一致。
 * 0.1.1：修 astock_probe 输出含 undefined 被宿主拒收。
 * 0.1.2：适配 DSH 0.2.1-rc.2 —— 两处改动：
 *   1. 技能改走 ctx.get("skills").registerProvider()，不再运行时 import
 *      @deepseek-ai/dsh-skill-filesystem（那是宿主的依赖，插件目录恒解析不到）。
 *   2. 去掉精确版本的 peerDependencies，改 engines.dsh 范围。原因见 package.json。
 */
const VERSION = "0.1.2";
/**
 * 与 package.json 的 engines.dsh 保持一致（探针里报出来，便于核对装载环境）。
 *
 * 注意：这是**下限**，不是精确匹配。DSH 的 bundle 版本检查会把精确的
 * `0.2.0-rc.2` 判为与运行时 `0.2.1-rc.2` 不兼容，整排 insert 行不进组合树
 * ——同 profile 的 @linfengqaqtat/dsh-scriptor 就是这么被跳过（rows: []）的。
 */
const DSH_RUNTIME_EXPECTED = ">=0.2.1-rc.2";

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
 * **0.1.2 的改动（DSH 0.2.1-rc.2 适配）**：不再运行时 import
 * `@deepseek-ai/dsh-skill-filesystem`。
 *
 * 原因：那个包是**宿主的**依赖，只存在于宿主自己的解析树里（桌面版在 `app.asar` 内）。
 * 插件目录 `D:\DS\插件\a-stock-data` 与 profile 的 `node_modules` 都不在它的解析路径上，
 * 实测 `import("@deepseek-ai/dsh-skill-filesystem")` 恒为 ERR_MODULE_NOT_FOUND ——
 * 连宿主包 `@deepseek-ai/dsh-tools` 在插件目录里也一样解析不到，这是结构性事实，不是版本问题。
 *
 * 现在改为直接调用宿主 `skills` 服务自带的提供方注册口：
 * `ctx.get("skills").registerProvider(create => ({ name, list, get }))`。
 * 这是已验证可用的形态（同 profile 的 dsh-mattpocock-skills-deck 就靠它挂上了 27 个技能）。
 *
 * `list` / `get` 的返回字段按宿主 `SkillProvider` 契约给全：
 * list 出 `locator` + `rank` + `source`，get 从 `locator.path` 读全文。
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

  // 用 ctx.get 而不是 ctx.inject：这里只要服务在就登记，不在就如实报告，
  // 不需要把整个插件挂成 skills 的依赖（缺 skills 时工具仍应可用）。
  let skills;
  try {
    skills = typeof ctx.get === "function" ? ctx.get("skills") : undefined;
  } catch (err) {
    state.skillsMount.detail = `读取 skills 服务抛错 —— ${err?.message ?? err}`;
    ctx.logger?.warn?.(`${TAG} 随包技能未挂载：${state.skillsMount.detail}`);
    return;
  }

  if (!skills || typeof skills.registerProvider !== "function") {
    state.skillsMount.detail = "宿主没有暴露 skills.registerProvider（DSH 版本不符？需要 0.2.1-rc.2）";
    ctx.logger?.warn?.(`${TAG} 随包技能未挂载：${state.skillsMount.detail}`);
    return;
  }

  try {
    const dispose = skills.registerProvider((control) => createBundledSkillProvider(ctx, control));

    if (typeof dispose === "function" && typeof ctx.effect === "function") {
      // 正确形态：callback 立刻执行并**返回**清理函数。
      ctx.effect(() => () => {
        try {
          dispose();
        } catch {
          // 卸载失败不影响宿主其余清理
        }
      });
    }

    state.skillsMount.ok = true;
    state.skillsMount.detail =
      `已注册提供方 ${SKILL_PROVIDER}，根目录 ${BUNDLED_SKILL_DIR}（rank ${BUNDLED_SKILL_RANK}）`;
    ctx.logger?.info?.(`${TAG} 随包技能已挂载：${BUNDLED_SKILL_DIR}`);
  } catch (err) {
    state.skillsMount.detail = `registerProvider 抛错 —— ${err?.message ?? err}`;
    ctx.logger?.warn?.(`${TAG} 随包技能未挂载：${state.skillsMount.detail}`);
  }
}

/** 随包技能优先级。数字越小越优先：家目录 400/500，项目级 100/200，随包取 600（最不优先）。 */
const BUNDLED_SKILL_RANK = 600;

/**
 * 构造随包技能提供方。
 *
 * 只扫 `skills/<名字>/SKILL.md` 这一层（与宿主文件系统提供方的发现规则一致），
 * 只认带 `name` + `description` frontmatter 的技能，名字必须与目录名一致。
 *
 * @param {object} ctx cordis 上下文（用于 logger）
 * @param {object} control 宿主给的提供方控制对象（含 invalidate / signal）
 * @returns {{name: string, list: Function, get: Function}}
 */
function createBundledSkillProvider(ctx, control) {
  return {
    name: SKILL_PROVIDER,

    async list(options = {}) {
      const fsp = await import("node:fs/promises");
      const pathMod = await import("node:path");

      const signal = options?.signal ?? control?.signal;
      if (signal?.aborted) throw signal.reason;

      let entries;
      try {
        entries = await fsp.readdir(BUNDLED_SKILL_DIR, { withFileTypes: true });
      } catch {
        return [];
      }

      const out = [];
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const dirName = ent.name;
        const skillDir = pathMod.join(BUNDLED_SKILL_DIR, dirName);
        const mdPath = pathMod.join(skillDir, "SKILL.md");

        let raw;
        try {
          raw = await fsp.readFile(mdPath, "utf8");
        } catch {
          continue;
        }

        const parsed = parseSkillFrontmatter(raw);
        // 名字必须与目录名一致，否则宿主按目录名取不到
        if (!parsed || parsed.name !== dirName) continue;

        out.push({
          name: parsed.name,
          description: parsed.description,
          ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
          invocation: parsed.invocation,
          source: "bundled",
          provider: SKILL_PROVIDER,
          rank: BUNDLED_SKILL_RANK,
          locator: { path: mdPath, directory: skillDir },
          resourceBase: { kind: "directory", path: skillDir },
          path: mdPath,
        });
      }

      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    },

    async get(candidate, options = {}) {
      const signal = options?.signal ?? control?.signal;
      if (signal?.aborted) throw signal.reason;

      const locator = candidate?.locator;
      const path = locator?.path ?? candidate?.path;
      if (!path) return undefined;

      const fsp = await import("node:fs/promises");
      let raw;
      try {
        raw = await fsp.readFile(path, "utf8");
      } catch {
        return undefined; // 文件在 list 之后消失：按契约返回 undefined
      }

      const parsed = parseSkillFrontmatter(raw);
      if (!parsed) return undefined;
      // 内容与候选名不一致时宁可不上，避免串技能
      if (parsed.name !== candidate.name) return undefined;

      return {
        name: parsed.name,
        description: parsed.description,
        ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
        invocation: parsed.invocation,
        source: "bundled",
        provider: SKILL_PROVIDER,
        resourceBase: {
          kind: "directory",
          path: locator?.directory ?? path,
        },
        path,
        content: parsed.content,
      };
    },
  };
}

/**
 * 解析 SKILL.md 的 YAML frontmatter（只取本插件需要的几个键）。
 *
 * 刻意不引 yaml 依赖：随包技能只有一层、字段固定，手写够用且不给宿主添依赖。
 * 支持 `key: value`、带引号的值、以及 `metadata:` 下的缩进块（忽略内容）。
 *
 * @param {string} raw
 * @returns {{name: string, description: string, whenToUse?: string, invocation: {modelInvocable: boolean, userInvocable: boolean}, content: string} | undefined}
 */
function parseSkillFrontmatter(raw) {
  const text = String(raw ?? "").replace(/^\uFEFF/, "");
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return undefined;

  const front = match[1];
  const body = text.slice(match[0].length);

  const field = (key) => {
    // 只匹配顶层键（行首无缩进），避免把 metadata: 下的同名键抓上来
    const re = new RegExp(`^${key.replace(/[-]/g, "\\-")}[ \\t]*:[ \\t]*(.*)$`, "m");
    const m = front.match(re);
    if (!m) return undefined;
    let v = m[1].trim();
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ) {
      v = v.slice(1, -1).trim();
    }
    return v.length > 0 ? v : undefined;
  };

  const name = field("name");
  const description = field("description");
  if (!name || !description) return undefined;

  const bool = (key) => {
    const v = field(key);
    if (v === undefined) return undefined;
    const lower = v.toLowerCase();
    if (lower === "true" || lower === "yes" || lower === "on" || lower === "1") return true;
    if (lower === "false" || lower === "no" || lower === "off" || lower === "0") return false;
    return undefined;
  };

  return {
    name,
    description,
    ...(field("whenToUse") !== undefined ? { whenToUse: field("whenToUse") } : {}),
    invocation: {
      modelInvocable: bool("disable-model-invocation") !== true,
      userInvocable: bool("user-invocable") !== false,
    },
    content: body.trim(),
  };
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