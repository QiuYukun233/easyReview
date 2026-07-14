# 中心度 v2:引用图 + 加权入度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 中心度从「名字出现次数加总」升级为「引用图加权入度」:名字池加入块身份名,每引用文件记 1,同名多定义均分;每块入边 top-10 以 `refsIn` 落盘 tree.json。

**Architecture:** `src/grade/centrality.ts` 原地重写(删 `nameFanInCentrality`,新 `referenceGraphCentrality`,保留 `genericDfCutoff` 一族);`types.ts` 加可选 `refsIn` + `ChunkRefIn`;`cli.ts` runMap 换调用并挂 refsIn。设计 spec:`docs/superpowers/specs/2026-07-14-centrality-refgraph-design.md`(三轮探针数据在里面)。

**Tech Stack:** TypeScript(tsx 运行,无 build)、vitest。

**背景(给零上下文的实现者):**
- easyReview 给仓库文件(「块」)打分;中心度 = 「全仓多依赖这个文件」,权重 0.6 进贡献度。
- v1 数每块函数名(叶子名)在其它文件的出现次数。两个根本局限:①「提到≠依赖」,单文件反复提及刷分;②块身份名(`import ApiClient` 的 `ApiClient`、Ruby 常量 `UrlHelper`)不是叶子,最强的依赖信号完全看不见。
- v2 规则:名字池 = 叶子名 ∪ 身份名(`chunk.name` 即无扩展名 basename;`.rb` 另加驼峰 `url_helper→UrlHelper`;非词 basename 不产);df(名字出现过的文件数)> `genericDfCutoff(N)` 的名字不建边;文件 f(非定义者)出现保留名字**≥1 次即记 1**(fin,不按次数)→ 边 `f→每个定义者`,权重 `1/定义者数`;中心度 = 入边权重和归一化 0..1,全零 `{}`;refsIn = 每块入边 top-10(权重降序、平权 from 字典序、names 字典序)。
- **删除 v1 的连锁**:`nameFanInCentrality` 退役 → 它的 11 条测试(1 条旧行为 + 4 条 naiveReference 对拍 + 6 条截断行为)一并删除;`genericDfCutoff` 3 条保留;新增 12 条图行为测试(含非词名回退回归——评审曾抓到该路径因转义字节损坏而死、且无测试覆盖)→ 文件 15 条,全量 **62 文件 / 282 测试**。
- 这是一次原子替换:centrality.ts 重写后 cli.ts 的旧导入立即失效,四个文件必须同任务内完成。

---

### Task 1: 引用图中心度 + refsIn 落盘(TDD,原子替换)

**Files:**
- Modify: `src/types.ts`(加 `ChunkRefIn` 接口 + `Tree.refsIn?` 字段)
- Modify: `src/grade/centrality.ts`(全文件替换)
- Modify: `src/cli.ts`(import 行 + runMap 两处)
- Test: `test/centrality.test.ts`(全文件替换)、`test/cli.test.ts`(既有测试加一条断言)

- [ ] **Step 1: 写失败测试**

`test/centrality.test.ts` **全文件替换**为:

```ts
import { describe, it, expect } from 'vitest';
import { referenceGraphCentrality, genericDfCutoff } from '../src/grade/centrality.js';
import type { Leaf, Chunk } from '../src/types.js';

const leaf = (file: string, name: string): Leaf => ({
  id: `${file}::${name}::1`, kind: 'fn', name, file, startLine: 1, endLine: 1, loc: 1,
});
// 与 buildTree 一致:name = 无扩展名 basename
const chunk = (file: string): Chunk => ({
  id: file, name: file.split('/').pop()!.replace(/\.[^.]+$/, ''), file, crate: 'app', leafIds: [],
});

describe('genericDfCutoff', () => {
  it('小仓库走 20 文件下限(umwelt N=68 时 5% 阈值=4 会误杀真领域名)', () => {
    expect(genericDfCutoff(68)).toBe(20);
  });

  it('N=400 恰为 5% 与下限的交界,401 起 5% 分支生效', () => {
    expect(genericDfCutoff(400)).toBe(20);
    expect(genericDfCutoff(401)).toBe(21);
  });

  it('大仓库走 ceil(5%)(chatwoot N=2425 → 122)', () => {
    expect(genericDfCutoff(2425)).toBe(122);
  });
});

describe('referenceGraphCentrality(引用图加权入度,spec:2026-07-14-centrality-refgraph-design.md)', () => {
  it('叶子名成边:引用方指向定义块,中心度与 refsIn 都记账', () => {
    const chunks = [chunk('util.js'), chunk('main.js')];
    const leaves = [leaf('util.js', 'helperFn')];
    const sources = { 'util.js': 'export function helperFn() {}', 'main.js': 'helperFn();' };
    const { centrality, refsIn } = referenceGraphCentrality(chunks, leaves, sources);
    expect(centrality['util.js']).toBe(1);
    expect(centrality['main.js']).toBe(0);
    expect(refsIn['util.js']).toEqual([{ from: 'main.js', weight: 1, names: ['helperFn'] }]);
    expect(refsIn['main.js'] ?? []).toEqual([]);
  });

  it('fin 计数:同一引用文件出现 5 次,权重仍 1', () => {
    const chunks = [chunk('lib.js'), chunk('spam.js')];
    const leaves = [leaf('lib.js', 'thing')];
    const sources = { 'lib.js': 'thing', 'spam.js': 'thing thing thing thing thing' };
    const { refsIn } = referenceGraphCentrality(chunks, leaves, sources);
    expect(refsIn['lib.js']).toEqual([{ from: 'spam.js', weight: 1, names: ['thing'] }]);
  });

  it('身份名成边:import ApiClient 场景,叶子名不可见时块仍有入度', () => {
    const chunks = [chunk('ApiClient.js'), chunk('users.js')];
    const leaves = [leaf('ApiClient.js', 'get')]; // 只在定义文件出现,产不了叶子边
    const sources = {
      'ApiClient.js': 'export default class ApiClient {}',
      'users.js': "import ApiClient from './ApiClient';",
    };
    const { centrality, refsIn } = referenceGraphCentrality(chunks, leaves, sources);
    expect(refsIn['ApiClient.js']).toEqual([{ from: 'users.js', weight: 1, names: ['ApiClient'] }]);
    expect(centrality['ApiClient.js']).toBe(1);
  });

  it('rb 驼峰身份名:url_helper.rb 被 UrlHelper 引用成边', () => {
    const chunks = [chunk('app/helpers/url_helper.rb'), chunk('app/models/msg.rb')];
    const leaves = [leaf('app/helpers/url_helper.rb', 'build_url')];
    const sources = {
      'app/helpers/url_helper.rb': 'module UrlHelper; def build_url; end; end',
      'app/models/msg.rb': 'include UrlHelper',
    };
    const { refsIn } = referenceGraphCentrality(chunks, leaves, sources);
    expect(refsIn['app/helpers/url_helper.rb']).toEqual([
      { from: 'app/models/msg.rb', weight: 1, names: ['UrlHelper'] },
    ]);
  });

  it('非词 basename(foo-bar.js)不产身份名', () => {
    const chunks = [chunk('foo-bar.js'), chunk('user.js')];
    const leaves = [leaf('foo-bar.js', 'doThing')];
    const sources = { 'foo-bar.js': 'export const doThing = () => {};', 'user.js': 'bar(); foo();' };
    const { centrality, refsIn } = referenceGraphCentrality(chunks, leaves, sources);
    expect(refsIn['foo-bar.js'] ?? []).toEqual([]);
    expect(centrality).toEqual({}); // 无任何边 → 全零 → {}
  });

  it('df 截断作用于身份名:泛用文件名 index 不建边,具体叶子名照常', () => {
    const chunks = [chunk('lib/index.js'), ...Array.from({ length: 21 }, (_, i) => chunk(`c${i + 1}.js`))];
    const leaves = [leaf('lib/index.js', 'specialFn')];
    const sources: Record<string, string> = { 'lib/index.js': 'export const specialFn = () => {}; // index' };
    for (let i = 1; i <= 21; i++) sources[`c${i}.js`] = `import x from '../index';` + (i === 1 ? ' specialFn();' : '');
    // 22 文件,cutoff=20;index df=22(lib/index.js 注释 + c1..c21)→ 截;specialFn df=2 → 成边
    const { refsIn } = referenceGraphCentrality(chunks, leaves, sources);
    expect(refsIn['lib/index.js']).toEqual([{ from: 'c1.js', weight: 1, names: ['specialFn'] }]);
  });

  it('多定义均分:同名两定义者各得 0.5', () => {
    const chunks = [chunk('a.js'), chunk('b.js'), chunk('c.js')];
    const leaves = [leaf('a.js', 'sharedFn'), leaf('b.js', 'sharedFn')];
    const sources = { 'a.js': 'sharedFn', 'b.js': 'sharedFn', 'c.js': 'sharedFn();' };
    const { centrality, refsIn } = referenceGraphCentrality(chunks, leaves, sources);
    expect(refsIn['a.js']).toEqual([{ from: 'c.js', weight: 0.5, names: ['sharedFn'] }]);
    expect(refsIn['b.js']).toEqual([{ from: 'c.js', weight: 0.5, names: ['sharedFn'] }]);
    expect(centrality['a.js']).toBe(1); // 0.5 是全场最大 → 归一化 1
    expect(centrality['c.js']).toBe(0);
  });

  it('自引不成边:定义文件里出现自己的名字不计', () => {
    const chunks = [chunk('solo.js')];
    const leaves = [leaf('solo.js', 'me')];
    const sources = { 'solo.js': 'const me = () => me();' };
    expect(referenceGraphCentrality(chunks, leaves, sources)).toEqual({ centrality: {}, refsIn: {} });
  });

  it('同一引用方多名字:权重累加、names 字典序', () => {
    const chunks = [chunk('Util.js'), chunk('use.js')];
    const leaves = [leaf('Util.js', 'zip'), leaf('Util.js', 'alpha')];
    const sources = {
      'Util.js': 'export const zip = 1, alpha = 2;',
      'use.js': "import Util from './Util'; Util.zip(); Util.alpha();",
    };
    const { refsIn } = referenceGraphCentrality(chunks, leaves, sources);
    expect(refsIn['Util.js']).toEqual([{ from: 'use.js', weight: 3, names: ['Util', 'alpha', 'zip'] }]);
  });

  it('归一化:入度除以全场最大,无边块为 0', () => {
    const chunks = [chunk('pop.js'), chunk('mid.js'), chunk('u1.js'), chunk('u2.js')];
    const leaves = [leaf('pop.js', 'popFn'), leaf('mid.js', 'midFn')];
    const sources = {
      'pop.js': 'popFn', 'mid.js': 'midFn',
      'u1.js': 'popFn(); midFn();', 'u2.js': 'popFn();',
    };
    const { centrality } = referenceGraphCentrality(chunks, leaves, sources);
    expect(centrality['pop.js']).toBe(1);   // 入度 2
    expect(centrality['mid.js']).toBe(0.5); // 入度 1
    expect(centrality['u1.js']).toBe(0);
  });

  it('refsIn top-10:权重降序、平权 from 字典序、超出截断', () => {
    const chunks = [chunk('core.js'), ...Array.from({ length: 11 }, (_, i) => chunk(`f${String(i + 1).padStart(2, '0')}.js`))];
    const leaves = [leaf('core.js', 'coreFnA'), leaf('core.js', 'coreFnB')];
    const sources: Record<string, string> = { 'core.js': 'coreFnA coreFnB' };
    for (let i = 1; i <= 11; i++) sources[`f${String(i).padStart(2, '0')}.js`] = 'coreFnA' + (i === 11 ? '; coreFnB' : '');
    const { refsIn } = referenceGraphCentrality(chunks, leaves, sources);
    const list = refsIn['core.js'];
    expect(list).toHaveLength(10);
    expect(list[0]).toEqual({ from: 'f11.js', weight: 2, names: ['coreFnA', 'coreFnB'] }); // 权重最高在前
    expect(list.slice(1).map((r) => r.from)).toEqual(
      ['f01.js', 'f02.js', 'f03.js', 'f04.js', 'f05.js', 'f06.js', 'f07.js', 'f08.js', 'f09.js'],
    ); // 平权按 from 字典序,f10.js 被 top-10 截掉
  });

  it('非词名(valid?)走正则回退成边(尾缀 ? 要求后跟词字符,夹具用 valid?x 形式)', () => {
    const chunks = [chunk('m.rb'), chunk('n.rb')];
    const leaves = [leaf('m.rb', 'valid?')];
    const sources = { 'm.rb': 'def valid?; end', 'n.rb': 'x = valid?x' };
    const { centrality, refsIn } = referenceGraphCentrality(chunks, leaves, sources);
    expect(refsIn['m.rb']).toEqual([{ from: 'n.rb', weight: 1, names: ['valid?'] }]);
    expect(centrality['m.rb']).toBe(1);
  });
});
```

`test/cli.test.ts` 里既有的 `it('produces graded-tree JSON + map markdown for a repo', …)` 中,在 `expect(tree.grades).toBeDefined();` 之后加一行:

```ts
    expect(tree.refsIn).toBeDefined();
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/centrality.test.ts`
Expected: FAIL——`referenceGraphCentrality` 不存在。

- [ ] **Step 3: types.ts 加 schema**

`src/types.ts` 中,在 `export interface Tree {` **之前**插入:

```ts
/** 引用图入边(中心度 v2 顺产物;spec:2026-07-14-centrality-refgraph-design.md) */
export interface ChunkRefIn {
  from: NodeId;      // 引用方块 id
  weight: number;    // fin·多定义均分后的累计权重
  names: string[];   // 命中的名字,字典序
}

```

并把 `Tree` 接口改为(只加一行可选字段,旧 tree.json 与既有夹具零改动):

```ts
export interface Tree {
  repo: string;
  chapters: Chapter[];
  chunks: Chunk[];
  leaves: Leaf[];
  refsIn?: Record<NodeId, ChunkRefIn[]>;  // 每块入边 top-10,权重降序;平权 from 字典序
}
```

- [ ] **Step 4: centrality.ts 全文件替换**

`src/grade/centrality.ts` 全文件替换为(逐字照抄,不增不减):

```ts
import type { Leaf, Chunk, NodeId, ChunkRefIn } from '../types.js';

/**
 * v2 引用图中心度(2026-07-14,设计 spec:2026-07-14-centrality-refgraph-design.md):
 * 名字池 = 叶子名 ∪ 身份名(chunk.name;.rb 另加驼峰 url_helper→UrlHelper;非词 basename 不产),
 * df(名字出现过的文件数,含定义文件)> max(⌈5%N⌉,20) 的泛用名不建边;
 * 文件 f(非定义者)出现保留名字 ≥1 次即记 1(fin,防单文件刷分)→ 边 f→每个定义者,权重 1/定义者数;
 * 中心度 = 入边权重和归一化 0..1,全零 → {};refsIn = 每块入边 top-10(权重降序/平权 from 字典序/names 字典序)。
 *
 * 实测(chatwoot 2425 块):身份名边是最大单项增益(ApiClient #284→#14 级);PageRank 双仓实测
 * 差于加权入度(簇内自引环流霸榜),已否,数据留档 spec。身份名撞大众词的核心文件(message.rb)
 * 仍被低估——文本匹配固有局限。尾缀 ?/! 名字的 \b 怪癖原样继承(见 PR #14 spec)。
 * 仍是纯文本 token 级:「解析具体代码是复现阶段做的,不是读代码阶段做的」。
 */
const WORD = /[A-Za-z0-9_]+/g;
const isWordName = (s: string) => /^[A-Za-z0-9_]+$/.test(s);

export const GENERIC_DF_RATIO = 0.05;
export const GENERIC_DF_FLOOR = 20;
export const REFS_IN_TOP_K = 10;

export function genericDfCutoff(fileCount: number): number {
  return Math.max(Math.ceil(fileCount * GENERIC_DF_RATIO), GENERIC_DF_FLOOR);
}

/** url_helper → UrlHelper */
const camelize = (s: string) =>
  s.split('_').map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p)).join('');

export interface ReferenceGraphResult {
  centrality: Record<NodeId, number>;
  refsIn: Record<NodeId, ChunkRefIn[]>;
}

export function referenceGraphCentrality(
  chunks: Chunk[],
  leaves: Leaf[],
  sources: Record<string, string>,
): ReferenceGraphResult {
  // 名字池:name -> 定义者(块)文件集合
  const definers = new Map<string, Set<string>>();
  const addName = (name: string, file: string) => {
    if (!definers.has(name)) definers.set(name, new Set());
    definers.get(name)!.add(file);
  };
  for (const l of leaves) addName(l.name, l.file);
  for (const c of chunks) {
    if (isWordName(c.name)) addName(c.name, c.file);
    if (c.file.endsWith('.rb')) {
      const cam = camelize(c.name);
      if (isWordName(cam)) addName(cam, c.file);
    }
  }

  // 每文件词频表(词名的 df 与出现判定共用;与 \b 词边界定义严格一致)
  const tokenCounts = new Map<string, Map<string, number>>();
  for (const [file, src] of Object.entries(sources)) {
    const counts = new Map<string, number>();
    for (const m of src.matchAll(WORD)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
    tokenCounts.set(file, counts);
  }

  const cutoff = genericDfCutoff(Object.keys(sources).length);

  // 建边。键 `${from}\u0000${to}`——块 id 是相对路径,不含 NUL。
  const weights = new Map<string, number>();
  const edgeNames = new Map<string, string[]>();
  for (const [name, defs] of definers) {
    // 出现文件集合:词名查表;非词名 re.test(fin 只需存在性,不数次数)
    const hits: string[] = [];
    if (isWordName(name)) {
      for (const [f, counts] of tokenCounts) if (counts.has(name)) hits.push(f);
    } else {
      const re = new RegExp(`\\b${escapeRe(name)}\\b`);
      for (const [f, src] of Object.entries(sources)) if (re.test(src)) hits.push(f);
    }
    if (hits.length > cutoff) continue; // df 截断(df 含定义文件)
    const share = 1 / defs.size;
    for (const f of hits) {
      if (defs.has(f)) continue; // 自引不成边
      for (const d of defs) {
        const k = `${f}\u0000${d}`;
        weights.set(k, (weights.get(k) ?? 0) + share);
        if (!edgeNames.has(k)) edgeNames.set(k, []);
        edgeNames.get(k)!.push(name);
      }
    }
  }

  // 汇总:入度 + 每块入边
  const inDeg: Record<string, number> = {};
  for (const c of chunks) inDeg[c.file] = 0;
  const inEdges = new Map<string, ChunkRefIn[]>();
  for (const [k, w] of weights) {
    const [from, to] = k.split('\u0000');
    inDeg[to] = (inDeg[to] ?? 0) + w;
    if (!inEdges.has(to)) inEdges.set(to, []);
    inEdges.get(to)!.push({ from, weight: w, names: edgeNames.get(k)!.slice().sort() });
  }

  const max = Math.max(0, ...Object.values(inDeg));
  const centrality: Record<NodeId, number> = {};
  if (max > 0) for (const [f, n] of Object.entries(inDeg)) centrality[f] = n / max;

  const refsIn: Record<NodeId, ChunkRefIn[]> = {};
  for (const [to, list] of inEdges) {
    list.sort((a, b) => b.weight - a.weight || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    refsIn[to] = list.slice(0, REFS_IN_TOP_K);
  }
  return { centrality, refsIn };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

- [ ] **Step 5: cli.ts 换集成**

`src/cli.ts` 中,import 行:

```ts
import { nameFanInCentrality } from './grade/centrality.js';
```

改为:

```ts
import { referenceGraphCentrality } from './grade/centrality.js';
```

runMap 中这一段:

```ts
  const graded = gradeTree(tree, {
    relChurn: relativeChurn(log),
    coupling: changeCoupling(log),
    ownership: ownershipConcentration(log),
    centrality: nameFanInCentrality(tree.leaves, sources),
  });
```

改为:

```ts
  const ref = referenceGraphCentrality(tree.chunks, tree.leaves, sources);
  const graded = gradeTree({ ...tree, refsIn: ref.refsIn }, {
    relChurn: relativeChurn(log),
    coupling: changeCoupling(log),
    ownership: ownershipConcentration(log),
    centrality: ref.centrality,
  });
```

- [ ] **Step 6: 跑测试确认全绿**

Run: `npx vitest run test/centrality.test.ts test/cli.test.ts`
Expected: PASS——centrality 15 条(cutoff 3 + 图行为 12),cli.test 全绿(含新断言)。

- [ ] **Step 7: 全量测试 + 类型检查**

Run: `npm test`
Expected: 全绿(62 文件 / 282 测试;删 v1 系 11 条 + 增图行为 12 条,净 +1)。

Run: `npm run typecheck`
Expected: 零错误(尤其确认 `nameFanInCentrality` 无残余引用)。

- [ ] **Step 8: 提交**

```bash
git add src/types.ts src/grade/centrality.ts src/cli.ts test/centrality.test.ts test/cli.test.ts
git commit -m "feat: 中心度 v2——引用图(身份名+叶子名)加权入度,refsIn 落盘 tree.json"
```

(Windows PowerShell 5.1 下多行提交信息用单引号 here-string,结尾 `'@` 顶格;记得 Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>。)

---

## 真仓验收(主会话做,不属于实现任务)

1. chatwoot 重跑(带 key):哨兵容差 ±20%——conversation.rb ~#1、URLHelper ~#12、ApiClient ~#34、ReplyBox ~#9、conversations_controller ~#32、actions.js ~#77;`--no-label` 确定性 map <15s。
2. refsIn 物证:URLHelper 入边 names 含 `URLHelper`/`frontendURL`,from 打开真实源码核对 2-3 条。
3. verify 突变探针:conversation.rb 突变 → 镜像 spec 真变红。
4. umwelt 回归:入度 top-3 = path_tree/routes/grid;refsIn 核对 1-2 条。
5. 两真仓零接触;HANDOFF、记忆更新。
