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
