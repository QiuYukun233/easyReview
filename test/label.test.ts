import { describe, it, expect, vi } from 'vitest';
import { collectLabelInputs, labelChunks } from '../src/label/label.js';
import type { GradedTree, Labeler, Grade, ChunkLabelInput } from '../src/types.js';

function fixture(): { graded: GradedTree; sources: Record<string, string> } {
  const grade: Grade = {
    risk: 0.1, riskBucket: 'low', contribution: 0.1, contribBucket: 'filler',
    signals: { relChurn: 0, coupling: 0, ownership: 0, centrality: 0, sizeNorm: 0 },
  };
  const graded: GradedTree = {
    repo: 'r',
    chapters: [{ id: 'k:', name: 'k::', crate: 'k', dir: '', chunkIds: ['a.rs', 'b.rs'] }],
    chunks: [
      { id: 'a.rs', name: 'a', file: 'a.rs', crate: 'k', leafIds: ['a.rs::f::1'] },
      { id: 'b.rs', name: 'b', file: 'b.rs', crate: 'k', leafIds: [] },
    ],
    leaves: [{ id: 'a.rs::f::1', kind: 'fn', name: 'f', file: 'a.rs', startLine: 1, endLine: 2, loc: 2 }],
    grades: { 'a.rs': grade, 'b.rs': grade },
  };
  const sources = { 'a.rs': 'fn f() {\n  do_it();\n}\n', 'b.rs': '' };
  return { graded, sources };
}

describe('collectLabelInputs', () => {
  it('slices function source, records neighbors and a content hash', () => {
    const { graded, sources } = fixture();
    const inputs = collectLabelInputs(graded, sources);
    const a = inputs.find((i) => i.chunkId === 'a.rs')!;
    expect(a.functions).toEqual([{ name: 'f', source: 'fn f() {\n  do_it();' }]);
    expect(a.chapterName).toBe('k::');
    expect(a.neighbors).toEqual(['b']);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const b = inputs.find((i) => i.chunkId === 'b.rs')!;
    expect(b.functions).toEqual([]);
  });
});

describe('labelChunks', () => {
  it('only labels stale chunks, merges into cache', async () => {
    const { graded, sources } = fixture();
    const inputs = collectLabelInputs(graded, sources);
    const cache = { version: 1 as const, entries: {
      'b.rs': { responsibility: 'old', whyNow: 'old', contentHash: inputs.find((i) => i.chunkId === 'b.rs')!.contentHash },
    } };
    const labeler: Labeler = {
      label: vi.fn(async (stale: ChunkLabelInput[]) => Object.fromEntries(stale.map((s) => [s.chunkId, { responsibility: 'R', whyNow: 'W' }]))),
    };
    const out = await labelChunks(inputs, cache, labeler);
    expect((labeler.label as any).mock.calls[0][0].map((s: any) => s.chunkId)).toEqual(['a.rs']); // b 命中缓存
    expect(out.entries['a.rs'].responsibility).toBe('R');
    expect(out.entries['b.rs'].responsibility).toBe('old');
  });

  it('degrades silently when labeler is null (no key)', async () => {
    const { graded, sources } = fixture();
    const inputs = collectLabelInputs(graded, sources);
    const out = await labelChunks(inputs, { version: 1, entries: {} }, null);
    expect(out).toEqual({ version: 1, entries: {} });
  });

  it('degrades silently when labeler throws, keeps old cache', async () => {
    const { graded, sources } = fixture();
    const inputs = collectLabelInputs(graded, sources);
    const cache = { version: 1 as const, entries: {} };
    const labeler: Labeler = { label: async () => { throw new Error('boom'); } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await labelChunks(inputs, cache, labeler);
    expect(out).toEqual({ version: 1, entries: {} });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
