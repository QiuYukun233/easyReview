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
