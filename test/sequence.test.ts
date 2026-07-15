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
    expect(path.steps[0].neighbors).toContain('mid.rs');
    expect(path.steps[2].neighbors).toEqual([]);
  });
});

describe('buildPath 邻居:真实依赖前置(spec:2026-07-15-refsout-design.md)', () => {
  const withRefs = (): GradedTree => ({
    ...tree(),
    refsIn: { 'easy.rs': [
      { from: 'hard.rs', weight: 1, names: ['easy'] },
      { from: 'stray.txt', weight: 1, names: ['easy'] },
    ] },
    refsOut: { 'easy.rs': [{ to: 'hard.rs', weight: 2, names: ['core'] }] },
  });

  it('它依赖的块(refsOut to)排最前,跨章也进', () => {
    const path = buildPath(withRefs());
    const step = path.steps.find((s) => s.chunkId === 'easy.rs')!;
    expect(step.neighbors[0]).toBe('hard.rs'); // refsOut,跨章(foo:core)
  });

  it('依赖它的块(refsIn from)次之且滤非块;章内殿后;全程去重不含自己', () => {
    const path = buildPath(withRefs());
    const step = path.steps.find((s) => s.chunkId === 'easy.rs')!;
    expect(step.neighbors).toEqual(['hard.rs', 'mid.rs']); // hard.rs 已由 refsOut 出、refsIn 去重;stray.txt 非块滤掉;mid.rs 章内
    expect(step.neighbors).not.toContain('easy.rs');
    expect(step.neighbors).not.toContain('stray.txt');
  });

  it('无 refsIn/refsOut 的老产物退化为纯章内邻居(既有行为)', () => {
    const path = buildPath(tree());
    const step = path.steps.find((s) => s.chunkId === 'easy.rs')!;
    expect(step.neighbors).toEqual(['mid.rs']);
  });
});
