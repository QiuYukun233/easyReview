# 设计：DeepSeek 作为默认标签提供商

> 日期：2026-07-07 · 主题：给 ① 的 LLM 块标签加一个 DeepSeek 提供商（OpenAI 兼容、便宜），设为默认；Claude 保留、可切。基于 `feat/llm-chunk-labels` 分支、并入 PR #1。

## 背景

① 把标签生成抽成了可注入的 `Labeler` 接口，目前只有 `ClaudeLabeler`（Anthropic SDK、`messages.parse`、默认 `claude-haiku-4-5`）。用户希望项目改用 **DeepSeek**（便宜、性能够用）。DeepSeek **不是 Anthropic 兼容，是 OpenAI 兼容**：base_url `https://api.deepseek.com`，`Authorization: Bearer $DEEPSEEK_API_KEY`，`chat/completions` 端点，只有自由 JSON 模式（`response_format:{type:'json_object'}`，无严格 schema），且 prompt 必须含 "json" 字样 + JSON 示例；文档明说偶尔返回空内容。

本计划新增 `DeepSeekLabeler`（用 `openai` SDK 指向 DeepSeek）并设为默认 provider；`ClaudeLabeler` 保留，可用 `--provider claude` 切回。铁律不变：LLM 只贴标签、不发明结构；无 key/失败 → map 照常纯确定性降级。

## 架构

`Labeler` 接口不变（`label(inputs): Promise<Record<NodeId, ChunkLabel>>`）。新增一个 DeepSeek 实现 + 共享 prompt 模块；`cli.ts` 的 labeler 解析改为按 provider 选择。

### 文件

| 路径 | 职责 | 动作 |
|---|---|---|
| `src/label/prompt.ts` | 共享 `LabelSchema`（zod）+ `userPrompt(input)`（块事实+函数源码，两 provider 通用）——从 `claude.ts` 抽出 | Create |
| `src/label/deepseek.ts` | `DeepSeekLabeler`（openai SDK、client 可注入、并发5、逐块弹性）+ `makeDeepSeekLabelerFromEnv(model?)` | Create |
| `src/label/claude.ts` | 改从 `prompt.ts` 引 `LabelSchema`/`userPrompt`（去重），其余不变 | Modify |
| `src/cli.ts` | `resolveLabeler` 支持 provider 选择；`parseArgs` 加 `--provider` | Modify |
| `package.json` | 加 `openai` 依赖 | Modify |
| `test/deepseek-labeler.test.ts` | DeepSeekLabeler 注入 fake chat client | Create |
| `test/cli.test.ts` | 扩展 provider 解析断言（保留现有用例） | Modify |

## DeepSeekLabeler

- 构造：`new OpenAI({ apiKey, baseURL: 'https://api.deepseek.com' })`——但 class 只依赖一个最小的 chat-completions 接口（`{ chat: { completions: { create(args): Promise<{ choices: {message:{content:string|null}}[] }> } } }`），便于测试注入 fake，不打真实 API。
- `label(inputs)`：每块一次 `chat.completions.create`，并发池上限 5（复用 ① 的 `mapWithConcurrency` 语义），参数：
  - `model`（默认 `deepseek-v4-flash`，可配）
  - `messages: [{role:'system', content: DEEPSEEK_SYSTEM}, {role:'user', content: userPrompt(input)}]`
  - `response_format: { type: 'json_object' }`
  - `max_tokens: 1024`（防截断）
- `DEEPSEEK_SYSTEM` = 共享铁律框架 + JSON 指令：明确"**用 json 输出**"，并给示例 `{"responsibility": "一句话职责", "whyNow": "为什么现在学它"}`（DeepSeek 硬性要求 prompt 含 "json" 字样 + 示例，否则可能不返 JSON）。铁律句照旧："严禁发明输入中未出现的结构、依赖或调用关系。"
- 解析：取 `choices[0]?.message?.content`；空 → 丢该块；否则 `JSON.parse` → `LabelSchema.safeParse`（zod）；校验不过 → 丢该块。
- **逐块弹性**（复用 ①）：每块的调用+解析包在 try/catch，失败（网络错 / 空内容 / 坏 JSON / 缺字段）→ `console.warn(\`[label] 跳过块 ${chunkId}：…\`)` + 返回 `{ id, label: null }`，被上层 `if (r.label)` 过滤丢掉。单块失败不拖垮整批。
- `makeDeepSeekLabelerFromEnv(model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash')`：无 `DEEPSEEK_API_KEY` → 返回 null；否则 `new DeepSeekLabeler(new OpenAI({apiKey, baseURL}), model)`。

> 实现注意：以真实安装的 `openai` SDK 为准（`chat.completions.create` 的返回结构、`response_format` 字段）。DeepSeek 是 OpenAI 兼容，标准 openai node SDK 直接可用。

## 共享 prompt 模块（`src/label/prompt.ts`）

从 `claude.ts` 抽出、两 provider 复用：
- `LabelSchema = z.object({ responsibility: z.string(), whyNow: z.string() })`
- `userPrompt(i: ChunkLabelInput): string`——块名/文件/章 + 风险/贡献度档 + 邻居 + 每个函数的源码（```rust 围栏）。**两 provider 的 userPrompt 完全相同**；差异只在各自的 SYSTEM（Claude 用 `messages.parse`+`output_config.format` 约束输出，DeepSeek 用 json_object + prompt 里的 json 指令/示例）。
- `claude.ts` 改为 import 这两个，删掉自己的重复定义；`ClaudeLabeler` 其余不变。

## provider 解析（`src/cli.ts`）

```
resolveLabeler(opts):
  if opts.noLabel → null
  if opts.labeler !== undefined → return opts.labeler   // 测试注入优先（含显式 null）
  provider = opts.provider ?? 'deepseek'                 // 默认 deepseek
  provider === 'claude'   → makeClaudeLabelerFromEnv(opts.model)     // 无 ANTHROPIC_API_KEY → null
  provider === 'deepseek' → makeDeepSeekLabelerFromEnv(opts.model)   // 无 DEEPSEEK_API_KEY → null
```
- `MapOptions` 加 `provider?: 'deepseek' | 'claude'`。
- `parseArgs` 加 `--provider`（值 deepseek/claude，默认 deepseek）。`--model` 沿用，按 provider 传给对应工厂（缺省则各自默认）。
- 降级不变：拿不到对应 key → labeler 为 null → map 仍产出 tree/map + 空 labels.json。

## 测试（TDD）

- `test/deepseek-labeler.test.ts`：注入 fake chat client，断言——每块一次调用；`response_format` 为 `{type:'json_object'}`；model 正确；prompt（system+user 合起来）含函数源码 + "json" 字样 + 示例键；正常 JSON 内容 → 解析+zod 校验出 `{responsibility, whyNow}`；**空内容 / 坏 JSON / 缺字段**三种 → 该块不在输出里、`console.warn` 被调（逐块弹性）。
- `test/cli.test.ts`（扩展，保留现有 FakeLabeler 注入用例）：断言默认 provider = deepseek 的解析路径（可注入 labeler 或对 `make*FromEnv` 无 key→null 行为断言，不打真实 API）；`--provider claude` 走 Claude 工厂。
- `test/label.test.ts` / `test/journey-md.test.ts` / `test/label-cache.test.ts`：接口未变，继续绿。
- 真实 DeepSeek observe 冒烟（手动，不入自动测试）：用户提供新 `DEEPSEEK_API_KEY`（环境变量，不明文贴）后 `npm run map` 跑一次，肉眼评标签质量。

## 分支/PR

- 本计划基于 `feat/llm-chunk-labels`（① 的 label 基础设施在此），提交叠在 ① 上，**PR #1 自动更新**为"LLM 标签（默认 DeepSeek，Claude 可切）"。
- 顺带更新 ① 的 HANDOFF/spec/plan 里"默认 haiku"的措辞为"默认 deepseek-v4-flash（Claude 可切）"。

## 非目标（YAGNI）

- 不做多块批量（仍每块一调 + 并发5 + 内容 hash 缓存）。
- 不做 provider 自动探测（显式 `--provider`，默认 deepseek）。
- 不接 OpenAI 本体或其它第三方。
- 不改 map/learn/journey 的确定性部分与卡片渲染（DeepSeek 只是换了标签来源）。

## 产物/依赖

- 加 `openai` 依赖。
- 无新增 gitignore（`easyreview.labels.json` 已忽略）。
