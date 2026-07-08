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
