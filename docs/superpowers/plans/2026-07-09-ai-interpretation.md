# AI 解读层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 源码抽屉里的按需 AI 解读层——块级一篇(职责/数据流/调用关系)+ 函数逐条,默认开可关,contentHash 增量缓存。

**Architecture:** 新模块 `src/interpret/`(input/prompt/deepseek/cache,纪律照抄 `src/label/`)+ serve 端 `GET /api/interpret`(白名单校验 → 查 `easyreview.interpret.json` → 未命中同步调 DeepSeek 落盘,在途去重)+ page.ts 顶栏开关与抽屉解读面板。铁律:LLM 只描述整文件源码 + tree 已有确定性事实,不发明结构。

**Tech Stack:** TypeScript (ESM, NodeNext)、zod、openai SDK(DeepSeek 兼容端点)、vitest、node:http。Spec:`docs/superpowers/specs/2026-07-09-ai-interpretation-design.md`。

**硬约束(全程牢记):**
- 测试只用 fake client,**永不**碰真 `DEEPSEEK_API_KEY`,key 永不写进任何文件。
- `src/serve/page.ts` 的内嵌 HTML/JS 在 TS 模板字面量里:**禁止反引号、禁止 `${`**,只用单引号拼接。
- vitest 不做类型检查,`npm run typecheck` 才是类型闸门。
- PowerShell 5.1 没有 `&&`,命令分开跑或用 `;`。

---

### Task 1: 类型 + `src/interpret/input.ts`(事实拼装与 contentHash)

**Files:**
- Modify: `src/types.ts`(文件末尾追加)
- Create: `src/interpret/input.ts`
- Test: `test/interpret-input.test.ts`

- [ ] **Step 1: 在 `src/types.ts` 末尾(`Labeler` 接口之后)追加类型**

```ts

// ── 子项目B-AI 解读层 ──
export interface InterpretInput {
  chunkId: NodeId;
  chunkName: string;
  file: string;
  chapterName: string;
  riskBucket: RiskBucket;
  contribBucket: ContribBucket;
  signals: Signals;
  functions: { name: string; startLine: number }[];
  neighbors: string[];        // 同章其它块的名字
  source: string;             // 整文件源码(实时读盘,超长会被截断)
  truncated: boolean;
  contentHash: string;
}

export interface ChunkInterpretation {
  overview: string;           // 职责展开,3-5 句
  dataFlow: string;           // 数据怎么进、怎么变、怎么出
  calls: string;              // 调用关系:文件内可见的 + 事实里给的,跨文件不臆测
  functions: { name: string; gist: string }[]; // 逐函数一句话
}

export interface InterpretCacheEntry extends ChunkInterpretation {
  contentHash: string;
}

export interface InterpretCache {
  version: 1;
  entries: Record<NodeId, InterpretCacheEntry>;
}

export interface Interpreter {
  interpret(input: InterpretInput): Promise<ChunkInterpretation | null>;
}
```

- [ ] **Step 2: 写失败测试 `test/interpret-input.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { collectInterpretInput, computeInterpretHash, MAX_SOURCE_CHARS } from '../src/interpret/input.js';
import { makeViewerTree } from './viewer-fixture.js';

const A = 'crates/foo/src/a.rs';
const SRC = 'fn f1() {}\n\nfn f2() {}\n';

function inputFor(src = SRC) {
  const tree = makeViewerTree();
  return collectInterpretInput(tree, tree.chunks.find((c) => c.id === A)!, src);
}

describe('collectInterpretInput', () => {
  it('拼出确定性事实:桶/章/邻居/信号/函数名单', () => {
    const i = inputFor();
    expect(i.chunkId).toBe(A);
    expect(i.chapterName).toBe('foo::src');
    expect(i.riskBucket).toBe('none');
    expect(i.contribBucket).toBe('filler');
    expect(i.neighbors).toEqual(['b']);
    expect(i.functions).toEqual([{ name: 'f1', startLine: 1 }, { name: 'f2', startLine: 5 }]);
    expect(i.signals.coupling).toBe(0.1);
    expect(i.truncated).toBe(false);
    expect(i.source).toBe(SRC);
  });

  it('contentHash 稳定;改源码/改桶位各自翻 hash', () => {
    expect(inputFor().contentHash).toBe(inputFor().contentHash);
    expect(inputFor('fn f1() { changed }\n').contentHash).not.toBe(inputFor().contentHash);
    const tree = makeViewerTree();
    const chunk = tree.chunks.find((c) => c.id === A)!;
    const base = collectInterpretInput(tree, chunk, SRC).contentHash;
    tree.grades[A] = { ...tree.grades[A], riskBucket: 'high' };
    expect(collectInterpretInput(tree, chunk, SRC).contentHash).not.toBe(base);
  });

  it('改 PROMPT_VERSION 翻 hash(通过 computeInterpretHash 注入版本验证)', () => {
    const i = inputFor();
    expect(computeInterpretHash(i, 'v-a')).not.toBe(computeInterpretHash(i, 'v-b'));
  });

  it('超长源码截断并标记 truncated', () => {
    const i = inputFor('x'.repeat(MAX_SOURCE_CHARS + 10));
    expect(i.truncated).toBe(true);
    expect(i.source.length).toBe(MAX_SOURCE_CHARS);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run test/interpret-input.test.ts`
Expected: FAIL(找不到 `../src/interpret/input.js`)

- [ ] **Step 4: 写 `src/interpret/input.ts`**

```ts
import { createHash } from 'node:crypto';
import type { GradedTree, Chunk, InterpretInput } from '../types.js';

/** 改 prompt 时递增此常量 → 全部缓存自然失效重生成。 */
export const PROMPT_VERSION = 'interpret-v1';
/** 源码超长兜底:截前 8 万字符(≈2 万 token),prompt 里注明被截断。 */
export const MAX_SOURCE_CHARS = 80000;

export function computeInterpretHash(
  i: Omit<InterpretInput, 'contentHash'>,
  version: string = PROMPT_VERSION,
): string {
  const h = createHash('sha256');
  h.update(version); h.update('\0');
  h.update(i.source); h.update('\0');
  h.update(i.riskBucket); h.update('\0');
  h.update(i.contribBucket); h.update('\0');
  h.update(String(i.signals.relChurn)); h.update('\0');
  h.update(String(i.signals.coupling)); h.update('\0');
  h.update(String(i.signals.ownership)); h.update('\0');
  h.update(String(i.signals.centrality)); h.update('\0');
  for (const n of i.neighbors) { h.update(n); h.update('\0'); }
  h.update('\0');
  for (const f of i.functions) { h.update(f.name); h.update(':'); h.update(String(f.startLine)); h.update('\0'); }
  return h.digest('hex');
}

/** 整文件源码 + tree 已有确定性事实 → 喂料与缓存键。不新增任何分析。
 *  注意:tree 里没有 coupling 伙伴名单(map 只落数值),跨文件事实上限 = 邻居名单 + 信号档位。 */
export function collectInterpretInput(g: GradedTree, chunk: Chunk, source: string): InterpretInput {
  const grade = g.grades[chunk.id];
  const chapter = g.chapters.find((ch) => ch.chunkIds.includes(chunk.id));
  const neighbors = chapter
    ? chapter.chunkIds.filter((x) => x !== chunk.id).map((x) => g.chunks.find((c) => c.id === x)?.name ?? x)
    : [];
  const functions = g.leaves
    .filter((l) => l.file === chunk.id)
    .map((l) => ({ name: l.name, startLine: l.startLine }));
  const truncated = source.length > MAX_SOURCE_CHARS;
  const base = {
    chunkId: chunk.id, chunkName: chunk.name, file: chunk.file,
    chapterName: chapter?.name ?? chunk.crate,
    riskBucket: grade.riskBucket, contribBucket: grade.contribBucket,
    signals: grade.signals,
    functions, neighbors,
    source: truncated ? source.slice(0, MAX_SOURCE_CHARS) : source,
    truncated,
  };
  return { ...base, contentHash: computeInterpretHash(base) };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/interpret-input.test.ts`
Expected: PASS(4 个)

- [ ] **Step 6: 类型检查 + 提交**

Run: `npm run typecheck`
Expected: 无错误

```bash
git add src/types.ts src/interpret/input.ts test/interpret-input.test.ts
git commit -m "feat(interpret): InterpretInput 事实拼装与 contentHash(整文件+信号+PROMPT_VERSION)"
```

---

### Task 2: `src/interpret/prompt.ts` + `src/interpret/deepseek.ts`(schema、铁律 prompt、DeepSeek 客户端)

**Files:**
- Create: `src/interpret/prompt.ts`
- Create: `src/interpret/deepseek.ts`
- Test: `test/interpret-deepseek.test.ts`

- [ ] **Step 1: 写失败测试 `test/interpret-deepseek.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { DeepSeekInterpreter } from '../src/interpret/deepseek.js';
import { interpretUserPrompt, INTERPRET_SYSTEM } from '../src/interpret/prompt.js';
import { collectInterpretInput } from '../src/interpret/input.js';
import { makeViewerTree } from './viewer-fixture.js';

const A = 'crates/foo/src/a.rs';
const GOOD = { overview: '职责', dataFlow: '数据', calls: '调用', functions: [{ name: 'f1', gist: '一句话' }] };

function fakeClient(content: string | null) {
  return { chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } } };
}
function inputFor(src = 'fn f1() {}\n') {
  const tree = makeViewerTree();
  return collectInterpretInput(tree, tree.chunks.find((c) => c.id === A)!, src);
}

describe('DeepSeekInterpreter', () => {
  it('好 JSON → 四字段齐', async () => {
    const r = await new DeepSeekInterpreter(fakeClient(JSON.stringify(GOOD)), 'm').interpret(inputFor());
    expect(r).toEqual(GOOD);
  });

  it('坏 JSON / 缺字段 / 空内容 / 抛错 → null 不炸', async () => {
    expect(await new DeepSeekInterpreter(fakeClient('not json'), 'm').interpret(inputFor())).toBeNull();
    expect(await new DeepSeekInterpreter(fakeClient(JSON.stringify({ overview: '缺仨字段' })), 'm').interpret(inputFor())).toBeNull();
    expect(await new DeepSeekInterpreter(fakeClient(null), 'm').interpret(inputFor())).toBeNull();
    const boom = { chat: { completions: { create: async () => { throw new Error('网络挂了'); } } } };
    expect(await new DeepSeekInterpreter(boom, 'm').interpret(inputFor())).toBeNull();
  });
});

describe('interpretUserPrompt / INTERPRET_SYSTEM', () => {
  it('含事实与源码围栏;系统提示含铁律与 json 指令', () => {
    const p = interpretUserPrompt(inputFor());
    expect(p).toContain('同章邻居:b');
    expect(p).toContain('```rust');
    expect(p).toContain('fn f1()');
    expect(INTERPRET_SYSTEM).toContain('严禁发明');
    expect(INTERPRET_SYSTEM).toContain('json');
  });

  it('超长截断 → prompt 注明被截断', () => {
    expect(interpretUserPrompt(inputFor('x'.repeat(90000)))).toContain('截断');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/interpret-deepseek.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 写 `src/interpret/prompt.ts`**

```ts
import { z } from 'zod';
import type { InterpretInput } from '../types.js';
import { langOf } from '../extract/lang.js';

export const InterpretSchema = z.object({
  overview: z.string(),
  dataFlow: z.string(),
  calls: z.string(),
  functions: z.array(z.object({ name: z.string(), gist: z.string() })),
});

/** 铁律:只描述整文件可见结构 + 事实清单给的关系;跨文件只转述事实,不点名未出现的文件。 */
export const INTERPRET_SYSTEM =
  '你是代码库导览助手。给定一个文件的完整源码和一组确定性事实,你为它写一篇中文解读,四个字段:\n' +
  '- overview:职责展开,3-5 句——这个文件对外做什么、内部怎么组织。\n' +
  '- dataFlow:数据怎么进、怎么变、怎么出(参数/状态/返回/副作用)。\n' +
  '- calls:调用关系,只讲两类——①文件内可见的(use/mod/函数间调用);②事实清单里给的(同章邻居、信号档位)。跨文件关系只能转述事实,不得点名事实与源码中未出现的文件。\n' +
  '- functions:逐函数一句话职责,name 与给定函数名单一致、顺序相同。\n' +
  '严禁发明源码与事实中未出现的结构、依赖或调用关系。\n\n' +
  '请用 json 输出,且只输出 json,格式示例:' +
  '{"overview": "…", "dataFlow": "…", "calls": "…", "functions": [{"name": "f", "gist": "一句话"}]}';

function levelOf(v: number): string {
  return v >= 0.66 ? '高' : v >= 0.33 ? '中' : '低';
}

export function interpretUserPrompt(i: InterpretInput): string {
  const fence = langOf(i.file)?.fence ?? '';
  const s = i.signals;
  return (
    '确定性事实:\n' +
    `- 块:${i.chunkName}(文件 ${i.file},章 ${i.chapterName})\n` +
    `- 风险:${i.riskBucket} · 架构贡献度:${i.contribBucket}\n` +
    `- 信号档位:相对churn ${levelOf(s.relChurn)} · 共变耦合 ${levelOf(s.coupling)} · 所有权集中 ${levelOf(s.ownership)} · 名字扇入中心度 ${levelOf(s.centrality)}\n` +
    `- 同章邻居:${i.neighbors.join('、') || '(无)'}\n` +
    `- 函数名单:${i.functions.map((f) => `${f.name}(第${f.startLine}行)`).join('、') || '(无独立函数)'}` +
    (i.truncated ? '\n- 注意:文件超长,以下源码被截断,只含开头部分。' : '') +
    `\n\n完整源码:\n\`\`\`${fence}\n${i.source}\n\`\`\``
  );
}
```

- [ ] **Step 4: 写 `src/interpret/deepseek.ts`**

```ts
import OpenAI from 'openai';
import type { Interpreter, InterpretInput, ChunkInterpretation } from '../types.js';
import type { ChatCompletionsClient } from '../label/deepseek.js';
import { InterpretSchema, INTERPRET_SYSTEM, interpretUserPrompt } from './prompt.js';

/** 单块解读:任何错误(网络/空内容/坏 JSON)→ null 不抛,由 serve 层决定降级。 */
export class DeepSeekInterpreter implements Interpreter {
  constructor(private client: ChatCompletionsClient, private model: string) {}

  async interpret(input: InterpretInput): Promise<ChunkInterpretation | null> {
    try {
      const resp = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: INTERPRET_SYSTEM },
          { role: 'user', content: interpretUserPrompt(input) },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 4096,
      });
      const content = resp.choices[0]?.message?.content;
      if (!content) throw new Error('空内容');
      const parsed = InterpretSchema.safeParse(JSON.parse(content));
      if (!parsed.success) throw new Error('JSON 不符合 InterpretSchema');
      return parsed.data;
    } catch (err) {
      console.warn(`[interpret] 块 ${input.chunkId} 解读失败:${String(err)}`);
      return null;
    }
  }
}

/** 无 DEEPSEEK_API_KEY → null(serve 据此回 503,viewer 灰字降级)。 */
export function makeInterpreterFromEnv(
  model: string = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
): Interpreter | null {
  if (!process.env.DEEPSEEK_API_KEY) return null;
  const client = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
  return new DeepSeekInterpreter(client as unknown as ChatCompletionsClient, model);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/interpret-deepseek.test.ts`
Expected: PASS(4 个)

- [ ] **Step 6: 类型检查 + 提交**

Run: `npm run typecheck`
Expected: 无错误

```bash
git add src/interpret/prompt.ts src/interpret/deepseek.ts test/interpret-deepseek.test.ts
git commit -m "feat(interpret): 铁律 prompt + InterpretSchema + DeepSeek 单块解读客户端"
```

---

### Task 3: `src/interpret/cache.ts` + `src/serve/interpret.ts`(缓存与 API 结果函数)

**Files:**
- Create: `src/interpret/cache.ts`
- Create: `src/serve/interpret.ts`
- Test: `test/serve-interpret.test.ts`(cache 的读写走这里间接覆盖)

- [ ] **Step 1: 写失败测试 `test/serve-interpret.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyInterpret, type InterpretResult } from '../src/serve/interpret.js';
import { makeViewerTree } from './viewer-fixture.js';
import type { Interpreter, ChunkInterpretation } from '../src/types.js';

const A = 'crates/foo/src/a.rs';
const INTERP: ChunkInterpretation = { overview: 'o', dataFlow: 'd', calls: 'c', functions: [{ name: 'f1', gist: 'g' }] };

let dirs: string[] = [];
afterEach(() => { dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); dirs = []; });

function makeDirs() {
  const out = mkdtempSync(join(tmpdir(), 'easyrev-interp-'));
  dirs.push(out);
  const repo = join(out, 'repo');
  mkdirSync(join(repo, 'crates/foo/src'), { recursive: true });
  writeFileSync(join(repo, 'crates/foo/src/a.rs'), 'fn f1() {}\n');
  return { out, tree: { ...makeViewerTree(), repo } };
}

/** 计数 fake:调用即计数(在 delay 前),供在途去重断言。 */
function countingInterpreter(result: ChunkInterpretation | null = INTERP, delayMs = 0) {
  let calls = 0;
  const fake: Interpreter = {
    interpret: () => { calls++; return new Promise((res) => setTimeout(() => res(result), delayMs)); },
  };
  return { fake, calls: () => calls };
}

function newInflight(): Map<string, Promise<InterpretResult>> { return new Map(); }

describe('applyInterpret', () => {
  it('缺参/未知块/../ 穿越 → 400,不调 LLM', async () => {
    const { tree } = makeDirs();
    const { fake, calls } = countingInterpreter();
    expect((await applyInterpret(tree, '/nope', undefined, fake, newInflight())).status).toBe(400);
    expect((await applyInterpret(tree, '/nope', '', fake, newInflight())).status).toBe(400);
    expect((await applyInterpret(tree, '/nope', '../../etc/passwd', fake, newInflight())).status).toBe(400);
    expect(calls()).toBe(0);
  });

  it('文件没了 → 404 带 repo 路径与 --repo 提示', async () => {
    const tree = { ...makeViewerTree(), repo: join(tmpdir(), 'easyrev-no-such-repo') };
    const r = await applyInterpret(tree, tmpdir(), A, null, newInflight());
    expect(r.status).toBe(404);
    expect(r.body.error).toContain('easyrev-no-such-repo');
    expect(r.body.error).toContain('--repo');
  });

  it('无 interpreter → 503,报错提到 DEEPSEEK_API_KEY', async () => {
    const { out, tree } = makeDirs();
    const r = await applyInterpret(tree, out, A, null, newInflight());
    expect(r.status).toBe(503);
    expect(r.body.error).toContain('DEEPSEEK_API_KEY');
  });

  it('miss → 生成落盘;二次请求命中缓存零 LLM 调用', async () => {
    const { out, tree } = makeDirs();
    const { fake, calls } = countingInterpreter();
    const inflight = newInflight();
    const r1 = await applyInterpret(tree, out, A, fake, inflight);
    expect(r1.status).toBe(200);
    expect(r1.body.cached).toBe(false);
    expect(r1.body.interpretation).toEqual(INTERP);
    const disk = JSON.parse(readFileSync(join(out, 'easyreview.interpret.json'), 'utf8'));
    expect(disk.entries[A].overview).toBe('o');
    const r2 = await applyInterpret(tree, out, A, fake, inflight);
    expect(r2.body.cached).toBe(true);
    expect(r2.body.interpretation).toEqual(INTERP);
    expect(calls()).toBe(1);
  });

  it('源码变了 → hash 失效重新生成', async () => {
    const { out, tree } = makeDirs();
    const { fake, calls } = countingInterpreter();
    const inflight = newInflight();
    await applyInterpret(tree, out, A, fake, inflight);
    writeFileSync(join(tree.repo, A), 'fn f1() { /* changed */ }\n');
    const r = await applyInterpret(tree, out, A, fake, inflight);
    expect(r.body.cached).toBe(false);
    expect(calls()).toBe(2);
  });

  it('生成失败 → 502,不落盘', async () => {
    const { out, tree } = makeDirs();
    const { fake } = countingInterpreter(null);
    const r = await applyInterpret(tree, out, A, fake, newInflight());
    expect(r.status).toBe(502);
    expect(existsSync(join(out, 'easyreview.interpret.json'))).toBe(false);
  });

  it('在途去重:并发两请求只生成一次', async () => {
    const { out, tree } = makeDirs();
    const { fake, calls } = countingInterpreter(INTERP, 30);
    const inflight = newInflight();
    const [r1, r2] = await Promise.all([
      applyInterpret(tree, out, A, fake, inflight),
      applyInterpret(tree, out, A, fake, inflight),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(calls()).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/serve-interpret.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 写 `src/interpret/cache.ts`**

```ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { InterpretCache } from '../types.js';

export function loadInterpretCache(path: string): InterpretCache {
  if (!existsSync(path)) return { version: 1, entries: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as InterpretCache;
  } catch {
    console.warn('⚠ easyreview.interpret.json 解析失败,忽略并重建缓存');
    return { version: 1, entries: {} };
  }
}

export function saveInterpretCache(path: string, cache: InterpretCache): void {
  writeFileSync(path, JSON.stringify(cache, null, 2));
}
```

- [ ] **Step 4: 写 `src/serve/interpret.ts`**

```ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GradedTree, Interpreter, ChunkInterpretation } from '../types.js';
import { collectInterpretInput } from '../interpret/input.js';
import { loadInterpretCache, saveInterpretCache } from '../interpret/cache.js';

export interface InterpretBody {
  ok: boolean;
  error?: string;
  interpretation?: ChunkInterpretation;
  cached?: boolean;
}

export interface InterpretResult { status: number; body: InterpretBody; }

/** 白名单 → 查缓存 → 未命中同步生成落盘。inflight 由 server 实例持有:同块并发请求共享同一在途生成。 */
export function applyInterpret(
  tree: GradedTree,
  outDir: string,
  chunkId: unknown,
  interpreter: Interpreter | null,
  inflight: Map<string, Promise<InterpretResult>>,
): Promise<InterpretResult> {
  if (typeof chunkId !== 'string' || chunkId === '') {
    return Promise.resolve({ status: 400, body: { ok: false, error: '缺少 chunk 参数' } });
  }
  const chunk = tree.chunks.find((c) => c.id === chunkId);
  if (!chunk) {
    return Promise.resolve({ status: 400, body: { ok: false, error: `未知块 ${chunkId}` } });
  }
  const abs = join(tree.repo, chunk.file);
  if (!existsSync(abs)) {
    return Promise.resolve({
      status: 404,
      body: { ok: false, error: `仓库路径 ${tree.repo} 下找不到 ${chunk.file}——repo 挪位置了?用 --repo 重新 map,或把仓库放回原处。` },
    });
  }
  const input = collectInterpretInput(tree, chunk, readFileSync(abs, 'utf8'));
  const cachePath = join(outDir, 'easyreview.interpret.json');
  const hit = loadInterpretCache(cachePath).entries[chunkId];
  if (hit && hit.contentHash === input.contentHash) {
    const interpretation: ChunkInterpretation = {
      overview: hit.overview, dataFlow: hit.dataFlow, calls: hit.calls, functions: hit.functions,
    };
    return Promise.resolve({ status: 200, body: { ok: true, interpretation, cached: true } });
  }
  if (!interpreter) {
    return Promise.resolve({ status: 503, body: { ok: false, error: '未配置 DEEPSEEK_API_KEY——解读不可用' } });
  }
  const running = inflight.get(chunkId);
  if (running) return running;
  const p = interpreter.interpret(input)
    .then((interp): InterpretResult => {
      if (!interp) return { status: 502, body: { ok: false, error: '解读生成失败——稍后重试' } };
      const cache = loadInterpretCache(cachePath); // 生成期间可能有别的块写入,重读再合并
      cache.entries[chunkId] = { ...interp, contentHash: input.contentHash };
      saveInterpretCache(cachePath, cache);
      return { status: 200, body: { ok: true, interpretation: interp, cached: false } };
    })
    .finally(() => { inflight.delete(chunkId); });
  inflight.set(chunkId, p);
  return p;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/serve-interpret.test.ts`
Expected: PASS(7 个)

- [ ] **Step 6: 类型检查 + 提交**

Run: `npm run typecheck`
Expected: 无错误

```bash
git add src/interpret/cache.ts src/serve/interpret.ts test/serve-interpret.test.ts
git commit -m "feat(serve): /api/interpret 结果函数——白名单+增量缓存+在途去重"
```

---

### Task 4: `server.ts` 接线(可注入 interpreter)+ HTTP 集成测试

**Files:**
- Modify: `src/serve/server.ts`(整文件替换,下面是完整新内容)
- Test: `test/serve-http.test.ts`(追加 1 个 it)

- [ ] **Step 1: 在 `test/serve-http.test.ts` 末尾(`GET /api/source` 那个 it 之后、`});` 之前)追加集成测试**

```ts
  it('GET /api/interpret: 注入 fake → 200 落盘;interpreter null → 503;无参 → 400', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'easyrev-http-'));
    dirs.push(dir);
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'crates/foo/src'), { recursive: true });
    writeFileSync(join(repo, 'crates/foo/src/a.rs'), 'fn f1() {}\n');
    writeFileSync(join(dir, 'easyreview.tree.json'), JSON.stringify({ ...makeViewerTree(), repo }));
    const fake = { interpret: async () => ({ overview: 'o', dataFlow: 'd', calls: 'c', functions: [] }) };
    const server = createViewerServer(dir, { interpreter: fake });
    servers.push(server);
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const r = await fetch(url + '/api/interpret?chunk=' + encodeURIComponent(A));
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.interpretation.overview).toBe('o');
    expect(JSON.parse(readFileSync(join(dir, 'easyreview.interpret.json'), 'utf8')).entries[A].overview).toBe('o');
    expect((await fetch(url + '/api/interpret')).status).toBe(400);

    // 无 key + 已有缓存 → 仍然能看(缓存命中优先于 503,这是设计行为)
    const serverNoKey = createViewerServer(dir, { interpreter: null });
    servers.push(serverNoKey);
    await new Promise<void>((res) => serverNoKey.listen(0, '127.0.0.1', res));
    const urlNoKey = `http://127.0.0.1:${(serverNoKey.address() as AddressInfo).port}`;
    const rc = await fetch(urlNoKey + '/api/interpret?chunk=' + encodeURIComponent(A));
    expect(rc.status).toBe(200);
    expect((await rc.json()).cached).toBe(true);

    // 无 key + 无缓存 → 503
    const dir2 = mkdtempSync(join(tmpdir(), 'easyrev-http-'));
    dirs.push(dir2);
    writeFileSync(join(dir2, 'easyreview.tree.json'), JSON.stringify({ ...makeViewerTree(), repo }));
    const server503 = createViewerServer(dir2, { interpreter: null });
    servers.push(server503);
    await new Promise<void>((res) => server503.listen(0, '127.0.0.1', res));
    const url2 = `http://127.0.0.1:${(server503.address() as AddressInfo).port}`;
    expect((await fetch(url2 + '/api/interpret?chunk=' + encodeURIComponent(A))).status).toBe(503);
  });
```

> 修订(执行中发现):原计划此测试让 server503 复用暖缓存 dir 并期望 503,与「缓存命中优先于 503」的设计矛盾——已改为上面版本(无 key 有缓存 → 200 cached:true;无 key 无缓存 → 503)。

**注意:测试必须显式注入 `{ interpreter: fake }` 或 `{ interpreter: null }`——本机 env 里有真 key,靠缺省解析会打到真 API。**

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/serve-http.test.ts`
Expected: 新 it FAIL(createViewerServer 不接受第二参数 / 404),其余 7 个 PASS

- [ ] **Step 3: 整文件替换 `src/serve/server.ts`**

```ts
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GradedTree, Interpreter } from '../types.js';
import { loadLabelCache } from '../label/cache.js';
import { loadProgress } from '../progress/progress.js';
import { makeInterpreterFromEnv } from '../interpret/deepseek.js';
import { buildViewerState } from './state.js';
import { applyDone } from './done.js';
import { readSource } from './source.js';
import { applyInterpret, type InterpretResult } from './interpret.js';
import { renderPage } from './page.js';

/** 没有 tree.json 就没得看——启动即失败,给出明确指引。 */
export function loadTreeOrThrow(outDir: string): GradedTree {
  const p = join(outDir, 'easyreview.tree.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as GradedTree;
  } catch {
    throw new Error(`找不到/读不了 ${p}——先运行 \`easyreview map --repo <path> --out ${outDir}\``);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export interface ViewerServerOptions {
  /** 缺省 = 按 env 解析(makeInterpreterFromEnv);显式 null = 无解读(503)。测试必须显式注入。 */
  interpreter?: Interpreter | null;
}

export function createViewerServer(outDir: string, opts: ViewerServerOptions = {}): Server {
  loadTreeOrThrow(outDir); // 启动校验
  const interpreter = opts.interpreter !== undefined ? opts.interpreter : makeInterpreterFromEnv();
  const inflight = new Map<string, Promise<InterpretResult>>();
  return createServer((req, res) => {
    handle(outDir, interpreter, inflight, req, res).catch((e) => {
      sendJson(res, 500, { ok: false, error: String(e) });
    });
  });
}

async function handle(
  outDir: string,
  interpreter: Interpreter | null,
  inflight: Map<string, Promise<InterpretResult>>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = (req.url ?? '/').split('?')[0];

  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderPage());
    return;
  }

  if (req.method === 'GET' && url === '/api/state') {
    // 每请求现读磁盘:另一终端重跑 map/done 后,F5 即最新
    const tree = loadTreeOrThrow(outDir);
    const labels = loadLabelCache(join(outDir, 'easyreview.labels.json'));
    const progress = loadProgress(join(outDir, 'easyreview.progress.json'));
    sendJson(res, 200, buildViewerState(tree, labels, progress));
    return;
  }

  if (req.method === 'GET' && url === '/api/source') {
    const tree = loadTreeOrThrow(outDir);
    const chunk = new URL(req.url ?? '/', 'http://localhost').searchParams.get('chunk');
    const result = readSource(tree, chunk ?? undefined);
    sendJson(res, result.status, result.body);
    return;
  }

  if (req.method === 'GET' && url === '/api/interpret') {
    const tree = loadTreeOrThrow(outDir);
    const chunk = new URL(req.url ?? '/', 'http://localhost').searchParams.get('chunk');
    const result = await applyInterpret(tree, outDir, chunk ?? undefined, interpreter, inflight);
    sendJson(res, result.status, result.body);
    return;
  }

  if (req.method === 'POST' && url === '/api/done') {
    let chunkId: unknown;
    try {
      chunkId = (JSON.parse(await readBody(req)) as { chunkId?: unknown }).chunkId;
    } catch {
      sendJson(res, 400, { ok: false, error: 'body 不是合法 JSON' });
      return;
    }
    const tree = loadTreeOrThrow(outDir);
    const result = applyDone(tree, outDir, chunkId);
    sendJson(res, result.status, result.body);
    return;
  }

  sendJson(res, 404, { ok: false, error: `没有这个路由:${req.method} ${url}` });
}
```

(`cli-serve.ts` 不用改——`createViewerServer(outDir)` 单参调用仍成立,缺省按 env 解析。)

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/serve-http.test.ts`
Expected: PASS(8 个)

- [ ] **Step 5: 类型检查 + 提交**

Run: `npm run typecheck`
Expected: 无错误

```bash
git add src/serve/server.ts test/serve-http.test.ts
git commit -m "feat(serve): GET /api/interpret 接线,interpreter 可注入(测试防真 key)"
```

---

### Task 5: page.ts 前端——顶栏开关 + 抽屉解读面板

**Files:**
- Modify: `src/serve/page.ts`(下述 8 处编辑,全部单引号拼接,禁反引号禁 `${`)
- Test: `test/serve-page.test.ts`(追加 1 个 it)

- [ ] **Step 1: 在 `test/serve-page.test.ts` 末尾追加断言(第二个 it 之后、外层 `});` 之前)**

```ts
  it('B: AI 解读——开关/面板/端点/持久化键/加载态都在', () => {
    const html = renderPage();
    expect(html).toContain('id="interp-toggle"');
    expect(html).toContain('id="interp"');
    expect(html).toContain('/api/interpret');
    expect(html).toContain('easyreview-interpret-collapsed');
    expect(html).toContain('解读生成中');
    expect(html).not.toContain('src=');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/serve-page.test.ts`
Expected: 新 it FAIL,前两个 PASS

- [ ] **Step 3: CSS——把 `#theme-toggle` 规则行改为共用选择器并加 off 态**

找到:

```
#theme-toggle { background: none; border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
```

替换为:

```
#theme-toggle, #interp-toggle { background: none; border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
#interp-toggle.off { color: var(--muted); border-style: dashed; }
```

- [ ] **Step 4: CSS——在 `.fn-chip { ... }` 行之后插入解读面板样式**

```
#interp { border-bottom: 1px solid var(--border); background: rgba(110,161,255,.08); padding: 8px 16px; font-size: 13px; max-height: 45vh; overflow: auto; }
#interp .interp-head { cursor: pointer; user-select: none; color: var(--accent); font-weight: 600; }
#interp .interp-body p { margin: 6px 0; }
#interp .fn-gist { margin: 2px 0; }
#interp .fn-gist code { color: var(--accent); cursor: pointer; }
```

- [ ] **Step 5: HTML——顶栏加开关、抽屉加面板容器**

找到 `<button id="theme-toggle" title="亮/暗切换">🌓</button>`,在这一行**之前**插入:

```
  <button id="interp-toggle" title="AI 解读开/关"></button>
```

找到:

```
  <div id="drawer-fns"></div>
  <div id="drawer-src"></div>
```

替换为:

```
  <div id="drawer-fns"></div>
  <div id="interp" hidden></div>
  <div id="drawer-src"></div>
```

- [ ] **Step 6: JS 状态——在 `var srcCache = {};` 行之后插入**

```
var interpOn = localStorage.getItem('easyreview-interpret') !== 'off'; // 默认开
var interpCollapsed = localStorage.getItem('easyreview-interpret-collapsed') === 'yes';
var interp = {}; // chunkId → { st: 'loading'|'ok'|'nokey'|'err', data?, msg? }(本页生命周期缓存)
```

- [ ] **Step 7: JS——openDrawer/closeDrawer 接入面板**

openDrawer 里找到(`renderDrawerFns();` 在 `var cached = srcCache[id]` 之前):

```
  renderDrawerHead();
  renderDrawerFns();
```

替换为:

```
  renderDrawerHead();
  renderDrawerFns();
  renderInterp();
  loadInterp(id);
```

closeDrawer 里找到:

```
  $('drawer').hidden = true;
```

替换为:

```
  $('drawer').hidden = true;
  $('interp').hidden = true;
```

- [ ] **Step 8: JS——在 `renderDrawerFns` 函数整体之后、`function renderSource(body) {` 之前插入三个函数**

```
// ── AI 解读面板(默认开可关;文本全部过 esc 再进 DOM) ──
function loadInterp(id) {
  if (!interpOn) return;
  var cur = interp[id];
  if (cur && (cur.st === 'ok' || cur.st === 'loading')) { renderInterp(); return; }
  interp[id] = { st: 'loading' };
  renderInterp();
  fetch('/api/interpret?chunk=' + encodeURIComponent(id))
    .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
    .then(function (res) {
      if (res.body.ok) interp[id] = { st: 'ok', data: res.body.interpretation };
      else interp[id] = { st: res.status === 503 ? 'nokey' : 'err', msg: res.body.error || ('HTTP ' + res.status) };
      if (drawerId === id) renderInterp();
    })
    .catch(function (e) {
      interp[id] = { st: 'err', msg: e.message };
      if (drawerId === id) renderInterp();
    });
}

function fnLine(name) {
  var c = state.chunks[drawerId];
  for (var i = 0; i < c.functions.length; i++) if (c.functions[i].name === name) return c.functions[i].startLine;
  return 0;
}

function renderInterp() {
  var box = $('interp');
  if (!interpOn || !drawerId) { box.hidden = true; return; }
  box.hidden = false;
  var it = interp[drawerId];
  var html = '<div class="interp-head" id="interp-head">' + (interpCollapsed ? '▸' : '▾') + ' AI 解读</div>';
  if (!interpCollapsed) {
    if (!it || it.st === 'loading') html += '<div class="interp-body muted">解读生成中…(首次约十几秒)</div>';
    else if (it.st === 'nokey') html += '<div class="interp-body muted">' + esc(it.msg) + '</div>';
    else if (it.st === 'err') html += '<div class="interp-body"><span class="muted">' + esc(it.msg) + '</span> <span class="nb" id="interp-retry">重试</span></div>';
    else {
      var d = it.data;
      html += '<div class="interp-body">';
      html += '<p><b>职责:</b>' + esc(d.overview) + '</p>';
      html += '<p><b>数据流:</b>' + esc(d.dataFlow) + '</p>';
      html += '<p><b>调用关系:</b>' + esc(d.calls) + '</p>';
      for (var i = 0; i < d.functions.length; i++) {
        var f = d.functions[i];
        var ln = fnLine(f.name);
        html += '<div class="fn-gist"><code' + (ln ? ' data-line="' + ln + '"' : '') + '>' + esc(f.name) + '</code> ' + esc(f.gist) + '</div>';
      }
      html += '</div>';
    }
  }
  box.innerHTML = html;
  $('interp-head').addEventListener('click', function () {
    interpCollapsed = !interpCollapsed;
    localStorage.setItem('easyreview-interpret-collapsed', interpCollapsed ? 'yes' : 'no');
    renderInterp();
  });
  var retry = $('interp-retry');
  if (retry) retry.addEventListener('click', function () { delete interp[drawerId]; loadInterp(drawerId); });
  var codes = box.querySelectorAll('code[data-line]');
  for (var j = 0; j < codes.length; j++) {
    codes[j].addEventListener('click', function (ev) { jumpTo(parseInt(ev.currentTarget.getAttribute('data-line'), 10)); });
  }
}
```

- [ ] **Step 9: JS——全局交互区接开关(在 `$('backdrop').addEventListener('click', closeDrawer);` 行之前插入)**

```
function renderInterpToggle() {
  $('interp-toggle').className = interpOn ? '' : 'off';
  $('interp-toggle').textContent = interpOn ? '✨ 解读:开' : '✨ 解读:关';
}
$('interp-toggle').addEventListener('click', function () {
  interpOn = !interpOn;
  localStorage.setItem('easyreview-interpret', interpOn ? 'on' : 'off');
  renderInterpToggle();
  if (interpOn && drawerId) loadInterp(drawerId);
  renderInterp();
});
renderInterpToggle();
```

(注意 `renderInterp()` 里 `!drawerId` 时自会把面板藏起来,开关在抽屉没开时切换只改按钮样子。)

- [ ] **Step 10: 跑测试确认通过 + 自查硬约束**

Run: `npx vitest run test/serve-page.test.ts`
Expected: PASS(3 个)

再跑一个硬约束自查(page.ts 里不允许出现反引号或 `${`,首行模板边界除外):

Run: `npx vitest run test/serve-page.test.ts test/serve-http.test.ts`
Expected: 全 PASS

- [ ] **Step 11: 类型检查 + 提交**

Run: `npm run typecheck`
Expected: 无错误

```bash
git add src/serve/page.ts test/serve-page.test.ts
git commit -m "feat(viewer): 顶栏解读开关 + 抽屉 AI 解读面板(折叠/重试/函数跳行/降级)"
```

---

### Task 6: HANDOFF 文档 + 全量验证

**Files:**
- Modify: `docs/HANDOFF.md`

- [ ] **Step 1: 更新 `docs/HANDOFF.md`**

先读文件找到 ④ viewer 的说明段与代码地图表,做三处更新:

1. ④ 段(viewer 说明)追加一句:抽屉里有 AI 解读面板(`GET /api/interpret` 按需生成,`easyreview.interpret.json` 增量缓存,顶栏「✨ 解读」开关默认开)。
2. 代码地图表追加行(照现有表格式):
   - `src/interpret/input.ts` — 解读喂料:整文件源码+确定性事实,contentHash(含 PROMPT_VERSION)
   - `src/interpret/prompt.ts` — 解读铁律 prompt + InterpretSchema
   - `src/interpret/deepseek.ts` — DeepSeek 单块解读客户端(无 key → null)
   - `src/interpret/cache.ts` — easyreview.interpret.json 读写
   - `src/serve/interpret.ts` — /api/interpret 结果函数(白名单+缓存+在途去重)
   - `server.ts` 一行的路由列表加上 `/api/interpret`
3. 测试数:把「42 文件 / 123 个测试」更新为实跑结果(见 Step 2,预期 45 文件 / 140 个,**以实际输出为准**——计划里的数字过期是惯犯,别照抄)。

- [ ] **Step 2: 全量测试 + 类型检查**

Run: `npx vitest run`
Expected: 全绿(预期 45 文件 / 140 测试,以实际为准)

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add docs/HANDOFF.md
git commit -m "docs: HANDOFF 同步 AI 解读层(interpret 模块/API/开关/测试数)"
```

---

## 验收(orchestrator 执行,不进任务)

真 key 只进进程环境变量(shell 看不到就从注册表读:`$env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')`),**永不落文件**。

1. `npm run serve -- --out E:/dev/easyReview/out/chatwoot --port 4872`(Ruby)与 `npm run serve -- --out E:/dev/easyReview --port 4870`(Rust,repo=D:/dev/umwelt-bevy)。
2. HTTP 层:`/api/interpret?chunk=<真实id>` 首次 200 且 `cached:false`(十几秒);再打一次 `cached:true` 毫秒级;`easyreview.interpret.json` 出现;无参 400;`../` 400。
3. 浏览器动线(用户过):开抽屉见「解读生成中…」→ 四段齐、函数名点击跳行;折叠记忆;重开秒出;改一个文件再开自动重生成;顶栏关开关 → Network 零 `/api/interpret`;临时无 key 起 serve → 灰字降级;暗色主题正常。

## Self-Review 记录

- Spec 覆盖:§1→Task 1/3(类型+hash+cache 文件),§2→Task 1/2,§3→Task 3/4,§4→Task 5,§5→已随 spec 提交(0f41769,不进本计划),§6→各任务测试步 + 验收段。无缺口。
- 占位符扫描:无 TBD/TODO;所有代码步给全文或精确锚点替换。
- 类型一致性:`InterpretResult` 在 Task 3 定义、Task 4 引用同名;`applyInterpret(tree, outDir, chunkId, interpreter, inflight)` 五参在 Task 3/4 一致;`ChunkInterpretation` 四字段与 zod schema、缓存 entry、前端渲染字段一一对应;`countingInterpreter` 在调用起点计数(去重断言正确)。
- 已知坑写进任务:测试显式注入 interpreter 防真 key;page.ts 无反引号无 `${`;HANDOFF 测试数以实跑为准。
