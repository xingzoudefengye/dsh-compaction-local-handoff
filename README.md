# dsh-compaction-local-handoff

DeepSeek Harness（DSH）的**零模型调用**压缩后端。把"到达阈值后额外发一次请求让模型写交接文档"换成"本地、确定性、有界地拼出交接文档"。

思路来自 ComeCode 的本地交接式压缩（`engine/apps/zcode-cli/packages/core/src/compact/local-handoff.ts`），但落在 DSH 官方的扩展点 `summarize()` 上，因此**不需要修改 harness 任何源码**。

## 它替换了什么

DSH 默认的 `@deepseek-ai/dsh-compaction-basic` 在上下文到达阈值后：

1. 先用 `tool-result-pruner` 无模型地剪掉超大工具结果（剪完低于阈值就结束）；
2. 仍需压缩时，**发起一次额外的 LLM 调用**（`purpose: "compaction"`）让模型按固定 8 节结构写检查点；
3. 用这条检查点替换最老的一段历史，保留最近约 16% 逐字。

本插件把第 2 步换成纯本地拼装。**第 1、3 步以及全部触发策略保持不变**：

| 行为 | 默认后端 | 本插件 |
|---|---|---|
| 触发阈值 | `floor(min(W × 0.8, W − O − headroom))` | 同 |
| 逐字保留近期尾部 | `retainRatio 0.16` | 同 |
| 工具结果剪枝 / 图片卸载 | 是 | 同 |
| 区间选择（工具配对安全、不遮蔽系统提示词） | 是 | 同 |
| 日志事务 / 并发锁 / 上下文溢出恢复 / `/compact` | 是 | 同 |
| 检查点怎么来 | **一次模型调用** | **本地拼装，0 次调用** |
| 检查点内容 | 模型自选措辞的 8 节 Markdown | 固定字段、逐字摘录、硬字符预算 |
| 上限 | 模型输出上限 | 6,000 字符，且不超过被遮蔽内容的一半 |
| 成本 / 延迟 | 每次触发都付费，还要等 | 免费、即时、可复现 |

## 交接文档里有什么

`<compacted-summary>` 内是一段有界文本（外层 preamble 由 DSH 自己加）：

- **guide**：不表示任务已完成；最新用户要求（压缩区间内最后一条）；提示完整原文仍在会话日志中、缺失细节按需重读。
- **summary**：阶段性要求/约束（历史内 system 更新，保留来源，标注"不作为新授权"）；压缩区间内涉及的文件（从工具调用参数提取，最多 25 个）；**回合级史书**（装了 [dsh-session-recall](../dsh-session-recall) 时出现）；最近 4 次工具调用及结果（失败/成功/结果未记录）；最近一条助手进展原文摘录；未解决报错线索；上次交接摘录（非新指令）；以及"工具结果只保留预览"的收尾提示。

装了 `dsh-session-recall` 后，交接里会多一段**回合级史书**（≤2400 字符，且不超过交接预算的 40%）：它由会话日志折叠而来，所以**重复压缩也不会丢**——被上一次交接替换掉的早期回合，其结论仍然在里面。没装该 bundle 时行为与之前完全一致；史书读取失败也只会退化成没有这一段，不会让压缩失败。

凭据形态的文本（`sk-…`、`Bearer …`、`api_key=…`）会被 redact，`<thinking>` 块被剥离。

各字段有独立字符预算（用户要求 1600、进展 900、单条工具 280、约束 300、旧交接 1200），总计硬上限 6,000 字符。

## 安装

用 DSH 自带的插件管理器（会把本仓库作为 bundle 装进 profile；实测该命令会同时写入 `dependencies` 和 `dsh.profile.bundles`）：

```bash
dsh plugin --profile web add github:xingzoudefengye/dsh-compaction-local-handoff
```

装完需要重启该 profile 的 app（新增模块根不在 HMR 热重载范围内）才能生效。

或手工两步：

```bash
cd ~/.dsh/profiles/web
pnpm add github:xingzoudefengye/dsh-compaction-local-handoff
```

然后把包加入 `package.json` 的 `dsh.profile.bundles`：

```json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "dsh-compaction-local-handoff"
] } }
```

### 为什么 `cordis.patch.yml` 是生成出来的

压缩后端在 profile 里被挂了**两层**，只改一层是不够的：

1. **profile 根**——`dsh-base` 直接挂了一行 `compaction-basic`；`preset-minimal` 这类没有自己压缩组的 preset 继承的就是它。
2. **每个 agent preset 内部的隔离压缩组**——`preset-standard` / `preset-ptc` / `preset-cordis` 各自带一个 `cordis:group`，带 `isolate: {compaction: true}`，里面又挂了一份 `compaction-basic`。**正常 GUI 会话跑在 preset 下，用的是这一份。**

第 2 层无法用普通的按 id patch 命中：preset 行的 `config.plugins` 是**数据**，交给 `@deepseek-ai/dsh-agent-preset-registry` 注册后才在 agent 自己的 scope 里挂载，而 loader 的 `applyEntryPatches` 只下钻 `group: true` 的行（preset 行不是）。

所幸 registry 的文档给了官方做法——"A new preset or an override of a shipped one is a bundle patch: an `insert` of a `@deepseek-ai/dsh-agent-preset` row, **or a patch keyed by that row's id**"。所以 `cordis.patch.yml` 由 `scripts/sync-presets.mjs` 生成：读**官方发布的 manifest 文件** `@deepseek-ai/dsh-web-app/presets/*.patch.yml`，**逐字复制**，只把那两行 `compaction-basic` 换成 `compaction-local-handoff`，其余（persona、plan-mode、delegation……）保持原样。

来源必须是 manifest 文件，**不能**是 `dsh --dump-default-config`：这个 bundle 自己就是一个 bundle，等 dump 渲染出来时它自己的补丁已经生效了 —— 读 dump 等于读本文件的输出，于是 `check:presets` 拿文件和自己比，永远失败（"no preset with a compaction group found"）。一个**永远不可能通过**的漂移守卫比没有更糟，因为它看起来像保护。

代价要说清楚：这意味着这些 preset 清单在你的 profile 里被**冻结**在生成时的那一版。harness 升级若改动了 shipped preset（新增工具、调整 prompt 段），你不会自动拿到，需要：

```bash
npm run sync:presets      # 重新生成
npm run check:presets     # 检查是否已过期（不一致时非零退出，并打印第一处差异）
```

生成器对上游 YAML 形状是**硬编码**的（`- insert:` 包装 + 4 空格缩进、`- id: compaction-basic` + `name:` 两行），形状一变就抛错要求更新，不会静默生成错误的东西。

## 验证

已经在本机真机验证过，**两条挂载路径都跑通了**。

**preset 路径（GUI 正常会话走的就是这条）**——在一个 `agentPreset: "standard"` 的 web 会话里执行 `/compact`，会话日志：

```
17:53:57.134  compaction/start
17:53:57.145  compaction/summary   provider=local  model=local-handoff
              shadowedRange 8-61 · 21 nodes · 5713 tokens
              llmStreamCall=无 · rawOutput=无 · usage=无 · maxTokens=无
```

11 毫秒完成，且摘要事件不带 `llmStreamCall` / `usage` / `maxTokens` —— 模型摘要路径一定会带这三者，所以这确实是一次纯本地压缩。节点数与 token 数同界面报告的"已压缩 21 条历史记录（约 5713 tokens）"一致。

**根路径**——一次性 profile + 小窗口强制触发自动压缩（`compaction (step pressure)`），同样得到 `provider: "local"`、`model: "local-handoff"`，`compaction/start` → `compaction/summary` 间隔 2 毫秒。

同时验证到的行为：

- 交接里的"最新用户要求"是**真用户指令**，不是被注入的 `<system-reminder>`（技能目录 / AGENTS.md / 运行时上下文）；
- 反复压缩时上一次交接被当**数据合并**（最多一条 `上次交接携带的文件（可能已过时）`），不会层层嵌套；
- 被遮蔽区间变小时交接跟着变小，能通过后端的"必须比源内容更小"检查。

自己验证：

- 在 GUI 里跑 `/compact`：压缩记录显示 `local / local-handoff`，且没有 `purpose: "compaction"` 的模型调用。
- 日志行不变：`compaction (step pressure): shadowed N surface nodes ...`。
- 想在隔离环境里试：`dsh plugin --profile <新profile> add <本仓库绝对路径>`，再用小窗口强制触发（见本仓库的测试做法）。

## 回滚

从 `dsh.profile.bundles` 里移除本包（或在插件页禁用它）即可；`compaction-basic` 会自然回到启用状态。**本插件不修改任何 harness 文件**，所以 harness 升级不会影响它，卸载也不会留下残留。

## 配置

继承 `compaction-basic` 的全部配置项（`thresholdRatio`、`retainRatio`、`retainTokens`、`headroomTokens`、`compactionRetries`、`maxOverflowRetries`、`modelPolicies`、`auto`）。`summarizationProvider` / `summarizationModel` / `maxTokens` 在这个后端下不再有意义。

```yaml
- id: compaction-local-handoff
  config:
    thresholdRatio: 0.7
    retainRatio: 0.2
```

本插件刻意不引入任何新配置键：新增键会被继承的 `resolveConfig` 拒绝，保持配置面与上游一致。

## 已知限制

- **交接是"有界交接"，不是"智能摘要"。** 较早的决策理由、失败过的方案、跨文件的推理不会自动保留 —— 与 ComeCode 的取舍一致。完整原文仍在会话日志里，但 **DSH 目前没有暴露给模型的"读历史"工具**（ComeCode 有 `ReadSessionContext`），所以模型只能靠重新读文件或重跑命令来恢复细节。
- **preset 清单被冻结。** 见上文"为什么 `cordis.patch.yml` 是生成出来的"：harness 升级改动 shipped preset 后需要重新跑 `npm run sync:presets`。
- **极短历史下会拒绝压缩。** 后端要求检查点必须小于被遮蔽的内容，而 DSH 会给每条检查点加一段固定 preamble（约 350 字符）；被遮蔽区间小于约 100 token 时无法再压，压缩会报 `summary is not smaller than the shadowed content`。这与默认后端的行为一致，且是非致命的（自动路径记一条警告后继续本轮）。
- **窗口贴着固定前缀时会反复压缩。** 阈值是 `min(W×0.8, W−O−headroom)`，而 system prompt + 工具 schema 是不可压缩的固定前缀。如果 `W` 只比前缀大一点（例如把 512K 调到 12K 做测试），每个 step 都会越过阈值、反复触发压缩。这是上游阈值策略的固有行为，不是本插件引入的；真实窗口下不会出现。
- 单条不可分单元（一次超大工具调用）仍无法被压缩。
- 图片内容不进入交接：只保留文本块。

## 开发

```bash
npm test                 # 纯函数测试；engine 测试在 peer 不可解析时自动跳过
scripts/dev-link.sh      # 把已安装 harness 的 peer 包软链进来，让 engine 测试真正跑起来
```

`lib/handoff.js` 是纯函数模块（无依赖、无 I/O），`lib/index.js` 只有子类化与预算计算。

## 设计说明

- **只覆写官方唯一的子类钩子。** `BasicCompactionEngine.summarize()` 是上游文档明确保留的扩展点（"Override this sole hook for a template or remote summarizer"），其余（阈值、保留、区间选择、事务、锁）都由上游负责，因此上游修 bug 时本插件自动受益。
- **不 import cordis。** 只 import `@deepseek-ai/dsh-compaction-basic`，并以 `peerDependencies` 声明。profile 里已有一份，Node 从 profile 的 `node_modules` 解析到同一实例，避免出现两份 `Service` 基类导致的服务身份问题。
- **无构建步骤。** 纯 ESM JavaScript，`pnpm add github:…` 直接可用，不触发 pnpm 的依赖构建脚本审批。

## License

MIT
