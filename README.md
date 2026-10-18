# dsh-compaction-local-handoff

DeepSeek Harness（DSH）的**零模型调用**压缩后端：上下文到达阈值后，用本地、确定性、有界的交接文档代替一次额外的模型摘要调用。

> **English:** A model-free compaction backend for DeepSeek Harness. When the context reaches the compaction threshold, it replaces the extra summarization LLM call with a deterministic, bounded handoff assembled locally from the messages being shadowed — no model call, no cost, no added latency, and reproducible output. Everything else about compaction (trigger threshold, verbatim tail retention, tool-result pruning, span selection, locking, `/compact`) is inherited unchanged from `@deepseek-ai/dsh-compaction-basic`. Install it with one `dsh plugin add` plus a host restart, and remove the bundle to get the default backend back.

## 兼容性

| 平台 | 支持 | 说明 |
|---|---|---|
| Windows 10 / 11（PowerShell） | ✅ | DSH_HOME 是 `%USERPROFILE%\.dsh`。npm 会生成 `dsh.cmd` / `dsh.ps1`，本仓库的 preset 查找识别 `PATHEXT`，`npm run dev:link` 使用目录 junction（无需管理员权限）。已在 Windows 11 + Node 24.19.0 上实机跑通全部测试。 |
| macOS（zsh） | ✅ | DSH_HOME 是 `~/.dsh`。npm 全局 `dsh` 通常是指向真实 `lib/bin.js` 的符号链接，preset 查找会先解析它。查找逻辑有 darwin 布局的单元测试，未在真机重复验证。 |
| Linux（bash/zsh） | ✅ | 与 macOS 同一套 Node 代码路径，`dev:link` 用普通目录符号链接。查找逻辑有 linux 布局的单元测试，未在真机重复验证。 |

运行要求：

- **Node.js**：`>=22`（取自 `package.json` 的 `engines`）。
- **DSH peer**：`@deepseek-ai/dsh-compaction-basic >=0.2.0-rc.2`（取自 `package.json` 的 `peerDependencies`）。该包由 DSH 自带，必须能从 profile 的 `node_modules` 解析到；本仓库不 vendor 它。
- 纯 ESM，**无构建步骤、无新增 npm 依赖**。

## 安装

1. **确认 Node 和 `dsh` 可用**（PowerShell 与 zsh 相同）：

   ```powershell
   node --version
   dsh --version
   ```

   `node` 需要 `v22` 或更高；`dsh --version` 能输出版本号（本机验证时为 `0.2.1-rc.2`）。

2. **安装 bundle**（两个平台逐字相同，不要改写命令）：

   ```powershell
   dsh plugin --profile web add "github:xingzoudefengye/dsh-compaction-local-handoff"
   ```

   这条命令把包写进 profile 的 `dependencies`，并把声明了 `dsh.bundle` 的它追加进有序的 `dsh.profile.bundles` 列表。两者缺一不可：前者让 Node 能找到模块，后者让它作为补丁层参与启动。

3. **重启该 profile 的 host**。新增模块根不在 HMR 热重载范围内：必须完全退出并重新启动运行 `dsh` 的进程（GUI 即重启应用/后台服务）。只刷新页面、只重载配置都不够。

4. 按[验证](#验证)确认它真的在跑本地后端。

**平台差异只有路径**：

- Windows：DSH_HOME 是 `%USERPROFILE%\.dsh`，profile 目录是 `$env:USERPROFILE\.dsh\profiles\web`。
- macOS / Linux：DSH_HOME 是 `~/.dsh`，profile 目录是 `~/.dsh/profiles/web`。
- `dsh plugin …` 本身没有平台差异。

### 手工安装（等价做法）

`dsh plugin add` 只是把 pnpm 和 bundle 选择一起做了。也可以手工两步（手工路径要求 `pnpm` 在 PATH；没有就先 `npm i -g pnpm`，或者直接用 `dsh plugin add`，它会用 DSH 安装自带的 pnpm）：

```powershell
# Windows PowerShell
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add "github:xingzoudefengye/dsh-compaction-local-handoff"
```

```zsh
# macOS / Linux
cd ~/.dsh/profiles/web
pnpm add "github:xingzoudefengye/dsh-compaction-local-handoff"
```

然后把包名加入该目录 `package.json` 的 `dsh.profile.bundles`：

```json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "dsh-compaction-local-handoff"
] } }
```

### 为什么 `cordis.patch.yml` 是生成出来的

压缩后端在 profile 里被挂了**两层**，只改一层不够：

1. **profile 根**——`dsh-base` 直接挂了一行 `compaction-basic`；没有自己压缩组的 preset（自定义 preset）继承它。当前随 DSH 发布的四个 preset 都有各自的压缩组。
2. **每个 agent preset 内部的隔离压缩组**——`preset-standard` / `preset-ptc` / `preset-minimal` / `preset-cordis` 各自带一个 `cordis:group`，带 `isolate: { compaction: true }`，里面又挂了一份 `compaction-basic`。**正常 GUI 会话跑在 preset 下，用的是这一份。**

第 2 层无法用普通的按 id patch 命中：preset 行的 `config.plugins` 是**数据**，交给 `@deepseek-ai/dsh-agent-preset-registry` 注册后才在 agent 自己的 scope 里挂载，而 loader 的 `applyEntryPatches` 只下钻 `group: true` 的行（preset 行不是）。

registry 的文档给了官方做法——“A new preset or an override of a shipped one is a bundle patch: an `insert` of a `@deepseek-ai/dsh-agent-preset` row, **or a patch keyed by that row's id**”。所以 `cordis.patch.yml` 由 `scripts/sync-presets.mjs` 生成：读**官方发布的 manifest 文件** `@deepseek-ai/dsh-web-app/presets/*.patch.yml`，**逐字复制**，只把那份 `compaction-basic` 换成 `compaction-local-handoff`，其余（persona、plan-mode、delegation……）保持原样。

来源必须是 manifest 文件，**不能**是 `dsh --dump-default-config`：这个 bundle 自己就是一个 bundle，等 dump 渲染出来时它自己的补丁已经生效了——读 dump 等于读本文件的输出，于是 `check:presets` 拿文件和自己比，永远失败（“no preset with a compaction group found”）。一个**永远不可能通过**的漂移守卫比没有更糟，因为它看起来像保护。

代价要说清楚：这意味着这些 preset 清单在你的 profile 里被**冻结**在生成时的那一版。harness 升级若改动了 shipped preset（新增工具、调整 prompt 段），你不会自动拿到。反向也一样：仓库里的快照是在某个具体 harness 版本上生成的（当前为 `0.2.1-rc.2`），比它旧的 harness 可能不认识快照里新增的 preset 行；`peerDependencies` 只保证压缩钩子存在，不保证 preset 行完全一致。源码检出里可以：

```powershell
npm run check:presets     # 只比较，不写文件；过期时非零退出并打印第一处差异
npm run sync:presets      # 重新生成 cordis.patch.yml
```

- `check:presets` 把生成器当前会产出的结果与仓库里的 `cordis.patch.yml` 比较（换行归一化后逐字节比较，不一致时打印第一处差异），不一致就退出 1。
- `sync:presets` 从你安装的 DSH 的 `@deepseek-ai/dsh-web-app/presets/*.patch.yml` 重新生成，因此 `check:presets` 比较的其实是“仓库快照 vs 你机器上的 harness”。
- 这两条命令只在**源码检出**里有意义。普通用户经 `dsh plugin add` 安装的是已经打好的包，不需要跑；升级 harness 后如果上游改了 preset，应更新本仓库并重新安装。

生成器对上游 YAML 形状是**硬编码**的（`- insert:` 包装 + 4 空格缩进、`- id: compaction-basic` + `name:` 两行），形状一变就抛错要求更新，不会静默生成错误的东西。

## 它替换了什么

DSH 默认的 `@deepseek-ai/dsh-compaction-basic` 在上下文到达阈值后：

1. 先用 `tool-result-pruner` 无模型地剪掉超大工具结果（剪完低于阈值就结束）；
2. 仍需压缩时，**发起一次额外的 LLM 调用**（`purpose: "compaction"`）让模型按固定 8 节结构写检查点；
3. 用这条检查点替换最老的一段历史，保留最近约 16% 逐字。

本插件把第 2 步换成纯本地拼装。**第 1、3 步以及全部触发策略保持不变**。思路来自 ComeCode 的本地交接式压缩（`engine/apps/zcode-cli/packages/core/src/compact/local-handoff.ts`），但落在 DSH 官方的扩展点 `summarize()` 上，因此**不需要修改 harness 任何源码**。

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
- **summary**：阶段性要求/约束（历史内 system 更新，保留来源，标注“不作为新授权”）；压缩区间内涉及的文件（从工具调用参数提取，最多 25 个）；**回合级史书**（装了 [dsh-session-recall](https://github.com/xingzoudefengye/dsh-session-recall) 时出现）；最近 4 次工具调用及结果（失败/成功/结果未记录）；最近一条助手进展原文摘录；未解决报错线索（最多 2 条）；上次交接摘录（非新指令）；以及“工具结果只保留预览”的收尾提示。

装了 `dsh-session-recall` 后，交接里会多一段**回合级史书**（≤2400 字符，且不超过交接预算的 40%）：它由会话日志折叠而来，所以**重复压缩也不会丢**——被上一次交接替换掉的早期回合，其结论仍然在里面。没装该 bundle 时行为与之前完全一致；史书读取失败也只会退化成没有这一段，不会让压缩失败。

各字段有独立字符预算（用户要求 1600、进展 900、单条工具 280、约束 300、旧交接 1200），总计硬上限 6,000 字符；实际预算还会被压到“被遮蔽字符数的一半减 600”（600 是给 DSH 固定 wrapper 留的余量）。凭据形态的文本（`sk-…`、`Bearer …`、`api_key=`、`password`/`secret`/`token`）会被 redact，`<thinking>` 块被剥离。

## 验证

### 1. 确认包已安装

PowerShell 与 zsh 相同：

```powershell
dsh plugin --profile web why dsh-compaction-local-handoff
```

预期输出（版本号以实际安装为准；`0.2.2` 是本源码检出的版本）：

```
dsh-compaction-local-handoff@0.2.2
└── dsh-profile-web (dependencies)

Found 1 version of dsh-compaction-local-handoff
```

注意：这只能证明**装上了**，不能证明 host 已经加载它。见下一步。

### 2. 确认运行时真的走了本地后端

在一个 `agentPreset: "standard"` 的 web 会话里执行 `/compact`，然后看压缩记录/会话日志：

```
17:53:57.134  compaction/start
17:53:57.145  compaction/summary   provider=local  model=local-handoff
              shadowedRange 8-61 · 21 nodes · 5713 tokens
              llmStreamCall=无 · rawOutput=无 · usage=无 · maxTokens=无
```

关键是 `provider=local`、`model=local-handoff`，且摘要事件**不带** `llmStreamCall` / `usage` / `maxTokens`——模型摘要路径一定会带这三者。节点数与 token 数应同界面报告的“已压缩 21 条历史记录（约 5713 tokens）”一致；这条记录 11 毫秒完成。

本仓库还验证过**根路径**：一次性 profile + 小窗口强制触发自动压缩（`compaction (step pressure)`），同样得到 `provider: "local"`、`model: "local-handoff"`，`compaction/start` → `compaction/summary` 间隔 2 毫秒。同时验证到：

- 交接里的“最新用户要求”是**真用户指令**，不是被注入的 `<system-reminder>`（技能目录 / AGENTS.md / 运行时上下文）；
- 反复压缩时上一次交接被当**数据合并**（最多一条 `上次交接携带的文件（可能已过时）`），不会层层嵌套；
- 被遮蔽区间变小时交接跟着变小，能通过后端的“必须比源内容更小”检查。

日志行本身不变：`compaction (step pressure): shadowed N surface nodes ...`。

想在隔离环境里试：`dsh plugin --profile <新 profile> add "<本仓库绝对路径>"`，再用小窗口强制触发自动压缩（做法同本仓库测试）。

### 3. 在源码检出里跑测试

```powershell
npm test
```

裸检出（尚未跑 `npm run dev:link`）会跳过 6 个 engine 测试：

```
ℹ tests 27
ℹ pass 21
ℹ fail 0
ℹ skipped 6
```

先跑一次 `npm run dev:link`（见[开发](#开发)），再跑：

```
ℹ tests 27
ℹ pass 27
ℹ fail 0
ℹ skipped 0
```

preset 快照检查：

```powershell
npm run check:presets
```

预期成功输出：

```
check:presets: 已是最新（4 个 preset 覆盖，来源 .../dsh-web-app/presets）
```

## 配置

本插件继承 `compaction-basic` 的**全部**配置项，**刻意不引入任何新键**：`resolveConfig` 会拒绝未知键（`BasicCompactionConfig: unknown key "..."`），所以配置面与上游保持一致。默认值来自 peer 的实现：

| 键 | 默认 | 作用 |
|---|---|---|
| `thresholdRatio` | `0.8` | 触发阈值比例：`floor(min(W × ratio, W − O − headroom))`。调低会更早、更频繁压缩。 |
| `retainRatio` | `0.16` | 最近这段历史逐字保留的比例；与 `retainTokens` 互斥。 |
| `retainTokens` | 未设置 | 用绝对 token 数替代 `retainRatio`；设置后比例不再生效，二者不能同时设置。 |
| `headroomTokens` | `65536` | 在窗口里额外留出的 token 余量。 |
| `compactionRetries` | `1` | 一次压缩失败后的重试次数。 |
| `maxOverflowRetries` | `1` | 上下文溢出恢复的重试次数。 |
| `auto` | `true` | `true` 注册按阈值自动压缩与溢出恢复；`false` 不自动触发，仍可手动 `/compact`。 |
| `modelPolicies` | `[]` | 按 `provider` + `model` 精确覆盖上述键的数组。 |
| `summarizationProvider` / `summarizationModel` / `maxTokens` | `""` / `""` / 等于 `headroomTokens` | 继承但本后端**不使用**：没有模型调用可路由，摘要长度由本地预算决定。 |

配置写进 profile 的用户 patch 层 `cordis.patch.yml`（Windows：`$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml`；macOS：`~/.dsh/profiles/web/cordis.patch.yml`），按 id 追加一条：

```yaml
- id: compaction-local-handoff
  config:
    thresholdRatio: 0.7
    retainRatio: 0.2
```

这条 patch 命中 **profile 根层**挂载的引擎。GUI 的 `standard` / `ptc` / `minimal` / `cordis` 会话各自在 preset 的隔离 `compaction` 组里又挂了一份（见[为什么 `cordis.patch.yml` 是生成出来的](#为什么-cordispatchyml-是生成出来的)），按 id 的根层 patch **到不了** preset 组，所以 preset 会话仍用默认值。要改 preset 层，得改生成文件里对应 preset 行 `config.plugins` 中 `compaction-local-handoff` 的 `config`（改源码检出的生成逻辑，或改 profile 里已安装副本），然后重启；harness 升级后还要重新对齐。

## 卸载

```powershell
dsh plugin --profile web remove dsh-compaction-local-handoff
```

然后重启该 profile 的 host。会发生什么：

- pnpm 移除依赖，并在同一次操作里把该包从 `dsh.profile.bundles` 中去掉；包目录和它带来的 `cordis.patch.yml` 一起消失。
- 本插件的 bundle patch 随之失效，`compaction-basic` 自动恢复，**不需要**手动改回任何 harness 文件。
- 本插件没有修改 harness 源码、没有额外状态目录，卸载后无残留。
- **留下的东西**：已写入会话日志的旧 `<compacted-summary>` 检查点仍是历史文本，不会回滚，也不影响默认后端继续压缩；如果你在 profile 的 `cordis.patch.yml` 里手写过 `- id: compaction-local-handoff` 的覆盖，要自己删掉，否则启动时会有一条 patch 未命中的警告。

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 装完 `/compact` 仍出现模型摘要（日志带 `llmStreamCall` / `usage`） | 新增模块根只在 host 启动时 import；HMR 不覆盖，刷新页面也不够 | 完全退出并重启该 profile 的 host，再试；`dsh plugin why` 只能证明已安装，不能证明已加载。 |
| 改了 `lib/*.js`，行为没变 | Node 的 ESM 模块缓存；运行中的 host 不会重新 import 已加载模块 | 重启 host。改文件时间、重开页面都不会让已加载的模块失效。 |
| `dsh plugin add` 失败（代理 / 内网 / 私有网络） | pnpm 需要访问 GitHub；失败时 `dsh` 会打印 `dsh: plugin command failed; diagnostics: <profile>/.plugin-manager/logs/.../pnpm.log` | 设置 `HTTPS_PROXY` / `HTTP_PROXY` 后重试（PowerShell：`$env:HTTPS_PROXY="..."`；zsh：`export HTTPS_PROXY=...`）；先用 `git ls-remote https://github.com/xingzoudefengye/dsh-compaction-local-handoff` 自测连通性；离线或内网可直接装本地检出：`dsh plugin --profile web add "<本地检出的绝对路径>"`。 |
| `npm run check:presets` 非零，报 `cordis.patch.yml 已过期` | 源码检出里的 preset 快照落后于你安装的 DSH（上游改了 shipped preset） | 在源码检出里 `npm run sync:presets` 重新生成，检查 diff 后重新安装；不要手改生成文件。 |
| `check:presets` 报 `找不到官方 preset 目录，试过：...` | `dsh` 不在 PATH，或安装布局超出查找范围 | 把 `dsh` 放进 PATH；或用 `node scripts/sync-presets.mjs --presets-dir <目录>` 直接指定 `@deepseek-ai/dsh-web-app/presets`。 |
| 启动报找不到 `@deepseek-ai/dsh-compaction-basic`，或版本不兼容 | 本插件 peer 要求 `>=0.2.0-rc.2`，旧 DSH 没有这个包或 `summarize()` 钩子形状不同 | `dsh --version` 确认版本；升级 DSH 后重启。只升级本插件不够。 |
| 压缩报 `summary is not smaller than the shadowed content` | 被遮蔽区间太小（约 100 token 以下），而 DSH 给每条检查点加固定 preamble（约 350 字符），后端要求检查点必须更小 | 非致命：自动路径记一条警告后继续本轮；手动 `/compact` 换更长的会话再试。与默认后端行为一致。 |
| PowerShell 里运行 `dsh` 报“禁止运行脚本” | Windows 优先解析到 `dsh.ps1`，而 ExecutionPolicy 是 `Restricted` | 改用 `dsh.cmd`，或 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 后重开终端。 |

## 相关插件

- [dsh-browser](https://github.com/xingzoudefengye/dsh-browser)
- [dsh-web-search-failover](https://github.com/xingzoudefengye/dsh-web-search-failover)
- [dsh-project-memory](https://github.com/xingzoudefengye/dsh-project-memory)
- [dsh-resume-budget](https://github.com/xingzoudefengye/dsh-resume-budget)
- [dsh-session-recall](https://github.com/xingzoudefengye/dsh-session-recall) — 可选：装上后本插件的交接里会多一段回合级史书。

## 设计说明

- **只覆写官方唯一的子类钩子。** `BasicCompactionEngine.summarize()` 是上游文档明确保留的扩展点（“Override this sole hook for a template or remote summarizer”），其余（阈值、保留、区间选择、事务、锁）都由上游负责，因此上游修 bug 时本插件自动受益。
- **不 import cordis。** 只 import `@deepseek-ai/dsh-compaction-basic`，并以 `peerDependencies` 声明。profile 里已有一份，Node 从 profile 的 `node_modules` 解析到同一实例，避免出现两份 `Service` 基类导致的服务身份问题。
- **无构建步骤。** 纯 ESM JavaScript，`pnpm add github:…` 直接可用，不触发 pnpm 的依赖构建脚本审批。
- **不修改 harness 源码。** 全部行为通过 bundle patch 与一个子类钩子实现，升级和卸载都不需要改 DSH 安装。

## 已知限制

- **交接是“有界交接”，不是“智能摘要”。** 较早的决策理由、失败过的方案、跨文件的推理不会自动保留——与 ComeCode 的取舍一致。完整原文仍在会话日志里，但 **DSH 目前没有暴露给模型的“读历史”工具**（ComeCode 有 `ReadSessionContext`），所以模型只能靠重新读文件或重跑命令来恢复细节。
- **preset 清单被冻结。** 见[为什么 `cordis.patch.yml` 是生成出来的](#为什么-cordispatchyml-是生成出来的)：harness 升级改动 shipped preset 后需要重新跑 `npm run sync:presets`。
- **极短历史下会拒绝压缩。** 后端要求检查点必须小于被遮蔽的内容，而 DSH 会给每条检查点加一段固定 preamble（约 350 字符）；被遮蔽区间小于约 100 token 时无法再压，压缩会报 `summary is not smaller than the shadowed content`。这与默认后端的行为一致，且是非致命的（自动路径记一条警告后继续本轮）。
- **窗口贴着固定前缀时会反复压缩。** 阈值是 `min(W×0.8, W−O−headroom)`，而 system prompt + 工具 schema 是不可压缩的固定前缀。如果 `W` 只比前缀大一点（例如把 512K 调到 12K 做测试），每个 step 都会越过阈值、反复触发压缩。这是上游阈值策略的固有行为，不是本插件引入的；真实窗口下不会出现。
- 单条不可分单元（一次超大工具调用）仍无法被压缩。
- 图片内容不进入交接：只保留文本块。

## 开发

```powershell
npm test            # 纯函数测试；peer 不可解析时 engine 测试自动跳过
npm run dev:link    # 把已安装 harness 的 peer 包链接进来，让 engine 测试真正跑起来
```

`npm run dev:link` 会找到 `dsh` 自带的 `@deepseek-ai/dsh-compaction-basic`，在 `node_modules/@deepseek-ai/` 下建链接（Windows 用 junction，macOS/Linux 用目录符号链接），可反复运行。需要手动指定目录时：

```powershell
node scripts/dev-link.mjs "C:\path\to\dir-containing\dsh-compaction-basic"
# 或设置 DSH_PACKAGE_DIR
```

代码结构：

- `lib/handoff.js`：纯函数模块（无依赖、无 I/O），负责所有字段裁剪与拼装。
- `lib/index.js`：只有子类化、`summarize()` 覆写与预算计算。
- `scripts/sync-presets.mjs`：从官方 preset manifest 生成 `cordis.patch.yml`。
- `scripts/dev-link.mjs`：开发期 peer 链接（跨平台）。

## 许可

[MIT](LICENSE)
