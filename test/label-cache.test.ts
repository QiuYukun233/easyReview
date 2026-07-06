import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeContentHash, selectStale, mergeLabels, loadLabelCache, saveLabelCache,
} from '../src/label/cache.js';
import type { ChunkLabelInput, LabelCache } from '../src/types.js';

const mkInput = (id: string, hash: string): ChunkLabelInput => ({
  chunkId: id, chunkName: id, file: id, chapterName: 'c',
  riskBucket: 'low', contribBucket: 'filler',
  functions: [{ name: 'f', source: 'fn f() {}' }], neighbors: [], contentHash: hash,
});

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

describe('label cache', () => {
  it('computeContentHash is deterministic and sensitive to source, buckets, and neighbors', () => {
    const base = { functions: [{ name: 'f', source: 'x' }], riskBucket: 'low', contribBucket: 'filler', neighbors: [] as string[] };
    expect(computeContentHash(base)).toBe(computeContentHash({ ...base }));
    expect(computeContentHash(base)).not.toBe(computeContentHash({ ...base, functions: [{ name: 'f', source: 'y' }] }));
    expect(computeContentHash(base)).not.toBe(computeContentHash({ ...base, riskBucket: 'high' }));
    expect(computeContentHash(base)).not.toBe(computeContentHash({ ...base, contribBucket: 'high' }));
    expect(computeContentHash(base)).not.toBe(computeContentHash({ ...base, neighbors: ['n'] }));
  });

  it('selectStale returns missing or hash-changed inputs only', () => {
    const cache: LabelCache = { version: 1, entries: {
      'same.rs': { responsibility: 'r', whyNow: 'w', contentHash: 'H1' },
      'changed.rs': { responsibility: 'r', whyNow: 'w', contentHash: 'OLD' },
    } };
    const inputs = [mkInput('same.rs', 'H1'), mkInput('changed.rs', 'H2'), mkInput('new.rs', 'H3')];
    const stale = selectStale(inputs, cache).map((i) => i.chunkId).sort();
    expect(stale).toEqual(['changed.rs', 'new.rs']);
  });

  it('mergeLabels writes fresh labels with their input hash, keeps others', () => {
    const cache: LabelCache = { version: 1, entries: {
      'keep.rs': { responsibility: 'old', whyNow: 'old', contentHash: 'K' },
    } };
    const inputs = [mkInput('keep.rs', 'K'), mkInput('fresh.rs', 'F')];
    const merged = mergeLabels(cache, inputs, { 'fresh.rs': { responsibility: 'new', whyNow: 'new' } });
    expect(merged.entries['keep.rs'].responsibility).toBe('old');
    expect(merged.entries['fresh.rs']).toEqual({ responsibility: 'new', whyNow: 'new', contentHash: 'F' });
  });

  it('loadLabelCache returns empty on missing file; saveLabelCache round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lbl-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const p = join(dir, 'labels.json');
    expect(loadLabelCache(p)).toEqual({ version: 1, entries: {} });
    const cache: LabelCache = { version: 1, entries: { 'a.rs': { responsibility: 'r', whyNow: 'w', contentHash: 'H' } } };
    saveLabelCache(p, cache);
    expect(loadLabelCache(p)).toEqual(cache);
  });

  it('loadLabelCache warns and returns empty on corrupt file (never throws)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lbl-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const p = join(dir, 'labels.json');
    writeFileSync(p, 'not valid json {');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadLabelCache(p)).toEqual({ version: 1, entries: {} });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('mergeLabels skips a fresh id absent from inputs', () => {
    const merged = mergeLabels(
      { version: 1, entries: {} },
      [mkInput('a.rs', 'A')],
      { 'ghost.rs': { responsibility: 'x', whyNow: 'y' } },
    );
    expect(merged.entries['ghost.rs']).toBeUndefined();
    expect(merged.entries['a.rs']).toBeUndefined();
  });
});
