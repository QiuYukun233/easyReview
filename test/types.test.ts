import { describe, it, expect } from 'vitest';
import type { Leaf } from '../src/types.js';

describe('types', () => {
  it('Leaf shape is usable', () => {
    const leaf: Leaf = {
      id: 'a.rs::foo::1', kind: 'fn', name: 'foo',
      file: 'a.rs', startLine: 1, endLine: 3, loc: 3,
    };
    expect(leaf.name).toBe('foo');
  });
});
