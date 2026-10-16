/**
 * astock_probe —— 装机探针，只报事实。
 *
 * 为什么需要它：宿主日志不落盘。当「工具没出现」时，分不清是
 * 提供方没挂上、注入时机不对、还是这次会话的快照早于安装。
 * 把装机事实做进工具输出，调一次就能拿到确定答案。
 *
 * 另一条教训：`ctx.tools.register()` 返回成功**不等于**工具留在了工具面上
 * （effect 回调写错会在注册当刻把刚注册的工具注销掉，而 register 全程返回成功）。
 * 所以「此刻在册几个」必须在调用时回读注册表，不能只信装配期的计数。
 */

/** 探针输出 schema。 */
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    plugin: { type: "string" },
    version: { type: "string" },
    dshRuntimeExpected: { type: "string" },
    python: {
      type: "object",
      additionalProperties: true,
      description: "解释器探测结果（bin / version / ok / note）",
    },
    paths: {
      type: "object",
      additionalProperties: true,
      description: "随包路径：bundledSkillDir / skillDir / runtimePy / cliPy 及各自是否存在",
    },
    skillsMount: {
      type: "object",
      additionalProperties: false,
      properties: {
        attempted: { type: "boolean" },
        ok: { type: "boolean" },
        provider: { type: "string" },
        detail: { type: "string" },
      },
      required: ["attempted", "ok", "provider", "detail"],
    },
    toolSurface: {
      type: "object",
      additionalProperties: false,
      properties: {
        attempted: { type: "integer" },
        registered: { type: "integer" },
        visibleAtCall: { type: "integer", description: "此刻回读注册表仍在册的工具数；宿主不支持回读时为 -1" },
        registryReadable: { type: "boolean" },
        missing: { type: "array", items: { type: "string" } },
        failures: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              tool: { type: "string" },
              stage: { type: "string" },
              message: { type: "string" },
            },
            required: ["tool", "stage", "message"],
          },
        },
      },
      required: ["attempted", "registered", "visibleAtCall", "registryReadable", "missing", "failures"],
    },
    echo: { type: "string" },
  },
  required: ["ok", "plugin", "version", "paths", "skillsMount", "toolSurface"],
};

/**
 * @param {object} ctx cordis 上下文（execute 时闭包持有，用来回读注册表）
 * @param {object} runtime
 * @param {object} state 装配期记账（见 lib/index.js）
 * @returns {object} 工具定义
 */
export function createProbeTool(ctx, runtime, state) {
  return {
    name: "astock_probe",
    description:
      "装机探针：返回 dsh-a-stock-data 插件的装载事实 —— 版本、随包技能是否挂载成功、"
      + "Python 解释器是否可用、随包路径是否存在、工具面此刻在册几个。"
      + "排查「工具/技能没出现」时先跑它。不取数、不写任何文件。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        echo: { type: "string", description: "可选回显字符串，用来确认参数确实透传到了 execute。" },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const lines = [
          `插件 ${value.plugin} v${value.version}（期望 DSH 运行时 ${value.dshRuntimeExpected}）`,
          `随包技能：${value.skillsMount.ok ? "已挂载" : "未挂载"}（提供方 ${value.skillsMount.provider}）— ${value.skillsMount.detail}`,
        ];
        for (const [key, p] of Object.entries(value.paths ?? {})) {
          if (typeof p === "object" && p !== null) {
            lines.push(`  ${key}: ${p.exists ? "✓" : "✗"} ${p.path}`);
          }
        }
        const py = value.python ?? {};
        lines.push(py.ok
          ? `Python：${py.bin} ${(py.prefixArgs ?? []).join(" ")} → ${(py.version ?? []).join(".")}`
          : `Python：不可用 — ${py.note ?? ""}`);
        const ts = value.toolSurface;
        lines.push(`工具面：装配 ${ts.attempted} / register 成功 ${ts.registered} / `
          + `此刻在册 ${ts.registryReadable ? ts.visibleAtCall : "（宿主不支持回读）"}`);
        if (ts.missing?.length) lines.push(`⚠️ 注册后不在册：${ts.missing.join(", ")}`);
        for (const f of ts.failures ?? []) lines.push(`⚠️ 装配失败 [${f.stage}] ${f.tool}：${f.message}`);
        if (value.echo !== undefined) lines.push(`回显：${value.echo}`);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },

    async execute(args) {
      const { existsSync } = await import("node:fs");
      const probe = await runtime.probePython();
      const p = runtime.paths;

      const missing = [];
      const get = ctx?.tools?.get;
      const registryReadable = typeof get === "function";
      if (registryReadable) {
        for (const name of state.names) {
          let found;
          try {
            found = get.call(ctx.tools, name);
          } catch {
            return buildProbeResult({
              runtime, state, probe, existsSync, args,
              registryReadable: false, visible: -1, missing: [],
            });
          }
          if (found === undefined || found === null) missing.push(name);
        }
      }

      return buildProbeResult({
        runtime, state, probe, existsSync, args,
        registryReadable,
        visible: registryReadable ? state.names.length - missing.length : -1,
        missing,
      });
    },
  };
}

/** 组装探针输出（两处出口共用，避免字段漂移）。 */
function buildProbeResult({ runtime, state, probe, existsSync, args, registryReadable, visible, missing }) {
  const p = runtime.paths;
  return {
    ok: true,
    plugin: state.pluginName,
    version: state.version,
    dshRuntimeExpected: state.dshRuntimeExpected,
    python: {
      ok: probe.ok,
      bin: probe.bin,
      prefixArgs: probe.prefixArgs,
      version: probe.version,
      executable: probe.executable,
      note: probe.note,
    },
    paths: {
      bundledSkillDir: { path: p.BUNDLED_SKILL_DIR, exists: existsSync(p.BUNDLED_SKILL_DIR) },
      skillDir: { path: p.SKILL_DIR, exists: existsSync(p.SKILL_DIR) },
      runtimePy: { path: p.RUNTIME_PY, exists: existsSync(p.RUNTIME_PY) },
      cliPy: { path: p.CLI_PY, exists: existsSync(p.CLI_PY) },
    },
    skillsMount: { ...state.skillsMount },
    toolSurface: {
      attempted: state.names.length,
      registered: state.registered.length,
      visibleAtCall: visible,
      registryReadable,
      missing,
      failures: state.failures,
    },
    echo: args?.echo,
  };
}