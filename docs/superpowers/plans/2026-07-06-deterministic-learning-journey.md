# easyReview 计划② — 确定性学习旅程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Plan ① 的接地地图变成一段"可走的学习旅程"：从分级树排出学习路径（简单/低风险起步 → 核心，带防盲区觅食），持久化进度，渲染进度条 + 每步卡片，并让地图随进度点亮。

**Architecture:** 纯确定性、无 LLM。复用 Plan ① `easyreview map` 产出的 `easyreview.tree.json`（GradedTree）。新增：路径排序（`path/`）、进度持久化（`progress/`）、旅程渲染（`render/journey-md.ts`）、地图点亮（扩展 `render/map-md.ts`）、CLI `learn`/`done`。LLM 贴标签是独立的 Plan ②-LLM，本计划不含。

**Tech Stack:** Node 20+, TypeScript(ESM), vitest。承接 Plan ① 的 `src/types.ts`、`GradedTree`、`easyreview.tree.json`。

**前置：** Plan ① 已完成（`impl/engine-foundation` 已并入 `main`）。本计划在新分支 `impl/learning-journey` 上做。

---

## 文件结构

```
easyReview/
  src/
    types.ts               # T1 追加 LearningStep / JourneyPath / Progress
    path/
      sequence.ts          # T2 buildPath(gradedTree) → 有序步骤 + 觅食邻居
    progress/
      progress.ts          # T3 load/save/mark/percent
    render/
      journey-md.ts        # T4 进度条 + 当前步卡片
      map-md.ts            # T5 扩展：可选 understood 高亮（点亮章）
    cli-learn.ts           # T6 runLearn / runDone
    cli.ts                 # T6 wire `learn` / `done` 命令（承接 Plan ①）
  test/
    *.test.ts
```

工作流：`easyreview map`（Plan ①，产出 tree.json）→ `easyreview learn`（读 tree.json，写 journey.md + progress.json）→ `easyreview done <chunkId>`（更新 progress.json，重渲 journey.md）。

---

### Task 1: 追加旅程类型

**Files:** Modify: `src/types.ts`; Test: `test/journey-types.test.ts`

- [ ] **Step 1: 写会失败的测试 test/journey-types.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import type { LearningStep, JourneyPath, Progress } from '../src/types.js';

describe('journey types', () => {
  it('shapes are usable', () => {
    const step: LearningStep = {
      chunkId: 'a.rs', order: 0, chapterId: 'foo:src', difficulty: 0.1, neighbors: ['b.rs'],
    };
    const path: JourneyPath = { repo: '/x', steps: [step] };
    const p: Progress = { version: 1, understood: ['a.rs'] };
    expect(path.steps[0].chunkId).toBe('a.rs');
    expect(p.understood).toContain('a.rs');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- journey-types`  Expected: FAIL（类型未定义）。

- [ ] **Step 3: 在 src/types.ts 末尾追加**

```ts
export interface LearningStep {
  chunkId: NodeId;
  order: number;          // 0-based 路径位置
  chapterId: NodeId;
  difficulty: number;     // 0..1 复合（越低越早学）
  neighbors: NodeId[];    // 同章其它 chunk（防盲区觅食）
}

export interface JourneyPath {
  repo: string;
  steps: LearningStep[];  // 已按学习序排好
}

export interface Progress {
  version: 1;
  understood: NodeId[];   // 已标记理解的 chunk id
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- journey-types`  Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/types.ts test/journey-types.test.ts
git commit -m "feat(types): learning journey types (LearningStep/JourneyPath/Progress)"
```

---

### Task 2: 学习路径排序（含觅食邻居）

**Files:** Create: `src/path/sequence.ts`, `test/sequence.test.ts`

说明：难度 = 0.5·贡献度 + 0.3·风险 + 0.2·size（都取自 grade，0..1）。章按其 chunk 的最小难度排序；章内按难度升序。每步的 `neighbors` = 同章其它 chunk（逼学习者在路径周围觅食，防盲区）。

- [ ] **Step 1: 写会失败的测试 test/sequence.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { buildPath } from '../src/path/sequence.js';
import type { GradedTree } from '../src/types.js';

function tree(): GradedTree {
  const mk = (id: string, contribution: number, risk: number, size: number) => ({
    id, name: id.replace('.rs',''), file: id, crate: 'foo', leafIds: [],
  });
  return {
    repo: '/x',
    chapters: [
      { id: 'foo:core', name: 'foo::core', crate: 'foo', dir: 'core', chunkIds: ['hard.rs'] },
      { id: 'foo:util', name: 'foo::util', crate: 'foo', dir: 'util', chunkIds: ['easy.rs', 'mid.rs'] },
    ],
    chunks: [mk('hard.rs',1,1,1), mk('easy.rs',0,0,0), mk('mid.rs',0.5,0.3,0.4)] as any,
    leaves: [],
    grades: {
      'hard.rs': { risk:1, riskBucket:'high', contribution:1, contribBucket:'high', signals:{relChurn:0,coupling:0,ownership:0,centrality:1,sizeNorm:1} },
      'easy.rs': { risk:0, riskBucket:'none', contribution:0, contribBucket:'filler', signals:{relChurn:0,coupling:0,ownership:0,centrality:0,sizeNorm:0} },
      'mid.rs': { risk:0.3, riskBucket:'low', contribution:0.5, contribBucket:'med', signals:{relChurn:0,coupling:0,ownership:0,centrality:0.5,sizeNorm:0.4} },
    },
  };
}

describe('buildPath', () => {
  it('orders simple/low-risk first, core last, with foraging neighbors', () => {
    const path = buildPath(tree());
    expect(path.steps.map((s) => s.chunkId)).toEqual(['easy.rs', 'mid.rs', 'hard.rs']);
    expect(path.steps[0].order).toBe(0);
    // easy 与 mid 同章 → 互为觅食邻居
    expect(path.steps[0].neighbors).toContain('mid.rs');
    // hard 独章 → 无邻居
    expect(path.steps[2].neighbors).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- sequence`  Expected: FAIL。

- [ ] **Step 3: 实现 src/path/sequence.ts**

```ts
import type { GradedTree, JourneyPath, LearningStep, NodeId } from '../types.js';

function difficultyOf(g: GradedTree, chunkId: NodeId): number {
  const grade = g.grades[chunkId];
  if (!grade) return 1;
  return 0.5 * grade.contribution + 0.3 * grade.risk + 0.2 * grade.signals.sizeNorm;
}

export function buildPath(g: GradedTree): JourneyPath {
  const chunkChapter: Record<NodeId, NodeId> = {};
  for (const ch of g.chapters) for (const id of ch.chunkIds) chunkChapter[id] = ch.id;

  const diff: Record<NodeId, number> = {};
  for (const c of g.chunks) diff[c.id] = difficultyOf(g, c.id);

  // 章序 = 该章 chunk 的最小难度
  const chapterMin: Record<NodeId, number> = {};
  for (const ch of g.chapters) {
    chapterMin[ch.id] = ch.chunkIds.length
      ? Math.min(...ch.chunkIds.map((id) => diff[id] ?? 1))
      : 1;
  }

  const ordered = [...g.chunks].sort((a, b) => {
    const chA = chunkChapter[a.id];
    const chB = chunkChapter[b.id];
    const ca = chapterMin[chA] ?? 1;
    const cb = chapterMin[chB] ?? 1;
    if (ca !== cb) return ca - cb;
    if (chA !== chB) return chA < chB ? -1 : 1; // chapterMin 打平时按 chapterId 保证章内连续
    return diff[a.id] - diff[b.id];
  });

  const neighborsOf = (id: NodeId): NodeId[] => {
    const ch = g.chapters.find((c) => c.id === chunkChapter[id]);
    return ch ? ch.chunkIds.filter((x) => x !== id) : [];
  };

  const steps: LearningStep[] = ordered.map((c, i) => ({
    chunkId: c.id,
    order: i,
    chapterId: chunkChapter[c.id],
    difficulty: diff[c.id],
    neighbors: neighborsOf(c.id),
  }));

  return { repo: g.repo, steps };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- sequence`  Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/path/sequence.ts test/sequence.test.ts
git commit -m "feat(path): learning-path sequencing with foraging neighbors"
```

---

### Task 3: 进度持久化

**Files:** Create: `src/progress/progress.ts`, `test/progress.test.ts`

- [ ] **Step 1: 写会失败的测试 test/progress.test.ts**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProgress, saveProgress, markUnderstood, percentComplete } from '../src/progress/progress.js';

let dirs: string[] = [];
afterEach(() => { dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); dirs = []; });

describe('progress', () => {
  it('returns empty progress when file missing', () => {
    const d = mkdtempSync(join(tmpdir(), 'ezp-')); dirs.push(d);
    const p = loadProgress(join(d, 'nope.json'));
    expect(p).toEqual({ version: 1, understood: [] });
  });

  it('mark is idempotent and round-trips through save/load', () => {
    const d = mkdtempSync(join(tmpdir(), 'ezp-')); dirs.push(d);
    const file = join(d, 'easyreview.progress.json');
    let p = loadProgress(file);
    p = markUnderstood(p, 'a.rs');
    p = markUnderstood(p, 'a.rs'); // 幂等
    p = markUnderstood(p, 'b.rs');
    saveProgress(file, p);
    const loaded = loadProgress(file);
    expect(loaded.understood).toEqual(['a.rs', 'b.rs']);
  });

  it('percentComplete rounds understood/total', () => {
    expect(percentComplete(0, { version: 1, understood: [] })).toBe(0);
    expect(percentComplete(4, { version: 1, understood: ['a', 'b'] })).toBe(50);
    expect(percentComplete(3, { version: 1, understood: ['a'] })).toBe(33);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- progress`  Expected: FAIL。

- [ ] **Step 3: 实现 src/progress/progress.ts**

```ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { Progress, NodeId } from '../types.js';

export function loadProgress(file: string): Progress {
  if (!existsSync(file)) return { version: 1, understood: [] };
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const understood = Array.isArray(raw?.understood) ? (raw.understood as NodeId[]) : [];
  return { version: 1, understood };
}

export function saveProgress(file: string, p: Progress): void {
  writeFileSync(file, JSON.stringify(p, null, 2));
}

export function markUnderstood(p: Progress, chunkId: NodeId): Progress {
  if (p.understood.includes(chunkId)) return p;
  return { version: 1, understood: [...p.understood, chunkId] };
}

export function percentComplete(total: number, p: Progress): number {
  if (total === 0) return 0;
  return Math.round((p.understood.length / total) * 100);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- progress`  Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/progress/progress.ts test/progress.test.ts
git commit -m "feat(progress): persist learner progress (load/save/mark/percent)"
```

---

### Task 4: 旅程渲染（进度条 + 当前步卡片）

**Files:** Create: `src/render/journey-md.ts`, `test/journey-md.test.ts`

说明：新手入口。渲染进度条 + "下一步"（第一个未理解的步骤）的卡片：所在章、文件、风险/贡献度、为什么现在学、它的函数、自测三问、觅食邻居、`done` 提示。

- [ ] **Step 1: 写会失败的测试 test/journey-md.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { renderJourneyMarkdown } from '../src/render/journey-md.js';
import type { GradedTree, JourneyPath, Progress } from '../src/types.js';

const g: GradedTree = {
  repo: '/x',
  chapters: [{ id: 'foo:util', name: 'foo::util', crate: 'foo', dir: 'util', chunkIds: ['easy.rs', 'mid.rs'] }],
  chunks: [
    { id: 'easy.rs', name: 'easy', file: 'easy.rs', crate: 'foo', leafIds: ['easy.rs::a::1'] },
    { id: 'mid.rs', name: 'mid', file: 'mid.rs', crate: 'foo', leafIds: [] },
  ],
  leaves: [{ id: 'easy.rs::a::1', kind: 'fn', name: 'a', file: 'easy.rs', startLine: 1, endLine: 3, loc: 3 }],
  grades: {
    'easy.rs': { risk:0, riskBucket:'none', contribution:0, contribBucket:'filler', signals:{relChurn:0,coupling:0,ownership:0,centrality:0,sizeNorm:0} },
    'mid.rs': { risk:0.3, riskBucket:'low', contribution:0.5, contribBucket:'med', signals:{relChurn:0,coupling:0,ownership:0,centrality:0.5,sizeNorm:0.4} },
  },
};
const path: JourneyPath = {
  repo: '/x',
  steps: [
    { chunkId: 'easy.rs', order: 0, chapterId: 'foo:util', difficulty: 0, neighbors: ['mid.rs'] },
    { chunkId: 'mid.rs', order: 1, chapterId: 'foo:util', difficulty: 0.4, neighbors: ['easy.rs'] },
  ],
};

describe('renderJourneyMarkdown', () => {
  it('shows progress bar and the next unmastered step card', () => {
    const progress: Progress = { version: 1, understood: [] };
    const md = renderJourneyMarkdown(g, path, progress);
    expect(md).toContain('# easyReview 学习旅程');
    expect(md).toContain('0%');
    expect(md).toContain('easy');            // 下一步是 easy.rs
    expect(md).toContain('easyreview done easy.rs');
    expect(md).toContain('`a`');             // 列出函数
    expect(md).toContain('mid');             // 觅食邻居
  });

  it('advances to next step and updates percent when one is understood', () => {
    const progress: Progress = { version: 1, understood: ['easy.rs'] };
    const md = renderJourneyMarkdown(g, path, progress);
    expect(md).toContain('50%');
    expect(md).toContain('easyreview done mid.rs'); // 现在下一步是 mid
  });

  it('celebrates when all understood', () => {
    const progress: Progress = { version: 1, understood: ['easy.rs', 'mid.rs'] };
    const md = renderJourneyMarkdown(g, path, progress);
    expect(md).toContain('100%');
    expect(md).toContain('🎉');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- journey-md`  Expected: FAIL。

- [ ] **Step 3: 实现 src/render/journey-md.ts**

```ts
import type { GradedTree, JourneyPath, Progress, Grade, RiskBucket, ContribBucket } from '../types.js';

const RISK: Record<RiskBucket, string> = { high: '高', med: '中', low: '低', none: '无' };
const CONTRIB: Record<ContribBucket, string> = { filler: '填充', low: '低', med: '中', high: '高' };

function whyNow(grade: Grade): string {
  if (grade.contribBucket === 'filler') return '简单、重复、低风险——用来先熟悉项目的词汇与惯用法。';
  if (grade.riskBucket === 'high') return '高风险核心：改错代价大，是你最终要吃透的部分。';
  if (grade.contribBucket === 'high') return '架构中心：很多东西依赖它，理解它能解锁一大片。';
  return '难度适中，承上启下。';
}

function bar(pct: number): string {
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

export function renderJourneyMarkdown(g: GradedTree, path: JourneyPath, progress: Progress): string {
  const understood = new Set(progress.understood);
  const total = path.steps.length;
  const done = progress.understood.length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const lines: string[] = [];
  lines.push('# easyReview 学习旅程');
  lines.push('');
  lines.push(`进度 \`[${bar(pct)}]\` ${pct}%  （已理解 ${done}/${total}）`);
  lines.push('');

  const next = path.steps.find((s) => !understood.has(s.chunkId));
  if (!next) {
    lines.push('🎉 全部走完——你已经走遍这个项目。回头看地图，它现在应该读得懂了。');
    return lines.join('\n');
  }

  const chunk = g.chunks.find((c) => c.id === next.chunkId)!;
  const grade = g.grades[next.chunkId];
  const chapter = g.chapters.find((c) => c.id === next.chapterId)!;
  const leaves = g.leaves.filter((l) => l.file === next.chunkId);

  lines.push(`## 下一步（第 ${next.order + 1}/${total} 步）：\`${chunk.name}\``);
  lines.push('');
  lines.push(`- 所在章：${chapter.name}`);
  lines.push(`- 文件：\`${chunk.file}\``);
  lines.push(`- 风险：${RISK[grade.riskBucket]} · 架构贡献度：${CONTRIB[grade.contribBucket]}`);
  lines.push(`- 为什么现在学它：${whyNow(grade)}`);
  lines.push('');
  lines.push(`### 它有哪些函数（${leaves.length}）`);
  if (leaves.length === 0) lines.push('- （本文件无独立函数，可能是模块声明/重导出）');
  for (const l of leaves) lines.push(`- \`${l.name}\`  (${l.file}:${l.startLine}-${l.endLine})`);
  lines.push('');
  lines.push('### 自测（答得上来再标记理解）');
  lines.push('- 这个块对外做什么？用一句话说清它的职责。');
  lines.push('- 它读/写了哪些状态或数据？');
  lines.push('- 谁会调用它、它又依赖谁？');
  lines.push('');
  if (next.neighbors.length) {
    lines.push('### 顺便看看（防盲区觅食）');
    lines.push('同章相邻，别只盯着这一条路径：');
    for (const n of next.neighbors.slice(0, 6)) {
      const nc = g.chunks.find((c) => c.id === n);
      if (nc) lines.push(`- \`${nc.name}\` (\`${n}\`)${understood.has(n) ? ' ✓' : ''}`);
    }
    lines.push('');
  }
  lines.push('---');
  lines.push(`理解了就运行：\`easyreview done ${chunk.id}\``);
  return lines.join('\n');
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- journey-md`  Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/render/journey-md.ts test/journey-md.test.ts
git commit -m "feat(render): learning-journey markdown (progress bar + next-step card)"
```

---

### Task 5: 地图点亮（可选 understood 高亮）

**Files:** Modify: `src/render/map-md.ts`; Test: `test/map-md-lit.test.ts`

说明：给 `renderMapMarkdown` 加一个**可选**第二参数 `understood?: Set<NodeId>`（chunk id 集合）。某章的所有 chunk 都被理解 → 章名前加 `✓ `。不传时行为与 Plan ① 完全一致（旧测试仍过）。

- [ ] **Step 1: 写会失败的测试 test/map-md-lit.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { renderMapMarkdown } from '../src/render/map-md.js';
import type { GradedTree } from '../src/types.js';

const g: GradedTree = {
  repo: '/x',
  chapters: [
    { id: 'foo:done', name: 'foo::done', crate: 'foo', dir: 'done', chunkIds: ['a.rs'] },
    { id: 'foo:todo', name: 'foo::todo', crate: 'foo', dir: 'todo', chunkIds: ['b.rs'] },
  ],
  chunks: [
    { id: 'a.rs', name: 'a', file: 'a.rs', crate: 'foo', leafIds: [] },
    { id: 'b.rs', name: 'b', file: 'b.rs', crate: 'foo', leafIds: [] },
  ],
  leaves: [],
  grades: {
    'a.rs': { risk:0.9, riskBucket:'high', contribution:0.9, contribBucket:'high', signals:{} as any },
    'b.rs': { risk:0.1, riskBucket:'none', contribution:0.1, contribBucket:'filler', signals:{} as any },
  },
};

describe('renderMapMarkdown lit', () => {
  it('marks fully-understood chapters with a check when understood set given', () => {
    const md = renderMapMarkdown(g, new Set(['a.rs']));
    expect(md).toContain('✓ foo::done');
    expect(md).toContain('foo::todo');
    expect(md).not.toContain('✓ foo::todo');
  });

  it('no argument keeps Plan-1 behavior (no checks)', () => {
    const md = renderMapMarkdown(g);
    expect(md).not.toContain('✓');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- map-md-lit`  Expected: FAIL。

- [ ] **Step 3: 修改 src/render/map-md.ts**

把签名与 `chapterBuckets`/落格逻辑改为支持可选 `understood`。完整替换后的文件：

```ts
import type { GradedTree, Chapter, RiskBucket, ContribBucket, NodeId } from '../types.js';

const RISK_ROWS: RiskBucket[] = ['high', 'med', 'low', 'none'];
const CONTRIB_COLS: ContribBucket[] = ['filler', 'low', 'med', 'high'];
const RISK_LABEL: Record<RiskBucket, string> = { high: '风险 高', med: '风险 中', low: '风险 低', none: '风险 无' };
const CONTRIB_LABEL: Record<ContribBucket, string> = { filler: '填充', low: '低', med: '中', high: '高' };

function mode<T>(xs: T[]): T {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function chapterBuckets(ch: Chapter, g: GradedTree): { risk: RiskBucket; contrib: ContribBucket } {
  const rs = ch.chunkIds.map((id) => g.grades[id].riskBucket);
  const cs = ch.chunkIds.map((id) => g.grades[id].contribBucket);
  return { risk: mode(rs), contrib: mode(cs) };
}

function isLit(ch: Chapter, understood: Set<NodeId>): boolean {
  return ch.chunkIds.length > 0 && ch.chunkIds.every((id) => understood.has(id));
}

export function renderMapMarkdown(g: GradedTree, understood?: Set<NodeId>): string {
  const grid = new Map<string, string[]>();
  for (const ch of g.chapters) {
    const { risk, contrib } = chapterBuckets(ch, g);
    const key = `${risk}|${contrib}`;
    const label = understood && isLit(ch, understood) ? `✓ ${ch.name}` : ch.name;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push(label);
  }

  const lines: string[] = [];
  lines.push('# easyReview 地图');
  lines.push('');
  lines.push(
    '> 接地地图：章按 git 历史算出的风险 × 架构贡献度落位。从左下（填充/低风险）起步，爬向右上核心。' +
      (understood ? '✓ = 已走完。' : ''),
  );
  lines.push('');
  lines.push(`| | ${CONTRIB_COLS.map((c) => CONTRIB_LABEL[c]).join(' | ')} |`);
  lines.push(`|---|${CONTRIB_COLS.map(() => '---').join('|')}|`);
  for (const risk of RISK_ROWS) {
    const cells = CONTRIB_COLS.map((contrib) => {
      const names = grid.get(`${risk}|${contrib}`) ?? [];
      return names.join('<br>') || '·';
    });
    lines.push(`| **${RISK_LABEL[risk]}** | ${cells.join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}
```

- [ ] **Step 4: 运行确认通过（含 Plan ① 旧测试）**

Run: `npm test -- map-md`  Expected: PASS（`map-md.test.ts` 与 `map-md-lit.test.ts` 都过）。

- [ ] **Step 5: Commit**

```bash
git add src/render/map-md.ts test/map-md-lit.test.ts
git commit -m "feat(render): optional understood-chapter highlighting on the map"
```

---

### Task 6: CLI `learn` / `done` + 冒烟

**Files:** Create: `src/cli-learn.ts`, `test/cli-learn.test.ts`; Modify: `src/cli.ts`

说明：`learn` 读 `easyreview.tree.json`（Plan ① 产出），构建路径，加载进度，写 `easyreview.journey.md` + 点亮的 `easyreview.map.md`，并确保 `easyreview.progress.json` 存在。`done <chunkId>` 加载 tree+progress，标记理解，保存，重渲。

- [ ] **Step 1: 写会失败的测试 test/cli-learn.test.ts**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { runMap } from '../src/cli.js';
import { runLearn, runDone } from '../src/cli-learn.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

describe('learn / done', () => {
  it('learn writes journey + progress; done advances progress', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'crates/foo/src/lib.rs', 'pub fn a() { b(); }\nfn b() {}');
    writeRepoFile(dir, 'crates/foo/src/util.rs', 'pub fn util() {}');
    writeRepoFile(dir, 'crates/foo/src/extra.rs', 'pub fn extra() {}');
    // 需 ≥3 chunk：否则 done 后进度=50%/100%，而 '50%'.includes('0%') 为真，断言 not.toContain('0%') 假失败
    commitAll(dir, 'init');

    await runMap({ repo: dir, outDir: dir });         // 产出 tree.json
    await runLearn({ outDir: dir });                  // 读 tree.json → journey + progress

    expect(existsSync(join(dir, 'easyreview.journey.md'))).toBe(true);
    expect(existsSync(join(dir, 'easyreview.progress.json'))).toBe(true);
    const journey = readFileSync(join(dir, 'easyreview.journey.md'), 'utf8');
    expect(journey).toContain('# easyReview 学习旅程');
    expect(journey).toContain('0%');

    // 找到第一步的 chunkId 并标记理解
    const firstDone = journey.match(/easyreview done (\S+)/)![1];
    await runDone({ outDir: dir, chunkId: firstDone });

    const progress = JSON.parse(readFileSync(join(dir, 'easyreview.progress.json'), 'utf8'));
    expect(progress.understood).toContain(firstDone);
    const journey2 = readFileSync(join(dir, 'easyreview.journey.md'), 'utf8');
    expect(journey2).not.toContain('0%'); // 进度前进
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- cli-learn`  Expected: FAIL（runLearn/runDone 未定义）。

- [ ] **Step 3: 实现 src/cli-learn.ts**

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GradedTree } from './types.js';
import { buildPath } from './path/sequence.js';
import { loadProgress, saveProgress, markUnderstood } from './progress/progress.js';
import { renderJourneyMarkdown } from './render/journey-md.js';
import { renderMapMarkdown } from './render/map-md.js';

function loadTree(outDir: string): GradedTree {
  const p = join(outDir, 'easyreview.tree.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as GradedTree;
  } catch {
    throw new Error(`找不到 ${p}——先运行 \`easyreview map --repo <path> --out ${outDir}\``);
  }
}

function progressPath(outDir: string): string {
  return join(outDir, 'easyreview.progress.json');
}

/** 从当前 tree + progress 重渲 journey.md 与点亮的 map.md。 */
function rerender(outDir: string, tree: GradedTree): void {
  const path = buildPath(tree);
  const progress = loadProgress(progressPath(outDir));
  writeFileSync(join(outDir, 'easyreview.journey.md'), renderJourneyMarkdown(tree, path, progress));
  writeFileSync(join(outDir, 'easyreview.map.md'), renderMapMarkdown(tree, new Set(progress.understood)));
}

export interface LearnOptions { outDir: string; }
export async function runLearn(opts: LearnOptions): Promise<void> {
  const tree = loadTree(opts.outDir);
  // 确保 progress.json 存在
  const p = loadProgress(progressPath(opts.outDir));
  saveProgress(progressPath(opts.outDir), p);
  rerender(opts.outDir, tree);
}

export interface DoneOptions { outDir: string; chunkId: string; }
export async function runDone(opts: DoneOptions): Promise<void> {
  const tree = loadTree(opts.outDir);
  const file = progressPath(opts.outDir);
  const updated = markUnderstood(loadProgress(file), opts.chunkId);
  saveProgress(file, updated);
  rerender(opts.outDir, tree);
}
```

- [ ] **Step 4: 在 src/cli.ts 末尾追加 learn/done 命令分发**

找到 Plan ① cli.ts 末尾的 `if (cmd === 'map') { ... }` 块，在其**后面**追加（不改动 map 分支）：

```ts
if (cmd === 'learn') {
  import('./cli-learn.js').then(({ runLearn }) =>
    runLearn({ outDir: parseArgs(process.argv.slice(3)).outDir })
      .then(() => console.log('✓ wrote easyreview.journey.md + progress + lit map'))
      .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); }),
  );
}

if (cmd === 'done') {
  const rest = process.argv.slice(3);
  const chunkId = rest.find((a) => !a.startsWith('--'));
  if (!chunkId) { console.error('用法: easyreview done <chunkId> [--out <dir>]'); process.exit(1); }
  import('./cli-learn.js').then(({ runDone }) =>
    runDone({ outDir: parseArgs(rest).outDir, chunkId })
      .then(() => console.log(`✓ marked ${chunkId} understood`))
      .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); }),
  );
}
```

（`parseArgs` 是 Plan ① cli.ts 已有的函数，返回 `{repo, outDir}`；这里复用它取 `--out`。）

- [ ] **Step 5: 在 package.json scripts 追加便捷命令**

在 `scripts` 里加两行（与已有 `map` 并列）：

```json
"learn": "tsx src/cli.ts learn",
"done": "tsx src/cli.ts done"
```

- [ ] **Step 6: 运行确认通过 + 全量**

Run: `npm test -- cli-learn`  Expected: PASS。
Run: `npm test`  Expected: 全部 PASS。
Run: `npx tsc --noEmit`  Expected: 干净。

- [ ] **Step 7: 对真实 umwelt-bevy 冒烟（观察验证）**

```bash
npm run map -- --repo D:/dev/umwelt-bevy --out .
npm run learn -- --out .
```
Expected：生成 `easyreview.journey.md`（进度 0%、下一步是某个填充/低风险块，如 constants 或 puzzles 下的小文件）、`easyreview.progress.json`、点亮的 `easyreview.map.md`。
人工核对：journey 的"下一步"应是简单/低风险块（不是 routing/eval_viewer）；`done` 一个块后进度前进、地图对应格出现 `✓`（当该章 chunk 全标记后）。

- [ ] **Step 8: Commit**

```bash
git add src/cli-learn.ts test/cli-learn.test.ts src/cli.ts package.json
git commit -m "feat(cli): learn/done commands — walkable learning journey"
```

- [ ] **Step 9: 忽略新生成物**

```bash
printf 'easyreview.journey.md\neasyreview.progress.json\n' >> .gitignore
git add .gitignore
git commit -m "chore: ignore generated journey + progress artifacts"
```

---

## 自查（Self-Review）

**Spec 覆盖**（对 `2026-07-05-easyreview-design.md` §9 v1a）：
- 学习路径（填充/低风险起步→核心，带觅食缺口防盲区）→ Task 2 ✓（难度升序 + neighbors）
- 进度持久化 → Task 3 ✓
- 进度条 + 每块卡片渲染 → Task 4 ✓
- 地图随进度点亮 → Task 5 ✓
- CLI 走查（learn/done）→ Task 6 ✓
- **本计划明确不含**：LLM 贴标签（Plan ②-LLM）、Gistify 执行验证（Plan ③）。与 spec §9 里程碑一致。
- 防盲区铁律（spec §3.4）：路径只"建议下一步 + neighbors 觅食 + 自测三问兜底"，非单轨 ✓。

**占位符扫描**：无 TBD/TODO；每步含完整代码。

**类型一致性**：`LearningStep/JourneyPath/Progress` 源自 Task 1；`GradedTree/Grade/RiskBucket/ContribBucket/NodeId/Leaf/Chapter/Chunk` 源自 Plan ① `types.ts`；`buildPath(GradedTree)→JourneyPath`、`renderJourneyMarkdown(GradedTree,JourneyPath,Progress)`、`renderMapMarkdown(GradedTree, understood?)` 签名贯穿一致；chunk.id=文件路径贯穿 sequence/progress/render/cli；`parseArgs`/`runMap` 复用 Plan ① 既有导出。

**已知 v1 近似（诚实标注）**：难度排序是纯启发式（贡献0.5+风险0.3+size0.2），非依赖图拓扑排序；"理解"验收是自测+自标（硬验收是 Plan ③ Gistify）；卡片标签用文件名（LLM 标签是 Plan ②-LLM）。均在 spec §11 风险清单内。
