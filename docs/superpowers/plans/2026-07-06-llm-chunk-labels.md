# LLM 块标签（增强层）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把学习卡片里静态的"块职责/为什么现在学它"换成 LLM 为每个块生成的两句人话，且永远是可选增强——无 key/离线/失败时静默回退现有静态文案，map 依旧纯确定性可跑。

**Architecture:** map 阶段收集每个块的确定性事实 + 函数源码，按"块 id + 内容 hash"增量调用一个可注入的 `Labeler` 接口（生产用 `ClaudeLabeler`，测试用 `FakeLabeler`），结果写 `easyreview.labels.json` 缓存；learn/done 只读缓存喂给卡片渲染。LLM 只贴标签、不发明结构。

**Tech Stack:** Node 20+ / TypeScript(ESM) / vitest / `@anthropic-ai/sdk`（`messages.parse()` + `zodOutputFormat`）/ `zod` / `node:crypto`。

> **重要模型约束**：默认模型 `claude-haiku-4-5` **不接受 `effort` 参数（会 400）**，所以 `ClaudeLabeler` 绝不传 `output_config.effort`——只传 `output_config.format`。这与 spec 里"effort:'low'"的设想冲突，以本计划为准。

---

## 文件结构

| 路径 | 职责 | 动作 |
|---|---|---|
| `src/types.ts` | 新增标签相关类型 + `Labeler` 接口 | Modify |
| `src/label/cache.ts` | 内容 hash、增量筛选、合并、读写缓存（纯函数 + IO） | Create |
| `src/label/label.ts` | 从 GradedTree 收集 `ChunkLabelInput[]`；`labelChunks` 编排（增量+降级） | Create |
| `src/label/claude.ts` | `ClaudeLabeler`（真实 SDK，client 可注入）+ `makeClaudeLabelerFromEnv` | Create |
| `src/cli.ts` | `runMap` 接线打标签、`--no-label`、`--model`；无 key 降级 | Modify |
| `src/render/journey-md.ts` | 卡片可选叠加"职责"行 + 用 LLM 的 whyNow | Modify |
| `src/cli-learn.ts` | `rerender` 读 labels.json 传入渲染 | Modify |
| `.gitignore` | 忽略 `easyreview.labels.json` | Modify |
| `package.json` | 加 `@anthropic-ai/sdk`、`zod` 依赖 | Modify |
| `test/label-cache.test.ts` | cache 纯函数单测 | Create |
| `test/label.test.ts` | collectLabelInputs + labelChunks（注入 FakeLabeler、降级） | Create |
| `test/claude-labeler.test.ts` | ClaudeLabeler 注入 fake client | Create |
| `test/journey-md.test.ts` | 卡片有/无标签两条路径 | Create |
| `test/cli.test.ts` | map 注入 FakeLabeler，断言 labels.json 落盘 | Modify |

---

## Task 1: 标签类型 + Labeler 接口

**Files:**
- Modify: `src/types.ts`（在文件末尾追加）
- Test: `test/label-types.test.ts`（Create）

- [ ] **Step 1: 写失败测试**

Create `test/label-types.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { ChunkLabelInput, ChunkLabel, LabelCache, Labeler } from '../src/types.js';

describe('label types', () => {
  it('shapes compile and hold expected fields', () => {
    const label: ChunkLabel = { responsibility: 'r', whyNow: 'w' };
    const input: ChunkLabelInput = {
      chunkId: 'a.rs', chunkName: 'a', file: 'a.rs', chapterName: 'crate::',
      riskBucket: 'low', contribBucket: 'filler',
      functions: [{ name: 'f', source: 'fn f() {}' }], neighbors: ['b'], contentHash: 'h',
    };
    const cache: LabelCache = { version: 1, entries: { 'a.rs': { ...label, contentHash: 'h' } } };
    const fake: Labeler = { label: async () => ({ 'a.rs': label }) };
    expect(input.functions[0].name).toBe('f');
    expect(cache.entries['a.rs'].contentHash).toBe('h');
    expect(typeof fake.label).toBe('function');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/label-types.test.ts`
Expected: FAIL — `ChunkLabelInput`/`ChunkLabel`/`LabelCache`/`Labeler` 未导出（类型错误 / collect 失败）。

- [ ] **Step 3: 在 `src/types.ts` 末尾追加类型**

```ts

// ── 计划②-LLM 块标签 ──
export interface ChunkLabelInput {
  chunkId: NodeId;
  chunkName: string;
  file: string;
  chapterName: string;
  riskBucket: RiskBucket;
  contribBucket: ContribBucket;
  functions: { name: string; source: string }[];
  neighbors: string[];       // 同章其它块的名字
  contentHash: string;       // sha256(函数源码拼接)
}

export interface ChunkLabel {
  responsibility: string;    // 一句话职责
  whyNow: string;            // 为什么现在学它
}

export interface LabelCacheEntry extends ChunkLabel {
  contentHash: string;
}

export interface LabelCache {
  version: 1;
  entries: Record<NodeId, LabelCacheEntry>;
}

export interface Labeler {
  label(inputs: ChunkLabelInput[]): Promise<Record<NodeId, ChunkLabel>>;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/label-types.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/types.ts test/label-types.test.ts
git commit -m "feat(types): LLM 块标签类型 + Labeler 接口"
```

---

## Task 2: 标签缓存（hash / 增量筛选 / 合并 / 读写）

**Files:**
- Create: `src/label/cache.ts`
- Test: `test/label-cache.test.ts`（Create）

- [ ] **Step 1: 写失败测试**

Create `test/label-cache.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeContentHash, selectStale, mergeLabels, loadLabelCache, saveLabelCache,
} from '../src/label/cache.js';
import type { ChunkLabelInput, LabelCache } from '../src/types.js';

const mkInput = (id: string, hash: string): ChunkLabelInput => ({
  chunkId: id, chunkName: id, file: id, chapterName: 'c',
  riskBucket: 'low', contribBucket: 'filler',
  functions: [{ name: 'f', source: 'fn f() {}' }], neighbors: [], contentHash: hash,
});

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

describe('label cache', () => {
  it('computeContentHash is deterministic and sensitive to source', () => {
    const a = computeContentHash([{ name: 'f', source: 'x' }]);
    const b = computeContentHash([{ name: 'f', source: 'x' }]);
    const c = computeContentHash([{ name: 'f', source: 'y' }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('selectStale returns missing or hash-changed inputs only', () => {
    const cache: LabelCache = { version: 1, entries: {
      'same.rs': { responsibility: 'r', whyNow: 'w', contentHash: 'H1' },
      'changed.rs': { responsibility: 'r', whyNow: 'w', contentHash: 'OLD' },
    } };
    const inputs = [mkInput('same.rs', 'H1'), mkInput('changed.rs', 'H2'), mkInput('new.rs', 'H3')];
    const stale = selectStale(inputs, cache).map((i) => i.chunkId).sort();
    expect(stale).toEqual(['changed.rs', 'new.rs']);
  });

  it('mergeLabels writes fresh labels with their input hash, keeps others', () => {
    const cache: LabelCache = { version: 1, entries: {
      'keep.rs': { responsibility: 'old', whyNow: 'old', contentHash: 'K' },
    } };
    const inputs = [mkInput('keep.rs', 'K'), mkInput('fresh.rs', 'F')];
    const merged = mergeLabels(cache, inputs, { 'fresh.rs': { responsibility: 'new', whyNow: 'new' } });
    expect(merged.entries['keep.rs'].responsibility).toBe('old');
    expect(merged.entries['fresh.rs']).toEqual({ responsibility: 'new', whyNow: 'new', contentHash: 'F' });
  });

  it('loadLabelCache returns empty on missing file; saveLabelCache round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lbl-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const p = join(dir, 'labels.json');
    expect(loadLabelCache(p)).toEqual({ version: 1, entries: {} });
    const cache: LabelCache = { version: 1, entries: { 'a.rs': { responsibility: 'r', whyNow: 'w', contentHash: 'H' } } };
    saveLabelCache(p, cache);
    expect(loadLabelCache(p)).toEqual(cache);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/label-cache.test.ts`
Expected: FAIL — `src/label/cache.js` 不存在。

- [ ] **Step 3: 实现 `src/label/cache.ts`**

```ts
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { ChunkLabelInput, LabelCache, ChunkLabel, NodeId } from '../types.js';

export function computeContentHash(functions: { name: string; source: string }[]): string {
  const h = createHash('sha256');
  for (const f of functions) {
    h.update(f.name); h.update('\0'); h.update(f.source); h.update('\0');
  }
  return h.digest('hex');
}

export function selectStale(inputs: ChunkLabelInput[], cache: LabelCache): ChunkLabelInput[] {
  return inputs.filter((i) => {
    const e = cache.entries[i.chunkId];
    return !e || e.contentHash !== i.contentHash;
  });
}

export function mergeLabels(
  cache: LabelCache,
  inputs: ChunkLabelInput[],
  fresh: Record<NodeId, ChunkLabel>,
): LabelCache {
  const entries = { ...cache.entries };
  const byId: Record<NodeId, ChunkLabelInput> = {};
  for (const i of inputs) byId[i.chunkId] = i;
  for (const [id, label] of Object.entries(fresh)) {
    const inp = byId[id];
    if (!inp) continue;
    entries[id] = { responsibility: label.responsibility, whyNow: label.whyNow, contentHash: inp.contentHash };
  }
  return { version: 1, entries };
}

export function loadLabelCache(path: string): LabelCache {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LabelCache;
  } catch {
    return { version: 1, entries: {} };
  }
}

export function saveLabelCache(path: string, cache: LabelCache): void {
  writeFileSync(path, JSON.stringify(cache, null, 2));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/label-cache.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add src/label/cache.ts test/label-cache.test.ts
git commit -m "feat(label): 内容 hash 缓存（增量筛选/合并/读写）"
```

---

## Task 3: 收集输入 + labelChunks 编排（含降级）

**Files:**
- Create: `src/label/label.ts`
- Test: `test/label.test.ts`（Create）

- [ ] **Step 1: 写失败测试**

Create `test/label.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { collectLabelInputs, labelChunks } from '../src/label/label.js';
import type { GradedTree, Labeler, Grade } from '../src/types.js';

function fixture(): { graded: GradedTree; sources: Record<string, string> } {
  const grade: Grade = {
    risk: 0.1, riskBucket: 'low', contribution: 0.1, contribBucket: 'filler',
    signals: { relChurn: 0, coupling: 0, ownership: 0, centrality: 0, sizeNorm: 0 },
  };
  const graded: GradedTree = {
    repo: 'r',
    chapters: [{ id: 'k:', name: 'k::', crate: 'k', dir: '', chunkIds: ['a.rs', 'b.rs'] }],
    chunks: [
      { id: 'a.rs', name: 'a', file: 'a.rs', crate: 'k', leafIds: ['a.rs::f::1'] },
      { id: 'b.rs', name: 'b', file: 'b.rs', crate: 'k', leafIds: [] },
    ],
    leaves: [{ id: 'a.rs::f::1', kind: 'fn', name: 'f', file: 'a.rs', startLine: 1, endLine: 2, loc: 2 }],
    grades: { 'a.rs': grade, 'b.rs': grade },
  };
  const sources = { 'a.rs': 'fn f() {\n  do_it();\n}\n', 'b.rs': '' };
  return { graded, sources };
}

describe('collectLabelInputs', () => {
  it('slices function source, records neighbors and a content hash', () => {
    const { graded, sources } = fixture();
    const inputs = collectLabelInputs(graded, sources);
    const a = inputs.find((i) => i.chunkId === 'a.rs')!;
    expect(a.functions).toEqual([{ name: 'f', source: 'fn f() {\n  do_it();' }]);
    expect(a.chapterName).toBe('k::');
    expect(a.neighbors).toEqual(['b']);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const b = inputs.find((i) => i.chunkId === 'b.rs')!;
    expect(b.functions).toEqual([]);
  });
});

describe('labelChunks', () => {
  it('only labels stale chunks, merges into cache', async () => {
    const { graded, sources } = fixture();
    const inputs = collectLabelInputs(graded, sources);
    const cache = { version: 1 as const, entries: {
      'b.rs': { responsibility: 'old', whyNow: 'old', contentHash: inputs.find((i) => i.chunkId === 'b.rs')!.contentHash },
    } };
    const labeler: Labeler = {
      label: vi.fn(async (stale) => Object.fromEntries(stale.map((s) => [s.chunkId, { responsibility: 'R', whyNow: 'W' }]))),
    };
    const out = await labelChunks(inputs, cache, labeler);
    expect((labeler.label as any).mock.calls[0][0].map((s: any) => s.chunkId)).toEqual(['a.rs']); // b 命中缓存
    expect(out.entries['a.rs'].responsibility).toBe('R');
    expect(out.entries['b.rs'].responsibility).toBe('old');
  });

  it('degrades silently when labeler is null (no key)', async () => {
    const { graded, sources } = fixture();
    const inputs = collectLabelInputs(graded, sources);
    const out = await labelChunks(inputs, { version: 1, entries: {} }, null);
    expect(out).toEqual({ version: 1, entries: {} });
  });

  it('degrades silently when labeler throws, keeps old cache', async () => {
    const { graded, sources } = fixture();
    const inputs = collectLabelInputs(graded, sources);
    const cache = { version: 1 as const, entries: {} };
    const labeler: Labeler = { label: async () => { throw new Error('boom'); } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await labelChunks(inputs, cache, labeler);
    expect(out).toEqual({ version: 1, entries: {} });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/label.test.ts`
Expected: FAIL — `src/label/label.js` 不存在。

- [ ] **Step 3: 实现 `src/label/label.ts`**

```ts
import type { GradedTree, ChunkLabelInput, LabelCache, Labeler, ChunkLabel, NodeId } from '../types.js';
import { computeContentHash, selectStale, mergeLabels } from './cache.js';

export function collectLabelInputs(g: GradedTree, sources: Record<string, string>): ChunkLabelInput[] {
  return g.chunks.map((c) => {
    const grade = g.grades[c.id];
    const leaves = g.leaves.filter((l) => l.file === c.id);
    const lines = (sources[c.file] ?? '').split('\n');
    const functions = leaves.map((l) => ({
      name: l.name,
      source: lines.slice(l.startLine - 1, l.endLine).join('\n'),
    }));
    const chapter = g.chapters.find((ch) => ch.chunkIds.includes(c.id));
    const neighbors = chapter
      ? chapter.chunkIds
          .filter((x) => x !== c.id)
          .map((x) => g.chunks.find((cc) => cc.id === x)?.name ?? x)
      : [];
    return {
      chunkId: c.id,
      chunkName: c.name,
      file: c.file,
      chapterName: chapter?.name ?? '',
      riskBucket: grade.riskBucket,
      contribBucket: grade.contribBucket,
      functions,
      neighbors,
      contentHash: computeContentHash(functions),
    };
  });
}

export async function labelChunks(
  inputs: ChunkLabelInput[],
  cache: LabelCache,
  labeler: Labeler | null,
): Promise<LabelCache> {
  const stale = selectStale(inputs, cache);
  let fresh: Record<NodeId, ChunkLabel> = {};
  if (labeler && stale.length) {
    try {
      fresh = await labeler.label(stale);
    } catch (e) {
      console.warn(`⚠ 标签生成失败，跳过（保留旧缓存）：${e instanceof Error ? e.message : e}`);
      fresh = {};
    }
  }
  return mergeLabels(cache, inputs, fresh);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/label.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add src/label/label.ts test/label.test.ts
git commit -m "feat(label): 收集输入 + labelChunks 编排（增量+无key/失败降级）"
```

---

## Task 4: ClaudeLabeler（真实 SDK，client 可注入）

**Files:**
- Create: `src/label/claude.ts`
- Modify: `package.json`（加依赖）
- Test: `test/claude-labeler.test.ts`（Create）

- [ ] **Step 1: 装依赖**

Run: `npm install @anthropic-ai/sdk zod`
Expected: `package.json` 的 dependencies 出现 `@anthropic-ai/sdk` 与 `zod`。

- [ ] **Step 2: 写失败测试**

Create `test/claude-labeler.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { ClaudeLabeler } from '../src/label/claude.js';
import type { ChunkLabelInput } from '../src/types.js';

const mkInput = (id: string, src: string): ChunkLabelInput => ({
  chunkId: id, chunkName: id, file: id, chapterName: 'c',
  riskBucket: 'low', contribBucket: 'filler',
  functions: [{ name: 'f', source: src }], neighbors: [], contentHash: 'h',
});

describe('ClaudeLabeler', () => {
  it('calls messages.parse once per chunk, includes source, maps parsed output', async () => {
    const parse = vi.fn(async (args: any) => ({
      parsed_output: { responsibility: `R:${args.messages[0].content.length}`, whyNow: 'W' },
    }));
    const client = { messages: { parse } };
    const labeler = new ClaudeLabeler(client as any, 'claude-haiku-4-5');
    const out = await labeler.label([mkInput('a.rs', 'fn f(){ SENTINEL }'), mkInput('b.rs', 'fn f(){}')]);

    expect(parse).toHaveBeenCalledTimes(2);
    // 不传 effort（haiku 会 400）
    expect(parse.mock.calls[0][0].output_config.effort).toBeUndefined();
    expect(parse.mock.calls[0][0].model).toBe('claude-haiku-4-5');
    // prompt 含源码
    const prompts = parse.mock.calls.map((c) => c[0].messages[0].content).join('\n');
    expect(prompts).toContain('SENTINEL');
    expect(out['a.rs'].whyNow).toBe('W');
    expect(out['b.rs'].responsibility).toBe('R:' + parse.mock.calls[1][0].messages[0].content.length);
  });

  it('drops chunks whose parsed_output is null', async () => {
    const parse = vi.fn(async () => ({ parsed_output: null }));
    const labeler = new ClaudeLabeler({ messages: { parse } } as any, 'claude-haiku-4-5');
    const out = await labeler.label([mkInput('a.rs', 'x')]);
    expect(out).toEqual({});
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run test/claude-labeler.test.ts`
Expected: FAIL — `src/label/claude.js` 不存在。

- [ ] **Step 4: 实现 `src/label/claude.ts`**

```ts
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { Labeler, ChunkLabelInput, ChunkLabel, NodeId } from '../types.js';

const LabelSchema = z.object({
  responsibility: z.string(),
  whyNow: z.string(),
});

/** ClaudeLabeler 只依赖 messages.parse，便于测试注入 fake client。 */
export interface MessagesParseClient {
  messages: { parse(args: unknown): Promise<{ parsed_output: ChunkLabel | null }> };
}

const SYSTEM =
  '你是代码库导览助手。给定一个已经确定好的代码块（一个文件）及其函数源码，你只为它写两句中文：\n' +
  '- responsibility：一句话说清这个块对外的职责。\n' +
  '- whyNow：一句话说清现在学它的理由（承上启下 / 架构核心 / 简单填充 等）。\n' +
  '严禁发明输入中未出现的结构、依赖或调用关系。只描述给定的内容。';

function userPrompt(i: ChunkLabelInput): string {
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

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < items.length) {
      const cur = idx++;
      out[cur] = await fn(items[cur]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 0 }, worker));
  return out;
}

export class ClaudeLabeler implements Labeler {
  constructor(private client: MessagesParseClient, private model: string) {}

  async label(inputs: ChunkLabelInput[]): Promise<Record<NodeId, ChunkLabel>> {
    const results = await mapWithConcurrency(inputs, 5, async (i) => {
      const resp = await this.client.messages.parse({
        model: this.model,
        max_tokens: 1024,
        system: SYSTEM,
        messages: [{ role: 'user', content: userPrompt(i) }],
        // 只约束输出格式；不传 effort（haiku-4-5 不接受 effort，会 400）
        output_config: { format: zodOutputFormat(LabelSchema) },
      });
      return { id: i.chunkId, label: resp.parsed_output };
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
  return new ClaudeLabeler(new Anthropic() as unknown as MessagesParseClient, model);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/claude-labeler.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json src/label/claude.ts test/claude-labeler.test.ts
git commit -m "feat(label): ClaudeLabeler（messages.parse+zod，client 可注入，haiku 默认不传 effort）"
```

---

## Task 5: map 接线打标签 + `--no-label` / `--model` + 降级；`.gitignore`

**Files:**
- Modify: `src/cli.ts`
- Modify: `.gitignore`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: 扩展 `test/cli.test.ts`（注入 FakeLabeler，断言 labels.json）**

在 `test/cli.test.ts` 现有 `describe('runMap', ...)` 内追加一个用例（保留原用例不动）。文件顶部已 import 的 `runMap` / `readFileSync` / `join` 复用；新增 `import type { Labeler } from '../src/types.js';`：

```ts
  it('writes easyreview.labels.json using an injected labeler', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'crates/foo/src/lib.rs', 'pub fn a() { b(); }\nfn b() {}');
    commitAll(dir, 'init');

    const labeler: Labeler = {
      label: async (inputs) =>
        Object.fromEntries(inputs.map((i) => [i.chunkId, { responsibility: `职责:${i.chunkName}`, whyNow: '现在学' }])),
    };
    await runMap({ repo: dir, outDir: dir, labeler });

    const labels = JSON.parse(readFileSync(join(dir, 'easyreview.labels.json'), 'utf8'));
    expect(labels.version).toBe(1);
    expect(labels.entries['crates/foo/src/lib.rs'].responsibility).toBe('职责:lib');
    expect(labels.entries['crates/foo/src/lib.rs'].contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('with labeler=null (no key) still writes tree+map, labels empty', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'crates/foo/src/lib.rs', 'pub fn a() {}');
    commitAll(dir, 'init');

    await runMap({ repo: dir, outDir: dir, labeler: null });

    expect(readFileSync(join(dir, 'easyreview.tree.json'), 'utf8')).toContain('grades');
    const labels = JSON.parse(readFileSync(join(dir, 'easyreview.labels.json'), 'utf8'));
    expect(labels.entries).toEqual({});
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — `runMap` 尚不接受 `labeler`，也不写 `easyreview.labels.json`。

- [ ] **Step 3: 改 `src/cli.ts`**

在文件顶部 import 区追加：

```ts
import type { Labeler } from './types.js';
import { collectLabelInputs, labelChunks } from './label/label.js';
import { loadLabelCache, saveLabelCache } from './label/cache.js';
import { makeClaudeLabelerFromEnv } from './label/claude.js';
```

把 `MapOptions` 与 `runMap` 替换为：

```ts
export interface MapOptions {
  repo: string;
  outDir: string;
  labeler?: Labeler | null; // 测试注入 fake；显式 null = 不打标签；缺省 = 按 env 决定
  noLabel?: boolean;        // --no-label：即使有 key 也跳过
  model?: string;           // --model：覆盖默认 claude-haiku-4-5
}

export async function runMap(opts: MapOptions): Promise<void> {
  const { repo, outDir } = opts;
  const tree = await buildTree(repo);
  const log = logNameOnly(repo);

  const sources: Record<string, string> = {};
  for (const f of listTrackedFiles(repo).filter((x) => x.endsWith('.rs'))) {
    sources[f] = readFileSync(join(repo, f), 'utf8');
  }

  const graded = gradeTree(tree, {
    relChurn: relativeChurn(log),
    coupling: changeCoupling(log),
    ownership: ownershipConcentration(log),
    centrality: nameFanInCentrality(tree.leaves, sources),
  });

  writeFileSync(join(outDir, 'easyreview.tree.json'), JSON.stringify(graded, null, 2));
  writeFileSync(join(outDir, 'easyreview.map.md'), renderMapMarkdown(graded));

  // ── LLM 块标签（纯增强；无论如何 tree/map 已经落盘）──
  const labelPath = join(outDir, 'easyreview.labels.json');
  const cache = loadLabelCache(labelPath);
  const inputs = collectLabelInputs(graded, sources);
  const labeler = opts.noLabel
    ? null
    : opts.labeler !== undefined
      ? opts.labeler
      : makeClaudeLabelerFromEnv(opts.model);
  const updated = await labelChunks(inputs, cache, labeler);
  saveLabelCache(labelPath, updated);
}
```

把 `parseArgs` 替换为（新增 `--no-label` / `--model`）：

```ts
function parseArgs(argv: string[]): MapOptions {
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  return {
    repo: get('--repo', process.cwd()),
    outDir: get('--out', process.cwd()),
    noLabel: argv.includes('--no-label'),
    model: argv.indexOf('--model') >= 0 ? get('--model', '') || undefined : undefined,
  };
}
```

把 map 分支的成功日志更新（可选，说明标签）：

```ts
if (cmd === 'map') {
  runMap(parseArgs(process.argv.slice(3)))
    .then(() => console.log('✓ wrote easyreview.tree.json + easyreview.map.md + labels.json'))
    .catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: 改 `.gitignore`**

在 `.gitignore` 末尾追加一行：

```
easyreview.labels.json
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS（原用例 + 2 新用例）

- [ ] **Step 6: 提交**

```bash
git add src/cli.ts .gitignore test/cli.test.ts
git commit -m "feat(cli): map 打标签写 labels.json；--no-label/--model；无key降级"
```

---

## Task 6: 卡片渲染叠加标签 + learn/done 读缓存

**Files:**
- Modify: `src/render/journey-md.ts`
- Modify: `src/cli-learn.ts`
- Test: `test/journey-md.test.ts`（Create）

- [ ] **Step 1: 写失败测试**

Create `test/journey-md.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderJourneyMarkdown } from '../src/render/journey-md.js';
import { buildPath } from '../src/path/sequence.js';
import type { GradedTree, Grade, LabelCache } from '../src/types.js';

function graded(): GradedTree {
  const grade: Grade = {
    risk: 0.1, riskBucket: 'low', contribution: 0.1, contribBucket: 'filler',
    signals: { relChurn: 0, coupling: 0, ownership: 0, centrality: 0, sizeNorm: 0 },
  };
  return {
    repo: 'r',
    chapters: [{ id: 'k:', name: 'k::', crate: 'k', dir: '', chunkIds: ['a.rs'] }],
    chunks: [{ id: 'a.rs', name: 'a', file: 'a.rs', crate: 'k', leafIds: ['a.rs::f::1'] }],
    leaves: [{ id: 'a.rs::f::1', kind: 'fn', name: 'f', file: 'a.rs', startLine: 1, endLine: 1, loc: 1 }],
    grades: { 'a.rs': grade },
  };
}
const emptyProgress = { version: 1 as const, understood: [] };

describe('renderJourneyMarkdown labels', () => {
  it('uses LLM label + adds a 职责 line when a label exists', () => {
    const g = graded();
    const labels: LabelCache = { version: 1, entries: { 'a.rs': { responsibility: '管理 XY 状态', whyNow: 'LLM 理由', contentHash: 'h' } } };
    const md = renderJourneyMarkdown(g, buildPath(g), emptyProgress, labels);
    expect(md).toContain('- 职责：管理 XY 状态');
    expect(md).toContain('为什么现在学它：LLM 理由');
  });

  it('falls back to static whyNow and omits 职责 line when no label', () => {
    const g = graded();
    const md = renderJourneyMarkdown(g, buildPath(g), emptyProgress);
    expect(md).not.toContain('- 职责：');
    expect(md).toContain('用来先熟悉项目的词汇与惯用法'); // filler 静态文案
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/journey-md.test.ts`
Expected: FAIL — `renderJourneyMarkdown` 尚不收 `labels` 参数、不输出"职责"行。

- [ ] **Step 3: 改 `src/render/journey-md.ts`**

改签名与 import（第 1 行加 `LabelCache`），并在"为什么现在学它"处叠加标签。

第 1 行改为：

```ts
import type { GradedTree, JourneyPath, Progress, Grade, RiskBucket, ContribBucket, LabelCache } from '../types.js';
```

把 `export function renderJourneyMarkdown(g, path, progress)` 签名改为多收可选 `labels`：

```ts
export function renderJourneyMarkdown(g: GradedTree, path: JourneyPath, progress: Progress, labels?: LabelCache): string {
```

把原来这两行：

```ts
  lines.push(`- 风险：${RISK[grade.riskBucket]} · 架构贡献度：${CONTRIB[grade.contribBucket]}`);
  lines.push(`- 为什么现在学它：${whyNow(grade)}`);
```

替换为：

```ts
  lines.push(`- 风险：${RISK[grade.riskBucket]} · 架构贡献度：${CONTRIB[grade.contribBucket]}`);
  const label = labels?.entries[next.chunkId];
  if (label) lines.push(`- 职责：${label.responsibility}`);
  lines.push(`- 为什么现在学它：${label ? label.whyNow : whyNow(grade)}`);
```

（`whyNow` 静态函数保留不动，作为无标签兜底。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/journey-md.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: 改 `src/cli-learn.ts` 让 rerender 读 labels.json**

顶部 import 追加：

```ts
import { loadLabelCache } from './label/cache.js';
```

把 `rerender` 改为读取并传入 labels：

```ts
function rerender(outDir: string, tree: GradedTree): void {
  const path = buildPath(tree);
  const progress = loadProgress(progressPath(outDir));
  const labels = loadLabelCache(join(outDir, 'easyreview.labels.json'));
  writeFileSync(join(outDir, 'easyreview.journey.md'), renderJourneyMarkdown(tree, path, progress, labels));
  writeFileSync(join(outDir, 'easyreview.map.md'), renderMapMarkdown(tree, new Set(progress.understood)));
}
```

（`loadLabelCache` 对缺失文件返回空缓存，所以未跑过 map-label 时行为不变。）

- [ ] **Step 6: 跑全量测试确认通过**

Run: `npx vitest run`
Expected: PASS —— 全绿（原 41 + 新增用例）。确认 `test/cli-learn.test.ts` 仍通过（rerender 变更向后兼容）。

- [ ] **Step 7: 提交**

```bash
git add src/render/journey-md.ts src/cli-learn.ts test/journey-md.test.ts
git commit -m "feat(render): 卡片叠加 LLM 职责/whyNow（无标签回退静态）；learn 读 labels 缓存"
```

---

## Task 7: 真实 Claude observe 冒烟（手动，不入自动测试）

**Files:** 无代码改动——这是人工验证步骤。

- [ ] **Step 1: 确认有可用凭据**

Run: `ant auth status`（或确认 `ANTHROPIC_API_KEY` 已设）。若无凭据，跳过本任务并在交接里注明"标签质量未经真实 Claude 验证"。

- [ ] **Step 2: 在真实 umwelt-bevy 上跑 map（会真调 haiku 打 68 块标签）**

Run: `npm run map -- --repo D:/dev/umwelt-bevy --out .`
Expected: 生成 `easyreview.labels.json`；无报错。若无 key，命令仍成功但 labels.json 为空 `{version:1,entries:{}}`（降级验证）。

- [ ] **Step 3: 肉眼评标签质量**

Run: `npm run learn -- --out .` 然后打开 `easyreview.journey.md`，看"职责"行与"为什么现在学它"是否贴切、是否**没有发明输入外的结构/依赖**。若明显跑偏，记录到交接文档作为后续 prompt 调优项（不阻塞本计划）。

- [ ] **Step 4: 再跑一次 map 验证增量缓存**

Run: `npm run map -- --repo D:/dev/umwelt-bevy --out .`
Expected: 第二次应几乎不再调 API（所有块 hash 命中缓存复用）。可在 `ClaudeLabeler.label` 里临时 `console.error(inputs.length)` 观察 stale 数应为 0；验证后移除临时日志、不提交。

---

## 收尾

- [ ] 全量测试：`npx vitest run` 全绿。
- [ ] 更新 `docs/HANDOFF.md`：把"下一步 1（LLM 贴标签）"标记为已完成，补一句 labels.json 生成物 + `--no-label`/`--model`/默认 haiku 说明。单独提交：`docs: HANDOFF 同步计划②-LLM 块标签完成`。
