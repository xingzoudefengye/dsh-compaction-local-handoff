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
- **summary**：阶段性要求/约束（历史内 system 更新，保留来源，标注"不作为新授权"）；压缩区间内涉及的文件（从工具调用参数提取，最多 25 个）；最近 4 次工具调用及结果（失败/成功/结果未记录）；最近一条助手进展原文摘录；未解决报错线索；上次交接摘录（非新指令）；以及"工具结果只保留预览"的收尾提示。

凭据形态的文本（`sk-…`、`Bearer …`、`api_key=…`）会被 redact，`<thinking>` 块被剥离。

各字段有独立字符预算（用户要求 1600、进展 900、单条工具 280、约束 300、旧交接 1200），总计硬上限 6,000 字符。

## 安装

用 DSH 自带的插件管理器（会把本仓库作为 bundle 装进 profile）：

```bash
dsh plugin --profile web install github:xingzoudefengye/dsh-compaction-local-handoff
```

或手工两步：

```bash
cd ~/.dsh/profiles/web
pnpm add github:xingzoudefengye/dsh-compaction-local-handoff
```

然后把包加入 `package.json` 的 `dsh.profile.bundles`（`dsh plugin install` 会自动做这一步）：

```json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "dsh-compaction-local-handoff"
] } }
```

本仓库自带的 `cordis.patch.yml` 会在它这一层：

```yaml
- id: compaction-basic
  disabled: true

- insert:
    - id: compaction-local-handoff
      name: 'dsh-compaction-local-handoff'
```

因为 bundle 层在 base 之后应用，这个 `disabled` 会覆盖 base 里的 `compaction-basic` 行。

## 验证

- 装好后跑 `/compact`：压缩记录里 `provider/model` 会显示 `local / local-handoff`，且会话日志里**没有** `purpose: "compaction"` 的模型调用。
- 或者看日志：压缩日志行仍是 `compaction (step pressure): shadowed N surface nodes ...`。
- 想确认当前生效的是哪个后端，看 profile 的插件页 / `dsh plugin --profile web list`。

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
- **极短历史下会拒绝压缩。** 后端要求检查点必须小于被遮蔽的内容，而 DSH 会给每条检查点加一段固定 preamble；区间太短时压缩会报 `summary is not smaller than the shadowed content`。这与默认后端的行为一致。
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
