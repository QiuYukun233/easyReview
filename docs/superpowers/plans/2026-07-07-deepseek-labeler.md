# DeepSeek 作为默认标签提供商 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 ① 的 LLM 块标签加一个 DeepSeek 提供商（OpenAI 兼容、便宜）并设为默认；Claude 保留、`--provider claude` 可切。

**Architecture:** `Labeler` 接口不变。抽出共享 `prompt.ts`（LabelSchema+BASE_SYSTEM+userPrompt）与 `concurrency.ts`（mapWithConcurrency）；新增 `DeepSeekLabeler`（openai SDK 指向 DeepSeek，`response_format:json_object`，逐块弹性）；`cli.ts` 的 `resolveLabeler` 按 provider 选择工厂。无 key → null → map 照常纯确定性降级，铁律不变。

**Tech Stack:** Node 20+ / TypeScript(ESM) / vitest / `openai`（指向 DeepSeek）/ `zod` / 现有 `@anthropic-ai/sdk`。

> **基于 `feat/llm-chunk-labels` 分支**（① 的 label 基础设施在此），并入 PR #1。本分支有 `npm run typecheck`（① 已加）——改类型后跑它。
> **DeepSeek API 已核实**：base_url `https://api.deepseek.com`，OpenAI 兼容；`response_format:{type:'json_object'}`（自由 JSON，无严格 schema）；prompt 必须含 "json" 字样 + JSON 示例；默认便宜模型 `deepseek-v4-flash`；文档明说偶尔返空内容（逐块弹性兜住）。实现时以真实安装的 `openai` SDK 的 `chat.completions.create` 返回结构为准。

---

## 文件结构

| 路径 | 职责 | 动作 |
|---|---|---|
| `src/label/prompt.ts` | 共享 `LabelSchema`(zod) + `BASE_SYSTEM`(铁律框架) + `userPrompt(input)` | Create |
| `src/label/concurrency.ts` | 共享 `mapWithConcurrency`（并发池，按输入序返回） | Create |
| `src/label/claude.ts` | 改从 prompt.ts/concurrency.ts 引共享件（去重），其余不变 | Modify |
| `src/label/deepseek.ts` | `DeepSeekLabeler`(openai SDK、client 可注入、并发5、逐块弹性) + `makeDeepSeekLabelerFromEnv` | Create |
| `src/cli.ts` | `resolveLabeler` 按 provider 选择并**导出**；`parseArgs` 加 `--provider`；`MapOptions.provider` | Modify |
| `package.json` | 加 `openai` 依赖 | Modify |
| `test/deepseek-labeler.test.ts` | DeepSeekLabeler(注入 fake) + makeDeepSeekLabelerFromEnv | Create |
| `test/cli.test.ts` | 加 `resolveLabeler` provider 路由用例（env 受控，不触网） | Modify |

---

## Task 1: 抽共享 prompt.ts + concurrency.ts，重构 claude.ts

**Files:**
- Create: `src/label/prompt.ts`, `src/label/concurrency.ts`
- Modify: `src/label/claude.ts`

行为保持重构——由现有 `test/claude-labeler.test.ts` + label 测试守。先读 `src/label/claude.ts` 对齐现状。

- [ ] **Step 1: 创建 `src/label/prompt.ts`**

```ts
import { z } from 'zod';
import type { ChunkLabelInput } from '../types.js';

export const LabelSchema = z.object({
  responsibility: z.string(),
  whyNow: z.string(),
});

/** 铁律框架 + 两字段说明。两个 provider 共用；DeepSeek 在此基础上追加 JSON 指令。 */
export const BASE_SYSTEM =
  '你是代码库导览助手。给定一个已经确定好的代码块（一个文件）及其函数源码，你只为它写两句中文：\n' +
  '- responsibility：一句话说清这个块对外的职责。\n' +
  '- whyNow：一句话说清现在学它的理由（承上启下 / 架构核心 / 简单填充 等）。\n' +
  '严禁发明输入中未出现的结构、依赖或调用关系。只描述给定的内容。';

export function userPrompt(i: ChunkLabelInput): string {
  const fns = i.functions
    .map((f) => `### ${f.name}\n\`\`\`rust\n${f.source}\n\`\`\``)
    .join('\n\n');
  return (
    `块：${i.chunkName}（文件 ${i.file}，章 ${i.chapterName}）\n` +
    `风险：${i.riskBucket} · 架构贡献度：${i.contribBucket}\n` +
    `同章邻居：${i.neighbors.join('、') || '（无）'}\n\n` +
    `函数：\n${fns || '（本块无独立函数，可能是模块声明/重导出）'}`
  );
}
```

- [ ] **Step 2: 创建 `src/label/concurrency.ts`**

```ts
/** 并发池：最多 limit 个 worker 并行跑 fn，结果按输入序返回。 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < items.length) {
      const cur = idx++;
      out[cur] = await fn(items[cur]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
```

- [ ] **Step 3: 重构 `src/label/claude.ts` 用共享件（整体替换文件）**

```ts
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Labeler, ChunkLabelInput, ChunkLabel, NodeId } from '../types.js';
import { LabelSchema, BASE_SYSTEM, userPrompt } from './prompt.js';
import { mapWithConcurrency } from './concurrency.js';

/** ClaudeLabeler 只依赖 messages.parse，便于测试注入 fake client。 */
export interface MessagesParseClient {
  messages: { parse(args: unknown): Promise<{ parsed_output: ChunkLabel | null }> };
}

export class ClaudeLabeler implements Labeler {
  constructor(private client: MessagesParseClient, private model: string) {}

  async label(inputs: ChunkLabelInput[]): Promise<Record<NodeId, ChunkLabel>> {
    const results = await mapWithConcurrency(inputs, 5, async (i) => {
      // 逐块容错：单块失败只丢自己（返回 null），不让整批 label() reject。
      try {
        const resp = await this.client.messages.parse({
          model: this.model,
          max_tokens: 1024,
          system: BASE_SYSTEM,
          messages: [{ role: 'user', content: userPrompt(i) }],
          // 只约束输出格式；不传 effort（haiku-4-5 不接受 effort，会 400）
          output_config: { format: zodOutputFormat(LabelSchema) },
        });
        return { id: i.chunkId, label: resp.parsed_output };
      } catch (err) {
        console.warn(`[label] 跳过块 ${i.chunkId}：${String(err)}`);
        return { id: i.chunkId, label: null as ChunkLabel | null };
      }
    });
    const out: Record<NodeId, ChunkLabel> = {};
    for (const r of results) if (r.label) out[r.id] = r.label;
    return out;
  }
}

/** 无 ANTHROPIC_API_KEY → 返回 null（调用方据此跳过打标签，纯确定性 map 照常）。 */
export function makeClaudeLabelerFromEnv(
  model: string = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
): Labeler | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  // 双重 cast：call site 的 messages.parse({...}) 参数形状不再被编译器对照真实 SDK 校验（人工核对保证）。
  return new ClaudeLabeler(new Anthropic() as unknown as MessagesParseClient, model);
}
```

- [ ] **Step 4: 跑现有测试回归**

Run: `npx vitest run test/claude-labeler.test.ts test/label.test.ts test/cli.test.ts`
Expected: PASS（userPrompt/BASE_SYSTEM 与旧 SYSTEM 逐字相同、行为不变；claude-labeler 用例断言 SENTINEL/model/无 effort/null-drop 仍成立）。再 `npm run typecheck` 干净、全量 `npx vitest run` 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/label/prompt.ts src/label/concurrency.ts src/label/claude.ts
git commit -m "refactor(label): 抽共享 prompt.ts + concurrency.ts（claude 复用，为 deepseek 铺路）"
```

---

## Task 2: DeepSeekLabeler（openai SDK 指向 DeepSeek）

**Files:**
- Create: `src/label/deepseek.ts`
- Modify: `package.json`（加 openai）
- Test: `test/deepseek-labeler.test.ts`

- [ ] **Step 1: 装依赖**

Run: `npm install openai`
Expected: `package.json` dependencies 出现 `openai`。

- [ ] **Step 2: 写失败测试 `test/deepseek-labeler.test.ts`**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DeepSeekLabeler, makeDeepSeekLabelerFromEnv } from '../src/label/deepseek.js';
import type { ChunkLabelInput } from '../src/types.js';

const mkInput = (id: string, src: string): ChunkLabelInput => ({
  chunkId: id, chunkName: id, file: id, chapterName: 'c',
  riskBucket: 'low', contribBucket: 'filler',
  functions: [{ name: 'f', source: src }], neighbors: [], contentHash: 'h',
});

describe('DeepSeekLabeler', () => {
  it('calls chat.completions.create per chunk with json_object mode + json prompt, maps parsed labels', async () => {
    const create = vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify({ responsibility: 'R', whyNow: 'W' }) } }] }));
    const labeler = new DeepSeekLabeler({ chat: { completions: { create } } } as any, 'deepseek-v4-flash');
    const out = await labeler.label([mkInput('a.rs', 'fn f(){ SENTINEL }')]);
    expect(create).toHaveBeenCalledTimes(1);
    const args = create.mock.calls[0][0] as any;
    expect(args.model).toBe('deepseek-v4-flash');
    expect(args.response_format).toEqual({ type: 'json_object' });
    const promptText = args.messages.map((m: any) => m.content).join('\n');
    expect(promptText).toContain('SENTINEL');           // 源码进了 prompt
    expect(promptText.toLowerCase()).toContain('json');  // DeepSeek 硬性要求
    expect(promptText).toContain('responsibility');      // 示例键
    expect(out['a.rs']).toEqual({ responsibility: 'R', whyNow: 'W' });
  });

  it('drops a chunk on empty content / bad json / missing field (per-chunk resilience)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies: (string | null)[] = [
      null,                                    // 空内容
      'not json',                              // 坏 JSON
      JSON.stringify({ responsibility: 'x' }), // 缺 whyNow
    ];
    let n = 0;
    const create = vi.fn(async () => ({ choices: [{ message: { content: bodies[n++] } }] }));
    const labeler = new DeepSeekLabeler({ chat: { completions: { create } } } as any, 'deepseek-v4-flash');
    const out = await labeler.label([mkInput('a.rs', 'x'), mkInput('b.rs', 'y'), mkInput('c.rs', 'z')]);
    expect(out).toEqual({});               // 三块全被丢
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

describe('makeDeepSeekLabelerFromEnv', () => {
  const saved = process.env.DEEPSEEK_API_KEY;
  afterEach(() => { if (saved === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = saved; });

  it('returns null without DEEPSEEK_API_KEY', () => {
    delete process.env.DEEPSEEK_API_KEY;
    expect(makeDeepSeekLabelerFromEnv()).toBeNull();
  });

  it('returns a labeler when DEEPSEEK_API_KEY is set (no network on construct)', () => {
    process.env.DEEPSEEK_API_KEY = 'dummy';
    expect(makeDeepSeekLabelerFromEnv()).not.toBeNull();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run test/deepseek-labeler.test.ts`
Expected: FAIL — `src/label/deepseek.js` 不存在。

- [ ] **Step 4: 实现 `src/label/deepseek.ts`**

```ts
import OpenAI from 'openai';
import type { Labeler, ChunkLabelInput, ChunkLabel, NodeId } from '../types.js';
import { LabelSchema, BASE_SYSTEM, userPrompt } from './prompt.js';
import { mapWithConcurrency } from './concurrency.js';

/** DeepSeek 是 OpenAI 兼容；只依赖 chat.completions.create，便于测试注入 fake client。 */
export interface ChatCompletionsClient {
  chat: {
    completions: {
      create(args: unknown): Promise<{ choices: { message: { content: string | null } }[] }>;
    };
  };
}

// DeepSeek 要求 prompt 含 "json" 字样 + 示例，否则可能不返 JSON。
const DEEPSEEK_SYSTEM =
  BASE_SYSTEM +
  '\n\n请用 json 输出，且只输出 json，格式示例：{"responsibility": "一句话职责", "whyNow": "为什么现在学它"}';

export class DeepSeekLabeler implements Labeler {
  constructor(private client: ChatCompletionsClient, private model: string) {}

  async label(inputs: ChunkLabelInput[]): Promise<Record<NodeId, ChunkLabel>> {
    const results = await mapWithConcurrency(inputs, 5, async (i) => {
      // 逐块容错：网络错 / 空内容 / 坏 JSON / 缺字段 → 只丢自己（返回 null）。
      try {
        const resp = await this.client.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: DEEPSEEK_SYSTEM },
            { role: 'user', content: userPrompt(i) },
          ],
          response_format: { type: 'json_object' },
          max_tokens: 1024,
        });
        const content = resp.choices[0]?.message?.content;
        if (!content) throw new Error('空内容');
        const parsed = LabelSchema.safeParse(JSON.parse(content));
        if (!parsed.success) throw new Error('JSON 不符合 LabelSchema');
        return { id: i.chunkId, label: parsed.data as ChunkLabel };
      } catch (err) {
        console.warn(`[label] 跳过块 ${i.chunkId}：${String(err)}`);
        return { id: i.chunkId, label: null as ChunkLabel | null };
      }
    });
    const out: Record<NodeId, ChunkLabel> = {};
    for (const r of results) if (r.label) out[r.id] = r.label;
    return out;
  }
}

/** 无 DEEPSEEK_API_KEY → 返回 null（调用方据此跳过打标签，纯确定性 map 照常）。 */
export function makeDeepSeekLabelerFromEnv(
  model: string = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
): Labeler | null {
  if (!process.env.DEEPSEEK_API_KEY) return null;
  const client = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
  return new DeepSeekLabeler(client as unknown as ChatCompletionsClient, model);
}
```

> 实现者注意：以真实安装的 `openai` SDK 为准。`chat.completions.create` 的返回是 `{ choices: [{ message: { content } }], ... }`；`response_format`/`max_tokens` 是标准参数。若 `new OpenAI(...)` 的构造入参名不同（如 `baseURL` 拼写），以真实类型为准，但功能不变（apiKey + DeepSeek base_url）。构造 client 不触网，只有 `.create()` 才发请求。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/deepseek-labeler.test.ts`
Expected: PASS（4 tests）。`npm run typecheck` 干净。

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json src/label/deepseek.ts test/deepseek-labeler.test.ts
git commit -m "feat(label): DeepSeekLabeler（openai SDK 指向 DeepSeek，json_object + 逐块弹性）"
```

---

## Task 3: cli.ts 按 provider 选择（默认 deepseek）

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts`

先读 `src/cli.ts` 对齐现状（有 `MapOptions`、私有 `resolveLabeler`、`parseArgs`）。

- [ ] **Step 1: 扩展 `test/cli.test.ts`（先写、确认失败）**

文件顶部 import 追加 `resolveLabeler`（Task 3 将从 cli.ts 导出）与类型：
```ts
import { runMap, resolveLabeler } from '../src/cli.js';
import type { Labeler } from '../src/types.js';
```
（若已 import `runMap`，改成合并导入；`afterEach` 清理沿用现有。）在文件末尾新增一个 describe（现有 runMap 用例不动）：

```ts
describe('resolveLabeler provider routing', () => {
  const savedD = process.env.DEEPSEEK_API_KEY;
  const savedA = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (savedD === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = savedD;
    if (savedA === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedA;
  });

  it('noLabel wins over everything', () => {
    expect(resolveLabeler({ repo: '', outDir: '', noLabel: true })).toBeNull();
  });

  it('an injected labeler wins over provider', () => {
    const fake: Labeler = { label: async () => ({}) };
    expect(resolveLabeler({ repo: '', outDir: '', labeler: fake })).toBe(fake);
  });

  it('defaults to deepseek: uses DEEPSEEK_API_KEY; provider=claude ignores it', () => {
    process.env.DEEPSEEK_API_KEY = 'dummy';
    delete process.env.ANTHROPIC_API_KEY;
    expect(resolveLabeler({ repo: '', outDir: '' })).not.toBeNull();               // 默认 deepseek，有 key
    expect(resolveLabeler({ repo: '', outDir: '', provider: 'claude' })).toBeNull(); // claude，无 ANTHROPIC key
  });

  it('provider=claude uses ANTHROPIC_API_KEY; default deepseek ignores it', () => {
    delete process.env.DEEPSEEK_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'dummy';
    expect(resolveLabeler({ repo: '', outDir: '', provider: 'claude' })).not.toBeNull();
    expect(resolveLabeler({ repo: '', outDir: '' })).toBeNull(); // 默认 deepseek，无 DEEPSEEK key
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — `resolveLabeler` 未从 cli.ts 导出 / 不认 `provider`。现有 runMap 用例仍通过。

- [ ] **Step 3: 改 `src/cli.ts`**

(a) import 区加：
```ts
import { makeDeepSeekLabelerFromEnv } from './label/deepseek.js';
```
(b) `MapOptions` 加字段（并更新 model 注释）：
```ts
export interface MapOptions {
  repo: string;
  outDir: string;
  labeler?: Labeler | null; // 测试注入 fake；显式 null = 不打标签；缺省 = 按 provider+env 决定
  noLabel?: boolean;        // --no-label：即使有 key 也跳过
  model?: string;           // --model：覆盖默认模型（deepseek-v4-flash / claude-haiku-4-5）
  provider?: 'deepseek' | 'claude'; // --provider：默认 deepseek
}
```
(c) 把 `resolveLabeler` 改为**导出** + 按 provider 选择：
```ts
export function resolveLabeler(opts: MapOptions): Labeler | null {
  if (opts.noLabel) return null;
  if (opts.labeler !== undefined) return opts.labeler; // 显式注入（含 null）优先
  const provider = opts.provider ?? 'deepseek';
  return provider === 'claude'
    ? makeClaudeLabelerFromEnv(opts.model)
    : makeDeepSeekLabelerFromEnv(opts.model);
}
```
(d) `parseArgs` 加 provider 解析（非 'claude' 一律 deepseek）：
```ts
  return {
    repo: get('--repo', process.cwd()),
    outDir: get('--out', process.cwd()),
    noLabel: argv.includes('--no-label'),
    model: get('--model', '') || undefined,
    provider: get('--provider', 'deepseek') === 'claude' ? 'claude' : 'deepseek',
  };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS（现有 runMap 用例 + 4 个 resolveLabeler 路由用例）。

- [ ] **Step 5: 全量 + typecheck**

Run: `npx vitest run` — 全绿。
Run: `npm run typecheck` — 干净。

- [ ] **Step 6: 提交**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat(cli): 标签 provider 可选（--provider，默认 deepseek）；resolveLabeler 导出可测"
```

---

## Task 4（可选，手动）：真实 DeepSeek observe 冒烟

**Files:** 无代码改动——需用户提供 `DEEPSEEK_API_KEY`（环境变量，勿明文贴）。

- [ ] **Step 1: 设 key（环境变量）**

由用户在自己 shell 里 `export DEEPSEEK_API_KEY=...`（或用 `!` 前缀在会话里跑），**不要把明文写进任何文件/提交**。

- [ ] **Step 2: 跑 map（默认 deepseek，会真调 deepseek-v4-flash 打 68 块）**

Run: `npm run map -- --repo D:/dev/umwelt-bevy --out .`
Expected: 生成 `easyreview.labels.json` 非空；`npm run learn -- --out .` 后打开 `easyreview.journey.md` 肉眼评"职责/为什么现在学它"质量、确认没发明输入外结构。第二次跑 map 因 hash 缓存几乎不再调 API。若个别块因 DeepSeek 返空被跳过（warn），属正常弹性。

---

## 收尾

- [ ] 全量 `npx vitest run` 全绿、`npm run typecheck` 干净。
- [ ] 更新 ① 的文档措辞（同一分支）：`docs/HANDOFF.md` 的 `①b` 段与代码地图、`docs/superpowers/specs/2026-07-06-llm-chunk-labels.md`、`docs/superpowers/plans/2026-07-06-llm-chunk-labels.md` 里"默认 haiku / ANTHROPIC_API_KEY"改为"默认 deepseek-v4-flash（DEEPSEEK_API_KEY；`--provider claude` 可切回 haiku）"，代码地图加 `label/prompt.ts`、`label/concurrency.ts`、`label/deepseek.ts` 三行。单独提交：`docs: 同步 DeepSeek 默认 provider`。
