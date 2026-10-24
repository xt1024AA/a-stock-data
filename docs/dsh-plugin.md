# a-stock-data 的 DSH 插件形态

本仓库原本是一个 **Claude Skill**：一个 432KB 的 `SKILL.md`，里面内嵌 91 段 Python，
用文档 + 代码块的方式教模型「怎么写代码去取 A 股数据」。

`a-stock-data-DSH` 分支在**不牺牲原有形态**的前提下，把它同时做成一个
**DeepSeek Harness（DSH）插件**。根目录的 `SKILL.md` 的端点实现一字未改
（只清理过打赏 / 引流段，见 CHANGELOG），Claude Code / Codex / OpenClaw 等宿主照旧可用；
DSH 走下面这套新装配。

---

## 1 为什么不是「把 SKILL.md 塞进插件就完了」

只把文档装成技能，模型拿到的还是「一段可抄的代码」。抄写会带来三类问题：

| 问题 | 后果 |
| --- | --- |
| 抄 100+ 个端点里的某一段 | 漏抄辅助函数 / 常量，`NameError` |
| 抄完当次会话有效、下次重来 | 同一份实现被反复重写，行为不可复现 |
| 文档与代码漂移 | SKILL.md 改了，抄本没人改 |

所以这个插件做两件事，缺一不可：

1. **随包技能**（rank 600）—— 把 `SKILL.md` 原样交给 DSH 的技能发现机制，
   模型按需加载完整文档，知道有哪些端点、参数怎么传、坑在哪。
2. **可调用的端点**（`astock_*` 工具）—— 把 SKILL.md 里内嵌的 Python
   **在构建期**提取成一个可 import 的运行时，模型按名字调用，不再抄写。

第 2 点是关键：**SKILL.md 仍是唯一事实来源**，运行时是它的派生物，
由 `scripts/build_runtime.py` 生成、由 `scripts/check_skill_contract.py` 与
`--check` 模式守护同步。

---

## 2 结构

```
a-stock-data/
├── SKILL.md                          ← 唯一事实来源（未改动，其它宿主继续用）
├── package.json                      ← DSH 插件清单：dsh.bundle.patch
├── cordis.patch.yml                  ← 往 profile 组合树里插一行
├── lib/
│   ├── index.js                      ← 装配：注册工具 + 挂随包技能
│   ├── runtime.js                    ← Python 桥：解释器探测 / 子进程 / JSON 解析
│   └── tools/
│       ├── probe.js                  ← astock_probe
│       ├── env.js                    ← astock_env
│       ├── endpoints.js              ← astock_endpoints
│       └── call.js                   ← astock_call
├── scripts/
│   ├── build_runtime.py              ← SKILL.md → 运行时（生成器）
│   ├── check_skill_contract.py       ← 随包 SKILL.md 是否满足 DSH 发现契约
│   └── test-tools.mjs                ← 工具面自测（假 ctx，可选 --live 联网）
└── skills/
    └── a-stock-data/
        ├── SKILL.md                  ← 由根 SKILL.md 同步（仅 frontmatter 归一）
        ├── runtime/                  ← 生成物
        │   ├── astock_runtime.py
        │   └── endpoints.json
        └── scripts/
            └── astock_cli.py         ← 工具面调用的命令行入口
```

### 2.1 为什么运行时是「生成」的

`astock_runtime.py` 由 `scripts/build_runtime.py` 从 `SKILL.md` 生成，绝不手抄。
生成器只做一件事：把文档里的 ```python 块按顺序拼成一个模块，**丢掉示例调用**。

判据是前向数据流，不是「像不像示例」：

- 从 `builtins` + 已见过的 import 出发，按文档顺序逐条语句检查
  「它执行时要查的名字此刻是否已绑好」；查不到就说明这条是用法演示。
- 再加一条：模块级语句**不得调用 SKILL.md 自己定义的任何函数**。
  真实初始化只碰外部库（`requests.Session()`、`HTTPAdapter(...)`、`EM_SESSION.headers.update(...)`）。

这两条都是踩出来的：单看「右值有没有调用本文件函数」会放过
`auction = ticks[ticks.time < "09:30:00"]`（下标不是调用）——而它依赖的 `ticks`
上一行正是示例调用，结果是 import 阶段真的去打网络。

### 2.2 软依赖策略

`mootdx` 被**刻意当作可选**，原因不是懒：它要求 `httpx<0.26`，而宿主里的
`litellm` / `mcp` 需要 `httpx>=0.27`，**装上会互相破坏**。`baostock` / `stockstats`
同理只在少数端点用得上。

缺失时运行时给它们装 stub，相关端点会**明确报错**，而不是静默返回空——
「确实没有数据」与「接口坏了」必须能分开，这是 SKILL.md 自己反复强调的口径。

---

## 3 安装

```bash
# 1. 装 Python 依赖（mootdx 请勿装，见 §2.2）
pip install requests pandas numpy stockstats baostock xlrd openpyxl

# 2. 装插件（<profile> 换成你的 profile 名）
dsh plugin --profile <profile> add <本仓库路径或 git 地址>
```

`dsh plugin add` 会读 `package.json` 的 `dsh.bundle.patch`，把本包追加进
profile 的 `dsh.profile.bundles`，并创建到本仓库的链接。

> **DSH Desktop 用户：** `desktop` profile 由 Electron 独占，装完**需要重启 DSH**
> 才会加载新的 JS 模块（运行中的进程缓存已加载的模块）。

装完先用探针确认：

```
astock_probe          # 版本 / 随包技能是否挂载 / Python 是否可用 / 工具面在册数
astock_env            # 依赖体检，缺什么给什么 pip 命令
```

---

## 4 工具面

| 工具 | 联网 | 作用 |
| --- | --- | --- |
| `astock_probe` | 否 | 装机事实：版本、随包技能挂载、解释器、工具面此刻在册几个 |
| `astock_env` | 否 | 环境体检：解释器 + 依赖 + 运行时指纹 |
| `astock_endpoints` | 否 | 端点清单检索（名称 / 签名 / 一句话说明） |
| `astock_call` | **是** | 调用一个端点取数 |

四个都**只读**：不写文件、不改环境、无审批闸门。

典型用法：

```
astock_endpoints { "query": "kline" }
astock_call      { "endpoint": "tencent_kline", "args": { "code": "600519", "count": 60 } }
astock_call      { "endpoint": "tencent_quote", "args": { "codes": ["600519", "000001"] } }
astock_call      { "endpoint": "full_valuation", "args": { "code": "688017" } }
```

两道与「静默失败」有关的保护：

- **大表截断**：`tdx_daily_package()` 一次返回 5 万行。默认最多回 200 行，
  并在 `meta.truncated` 里如实标注，避免把前 200 行当成全量。
- **参数类型拦截**：`tencent_quote(codes: list[str])` 拿到字符串不会报错，
  它会按字符迭代、最后静默返回 `{}`。命令行入口按签名注解做浅层体检，
  在进端点之前就以 `bad_args` 拦下，并给出正确的调用样例。

---

## 5 验证

```bash
# 生成物是否与 SKILL.md 同步（CI 用）
python scripts/build_runtime.py --check

# 随包 SKILL.md 是否满足 DSH 的发现契约
python scripts/check_skill_contract.py

# 工具面自测（假 ctx，复刻 Cordis 的 effect/register 语义）
node scripts/test-tools.mjs           # 本地用例
node scripts/test-tools.mjs --live    # 追加联网用例
```

`test-tools.mjs` 不是走形式：它用假 ctx **如实复刻**了 Cordis 的两条语义
（`effect(callback)` 立刻调用并把返回值当清理函数；`register` 返回精确注销器），
于是「工具注册后被自己的 disposer 立刻注销」这个经典事故会被
`astock_probe` 的 `toolSurface.visibleAtCall` 直接抓出来。

### 本分支的实测记录

| 项目 | 结果 |
| --- | --- |
| 运行时提取 | 91 个 python 块 / 保留 437 条语句 / 丢弃 260 条示例代码 / **104 个端点** |
| 导入副作用 | 1.46 秒，无网络调用 |
| 真实端点冒烟 | **49 / 52 通过**（v0.1.2 记录；v0.1.3 随上游 v3.10.3 修复并联网复测 `sse_e_interaction`，余下 2 项为上游数据约束） |
| 工具面自测 | **40 / 40 通过**（离线）；`--live` 为 **44 / 44**。v0.1.1 为 34 条，其中技能挂载一条是假绿，见 §6 |
| skill 发现契约 | 全部通过 |
| 真机安装 | v0.1.1 时 `dsh plugin add` 成功、bundle 已追加、`--dump-config` 组合出该行；**但升级到 DSH 0.2.1-rc.2 后整行被跳过**，根因见 §6 第一行 |
| 真机运行 | v0.1.1 在 0.2.0-rc.2 下正常：`astock_probe` 报随包技能已挂载（提供方 `astock-bundled`，rank 600）、工具面装配 4 / 注册 4 / 此刻在册 4、`astock_call` 取到真实行情。v0.1.3 改的是随包运行时内容，需重启 DSH 后复核版本号 |

v0.1.2 冒烟时未通过 3 项，报错都由**提取出的 SKILL.md 代码自己抛出**，
说明代码是被忠实提取并真正执行了的。其中 `sse_e_interaction` 已随上游 v3.10.3 修复：

| 端点 | 情况 |
| --- | --- |
| `bse_quote_backup` | 只提供当前快照，传入历史交易日会明确拒绝（上游设计） |
| `st_stock_list` | 快照为空时的上游自检报错（数据源侧波动） |

---

## 6 排障

| 现象 | 处置 |
| --- | --- |
| **整插件消失**（`astock_*` 工具全无、`Config` 目录里查不到该行，但 `dsh.profile.bundles` 明明列着它） | **先看版本声明，不要改 patch。** DSH 的 bundle 版本检查若判定不兼容，整排 `insert` 行会被静默跳过 —— 症状与「patch 写错」完全一样，但改 patch 没用。判据：`plugin_manager list_bundles` 里该 bundle 若带 `"error": {"code": "incompatible-version"}` 且 `"rows": []`，就是它。v0.1.1 的 `peerDependencies: "0.2.0-rc.2"`（精确版本）在运行时 `0.2.1-rc.2` 下正是此症；v0.1.2 已改为 `engines.dsh: ">=0.2.1-rc.2"` |
| 随包技能没挂上，`skillsMount.detail` 报「无法解析 @deepseek-ai/dsh-skill-filesystem」 | v0.1.1 的已知问题。`@deepseek-ai/*` 是宿主依赖，只在其自身解析树内（桌面版在 `app.asar`），插件目录恒 `ERR_MODULE_NOT_FOUND`。v0.1.2 改为 `ctx.get("skills").registerProvider()`，不再 import 宿主包 |
| 工具没出现 | 跑 `astock_probe`；`visibleAtCall` 为 0 说明装配期被注销，`skillsMount` 说明技能侧 |
| 测试全绿但装机不可用 | `test-tools.mjs` 第 3 节在 v0.1.1 曾把「挂载失败」也判为通过（`ok \|\| detail 非空`），所以绿不代表可用。v0.1.2 已改硬断言 |
| 工具报 `value is not lossless JSON` | 返回值里有 `undefined`（`JSON.stringify` 会静默丢掉，本地看不出）。v0.1.1 已修；**改过 `lib/` 后必须重启 DSH** 才生效——运行中的进程缓存已加载的 JS 模块，HMR 只热加新条目、不热换已有模块。重启后 `astock_probe` 报的版本号可用于确认 |
| `python_unavailable` | 装 python.org 的 3.9+；Windows 上 Microsoft Store 的 `python3.exe` 是占位程序，会弹商店。也可用 `ASTOCK_PYTHON` 指定绝对路径 |
| 缺依赖 | `astock_env` 会给出确切的 pip 命令 |
| 端点评 `NameError` | 生成物与 SKILL.md 不同步，跑 `python scripts/build_runtime.py` |
| 端点报 `RuntimeError` | 多半是来源格式变了或该标的确实没有数据——错误信息里带函数名与字段名 |
| 大表只回了一点 | 看 `meta.truncated`；调大 `limit` 或缩小查询区间 |


---

## 7 与上游的关系

本分支只**增加** DSH 插件装配，不修改上游的数据实现：

- 根 `SKILL.md` 的端点实现一字未改（只清理过打赏 / 引流段），上游同步后重新生成即可。
- 所有端点实现都来自 SKILL.md，本仓库不维护第二份实现。
- 上游改了端点 → `python scripts/build_runtime.py` 重新生成 → `--check` 会在 CI 里守住。

### 7.1 同步上游的三步

```bash
git fetch origin main && git merge origin/main   # 合并上游（冲突只会出现在下面两处）
python scripts/build_runtime.py                  # 重新生成随包 SKILL.md + 运行时
python scripts/build_runtime.py --check && python scripts/check_skill_contract.py && node scripts/test-tools.mjs
```

两处可预期的冲突：

- `SKILL.md` 头部：本分支删掉了「项目主页 / 作者联系方式」引流段，上游若在同一区域改标题或加版本说明，
  git 会把两边的改动挤成一个冲突块 —— 取上游的新标题，**不要**把引流段加回来。
- `CHANGELOG.md`：本分支的插件记录与上游的版本记录都写在文件顶部 —— 两段都保留，按日期从新到旧排。

改完 `SKILL.md`（含解决冲突）必须重建一次，否则 `--check` 会报生成物与源文件不同步。
运行时只是内容更新时，**不用**改 `lib/`；重启 DSH 即可让新运行时生效（`astock_probe` 的版本号可用于确认）。