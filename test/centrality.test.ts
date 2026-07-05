import { describe, it, expect } from 'vitest';
import { nameFanInCentrality } from '../src/grade/centrality.js';
import type { Leaf } from '../src/types.js';

const leaf = (file: string, name: string): Leaf => ({
  id: `${file}::${name}::1`, kind: 'fn', name, file, startLine: 1, endLine: 1, loc: 1,
});

describe('nameFanInCentrality', () => {
  it('counts cross-file identifier occurrences of a chunk\'s function names', () => {
    const leaves = [leaf('util.rs', 'helper'), leaf('main.rs', 'run')];
    const sources: Record<string, string> = {
      'util.rs': 'pub fn helper() {}',
      'main.rs': 'fn run() { helper(); helper(); }',
    };
    const cen = nameFanInCentrality(leaves, sources);
    expect(cen['util.rs']).toBe(1);
    expect(cen['main.rs'] ?? 0).toBe(0);
  });
});
