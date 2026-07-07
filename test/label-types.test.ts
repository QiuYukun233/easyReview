import { describe, it, expect } from 'vitest';
import type { ChunkLabelInput, ChunkLabel, LabelCache, Labeler } from '../src/types.js';

describe('label types', () => {
  it('shapes compile and hold expected fields', () => {
    const label: ChunkLabel = { responsibility: 'r', whyNow: 'w' };
    const input: ChunkLabelInput = {
      chunkId: 'a.rs', chunkName: 'a', file: 'a.rs', chapterName: 'crate::',
      riskBucket: 'low', contribBucket: 'filler',
      functions: [{ name: 'f', source: 'fn f() {}' }], neighbors: ['b'], contentHash: 'h',
    };
    const cache: LabelCache = { version: 1, entries: { 'a.rs': { ...label, contentHash: 'h' } } };
    const fake: Labeler = { label: async () => ({ 'a.rs': label }) };
    expect(input.functions[0].name).toBe('f');
    expect(cache.entries['a.rs'].contentHash).toBe('h');
    expect(typeof fake.label).toBe('function');
  });
});
