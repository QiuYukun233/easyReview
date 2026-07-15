# flow phase(trace 切窗/请求段标记)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 流程链每步标 phase(setup/request),UI 把 setup 段折成默认收起的一行,请求叙事直接可读。

**Architecture:** foldTrace 内做分相(分界点=首次进 app/controllers/ 的调用含自身;分界起仍被命中→request 否则 setup;steps 重排 setup 段首现序在前、request 段按分界后首次命中序在后;无分界点→全 request 不分段);FlowStep.phase 可选字段零 schema 破坏;serve 透传零改动;page.ts renderFlows 加折叠头。tracer 一字不动。

**Tech Stack:** TypeScript(tsx 直跑)、vitest、page.ts 内嵌 JS(单引号拼接,禁反引号与 `\${`)。

**Spec:** `docs/superpowers/specs/2026-07-16-flow-phase-design.md`
**基线:** 分支 feat/flow-phase(自 main c9402ad),65 文件 323 测试全绿。完成后 331。

---

## 硬约束

1. 本计划所有代码块**零反斜杠转义序列**,照抄即可;自行改写字符串则提交前对改动文件跑控制字节(0x00-0x08)扫描。
2. page.ts 内嵌 JS 禁反引号与 `\${`;动态文本过 esc()。
3. `src/flow/trace.ts` 的 TRACER_RB 段(含 Ruby 与外层插值)**一字不动**——本计划只改 foldTrace。

---

### Task 1: foldTrace 分相 + FlowStep.phase

**Files:**
- Modify: `src/types.ts`(FlowStep 加一行)
- Modify: `src/flow/trace.ts`(foldTrace 整函数替换,TRACER_RB 不动)
- Modify: `test/flow-trace.test.ts`(追加一个 describe,5 条)

- [ ] **Step 1: 写失败测试**

`test/flow-trace.test.ts` 文件末尾追加:

```ts
describe('foldTrace 分相(spec:2026-07-16-flow-phase-design.md)', () => {
  it('controller 分界:自身与其后命中者归 request(分界含自身)', () => {
    const steps = foldTrace([
      call('/app/app/models/factory_only.rb', 'build'),
      call('/app/app/controllers/msg_controller.rb', 'create'),
      call('/app/app/models/message.rb', 'save'),
    ]);
    expect(steps.map((s) => [s.chunkId, s.phase])).toEqual([
      ['app/models/factory_only.rb', 'setup'],
      ['app/controllers/msg_controller.rb', 'request'],
      ['app/models/message.rb', 'request'],
    ]);
  });

  it('跨相文件(分界前首现+分界后命中)归 request,hits 仍全链统计(conversation.rb 场景)', () => {
    const steps = foldTrace([
      call('/app/app/models/conversation.rb', 'create'),
      call('/app/app/controllers/c.rb', 'act'),
      call('/app/app/models/conversation.rb', 'save'),
    ]);
    const conv = steps.find((s) => s.chunkId === 'app/models/conversation.rb')!;
    expect(conv.phase).toBe('request');
    expect(conv.hits).toBe(2);
  });

  it('工厂专属(分界后零命中)归 setup', () => {
    const steps = foldTrace([
      call('/app/app/models/factory_only.rb', 'build'),
      call('/app/app/models/factory_only.rb', 'build'),
      call('/app/app/controllers/c.rb', 'act'),
    ]);
    const fo = steps.find((s) => s.chunkId === 'app/models/factory_only.rb')!;
    expect(fo.phase).toBe('setup');
    expect(fo.hits).toBe(2);
  });

  it('无 controller → 全部 request 且无 setup 步(model spec 场景,行为同现状)', () => {
    const steps = foldTrace([call('/app/app/models/a.rb', 'f'), call('/app/app/models/b.rb', 'g')]);
    expect(steps.map((s) => s.chunkId)).toEqual(['app/models/a.rb', 'app/models/b.rb']);
    expect(steps.every((s) => s.phase === 'request')).toBe(true);
  });

  it('步序:setup 段首现序在前(非字典序),request 段按分界后首次命中序', () => {
    const steps = foldTrace([
      call('/app/app/models/z_setup.rb', 'f'),
      call('/app/app/models/a_setup.rb', 'f'),
      call('/app/app/models/late.rb', 'f'),
      call('/app/app/controllers/c.rb', 'act'),
      call('/app/app/models/late.rb', 'f'),
      call('/app/app/models/early.rb', 'f'),
    ]);
    expect(steps.map((s) => s.chunkId)).toEqual([
      'app/models/z_setup.rb', 'app/models/a_setup.rb',
      'app/controllers/c.rb', 'app/models/late.rb', 'app/models/early.rb',
    ]);
    expect(steps.map((s) => s.phase)).toEqual(['setup', 'setup', 'request', 'request', 'request']);
  });
});
```

(`call` 工厂在该测试文件顶部已有。第 5 条要点:z_setup/a_setup 保持首现序证明非字典序;late 首现于分界前但分界后再命中 → request,且按「分界后首次命中」排在 controller 之后、early 之前。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/flow-trace.test.ts`
Expected: 新增 5 条 FAIL(phase 为 undefined / 步序不符),原有 6 条 PASS。

- [ ] **Step 3: types.ts 加 phase 字段**

`src/types.ts` 的 `FlowStep` 接口中 `hits: ...` 行之后加一行:

```ts
  phase?: 'setup' | 'request'; // 分相(spec:2026-07-16-flow-phase-design.md);旧数据无此字段=不分段
```

- [ ] **Step 4: foldTrace 整函数替换**

`src/flow/trace.ts` 中从 `/** 调用序列 → 文件级链:...` 注释行起、到文件末尾的整段(即旧 foldTrace 及其文档注释),替换为:

```ts
/** 调用序列 → 文件级链 + 分相(spec:2026-07-16-flow-phase-design.md):
 *  去容器前缀、只保 app/、hits=全链命中次数。
 *  分界点 = 首次进 app/controllers/ 的调用(含自身);分界起仍被命中 → request,否则 setup。
 *  steps 重排:setup 段(首现序)在前、request 段(按分界后首次命中序,叙事从 controller 开场)在后;
 *  无分界点 → 全部 request、不分段(model spec 等,行为同分相前)。 */
export function foldTrace(calls: RawCall[], containerPrefix = '/app/'): FlowStep[] {
  const rels: string[] = calls.map((c) => {
    if (!c.file.startsWith(containerPrefix)) return '';
    const rel = c.file.slice(containerPrefix.length);
    return rel.startsWith('app/') ? rel : '';
  });
  const boundary = rels.findIndex((r) => r.startsWith('app/controllers/'));

  const byFile = new Map<string, { hits: number; methodCounts: Map<string, number>; firstAfterBoundary: number }>();
  const order: string[] = [];
  for (let i = 0; i < calls.length; i++) {
    const rel = rels[i];
    if (!rel) continue;
    let e = byFile.get(rel);
    if (!e) { e = { hits: 0, methodCounts: new Map(), firstAfterBoundary: -1 }; byFile.set(rel, e); order.push(rel); }
    e.hits++;
    e.methodCounts.set(calls[i].method, (e.methodCounts.get(calls[i].method) ?? 0) + 1);
    if (boundary >= 0 && i >= boundary && e.firstAfterBoundary < 0) e.firstAfterBoundary = i;
  }

  const toStep = (f: string, phase: 'setup' | 'request'): FlowStep => {
    const e = byFile.get(f)!;
    const methods = [...e.methodCounts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, METHODS_TOP_N)
      .map(([m]) => m);
    return { chunkId: f, methods, hits: e.hits, phase };
  };

  if (boundary < 0) return order.map((f) => toStep(f, 'request'));
  const setup = order.filter((f) => byFile.get(f)!.firstAfterBoundary < 0);
  const request = order.filter((f) => byFile.get(f)!.firstAfterBoundary >= 0)
    .sort((a, b) => byFile.get(a)!.firstAfterBoundary - byFile.get(b)!.firstAfterBoundary);
  return [...setup.map((f) => toStep(f, 'setup')), ...request.map((f) => toStep(f, 'request'))];
}
```

**TRACER_RB 段与 import/常量一字不动。**

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/flow-trace.test.ts test/cli-flow.test.ts`
Expected: 全 PASS(flow-trace 11 条;cli-flow 6 条——既有测试的 steps 断言只查 chunkId 数组,phase 追加不破坏)。若 cli-flow 有 toEqual 深比较挂掉,把该断言的期望对象补上对应 phase 字段(合法的连带更新,报告里注明)。

- [ ] **Step 6: 全量 + typecheck + commit**

Run: `npm test`(预期 65 文件 328)与 `npm run typecheck`(干净)。

```bash
git add src/types.ts src/flow/trace.ts test/flow-trace.test.ts
git commit -m "feat: foldTrace 分相——controller 分界+双相判定,setup/request 段重排"
```

(若 Step 5 连带改了 test/cli-flow.test.ts,一并 add 并在 commit message 里加一行说明。)

---

### Task 2: viewer——setup 段折叠 + 图例释义

**Files:**
- Modify: `test/viewer-state.test.ts`(追加 1 条 it 到 flows describe)
- Modify: `test/serve-page.test.ts`(追加 2 条 it)
- Modify: `src/serve/page.ts`(四处编辑,全逐字)

- [ ] **Step 1: 写失败测试**

`test/viewer-state.test.ts` 的 `describe('buildViewerState flows(纵向切割,spec §7)')` 内部末尾追加:

```ts
  it('steps 带 phase 原样透传到前端', () => {
    const withPhase = { version: 1 as const, flows: [{
      id: 'flow-p', name: 'P',
      source: { kind: 'rspec-trace' as const, spec: 'spec/p_spec.rb', tracedAt: '2026-07-16T00:00:00Z' },
      steps: [{ chunkId: A, methods: ['f'], hits: 1, phase: 'request' as const }],
      rawTrace: [],
    }] };
    const s = buildViewerState(makeViewerTree(), makeViewerLabels(), { version: 1, understood: [] }, withPhase);
    expect(s.flows[0].steps[0].phase).toBe('request');
  });
```

`test/serve-page.test.ts` 的 describe 末尾追加:

```ts
  it('flow phase: setup 折叠头/持久化键/文案都在', () => {
    const html = renderPage();
    expect(html).toContain('flow-setup-head');
    expect(html).toContain('easyreview-flow-setup-collapsed');
    expect(html).toContain('引导与测试数据准备');
  });

  it('flow phase: 图例含相释义', () => {
    const html = renderPage();
    expect(html).toContain('setup=引导+测试数据');
    expect(html).toContain('request=请求叙事');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/viewer-state.test.ts test/serve-page.test.ts`
Expected: viewer-state 新 1 条 PASS(透传本就原样——它是回归锁,不是驱动开发的红灯;如实接受),serve-page 新 2 条 FAIL。

- [ ] **Step 3: page.ts 四处编辑**

**编辑 ①(CSS)**——`.flow-step code { ... }` 行之后加一行:

```css
.flow-setup-head { cursor: pointer; user-select: none; color: var(--accent); font-weight: 600; padding: 3px 0; }
```

**编辑 ②(JS 状态变量)**——`var refsOutCollapsed = ...` 行之后加一行:

```js
var flowSetupCollapsed = localStorage.getItem('easyreview-flow-setup-collapsed') !== 'no'; // 默认折叠
```

**编辑 ③(图例)**——FLOWS_LEGEND 整行替换为:

```js
var FLOWS_LEGEND = '纵向切片:一条真实业务流程的执行链(rspec 真跑采集,非静态猜测)· setup=引导+测试数据(默认折叠) request=请求叙事 · ×N=命中次数 · 点步骤看源码';
```

**编辑 ④(renderFlows 整函数替换)**——现有 `function renderFlows() { ... }` 整段替换为:

```js
function renderFlows() {
  var html = '';
  for (var i = 0; i < state.flows.length; i++) {
    var f = state.flows[i];
    html += '<div class="flow-card"><h3>' + esc(f.name) + '</h3>';
    html += '<div class="muted">来源:rspec 真跑采集(' + esc(f.spec) + ')</div>';
    if (!f.steps.length) html += '<div class="muted">(此流程没有步骤——flows.json 可能被手工改动,重跑 flow trace 重采)</div>';
    var setupCount = 0;
    for (var m = 0; m < f.steps.length; m++) if (f.steps[m].phase === 'setup') setupCount++;
    if (setupCount) {
      html += '<div class="flow-setup-head">' + (flowSetupCollapsed ? '▸ ' : '▾ ') + '引导与测试数据准备(第 1-' + setupCount + ' 步)</div>';
    }
    for (var j = 0; j < f.steps.length; j++) {
      var s = f.steps[j];
      if (s.phase === 'setup' && flowSetupCollapsed) continue;
      var c = state.chunks[s.chunkId];
      var label = c
        ? '<span class="nb flow-jump" data-ref="' + esc(s.chunkId) + '" title="' + esc(s.chunkId) + '">' + esc(c.name) + '</span>'
        : '<span class="muted" title="' + esc(s.chunkId) + '">' + esc(s.chunkId.split('/').pop()) + '</span>';
      html += '<div class="flow-step"><span class="no">' + (j + 1) + '.</span>' + label +
        ' <code>' + esc(s.methods.slice(0, 3).join(', ')) + '</code>' +
        ' <span class="hits">×' + s.hits + '</span></div>';
    }
    html += '</div>';
  }
  $('flows').innerHTML = html;
  var heads = $('flows').querySelectorAll('.flow-setup-head');
  for (var h = 0; h < heads.length; h++) {
    heads[h].addEventListener('click', function () {
      flowSetupCollapsed = !flowSetupCollapsed;
      localStorage.setItem('easyreview-flow-setup-collapsed', flowSetupCollapsed ? 'yes' : 'no');
      renderFlows();
    });
  }
  var els = $('flows').querySelectorAll('.flow-jump');
  for (var k = 0; k < els.length; k++) {
    els[k].addEventListener('click', function (ev) {
      selectedId = ev.currentTarget.getAttribute('data-ref');
      openDrawer(selectedId);
      render();
    });
  }
}
```

(与现状差异:setupCount 统计、折叠头(含 localStorage 交互)、折叠时 `continue` 跳过 setup 步、步号 `j + 1` 保持全局连续;其余逐字保留。旧数据无 phase → setupCount=0 → 无折叠头全量展示,零回归。)

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/serve-page.test.ts test/viewer-state.test.ts`
Expected: 全 PASS(serve-page 12、viewer-state 15)。

- [ ] **Step 5: 全量回归 + typecheck**

Run: `npm test`
Expected: **65 文件 331 测试**全 PASS(323 + Task1 的 5 + 本任务 3)。
Run: `npm run typecheck`
Expected: 干净。

- [ ] **Step 6: Commit**

```bash
git add test/viewer-state.test.ts test/serve-page.test.ts src/serve/page.ts
git commit -m "feat: 流程视图 setup 段默认折叠——叙事从 controller 开场,图例补相释义"
```

---

## 真仓验收(主会话做,不在任务内)

1. 重跑:`npm run flow -- trace spec/controllers/api/v1/accounts/conversations/messages_controller_spec.rb --name "发消息(API→模型→分发)" --repo E:/learning/agent-research/repos/chatwoot --out E:/dev/easyReview/out/chatwoot`(同 id 覆盖旧流程)。
2. 物证:conversation.rb / message.rb / messages_controller 的 phase=request;工厂/引导文件 phase=setup;请求段第一步是 controller;setup+request 步数总和=总步数。
3. HTTP 层:steps 带 phase 到前端;页面含折叠头。
4. 旧数据回归:临时用无 phase 的 flows.json(重跑前先备份一份)serve → 不分段零回归。
5. 真实仓零接触;umwelt 零接触。