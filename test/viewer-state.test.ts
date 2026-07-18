import { describe, it, expect } from 'vitest';
import { buildViewerState } from '../src/serve/state.js';
import { makeViewerTree, makeViewerLabels, makeViewerTreeWithRefs, makeViewerTreeWithRefsOut } from './viewer-fixture.js';

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
    expect(s.chunks[A].functions).toEqual([{ name: 'f1', startLine: 1 }, { name: 'f2', startLine: 5 }]);
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

describe('buildViewerState refsOut(它依赖谁)', () => {
  it('refsOut 进 ViewerChunk 去 weight,hasRefsOut=true', () => {
    const s = buildViewerState(makeViewerTreeWithRefsOut(), makeViewerLabels(), { version: 1, understood: [] });
    expect(s.hasRefsOut).toBe(true);
    expect(s.chunks[B].refsOut).toEqual([{ to: A, names: ['a'] }]);
    expect(s.chunks[A].refsOut).toEqual([]);
  });

  it('仅 refsIn 的中间期产物 → hasRefsOut=false 且各块 refsOut=[]', () => {
    const s = buildViewerState(makeViewerTreeWithRefs(), makeViewerLabels(), { version: 1, understood: [] });
    expect(s.hasRefs).toBe(true);
    expect(s.hasRefsOut).toBe(false);
    expect(s.chunks[B].refsOut).toEqual([]);
    expect(s.chunks[C].refsOut).toEqual([]);
  });

  it('全无的老产物 → 双旗标 false', () => {
    const s = buildViewerState(makeViewerTree(), makeViewerLabels(), { version: 1, understood: [] });
    expect(s.hasRefs).toBe(false);
    expect(s.hasRefsOut).toBe(false);
  });
});

describe('buildViewerState flows(纵向切割,spec §7)', () => {
  const FLOWS = { version: 1 as const, flows: [{
    id: 'flow-msg', name: '发消息',
    source: { kind: 'rspec-trace' as const, spec: 'spec/m_spec.rb', tracedAt: '2026-07-15T00:00:00Z' },
    steps: [{ chunkId: A, methods: ['f1'], hits: 2 }],
    rawTrace: [{ file: '/app/app/x.rb', method: 'f1', line: 1 }],
  }] };

  it('flows 进 state:steps/名字/来源 spec 保留,rawTrace 不出(payload 卫生)', () => {
    const s = buildViewerState(makeViewerTree(), makeViewerLabels(), { version: 1, understood: [] }, FLOWS);
    expect(s.hasFlows).toBe(true);
    expect(s.flows).toEqual([{ id: 'flow-msg', name: '发消息', spec: 'spec/m_spec.rb',
      steps: [{ chunkId: A, methods: ['f1'], hits: 2 }] }]);
  });

  it('第 4 参缺省(既有调用方)→ hasFlows=false 且 flows=[]', () => {
    const s = buildViewerState(makeViewerTree(), makeViewerLabels(), { version: 1, understood: [] });
    expect(s.hasFlows).toBe(false);
    expect(s.flows).toEqual([]);
    expect(buildViewerState(makeViewerTree(), makeViewerLabels(), { version: 1, understood: [] }, null).hasFlows).toBe(false);
  });

  it('空 flows 文件 → hasFlows=false(Tab 不该出现)', () => {
    const s = buildViewerState(makeViewerTree(), makeViewerLabels(), { version: 1, understood: [] },
      { version: 1, flows: [] });
    expect(s.hasFlows).toBe(false);
  });

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
});

describe('buildViewerState 候选(flow discover)', () => {
  const P = { version: 1 as const, understood: [] };
  const candFile = { version: 1 as const, candidates: [
    { id: 'flow-a-L1', name: 'A 流程', spec: 'spec/a_spec.rb:1' },
    { id: 'flow-b-L2', name: 'B 流程', spec: 'spec/b_spec.rb:2' },
  ] };

  it('无候选文件 → hasCandidates=false、candidates 空', () => {
    const s = buildViewerState(makeViewerTree(), makeViewerLabels(), P, null, null);
    expect(s.hasCandidates).toBe(false);
    expect(s.candidates).toEqual([]);
  });

  it('有候选文件 → hasCandidates=true、候选透出', () => {
    const s = buildViewerState(makeViewerTree(), makeViewerLabels(), P, null, candFile);
    expect(s.hasCandidates).toBe(true);
    expect(s.candidates.map((c) => c.id)).toEqual(['flow-a-L1', 'flow-b-L2']);
  });

  it('已追踪(同 id)的候选被滤掉', () => {
    const flowsFile = { version: 1 as const, flows: [
      { id: 'flow-a-L1', name: 'A', source: { kind: 'rspec-trace' as const, spec: 'spec/a_spec.rb:1', tracedAt: 't' }, steps: [], rawTrace: [] },
    ] };
    const s = buildViewerState(makeViewerTree(), makeViewerLabels(), P, flowsFile, candFile);
    expect(s.candidates.map((c) => c.id)).toEqual(['flow-b-L2']); // a 已追踪,只剩 b
    expect(s.hasCandidates).toBe(true); // 跑过 discover 就是 true(即使全被滤空也保持)
  });
});
