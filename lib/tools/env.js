/**
 * astock_env —— 环境体检。
 *
 * 回答「为什么取数失败」这类第一个该问的问题：解释器找得到吗？依赖齐吗？
 * 运行时是从 SKILL.md 生成的那一份吗？哪些可选依赖被 stub 掉了？
 *
 * 只读，不装包、不改环境。缺依赖时把确切的 pip 命令给出来，而不是只说「环境有问题」。
 */

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", description: "必需依赖与运行时是否都就位" },
    python: {
      type: "object",
      additionalProperties: true,
      description: "探测到的解释器：bin / prefixArgs / version / executable / attempts",
    },
    deps: {
      type: "object",
      additionalProperties: true,
      description: "依赖是否安装：{ 名字: { required, installed } }",
    },
    runtime: {
      type: "object",
      additionalProperties: true,
      description: "随包运行时：path / exists / softStubs / endpointCount",
    },
    notes: { type: "array", items: { type: "string" } },
    error: { type: "string" },
  },
  required: ["ok"],
};

/**
 * @param {object} runtime
 * @returns {object} 工具定义
 */
export function createEnvTool(runtime) {
  return {
    name: "astock_env",
    description:
      "诊断 a-stock-data 插件在本机的运行条件：Python 解释器是否可用（版本 >= 3.9）、"
      + "requests/pandas 等依赖是否齐全、随包运行时是否就位、哪些可选依赖被降级为 stub。"
      + "取数报错或工具不可用时先跑它。只读，不会安装任何东西。",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const lines = [value.ok ? "✅ a-stock-data 环境就绪" : "❌ a-stock-data 环境有问题"];

        const py = value.python ?? {};
        lines.push(py.ok
          ? `Python：${py.bin} ${(py.prefixArgs ?? []).join(" ")} → ${(py.version ?? []).join(".")}（${py.executable ?? "?"}）`
          : `Python：不可用 —— ${py.note ?? "未探测到 >= 3.9 的解释器"}`);

        const deps = value.deps ?? {};
        const installed = Object.entries(deps).filter(([, d]) => d.installed).map(([n]) => n);
        const missingRequired = Object.entries(deps).filter(([, d]) => d.required && !d.installed).map(([n]) => n);
        const missingOptional = Object.entries(deps).filter(([, d]) => !d.required && !d.installed).map(([n]) => n);
        lines.push(`依赖已装：${installed.join(", ") || "（无）"}`);
        if (missingRequired.length) lines.push(`⚠️ 缺少必需依赖：${missingRequired.join(", ")}`);
        if (missingOptional.length) lines.push(`可选依赖未装：${missingOptional.join(", ")}（相关端点会明确报错）`);

        const rt = value.runtime ?? {};
        lines.push(rt.exists
          ? `随包运行时：${rt.path}（${rt.endpointCount ?? "?"} 个端点${rt.softStubs?.length ? `，stub: ${rt.softStubs.join(", ")}` : ""}）`
          : `随包运行时缺失：${rt.error ?? "未找到"}`);

        for (const note of value.notes ?? []) lines.push(`· ${note}`);
        if (value.error) lines.push(`错误：${value.error}`);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },

    async execute() {
      const probe = await runtime.probePython();

      // 解释器不可用时，Python 侧的体检跑不了，直接在 Node 侧给出结论
      if (!probe.ok) {
        return {
          ok: false,
          python: { ok: false, note: probe.note, attempts: probe.attempts },
          deps: {},
          runtime: { exists: false },
          notes: ["先修好 Python，再用 astock_call 取数。"],
        };
      }

      const res = await runtime.runCli(["env"], { timeoutMs: 120_000 });
      const v = res.value;
      if (!v) {
        return {
          ok: false,
          python: probe,
          deps: {},
          runtime: { exists: false },
          notes: ["体检命令没有返回可解析的 JSON。"],
          error: res.error ?? String(res.stderr ?? "").slice(-400),
        };
      }
      return {
        ok: v.ok !== false,
        python: probe,
        deps: v.deps ?? {},
        runtime: v.runtime ?? {},
        notes: v.notes ?? [],
      };
    },
  };
}