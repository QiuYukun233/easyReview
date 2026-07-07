# 设计：计划②-LLM 块标签（增强层）

> 日期：2026-07-06 · 主题：把学习卡片里静态的"块职责/为什么现在学它"换成 LLM 生成的块标签。
>
> **2026-07-07 更新**：默认 provider 已由本文的"Claude（默认 haiku / ANTHROPIC_API_KEY）"改为 **deepseek-v4-flash（DEEPSEEK_API_KEY；`--provider claude` 可切回 haiku）**，见 `2026-07-07-deepseek-labeler.md`。下文保留原始设计不改。

## 目标与铁律

当前学习卡片的"为什么现在学它"是 `render/journey-md.ts` 里的静态 `whyNow(grade)` 文案（四选一）。本计划用 LLM 为每个块生成两句人话——**职责**与**学习钩子**——替换/补充这段静态文案。

**铁律不变**：LLM 只贴标签、不发明结构。所有结构（章/块/叶、风险×贡献度档位、觅食邻居）仍全部来自确定性信号（git 历史、tree-sitter、四轴分级）。LLM 拿到的是既有块的确定性事实，只被要求为它写两句话。**LLM 标签永远是可选增强**：没有 API key、离线、或调用失败时，整个引擎照常纯确定性运行，卡片回退到现有静态文案。

## 数据契约（`src/types.ts` 新增）

```ts
export interface ChunkLabelInput {
  chunkId: NodeId;
  chunkName: string;
  file: string;
  chapterName: string;
  riskBucket: RiskBucket;
  contribBucket: ContribBucket;
  functions: { name: string; source: string }[]; // 该块每个函数的源码片段
  neighbors: string[];                            // 同章其它块的名字
  contentHash: string;                            // sha256(函数源码拼接) —— 缓存键
}

export interface ChunkLabel {
  responsibility: string; // 一句话职责
  whyNow: string;         // 为什么现在学它
}

export interface LabelCacheEntry extends ChunkLabel { contentHash: string; }
export interface LabelCache {
  version: 1;
  entries: Record<NodeId, LabelCacheEntry>;
}
```

## Labeler 接口（可注入，测试打桩）

```ts
export interface Labeler {
  label(inputs: ChunkLabelInput[]): Promise<Record<NodeId, ChunkLabel>>;
}
```

- **`ClaudeLabeler`**（`src/label/claude.ts`）：用 `@anthropic-ai/sdk` 的 `client.messages.parse()` + `zodOutputFormat`（`@anthropic-ai/sdk/helpers/zod`）产出结构化 `ChunkLabel`。
  - **每块一次 parse 调用**，并发池上限 ~5（不是一次塞多块——保证 schema 可靠、prompt 简单、失败隔离到单块）。
  - `output_config.effort: 'low'`。
  - 模型可配：`--model` 标志或 `ANTHROPIC_MODEL` 环境变量；**默认 `claude-haiku-4-5`**（68 块批量、便宜）。想要更高质量可切 `claude-opus-4-8`。
  - 认证：`new Anthropic()`（读 `ANTHROPIC_API_KEY`）。
  - 系统提示钉死铁律："你只为一个已给定的代码块写职责与学习钩子，不得发明未在输入中出现的结构、依赖或调用关系。"
- **`FakeLabeler`**（测试用）：确定性返回，不打真实 API。所有单测/CLI 测试注入它。
- 真实 Claude 只在手动 observe 冒烟里跑一次（真实 `D:\dev\umwelt-bevy` 上，肉眼看标签质量）。

## 缓存复用逻辑（`src/label/cache.ts`）

- 为每个块算 `contentHash = sha256(该块所有函数源码按 leafId 序拼接)`（用 `node:crypto`，确定性，不用 `Date`/`random`）。
- 读现有 `easyreview.labels.json`（缺失当空 `{version:1, entries:{}}`）。
- 筛出**缓存缺失、或 `contentHash` 与缓存不符**的块 → 只把这些块交给 Labeler（增量：改一个文件不必重刷全部 68 块）。
- 合并新旧 → 写回缓存。未变的块直接复用旧标签。

纯函数拆分，便于测试：
- `computeContentHash(functions): string`
- `selectStale(inputs, cache): ChunkLabelInput[]` —— 返回需要重新打标签的输入子集。
- `mergeLabels(cache, inputs, fresh): LabelCache` —— 把新标签按 chunkId+hash 合并进缓存。

## map 接线（`src/label/label.ts` + `src/cli.ts`）

`runMap` 在 grade 完成、写 tree.json 之后：

1. 从 `GradedTree` + 读源文件收集 `ChunkLabelInput[]`（函数源码从 leaf 的 `file:startLine-endLine` 切）。
2. `const stale = selectStale(inputs, cache)`。
3. 若 `stale` 非空且应调 LLM：`fresh = await labeler.label(stale)`；否则 `fresh = {}`。
4. `cache = mergeLabels(cache, inputs, fresh)`；写 `easyreview.labels.json`。

**降级规则（map 绝不因 LLM 失败而失败）**：
- `ANTHROPIC_API_KEY` 缺失 → 根本不构造 `ClaudeLabeler`，跳过打标签（`fresh = {}`），保留旧缓存。
- 传入 `--no-label` → 即使有 key 也强制跳过（要纯确定性快跑时用）。
- Labeler 抛错 → `catch` 后 `console.warn` 一行说明，跳过、保留旧缓存。
- **无论如何 map 始终产出 `easyreview.tree.json` + `easyreview.map.md`。** LLM 是纯增强。

`runMap` 接受可选注入的 `labeler?: Labeler`（测试传 FakeLabeler；生产缺省时内部按上面规则决定是否 new `ClaudeLabeler`）。

## 卡片渲染（`src/render/journey-md.ts` 改）

- `renderJourneyMarkdown(g, path, progress, labels?)` 多收一个可选 `labels?: LabelCache`。
- 当前"下一步"块若在 `labels.entries` 里有标签：
  - 新增一行 `- 职责：{responsibility}`（在"为什么现在学它"上方）。
  - "为什么现在学它"用 `label.whyNow`。
- 若无标签（离线/未生成/被 `--no-label` 跳过）：完全照现在——静态 `whyNow(grade)`，不加职责行。
- `src/cli-learn.ts` 的 `rerender` 读 `easyreview.labels.json`（缺失当空）传入 `renderJourneyMarkdown`。

**纯增量**：旧行为是默认兜底，有标签才叠加。

## 测试（TDD，沿用项目纪律）

- `test/label-cache.test.ts`：`computeContentHash` 确定性；`selectStale` 只挑缺失/变更块；`mergeLabels` 正确合并。
- `test/label.test.ts`：注入 `FakeLabeler`，验证 map 打标签流程——增量筛选 + 合并写盘；无 key 时降级不抛、仍写出 tree/map；`--no-label` 跳过。
- `test/journey-md.test.ts`（扩展）：有标签走 LLM 文案 + 职责行；无标签回退静态。断言两条路径。
- `test/cli.test.ts`（扩展）：map 注入 FakeLabeler，断言 `easyreview.labels.json` 落盘且内容正确。
- observe 冒烟（手动，不入自动测试）：真实 Claude 在 umwelt-bevy 上跑一次，肉眼评标签质量。

## 生成物与依赖

- `.gitignore` 加 `easyreview.labels.json`（跟其它生成物一致）。
- 新增依赖：`@anthropic-ai/sdk`、`zod`。

## 非目标（YAGNI）

- 不做一次调用塞多块的批量优化（每块一调 + 并发池 + hash 缓存已够；真慢再说）。
- 不让 LLM 产出 label 短标题或依赖关系（依赖仍靠确定性 coupling 信号）。
- 不动地图渲染（本计划只增强学习卡片）。
