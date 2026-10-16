/**
 * astock_call —— 调用一个 a-stock-data 端点。
 *
 * 这是本插件的核心工具：SKILL.md 里有 87 个端点，与其让模型把文档里的代码块抄一遍再跑
 * （抄错、抄漏、版本漂移都是常有的事），不如直接按名字调用构建期提取好的实现。
 *
 * 只读取数，不写文件、不改状态 —— 所以没有审批闸门。
 * 返回里的 meta 会写明是否因体积被截断，避免模型把「前 200 行」当成全量。
 */

/** 结果输出的 schema。 */
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    endpoint: { type: "string" },
    meta: {
      type: "object",
      additionalProperties: true,
      description: "取数元信息：totalRows / shownRows / truncated / columns（大表被截断时为 truncated=true）",
    },
    result: {
      description: "端点返回值：对象 / 数组 / 标量，视端点而定",
    },
    error: { type: "string" },
    errorKind: {
      type: "string",
      description: "unknown_endpoint | bad_args | endpoint_error | python_unavailable | cli_missing | bad_output | output_too_large | spawn_failed",
    },
    hint: { type: "string" },
  },
  required: ["ok"],
};

function renderResult(value) {
  if (!value.ok) {
    const lines = [`❌ astock_call ${value.endpoint ?? ""} 失败（${value.errorKind ?? "error"}）`];
    if (value.error) lines.push(value.error);
    if (value.hint) lines.push(`提示：${value.hint}`);
    return [{ type: "text", text: lines.join("\n") }];
  }

  const meta = value.meta ?? {};
  const head = [`✅ astock_call ${value.endpoint}`];
  if (meta.totalRows !== undefined) {
    head.push(`行数：${meta.shownRows}/${meta.totalRows}${meta.truncated ? "（已截断，调大 limit 取全量）" : ""}`);
  }
  if (Array.isArray(meta.columns) && meta.columns.length) {
    head.push(`列：${meta.columns.join(", ")}`);
  }

  const body = JSON.stringify(value.result, null, 2);
  // 渲染层也要有个上限：工具结果过长会挤掉对话上下文
  const clipped = body.length > 12_000 ? body.slice(0, 12_000) + "\n…（结果过长已截断显示，完整数据请缩小查询范围）" : body;
  return [{ type: "text", text: `${head.join("\n")}\n\n${clipped}` }];
}

/**
 * @param {object} runtime createRuntime 的产物
 * @returns {object} 工具定义
 */
export function createCallTool(runtime) {
  return {
    name: "astock_call",
    description:
      "调用 a-stock-data 的一个数据端点取 A 股及相关市场数据（行情/K线/研报/资金面/龙虎榜/解禁/"
      + "涨停/ETF期权/宏观利率/期货/可转债/新闻公告等 100+ 个端点）。"
      + "端点名与参数用法见随包技能 a-stock-data（SKILL.md）；用 astock_endpoints 查完整清单与签名。"
      + "只读取数，不修改任何东西。大表会在 meta.truncated 里标明并截断，需要全量就调大 limit。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        endpoint: {
          type: "string",
          description: '端点函数名，例如 "tencent_quote"、"tencent_kline"、"full_valuation"、"convertible_bonds"。',
        },
        args: {
          type: "object",
          additionalProperties: true,
          description:
            '传给端点的关键字参数，例：{"codes": ["600519"]}、{"code": "600519", "count": 60}。'
            + "参数名与类型见 astock_endpoints 返回的 signature。",
        },
        limit: {
          type: "integer",
          description: "最多返回多少行 / 条（默认 200）。大表用它可以避免输出过长。",
        },
      },
      required: ["endpoint"],
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderResult(value) },

    async execute(args) {
      const endpoint = String(args?.endpoint ?? "").trim();
      if (!endpoint) {
        return { ok: false, errorKind: "bad_args", error: "endpoint 不能为空。" };
      }

      const cliArgs = ["call", endpoint];
      if (args?.args !== undefined && args.args !== null) {
        cliArgs.push("--args", JSON.stringify(args.args));
      }
      if (args?.limit !== undefined && args.limit !== null) {
        cliArgs.push("--limit", String(args.limit));
      }

      const res = await runtime.runCli(cliArgs);
      if (!res.value) {
        return {
          ok: false,
          endpoint,
          errorKind: res.errorKind ?? "error",
          error: res.error ?? "调用失败。",
          hint: res.stderr ? String(res.stderr).slice(-400) : "",
        };
      }

      const v = res.value;
      if (v.ok === false) {
        return {
          ok: false,
          endpoint,
          errorKind: v.errorKind ?? "error",
          error: v.error ?? "端点报错。",
          hint: v.hint ?? "",
        };
      }
      return { ok: true, endpoint, meta: v.meta ?? {}, result: v.result ?? null };
    },
  };
}