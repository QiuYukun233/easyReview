import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
  it('computeContentHash is deterministic and sensitive to source', () => {
    const a = computeContentHash([{ name: 'f', source: 'x' }]);
    const b = computeContentHash([{ name: 'f', source: 'x' }]);
    const c = computeContentHash([{ name: 'f', source: 'y' }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
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
});
