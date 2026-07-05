import { describe, it, expect } from 'vitest';
import { gradeTree } from '../src/grade/grade.js';
import type { Tree } from '../src/types.js';

function fakeTree(): Tree {
  return {
    repo: '/x',
    chapters: [{ id: 'root:', name: 'root::/', crate: 'root', dir: '', chunkIds: ['hot.rs', 'mid.rs', 'cold.rs'] }],
    chunks: [
      { id: 'hot.rs', name: 'hot', file: 'hot.rs', crate: 'root', leafIds: ['hot.rs::h::1'] },
      { id: 'mid.rs', name: 'mid', file: 'mid.rs', crate: 'root', leafIds: ['mid.rs::m::1'] },
      { id: 'cold.rs', name: 'cold', file: 'cold.rs', crate: 'root', leafIds: ['cold.rs::c::1'] },
    ],
    leaves: [
      { id: 'hot.rs::h::1', kind: 'fn', name: 'h', file: 'hot.rs', startLine: 1, endLine: 20, loc: 20 },
      { id: 'mid.rs::m::1', kind: 'fn', name: 'm', file: 'mid.rs', startLine: 1, endLine: 10, loc: 10 },
      { id: 'cold.rs::c::1', kind: 'fn', name: 'c', file: 'cold.rs', startLine: 1, endLine: 2, loc: 2 },
    ],
  };
}

describe('gradeTree', () => {
  it('produces a grade per chunk with buckets, churn-dominant risk', () => {
    const tree = fakeTree();
    const graded = gradeTree(tree, {
      relChurn: { 'hot.rs': 1, 'mid.rs': 0.5, 'cold.rs': 0 },
      coupling: { 'hot.rs': 1, 'mid.rs': 0.3, 'cold.rs': 0 },
      ownership: { 'hot.rs': 1, 'mid.rs': 1, 'cold.rs': 1 },
      centrality: { 'hot.rs': 1, 'mid.rs': 0.5, 'cold.rs': 0 },
    });
    expect(Object.keys(graded.grades)).toHaveLength(3);
    const hot = graded.grades['hot.rs'];
    const cold = graded.grades['cold.rs'];
    expect(hot.risk).toBeGreaterThan(cold.risk);
    expect(hot.riskBucket).toBe('high');
    expect(cold.contribBucket).toBe('filler');
    expect(hot.risk).toBeGreaterThan(0.7);
  });
});
