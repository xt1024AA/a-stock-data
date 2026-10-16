/**
 * astock_endpoints —— 查端点清单。
 *
 * 存在的理由：SKILL.md 有 432KB，通读一遍既慢又没必要。这个工具把「有哪些端点、签名长什么样、
 * 一句话说明」做成本地可查的清单，模型先检索再调用。
 *
 * 纯本地读 endpoints.json / 运行时，不发网络请求。默认不返回全部 100+ 条，
 * 以免把工具结果撑满；给 query 就按名字与说明过滤。
 */

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    count: { type: "integer", description: "匹配到的端点数" },
    total: { type: "integer", description: "运行时里的端点总数" },
    truncated: { type: "boolean", description: "匹配结果是否被 limit 截断" },
    endpoints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          signature: { type: "string" },
          summary: { type: "string" },
        },
        required: ["name", "signature", "summary"],
      },
    },
    error: { type: "string" },
  },
  required: ["ok", "count", "total", "truncated", "endpoints"],
};

/**
 * @param {object} runtime
 * @returns {object} 工具定义
 */
export function createEndpointsTool(runtime) {
  return {
    name: "astock_endpoints",
    description:
      "列出 / 检索 a-stock-data 的可用数据端点（名称、参数签名、一句话说明）。"
      + "用它先确认端点名与参数类型，再用 astock_call 调用。纯本地查询，不联网。"
      + "给 query 会同时按端点名与说明做子串匹配（大小写不敏感）。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: '检索词，例如 "kline"、"资金流"、"可转债"、"北向"。留空则返回 part 指定的分组。',
        },
        limit: {
          type: "integer",
          description: "最多返回多少条（默认 40，上限 300）。",
        },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (!value.ok) {
          return [{ type: "text", text: `❌ astock_endpoints 失败：${value.error ?? "未知错误"}` }];
        }
        const lines = [
          `共 ${value.total} 个端点，匹配 ${value.count} 个${value.truncated ? "（已截断，调大 limit 看更多）" : ""}：`,
          "",
        ];
        for (const e of value.endpoints) {
          lines.push(`- ${e.name}${e.signature}`);
          if (e.summary) lines.push(`    ${e.summary}`);
        }
        return [{ type: "text", text: lines.join("\n") }];
      },
    },

    async execute(args) {
      const res = await runtime.runCli(["list"], { timeoutMs: 120_000 });
      const v = res.value;
      if (!v || v.ok === false) {
        return {
          ok: false, count: 0, total: 0, truncated: false, endpoints: [],
          error: v?.error ?? res.error ?? "读取端点清单失败。",
        };
      }

      const all = Object.entries(v.endpoints ?? {}).map(([name, meta]) => ({
        name,
        signature: meta?.signature ?? "(…)",
        summary: meta?.summary ?? "",
      }));

      const query = String(args?.query ?? "").trim().toLowerCase();
      const matched = query
        ? all.filter((e) => e.name.toLowerCase().includes(query)
            || e.summary.toLowerCase().includes(query))
        : all;

      const limit = Math.max(1, Math.min(Number(args?.limit ?? 40) || 40, 300));
      matched.sort((a, b) => a.name.localeCompare(b.name));
      const shown = matched.slice(0, limit);

      return {
        ok: true,
        count: matched.length,
        total: all.length,
        truncated: matched.length > shown.length,
        endpoints: shown,
      };
    },
  };
}