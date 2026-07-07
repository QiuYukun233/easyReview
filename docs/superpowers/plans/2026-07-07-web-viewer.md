# web viewer（点亮地图 + 进度条）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `easyreview serve` 起本地 web viewer——风险×贡献度网格随进度点亮、右侧固定"下一步"卡片、页面可"标记已理解"（写同一份 progress.json）、亮/暗主题。

**Architecture:** 静态壳 + JSON API。`node:http` 服务三个路由：`GET /`（内嵌 CSS/JS 单页）、`GET /api/state`（每请求现读 tree/labels/progress 合并为 ViewerState）、`POST /api/done`（复用 progress 模块写 understood）。核心逻辑（state 组装、done 校验）是纯函数/可注入，单测不碰网络；HTTP 层用真 server + 随机端口测。viewer 只消费 CLI 生成的 JSON——铁律不动。

**Tech Stack:** Node 20+（`node:http`、全局 `fetch`）/ TypeScript(ESM，import 带 `.js` 后缀) / vitest / 前端原生 HTML/CSS/JS（零依赖零构建）。

> spec：`docs/superpowers/specs/2026-07-07-web-viewer-design.md`。
> vitest 不做类型检查（esbuild 抹类型）——每个任务收尾都要跑 `npm run typecheck`。
> Shell 是 Windows PowerShell 5.1（无 `&&`，用 `;`）或 Bash 工具。

---

## 文件结构

| 路径 | 职责 | 动作 |
|---|---|---|
| `src/serve/state.ts` | `buildViewerState(tree, labels, progress)` 纯函数 → ViewerState | Create |
| `src/serve/done.ts` | `applyDone(tree, outDir, chunkId)`：校验 + 复用 progress 模块写盘 | Create |
| `src/serve/page.ts` | `renderPage()`：内嵌 CSS/JS 的 index.html 字符串 | Create |
| `src/serve/server.ts` | `createViewerServer(outDir)`：路由分发、错误兜底 | Create |
| `src/cli-serve.ts` | `runServe({outDir, port})`：监听 + 打印 URL | Create |
| `src/cli.ts` | 加 `serve` 命令分发 | Modify |
| `src/render/journey-md.ts` | `whyNow` 加 `export`（静态回退文案复用） | Modify |
| `package.json` | 加 `"serve"` script | Modify |
| `test/viewer-fixture.ts` | 共享测试夹具：小 GradedTree/LabelCache | Create |
| `test/viewer-state.test.ts` / `test/serve-done.test.ts` / `test/serve-page.test.ts` / `test/serve-http.test.ts` | 各层测试 | Create |

---

## Task 1: `buildViewerState` 纯函数（+ 导出 whyNow）

**Files:**
- Create: `src/serve/state.ts`, `test/viewer-fixture.ts`
- Modify: `src/render/journey-md.ts`（仅一处加 export）
- Test: `test/viewer-state.test.ts`

- [ ] **Step 1: `src/render/journey-md.ts` 把私有 `whyNow` 导出**

第 6 行 `function whyNow(grade: Grade): string {` 改为：

```ts
export function whyNow(grade: Grade): string {
```

其余一字不动（`renderJourneyMarkdown` 内部继续用它，行为不变）。

- [ ] **Step 2: 创建共享夹具 `test/viewer-fixture.ts`**

```ts
import type { GradedTree, LabelCache } from '../src/types.js';

/** 2 章 3 块 2 叶的小树：a.rs(有函数/有标签/filler..none)、b.rs(核心 high:high)、c.rs(另一章、无叶子)。 */
export function makeViewerTree(): GradedTree {
  return {
    repo: '/fake',
    chapters: [
      { id: 'foo:src', name: 'foo::src', crate: 'foo', dir: 'src', chunkIds: ['crates/foo/src/a.rs', 'crates/foo/src/b.rs'] },
      { id: 'bar:src', name: 'bar::src', crate: 'bar', dir: 'src', chunkIds: ['crates/bar/src/c.rs'] },
    ],
    chunks: [
      { id: 'crates/foo/src/a.rs', name: 'a', file: 'crates/foo/src/a.rs', crate: 'foo', leafIds: ['crates/foo/src/a.rs::f1::1', 'crates/foo/src/a.rs::f2::5'] },
      { id: 'crates/foo/src/b.rs', name: 'b', file: 'crates/foo/src/b.rs', crate: 'foo', leafIds: [] },
      { id: 'crates/bar/src/c.rs', name: 'c', file: 'crates/bar/src/c.rs', crate: 'bar', leafIds: [] },
    ],
    leaves: [
      { id: 'crates/foo/src/a.rs::f1::1', kind: 'fn', name: 'f1', file: 'crates/foo/src/a.rs', startLine: 1, endLine: 3, loc: 3 },
      { id: 'crates/foo/src/a.rs::f2::5', kind: 'fn', name: 'f2', file: 'crates/foo/src/a.rs', startLine: 5, endLine: 8, loc: 4 },
    ],
    grades: {
      'crates/foo/src/a.rs': { risk: 0.1, riskBucket: 'none', contribution: 0.1, contribBucket: 'filler',
        signals: { relChurn: 0.1, coupling: 0.1, ownership: 1, centrality: 0.1, sizeNorm: 0.1 } },
      'crates/foo/src/b.rs': { risk: 0.9, riskBucket: 'high', contribution: 0.9, contribBucket: 'high',
        signals: { relChurn: 0.9, coupling: 0.9, ownership: 0.5, centrality: 0.9, sizeNorm: 0.5 } },
      'crates/bar/src/c.rs': { risk: 0.4, riskBucket: 'med', contribution: 0.4, contribBucket: 'low',
        signals: { relChurn: 0.4, coupling: 0.4, ownership: 0.7, centrality: 0.4, sizeNorm: 0.3 } },
    },
  };
}

export function makeViewerLabels(): LabelCache {
  return {
    version: 1,
    entries: {
      'crates/foo/src/a.rs': { responsibility: '演示职责', whyNow: 'LLM说现在学', contentHash: 'h' },
    },
  };
}
```

- [ ] **Step 3: 写失败测试 `test/viewer-state.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { buildViewerState } from '../src/serve/state.js';
import { makeViewerTree, makeViewerLabels } from './viewer-fixture.js';

const A = 'crates/foo/src/a.rs';
const B = 'crates/foo/src/b.rs';
const C = 'crates/bar/src/c.rs';
const EMPTY_LABELS = { version: 1 as const, entries: {} };

describe('buildViewerState', () => {
  it('puts every chunk in its risk:contrib cell and counts progress', () => {
    const s = buildViewerState(makeViewerTree(), makeViewerLabels(), { version: 1, understood: [A], verified: [A] });
    expect(s.grid.riskBuckets).toEqual(['high', 'med', 'low', 'none']);
    expect(s.grid.contribBuckets).toEqual(['filler', 'low', 'med', 'high']);
    expect(s.grid.cells['none:filler']).toEqual([A]);
    expect(s.grid.cells['high:high']).toEqual([B]);
    expect(s.grid.cells['med:low']).toEqual([C]);
    expect(s.grid.cells['low:med']).toEqual([]);          // 空格也存在
    expect(s.progress).toEqual({ understood: 1, verified: 1, total: 3 });
    expect(s.chunks[A].understood).toBe(true);
    expect(s.chunks[A].verified).toBe(true);
    expect(s.chunks[B].understood).toBe(false);
  });

  it('uses LLM label when present, falls back to static whyNow otherwise', () => {
    const s = buildViewerState(makeViewerTree(), makeViewerLabels(), { version: 1, understood: [] });
    expect(s.chunks[A].responsibility).toBe('演示职责');
    expect(s.chunks[A].whyNow).toBe('LLM说现在学');
    expect(s.chunks[B].responsibility).toBeNull();
    expect(s.chunks[B].whyNow).toContain('高风险');        // journey-md 静态文案
  });

  it('exposes path order, functions and neighbors; nextId is first un-understood on path', () => {
    const s = buildViewerState(makeViewerTree(), makeViewerLabels(), { version: 1, understood: [] });
    expect(s.path).toHaveLength(3);
    expect(s.nextId).toBe(s.path[0]);
    expect(s.path[0]).toBe(A);                             // filler 难度最低,先学
    expect(s.chunks[A].functions).toEqual(['f1', 'f2']);
    expect(s.chunks[A].neighbors).toEqual([B]);            // 同章邻居
    expect(s.chunks[A].chapterName).toBe('foo::src');
  });

  it('nextId skips understood chunks and is null when all done', () => {
    const t = makeViewerTree();
    const s1 = buildViewerState(t, makeViewerLabels(), { version: 1, understood: [A] });
    expect(s1.nextId).toBe(s1.path[1]);
    const s2 = buildViewerState(t, makeViewerLabels(), { version: 1, understood: [A, B, C] });
    expect(s2.nextId).toBeNull();
  });

  it('works with empty labels cache (all responsibility null)', () => {
    const s = buildViewerState(makeViewerTree(), EMPTY_LABELS, { version: 1, understood: [] });
    expect(s.chunks[A].responsibility).toBeNull();
    expect(s.chunks[A].whyNow.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `npx vitest run test/viewer-state.test.ts`
Expected: FAIL — `src/serve/state.js` 不存在。

- [ ] **Step 5: 实现 `src/serve/state.ts`**

```ts
import type { GradedTree, LabelCache, Progress, NodeId, RiskBucket, ContribBucket } from '../types.js';
import { buildPath } from '../path/sequence.js';
import { whyNow } from '../render/journey-md.js';

export interface ViewerChunk {
  name: string; file: string; crate: string; chapterName: string;
  riskBucket: RiskBucket; contribBucket: ContribBucket;
  understood: boolean; verified: boolean;
  responsibility: string | null;  // labels.json 没有则 null
  whyNow: string;                 // LLM 的,或 journey-md 静态回退
  functions: string[];
  neighbors: NodeId[];
}

export interface ViewerState {
  generatedAt: string;
  progress: { understood: number; verified: number; total: number };
  grid: { riskBuckets: RiskBucket[]; contribBuckets: ContribBucket[]; cells: Record<string, NodeId[]> };
  chunks: Record<NodeId, ViewerChunk>;
  path: NodeId[];
  nextId: NodeId | null;
}

const RISK_ROWS: RiskBucket[] = ['high', 'med', 'low', 'none'];
const CONTRIB_COLS: ContribBucket[] = ['filler', 'low', 'med', 'high'];

export function buildViewerState(g: GradedTree, labels: LabelCache, progress: Progress): ViewerState {
  const path = buildPath(g);
  const understood = new Set(progress.understood);
  const verified = new Set(progress.verified ?? []);

  const cells: Record<string, NodeId[]> = {};
  for (const r of RISK_ROWS) for (const c of CONTRIB_COLS) cells[`${r}:${c}`] = [];

  const chapterName: Record<NodeId, string> = {};
  for (const ch of g.chapters) for (const id of ch.chunkIds) chapterName[id] = ch.name;

  const neighborsByChunk: Record<NodeId, NodeId[]> = {};
  for (const s of path.steps) neighborsByChunk[s.chunkId] = s.neighbors;

  const chunks: Record<NodeId, ViewerChunk> = {};
  for (const c of g.chunks) {
    const grade = g.grades[c.id];
    if (!grade) continue; // 无评级的块不进视图(map 产物中不应出现)
    cells[`${grade.riskBucket}:${grade.contribBucket}`].push(c.id);
    const label = labels.entries[c.id];
    chunks[c.id] = {
      name: c.name, file: c.file, crate: c.crate,
      chapterName: chapterName[c.id] ?? c.crate,
      riskBucket: grade.riskBucket, contribBucket: grade.contribBucket,
      understood: understood.has(c.id), verified: verified.has(c.id),
      responsibility: label ? label.responsibility : null,
      whyNow: label ? label.whyNow : whyNow(grade),
      functions: g.leaves.filter((l) => l.file === c.id).map((l) => l.name),
      neighbors: neighborsByChunk[c.id] ?? [],
    };
  }

  const pathIds = path.steps.map((s) => s.chunkId);
  return {
    generatedAt: new Date().toISOString(),
    progress: {
      understood: progress.understood.length,
      verified: (progress.verified ?? []).length,
      total: g.chunks.length,
    },
    grid: { riskBuckets: RISK_ROWS, contribBuckets: CONTRIB_COLS, cells },
    chunks,
    path: pathIds,
    nextId: pathIds.find((id) => !understood.has(id)) ?? null,
  };
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run test/viewer-state.test.ts`
Expected: PASS（5 tests）。再 `npx vitest run` 全绿（journey-md 回归不受 export 影响）、`npm run typecheck` 干净。

- [ ] **Step 7: 提交**

```bash
git add src/serve/state.ts src/render/journey-md.ts test/viewer-fixture.ts test/viewer-state.test.ts
git commit -m "feat(serve): buildViewerState 纯函数（网格分桶/卡片数据/path/nextId；whyNow 导出复用）"
```

---

## Task 2: `applyDone`（校验 + 写 progress）

**Files:**
- Create: `src/serve/done.ts`
- Test: `test/serve-done.test.ts`

- [ ] **Step 1: 写失败测试 `test/serve-done.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDone } from '../src/serve/done.js';
import { makeViewerTree } from './viewer-fixture.js';

const A = 'crates/foo/src/a.rs';

let dirs: string[] = [];
afterEach(() => { dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); dirs = []; });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'easyrev-serve-')); dirs.push(d); return d; };

describe('applyDone', () => {
  it('writes understood to progress.json for a valid chunk (idempotent)', () => {
    const dir = tmp();
    const r1 = applyDone(makeViewerTree(), dir, A);
    expect(r1).toEqual({ status: 200, body: { ok: true } });
    const p = JSON.parse(readFileSync(join(dir, 'easyreview.progress.json'), 'utf8'));
    expect(p.understood).toEqual([A]);
    const r2 = applyDone(makeViewerTree(), dir, A);   // 重复标记不重复写入
    expect(r2.status).toBe(200);
    const p2 = JSON.parse(readFileSync(join(dir, 'easyreview.progress.json'), 'utf8'));
    expect(p2.understood).toEqual([A]);
  });

  it('rejects unknown chunk with 400 and writes nothing', () => {
    const dir = tmp();
    const r = applyDone(makeViewerTree(), dir, 'nope.rs');
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toContain('nope.rs');
    expect(existsSync(join(dir, 'easyreview.progress.json'))).toBe(false);
  });

  it('rejects missing/non-string chunkId with 400', () => {
    const dir = tmp();
    expect(applyDone(makeViewerTree(), dir, undefined).status).toBe(400);
    expect(applyDone(makeViewerTree(), dir, 42).status).toBe(400);
    expect(applyDone(makeViewerTree(), dir, '').status).toBe(400);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/serve-done.test.ts`
Expected: FAIL — `src/serve/done.js` 不存在。

- [ ] **Step 3: 实现 `src/serve/done.ts`**

```ts
import { join } from 'node:path';
import type { GradedTree } from '../types.js';
import { loadProgress, saveProgress, markUnderstood } from '../progress/progress.js';

export interface DoneResult {
  status: number;
  body: { ok: boolean; error?: string };
}

/** 校验 chunkId 后复用 progress 模块读改写——和 CLI done 同一条代码路径、同一份文件。 */
export function applyDone(tree: GradedTree, outDir: string, chunkId: unknown): DoneResult {
  if (typeof chunkId !== 'string' || chunkId === '') {
    return { status: 400, body: { ok: false, error: '缺少 chunkId' } };
  }
  if (!tree.chunks.some((c) => c.id === chunkId)) {
    return { status: 400, body: { ok: false, error: `未知块 ${chunkId}` } };
  }
  const file = join(outDir, 'easyreview.progress.json');
  saveProgress(file, markUnderstood(loadProgress(file), chunkId));
  return { status: 200, body: { ok: true } };
}
```

（写盘失败会抛异常——由 Task 4 的 server 兜底成 500，这里不 catch。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/serve-done.test.ts`
Expected: PASS（3 tests）。`npm run typecheck` 干净。

- [ ] **Step 5: 提交**

```bash
git add src/serve/done.ts test/serve-done.test.ts
git commit -m "feat(serve): applyDone（校验块存在,复用 progress 模块写 understood）"
```

---

## Task 3: `renderPage`（内嵌 CSS/JS 单页）

**Files:**
- Create: `src/serve/page.ts`
- Test: `test/serve-page.test.ts`

前端约定（spec 定稿）：布局=左网格右固定卡片面板；方块状态色 灰/绿/绿框(verified)/黄(下一步)；点块本地切卡片；每张卡有"标记已理解"（已理解则禁用态）；邻居可点；主题=默认跟系统、按钮切换、localStorage 记住。

- [ ] **Step 1: 写失败测试 `test/serve-page.test.ts`**

（页面 JS 不做行为单测——spec 决定；这里只钉住结构关键点，防手滑删块。）

```ts
import { describe, it, expect } from 'vitest';
import { renderPage } from '../src/serve/page.js';

describe('renderPage', () => {
  it('returns a self-contained html page with the agreed structure', () => {
    const html = renderPage();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('id="grid"');            // 网格区
    expect(html).toContain('id="panel"');           // 右侧卡片面板
    expect(html).toContain('id="progress-fill"');   // 进度条
    expect(html).toContain('id="theme-toggle"');    // 主题切换
    expect(html).toContain('id="error-banner"');    // fetch 失败红条
    expect(html).toContain('/api/state');
    expect(html).toContain('/api/done');
    expect(html).toContain('data-theme');           // 暗色主题变量挂载点
    expect(html).not.toContain('src=');             // 零外部资源(自包含)
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/serve-page.test.ts`
Expected: FAIL — `src/serve/page.js` 不存在。

- [ ] **Step 3: 实现 `src/serve/page.ts`**

整文件如下。注意：外层是 TS 模板字符串，**内嵌 JS 里一律用单引号字符串拼接、不用反引号**，避免转义地狱。

```ts
/** 自包含单页：无外部资源、无构建。数据全部来自 /api/state。 */
export function renderPage(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>easyReview</title>
<style>
:root {
  --bg: #f7f7f5; --panel-bg: #ffffff; --text: #222; --muted: #777;
  --border: #ddd; --dot: #b9b9b3; --lit: #2f9e63; --next: #e0a52e;
  --accent: #2f6fde; --danger: #c0392b;
}
:root[data-theme="dark"] {
  --bg: #16181d; --panel-bg: #1f2229; --text: #e6e6e3; --muted: #9a9a94;
  --border: #383c45; --dot: #4a4e58; --lit: #3fbf78; --next: #e8b542;
  --accent: #6ea1ff; --danger: #e06050;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #16181d; --panel-bg: #1f2229; --text: #e6e6e3; --muted: #9a9a94;
    --border: #383c45; --dot: #4a4e58; --lit: #3fbf78; --next: #e8b542;
    --accent: #6ea1ff; --danger: #e06050;
  }
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.6 system-ui, sans-serif; background: var(--bg); color: var(--text); }
header { display: flex; align-items: center; gap: 16px; padding: 10px 20px; border-bottom: 1px solid var(--border); }
header h1 { font-size: 16px; margin: 0; }
#progress-wrap { flex: 1; display: flex; align-items: center; gap: 10px; }
#progress-bar { flex: 1; height: 10px; background: var(--border); border-radius: 5px; overflow: hidden; max-width: 420px; }
#progress-fill { height: 100%; width: 0; background: var(--lit); transition: width .2s; }
#progress-text { color: var(--muted); white-space: nowrap; }
#theme-toggle { background: none; border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
#error-banner { background: var(--danger); color: #fff; padding: 6px 20px; }
main { display: flex; gap: 16px; padding: 16px 20px; align-items: flex-start; }
#map { flex: 3; min-width: 0; }
#grid { display: grid; grid-template-columns: 60px repeat(4, 1fr); gap: 6px; }
.axis { display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 12px; }
.cell { border: 1px solid var(--border); border-radius: 8px; min-height: 64px; padding: 6px; display: flex; flex-wrap: wrap; gap: 5px; align-content: flex-start; background: var(--panel-bg); }
.dot { width: 14px; height: 14px; border-radius: 4px; background: var(--dot); cursor: pointer; border: 2px solid transparent; }
.dot.lit { background: var(--lit); }
.dot.verified { border-color: var(--lit); }
.dot.next { background: var(--next); }
.dot.selected { outline: 2px solid var(--accent); }
#legend { margin-top: 10px; color: var(--muted); font-size: 12px; }
#panel { flex: 2; max-width: 460px; position: sticky; top: 16px; }
.card { border: 1px solid var(--border); border-radius: 10px; background: var(--panel-bg); padding: 16px; }
.card h2 { margin: 0 0 6px; font-size: 15px; }
.card .meta, .card .muted { color: var(--muted); font-size: 13px; }
.card ul { margin: 6px 0; padding-left: 20px; }
.card .nb { color: var(--accent); cursor: pointer; text-decoration: underline; }
.back { display: inline-block; margin-bottom: 8px; color: var(--accent); cursor: pointer; }
button.done-btn { margin-top: 10px; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--lit); background: none; color: var(--lit); cursor: pointer; font-size: 14px; }
button.done-btn:disabled { border-color: var(--border); color: var(--muted); cursor: default; }
</style>
</head>
<body>
<header>
  <h1>easyReview</h1>
  <div id="progress-wrap">
    <div id="progress-bar"><div id="progress-fill"></div></div>
    <span id="progress-text"></span>
  </div>
  <button id="theme-toggle" title="亮/暗切换">🌓</button>
</header>
<div id="error-banner" hidden></div>
<main>
  <section id="map">
    <div id="grid"></div>
    <div id="legend">■ 灰=未学 · <span style="color:var(--lit)">■</span> 绿=已理解 · 绿框=已验证 · <span style="color:var(--next)">■</span> 黄=下一步 · 行=风险(高→无) 列=贡献度(填充→高)</div>
  </section>
  <aside id="panel"></aside>
</main>
<script>
'use strict';
var state = null;
var selectedId = null; // null = 面板显示"下一步"

var RISK_CN = { high: '高', med: '中', low: '低', none: '无' };
var CONTRIB_CN = { filler: '填充', low: '低', med: '中', high: '高' };

function $(id) { return document.getElementById(id); }
function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ── 主题:默认跟系统,手动选择存 localStorage ──
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
}
function currentTheme() {
  var forced = document.documentElement.getAttribute('data-theme');
  if (forced) return forced;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
applyTheme(localStorage.getItem('easyreview-theme'));
$('theme-toggle').addEventListener('click', function () {
  var next = currentTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('easyreview-theme', next);
  applyTheme(next);
});

// ── 数据 ──
function refresh() {
  return fetch('/api/state')
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (s) { state = s; $('error-banner').hidden = true; render(); })
    .catch(function (e) {
      $('error-banner').hidden = false;
      $('error-banner').textContent = '服务器没响应(' + e.message + ')——确认 easyreview serve 还在跑,然后刷新。';
    });
}

function markDone(id) {
  fetch('/api/done', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chunkId: id }),
  })
    .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
    .then(function (res) {
      if (!res.ok) { alert('标记失败:' + (res.body.error || '未知错误')); return; }
      if (id === state.nextId) selectedId = null; // 标的是下一步 → 面板自动跳到新的下一步
      return refresh();                            // 跳着标 → selectedId 不动,卡片变已理解态
    })
    .catch(function (e) { alert('标记失败:' + e.message); });
}

// ── 渲染 ──
function render() { renderProgress(); renderGrid(); renderPanel(); }

function renderProgress() {
  var p = state.progress;
  var pct = p.total ? Math.round((p.understood / p.total) * 100) : 0;
  $('progress-fill').style.width = pct + '%';
  $('progress-text').textContent = '已理解 ' + p.understood + '/' + p.total + ' (' + pct + '%) · 已验证 ' + p.verified;
}

function renderGrid() {
  var g = state.grid;
  var html = '<div class="axis"></div>';
  for (var ci = 0; ci < g.contribBuckets.length; ci++) html += '<div class="axis">' + CONTRIB_CN[g.contribBuckets[ci]] + '</div>';
  for (var ri = 0; ri < g.riskBuckets.length; ri++) {
    var r = g.riskBuckets[ri];
    html += '<div class="axis">' + RISK_CN[r] + '</div>';
    for (var cj = 0; cj < g.contribBuckets.length; cj++) {
      var ids = g.cells[r + ':' + g.contribBuckets[cj]] || [];
      html += '<div class="cell">';
      for (var k = 0; k < ids.length; k++) {
        var id = ids[k];
        var c = state.chunks[id];
        var cls = 'dot';
        if (c.understood) cls += ' lit';
        if (c.verified) cls += ' verified';
        if (id === state.nextId) cls += ' next';
        if (id === (selectedId || state.nextId)) cls += ' selected';
        html += '<span class="' + cls + '" data-id="' + esc(id) + '" title="' + esc(c.name + ' · ' + c.chapterName) + '"></span>';
      }
      html += '</div>';
    }
  }
  $('grid').innerHTML = html;
  var dots = $('grid').querySelectorAll('.dot');
  for (var i = 0; i < dots.length; i++) {
    dots[i].addEventListener('click', function (ev) {
      selectedId = ev.currentTarget.getAttribute('data-id');
      render();
    });
  }
}

function renderPanel() {
  var showId = selectedId || state.nextId;
  if (!showId) {
    $('panel').innerHTML = '<div class="card"><h2>🎉 全部走完</h2><p>你已经走遍这个项目。回头看地图,它现在应该读得懂了。</p>' +
      '<p class="muted">下一步:用 <code>npm run verify -- &lt;chunkId&gt;</code> 验证你的理解(突变探针)。</p></div>';
    return;
  }
  var c = state.chunks[showId];
  var isNext = showId === state.nextId;
  var stepNo = state.path.indexOf(showId) + 1;
  var html = '';
  if (!isNext && state.nextId) html += '<span class="back" id="back-next">← 回到下一步</span>';
  html += '<div class="card">';
  html += '<h2>' + (isNext ? '下一步(第 ' + stepNo + '/' + state.path.length + ' 步):' : '') + esc(c.name) + '</h2>';
  html += '<div class="meta">' + esc(c.chapterName) + ' · <code>' + esc(c.file) + '</code><br>风险 ' + RISK_CN[c.riskBucket] + ' · 贡献度 ' + CONTRIB_CN[c.contribBucket] +
          (c.verified ? ' · <b>已验证 ✓</b>' : '') + '</div>';
  if (c.responsibility) html += '<p><b>职责:</b>' + esc(c.responsibility) + '</p>';
  html += '<p><b>为什么现在学它:</b>' + esc(c.whyNow) + '</p>';
  html += '<p><b>函数(' + c.functions.length + ')</b></p>';
  html += c.functions.length
    ? '<ul>' + c.functions.map(function (f) { return '<li><code>' + esc(f) + '</code></li>'; }).join('') + '</ul>'
    : '<p class="muted">(本文件无独立函数,可能是模块声明/重导出)</p>';
  html += '<p><b>自测</b>(答得上来再标记)</p><ul class="muted">' +
    '<li>这个块对外做什么?一句话说清职责。</li>' +
    '<li>它读/写了哪些状态或数据?</li>' +
    '<li>谁会调用它、它又依赖谁?</li></ul>';
  if (c.neighbors.length) {
    html += '<p><b>顺便看看</b>(防盲区觅食)</p><ul>' + c.neighbors.slice(0, 6).map(function (n) {
      var nc = state.chunks[n];
      return '<li><span class="nb" data-id="' + esc(n) + '">' + esc(nc ? nc.name : n) + '</span>' + (nc && nc.understood ? ' ✓' : '') + '</li>';
    }).join('') + '</ul>';
  }
  html += c.understood
    ? '<button class="done-btn" disabled>已理解 ✓</button>'
    : '<button class="done-btn" id="done-btn">✓ 标记已理解</button>';
  html += '</div>';
  $('panel').innerHTML = html;
  var back = $('back-next');
  if (back) back.addEventListener('click', function () { selectedId = null; render(); });
  var btn = $('done-btn');
  if (btn) btn.addEventListener('click', function () { markDone(showId); });
  var nbs = $('panel').querySelectorAll('.nb');
  for (var i = 0; i < nbs.length; i++) {
    nbs[i].addEventListener('click', function (ev) { selectedId = ev.currentTarget.getAttribute('data-id'); render(); });
  }
}

refresh();
</script>
</body>
</html>
`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/serve-page.test.ts`
Expected: PASS（1 test）。`npm run typecheck` 干净。

- [ ] **Step 5: 提交**

```bash
git add src/serve/page.ts test/serve-page.test.ts
git commit -m "feat(serve): 自包含单页（网格+固定下一步卡片+进度条+亮暗主题）"
```

---

## Task 4: HTTP server + `serve` 命令接线

**Files:**
- Create: `src/serve/server.ts`, `src/cli-serve.ts`
- Modify: `src/cli.ts`, `package.json`
- Test: `test/serve-http.test.ts`

- [ ] **Step 1: 写失败测试 `test/serve-http.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createViewerServer } from '../src/serve/server.js';
import { makeViewerTree, makeViewerLabels } from './viewer-fixture.js';

const A = 'crates/foo/src/a.rs';

let dirs: string[] = [];
let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((res) => s.close(res))));
  servers = [];
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  dirs = [];
});

function makeOutDir(withLabels = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'easyrev-http-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'easyreview.tree.json'), JSON.stringify(makeViewerTree()));
  if (withLabels) writeFileSync(join(dir, 'easyreview.labels.json'), JSON.stringify(makeViewerLabels()));
  return dir;
}

async function listen(dir: string): Promise<string> {
  const server = createViewerServer(dir);
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('viewer http server', () => {
  it('throws at construction when tree.json is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easyrev-http-'));
    dirs.push(dir);
    expect(() => createViewerServer(dir)).toThrow(/easyreview map/);
  });

  it('GET / serves the html page', async () => {
    const url = await listen(makeOutDir());
    const r = await fetch(url + '/');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(await r.text()).toContain('easyReview');
  });

  it('GET /api/state returns the merged viewer state', async () => {
    const url = await listen(makeOutDir());
    const r = await fetch(url + '/api/state');
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(s.progress.total).toBe(3);
    expect(s.nextId).toBe(A);
    expect(s.chunks[A].responsibility).toBe('演示职责');
  });

  it('POST /api/done marks understood end-to-end (state reflects it)', async () => {
    const dir = makeOutDir();
    const url = await listen(dir);
    const r = await fetch(url + '/api/done', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chunkId: A }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
    const p = JSON.parse(readFileSync(join(dir, 'easyreview.progress.json'), 'utf8'));
    expect(p.understood).toEqual([A]);
    const s = await (await fetch(url + '/api/state')).json();
    expect(s.chunks[A].understood).toBe(true);
    expect(s.nextId).not.toBe(A);
  });

  it('POST /api/done rejects unknown chunk (400) and bad json (400)', async () => {
    const url = await listen(makeOutDir());
    const bad = await fetch(url + '/api/done', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chunkId: 'nope.rs' }),
    });
    expect(bad.status).toBe(400);
    const garbage = await fetch(url + '/api/done', { method: 'POST', body: 'not json' });
    expect(garbage.status).toBe(400);
  });

  it('works without labels.json (responsibility null) and unknown route is 404', async () => {
    const url = await listen(makeOutDir(false));
    const s = await (await fetch(url + '/api/state')).json();
    expect(s.chunks[A].responsibility).toBeNull();
    expect((await fetch(url + '/api/nope')).status).toBe(404);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/serve-http.test.ts`
Expected: FAIL — `src/serve/server.js` 不存在。

- [ ] **Step 3: 实现 `src/serve/server.ts`**

```ts
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GradedTree } from '../types.js';
import { loadLabelCache } from '../label/cache.js';
import { loadProgress } from '../progress/progress.js';
import { buildViewerState } from './state.js';
import { applyDone } from './done.js';
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

export function createViewerServer(outDir: string): Server {
  loadTreeOrThrow(outDir); // 启动校验
  return createServer((req, res) => {
    handle(outDir, req, res).catch((e) => {
      sendJson(res, 500, { ok: false, error: String(e) });
    });
  });
}

async function handle(outDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
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

- [ ] **Step 4: 实现 `src/cli-serve.ts`**

```ts
import { createViewerServer } from './serve/server.js';

export interface ServeOptions { outDir: string; port: number; }

export async function runServe(opts: ServeOptions): Promise<void> {
  const server = createViewerServer(opts.outDir);
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      reject(e.code === 'EADDRINUSE'
        ? new Error(`端口 ${opts.port} 被占用——换一个:easyreview serve --port <其它端口>`)
        : e);
    });
    server.listen(opts.port, '127.0.0.1', () => resolve());
  });
  console.log(`easyReview viewer: http://localhost:${opts.port}  (Ctrl+C 退出)`);
}
```

- [ ] **Step 5: `src/cli.ts` 加 serve 分发（照 learn/verify 模式，加在 `verify` 块之后）**

```ts
if (cmd === 'serve') {
  const rest = process.argv.slice(3);
  const { outDir } = parseArgs(rest);
  const pi = rest.indexOf('--port');
  const port = pi >= 0 && rest[pi + 1] ? Number(rest[pi + 1]) : 4870;
  import('./cli-serve.js').then(({ runServe }) =>
    runServe({ outDir, port })
      .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); }),
  );
}
```

- [ ] **Step 6: `package.json` scripts 加一行**

`"verify": "tsx src/cli.ts verify"` 之后加：

```json
    "serve": "tsx src/cli.ts serve"
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run test/serve-http.test.ts`
Expected: PASS（6 tests）。再 `npx vitest run` 全绿、`npm run typecheck` 干净。

- [ ] **Step 8: 提交**

```bash
git add src/serve/server.ts src/cli-serve.ts src/cli.ts package.json test/serve-http.test.ts
git commit -m "feat(serve): node:http viewer 服务（GET /、/api/state、POST /api/done）+ serve 命令"
```

---

## Task 5（手动 observe）：真实 umwelt-bevy 冒烟

**Files:** 无代码改动。

- [ ] **Step 1: 起服务**

Run: `npm run serve -- --out .`（outDir 已有真实 umwelt-bevy 的 tree/labels/progress）
Expected: 打印 `easyReview viewer: http://localhost:4870`。

- [ ] **Step 2: 浏览器过动线**

打开页面检查：68 块落进正确格子、进度条与 progress.json 一致、右侧默认"下一步"卡片（有 LLM 职责行）、点任意块切卡片 + "← 回到下一步"、点邻居跳卡片、"标记已理解"后进度/点亮/下一步联动、主题切换 + 刷新记住、CLI `npm run learn` 再看 journey.md 与页面进度一致（单一状态源）。

- [ ] **Step 3: 异常路径**

无 tree 的空目录起 serve → 报"先运行 easyreview map"退出；重复起两个 serve 同端口 → 第二个报端口占用提示。

---

## 收尾

- [ ] 全量 `npx vitest run` 全绿、`npm run typecheck` 干净。
- [ ] 更新 `docs/HANDOFF.md`：
  - "完整闭环"代码块加一段：`# ④ web viewer：npm run serve -- --out . → http://localhost:4870（点亮地图+下一步卡片+页面标记已理解+亮暗主题；铁律不变,viewer 只消费 JSON）`
  - 代码地图表加四行：`serve/state.ts`（ViewerState 组装纯函数）、`serve/done.ts`（页面 done,复用 progress 模块）、`serve/page.ts`（自包含单页）、`serve/server.ts` + `cli-serve.ts`（http 路由 + serve 命令）。
  - "明天可选的下一步"第 4 条 **web viewer** 标 ✅ 已完成（指向本计划）。
  - "遗留小事"里 `easyReview/` 空目录一条删掉（已删）。
  - 单独提交：`docs: HANDOFF 同步 web viewer 完成`。
