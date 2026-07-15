# 「被谁依赖」UI 面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 tree.json 已落盘的 refsIn(每块入边 top-10)呈现到 viewer:右侧面板卡片 + 源码抽屉双落点,来源是块的可点跳转。

**Architecture:** serve 层把 `tree.refsIn` 拍平进 `ViewerChunk.refsIn`(丢 weight)并给 `ViewerState.hasRefs` 旗标;前端 page.ts 加共用渲染函数 `refsHtml` + 抽屉折叠区 `#drawer-refs` + 面板段落,点击跳转复用 selectedId/openDrawer。map/grade 零改动,老产物(无 refsIn)零回归。

**Tech Stack:** TypeScript(tsx 直跑,无构建)、vitest、page.ts 内嵌 JS(单引号拼接,**禁反引号与 `\${`**——外层是 TS 模板字面量)。

**Spec:** `docs/superpowers/specs/2026-07-15-refsin-viewer-design.md`

**基线:** 282 测试全绿(`npm test`),typecheck 干净(`npm run typecheck`)。完成后 287 测试。

---

### Task 1: serve 层——ViewerChunk.refsIn + ViewerState.hasRefs

**Files:**
- Modify: `test/viewer-fixture.ts`(文件末尾追加一个工厂函数)
- Modify: `test/viewer-state.test.ts`(追加一个 describe)
- Modify: `src/serve/state.ts`

- [ ] **Step 1: fixture 加带 refsIn 的树工厂**

`test/viewer-fixture.ts` 第 1 行的 import 改为:

```ts
import type { GradedTree, LabelCache, ChunkRefIn } from '../src/types.js';
```

文件末尾追加:

```ts
/** makeViewerTree 之上加 refsIn:a.rs 被 b.rs(块)与 util.rs(范围内非块文件)引用;b/c 无键。 */
export function makeViewerTreeWithRefs(): GradedTree {
  const refsIn: Record<string, ChunkRefIn[]> = {
    'crates/foo/src/a.rs': [
      { from: 'crates/foo/src/b.rs', weight: 1, names: ['a', 'helper'] },
      { from: 'crates/foo/src/util.rs', weight: 0.5, names: ['a'] },
    ],
  };
  return { ...makeViewerTree(), refsIn };
}
```

- [ ] **Step 2: 写 3 条失败测试**

`test/viewer-state.test.ts` 第 3 行 import 改为:

```ts
import { makeViewerTree, makeViewerLabels, makeViewerTreeWithRefs } from './viewer-fixture.js';
```

文件末尾(既有 describe 的收尾 `});` 之后)追加:

```ts
describe('buildViewerState refsIn(被谁依赖)', () => {
  it('refsIn 保序进 ViewerChunk,weight 不出,hasRefs=true', () => {
    const s = buildViewerState(makeViewerTreeWithRefs(), makeViewerLabels(), { version: 1, understood: [] });
    expect(s.hasRefs).toBe(true);
    expect(s.chunks[A].refsIn).toEqual([
      { from: B, names: ['a', 'helper'] },            // toEqual 深比较,weight 混进来会挂
      { from: 'crates/foo/src/util.rs', names: ['a'] },
    ]);
  });

  it('tree 无 refsIn(老产物)→ hasRefs=false 且各块 refsIn=[]', () => {
    const s = buildViewerState(makeViewerTree(), makeViewerLabels(), { version: 1, understood: [] });
    expect(s.hasRefs).toBe(false);
    expect(s.chunks[A].refsIn).toEqual([]);
    expect(s.chunks[B].refsIn).toEqual([]);
  });

  it('有 refsIn 但某块无键 → 该块 [] 而 hasRefs 仍 true', () => {
    const s = buildViewerState(makeViewerTreeWithRefs(), makeViewerLabels(), { version: 1, understood: [] });
    expect(s.hasRefs).toBe(true);
    expect(s.chunks[B].refsIn).toEqual([]);
    expect(s.chunks[C].refsIn).toEqual([]);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run test/viewer-state.test.ts`
Expected: 新增 3 条 FAIL(`hasRefs`/`refsIn` 为 undefined),原有 5 条 PASS。

- [ ] **Step 4: 实现 state.ts**

`src/serve/state.ts` 的 `ViewerChunk` 接口(第 5-13 行)改为:

```ts
export interface ViewerChunk {
  name: string; file: string; crate: string; chapterName: string;
  riskBucket: RiskBucket; contribBucket: ContribBucket;
  understood: boolean; verified: boolean;
  responsibility: string | null;  // labels.json 没有则 null
  whyNow: string;                 // LLM 的,或 journey-md 静态回退
  functions: { name: string; startLine: number }[];
  neighbors: NodeId[];
  refsIn: { from: NodeId; names: string[] }[]; // 入边(落盘已按权重降序);weight 不出——内部量纲对读者无意义
}
```

`ViewerState` 接口(第 15-22 行)改为:

```ts
export interface ViewerState {
  generatedAt: string;
  progress: { understood: number; verified: number; total: number };
  grid: { riskBuckets: RiskBucket[]; contribBuckets: ContribBucket[]; cells: Record<string, NodeId[]> };
  chunks: Record<NodeId, ViewerChunk>;
  path: NodeId[];
  nextId: NodeId | null;
  hasRefs: boolean; // tree.refsIn 是否存在;false=老产物两处不渲染(区别于"有数据但此块无入边")
}
```

`buildViewerState` 中 chunk 对象字面量的 `neighbors` 行后加一行:

```ts
      neighbors: neighborsByChunk[c.id] ?? [],
      refsIn: (g.refsIn?.[c.id] ?? []).map((r) => ({ from: r.from, names: r.names })),
```

末尾 return 对象的 `nextId` 行后加一行:

```ts
    nextId: pathIds.find((id) => !understood.has(id)) ?? null,
    hasRefs: g.refsIn !== undefined,
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/viewer-state.test.ts`
Expected: 8 条全 PASS。

- [ ] **Step 6: Commit**

```bash
git add test/viewer-fixture.ts test/viewer-state.test.ts src/serve/state.ts
git commit -m "feat: serve 层暴露 refsIn(去 weight)与 hasRefs 旗标"
```

---

### Task 2: page.ts——面板段落 + 抽屉折叠区 + 可点跳转

**Files:**
- Modify: `test/serve-page.test.ts`(追加 2 条 it)
- Modify: `src/serve/page.ts`(八处编辑,下面全部逐字给出)

- [ ] **Step 1: 写 2 条失败测试**

`test/serve-page.test.ts` 的 describe 末尾(第三个 it 之后)追加:

```ts
  it('refsIn: 抽屉容器与折叠持久化键都在', () => {
    const html = renderPage();
    expect(html).toContain('id="drawer-refs"');
    expect(html).toContain('easyreview-refs-collapsed');
    expect(html).not.toContain('src=');             // 仍自包含
  });

  it('refsIn: 共用渲染函数与被谁依赖/空态文案都在', () => {
    const html = renderPage();
    expect(html).toContain('refsHtml');
    expect(html).toContain('被谁依赖');
    expect(html).toContain('未检出');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/serve-page.test.ts`
Expected: 新增 2 条 FAIL,原有 3 条 PASS。

- [ ] **Step 3: page.ts 八处编辑**

**编辑 ①(CSS)**——在 `#drawer-src { flex: 1; ...` 这行之前插入三行:

```css
#drawer-refs { padding: 6px 16px; border-bottom: 1px solid var(--border); font-size: 13px; max-height: 30vh; overflow: auto; }
#drawer-refs .refs-head { cursor: pointer; user-select: none; color: var(--accent); font-weight: 600; }
#drawer-refs ul { margin: 6px 0; padding-left: 20px; }
```

**编辑 ②(HTML)**——抽屉骨架中 `<div id="drawer-fns"></div>` 与 `<div id="interp" hidden></div>` 之间插入一行:

```html
  <div id="drawer-refs" hidden></div>
```

**编辑 ③(JS 状态变量)**——`var interpCollapsed = ...` 行之后加一行:

```js
var refsCollapsed = localStorage.getItem('easyreview-refs-collapsed') !== 'no'; // 默认折叠(不挤源码空间)
```

**编辑 ④(新增渲染函数)**——在 `renderInterp` 函数的收尾 `}` 之后、`function renderSource(body) {` 之前,插入整段:

```js
// ── 被谁依赖(refsIn,中心度 v2 落盘;hasRefs=false 的老产物两处都不渲染) ──
var REFS_EMPTY = '未检出(名字级静态扫描,入口文件/动态调用检不到)';
function refTitle(n) { return n ? '被谁依赖(' + (n >= 10 ? '前 10' : n) + ')' : '被谁依赖'; }
function refsHtml(id) { // 非空列表 → <ul>;来源是块的可点跳转(data-ref,避免撞面板既有 .nb[data-id] 绑定),证据名最多 3 个
  var refs = state.chunks[id].refsIn;
  var html = '<ul>';
  for (var i = 0; i < refs.length; i++) {
    var r = refs[i];
    var base = r.from.split('/').pop();
    var src = state.chunks[r.from]
      ? '<span class="nb ref-jump" data-ref="' + esc(r.from) + '" title="' + esc(r.from) + '">' + esc(base) + '</span>'
      : '<span class="muted" title="' + esc(r.from) + '">' + esc(base) + '</span>';
    var ev = r.names.length
      ? ' <span class="muted">(' + esc(r.names.slice(0, 3).join(', ') + (r.names.length > 3 ? '…' : '')) + ')</span>'
      : '';
    html += '<li>' + src + ev + '</li>';
  }
  return html + '</ul>';
}
function bindRefJumps(rootEl) {
  var els = rootEl.querySelectorAll('.ref-jump');
  for (var i = 0; i < els.length; i++) {
    els[i].addEventListener('click', function (ev) {
      selectedId = ev.currentTarget.getAttribute('data-ref');
      openDrawer(selectedId);
      render();
    });
  }
}
function renderDrawerRefs() {
  var box = $('drawer-refs');
  if (!state.hasRefs || !drawerId) { box.hidden = true; return; }
  box.hidden = false;
  var n = state.chunks[drawerId].refsIn.length;
  var html = '<div class="refs-head" id="refs-head">' + (refsCollapsed ? '▸ ' : '▾ ') + refTitle(n) + '</div>';
  if (!refsCollapsed) html += n ? refsHtml(drawerId) : '<div class="muted">' + REFS_EMPTY + '</div>';
  box.innerHTML = html;
  $('refs-head').addEventListener('click', function () {
    refsCollapsed = !refsCollapsed;
    localStorage.setItem('easyreview-refs-collapsed', refsCollapsed ? 'yes' : 'no');
    renderDrawerRefs();
  });
  bindRefJumps(box);
}
```

**编辑 ⑤(openDrawer)**——`renderDrawerFns();` 行之后加一行 `renderDrawerRefs();`,即:

```js
  renderDrawerHead();
  renderDrawerFns();
  renderDrawerRefs();
  renderInterp();
  loadInterp(id);
```

**编辑 ⑥(closeDrawer)**——`$('interp').hidden = true;` 行之前加一行:

```js
  $('drawer-refs').hidden = true;
```

**编辑 ⑦(render)**——

```js
  if (drawerId) { renderDrawerHead(); renderDrawerFns(); } // done 后按钮/✓ 即时更新
```

改为:

```js
  if (drawerId) { renderDrawerHead(); renderDrawerFns(); renderDrawerRefs(); } // done 后按钮/✓ 即时更新
```

**编辑 ⑧(renderPanel)**——`renderPanel` 中 `if (c.neighbors.length) {` 之前插入(「被谁依赖」在「顺便看看」之前):

```js
  if (state.hasRefs) {
    html += c.refsIn.length
      ? '<p><b>' + refTitle(c.refsIn.length) + '</b></p>' + refsHtml(showId)
      : '<p class="muted"><b>被谁依赖:</b>' + REFS_EMPTY + '</p>';
  }
```

同函数末尾,既有的 `.nb[data-id]` 绑定循环之后追加一行:

```js
  bindRefJumps($('panel'));
```

- [ ] **Step 4: 跑 page 测试确认通过**

Run: `npx vitest run test/serve-page.test.ts`
Expected: 5 条全 PASS。

- [ ] **Step 5: 全量回归 + typecheck**

Run: `npm test`
Expected: 62 文件 287 测试全 PASS。
Run: `npm run typecheck`
Expected: 无输出(干净)。

- [ ] **Step 6: Commit**

```bash
git add test/serve-page.test.ts src/serve/page.ts
git commit -m "feat: 被谁依赖面板——面板+抽屉双落点,可点跳转,老产物零回归"
```

---

## 给实现者的硬约束

1. page.ts 内嵌 JS **绝对禁止反引号与 `\${`**(外层是 TS 模板字面量,写了会当场炸或静默串模板)。
2. 所有动态文本(from 路径、basename、names)必须过 `esc()` 再拼 HTML。
3. 可点跳转用 `data-ref` 属性而非 `data-id`——renderPanel 既有 `.nb[data-id]` 绑定循环会把 data-id 的元素再绑一遍 select-only 监听,造成双触发。
4. 本计划所有代码块不含 `\u`/`\b` 类转义序列,照抄即可;若你(实现者)自行改写任何字符串,提交前用 `node -e` 检查文件无 0x00-0x08 控制字节。
