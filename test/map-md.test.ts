import { describe, it, expect } from 'vitest';
import { renderMapMarkdown } from '../src/render/map-md.js';
import type { GradedTree } from '../src/types.js';

const graded: GradedTree = {
  repo: '/x',
  chapters: [
    { id: 'foo:core', name: 'foo::core', crate: 'foo', dir: 'core', chunkIds: ['a.rs'] },
    { id: 'foo:util', name: 'foo::util', crate: 'foo', dir: 'util', chunkIds: ['b.rs'] },
  ],
  chunks: [
    { id: 'a.rs', name: 'a', file: 'a.rs', crate: 'foo', leafIds: [] },
    { id: 'b.rs', name: 'b', file: 'b.rs', crate: 'foo', leafIds: [] },
  ],
  leaves: [],
  grades: {
    'a.rs': { risk: 0.9, riskBucket: 'high', contribution: 0.9, contribBucket: 'high', signals: {} as any },
    'b.rs': { risk: 0.1, riskBucket: 'none', contribution: 0.1, contribBucket: 'filler', signals: {} as any },
  },
};

describe('renderMapMarkdown', () => {
  it('places chapters into the risk×contribution grid', () => {
    const md = renderMapMarkdown(graded);
    expect(md).toContain('# easyReview 地图');
    expect(md).toContain('foo::core');
    expect(md).toContain('foo::util');
    expect(md).toContain('填充');
    expect(md).toContain('风险 高');
  });
});
