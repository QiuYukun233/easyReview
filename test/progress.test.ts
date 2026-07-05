import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProgress, saveProgress, markUnderstood, percentComplete } from '../src/progress/progress.js';

let dirs: string[] = [];
afterEach(() => { dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); dirs = []; });

describe('progress', () => {
  it('returns empty progress when file missing', () => {
    const d = mkdtempSync(join(tmpdir(), 'ezp-')); dirs.push(d);
    const p = loadProgress(join(d, 'nope.json'));
    expect(p).toEqual({ version: 1, understood: [] });
  });

  it('mark is idempotent and round-trips through save/load', () => {
    const d = mkdtempSync(join(tmpdir(), 'ezp-')); dirs.push(d);
    const file = join(d, 'easyreview.progress.json');
    let p = loadProgress(file);
    p = markUnderstood(p, 'a.rs');
    p = markUnderstood(p, 'a.rs');
    p = markUnderstood(p, 'b.rs');
    saveProgress(file, p);
    const loaded = loadProgress(file);
    expect(loaded.understood).toEqual(['a.rs', 'b.rs']);
  });

  it('percentComplete rounds understood/total', () => {
    expect(percentComplete(0, { version: 1, understood: [] })).toBe(0);
    expect(percentComplete(4, { version: 1, understood: ['a', 'b'] })).toBe(50);
    expect(percentComplete(3, { version: 1, understood: ['a'] })).toBe(33);
  });

  it('preserves verified across load/mark/save (multi-chunk)', () => {
    const d = mkdtempSync(join(tmpdir(), 'ezp-')); dirs.push(d);
    const file = join(d, 'easyreview.progress.json');
    // simulate: chunk A already understood+verified
    saveProgress(file, { version: 1, understood: ['a.rs'], verified: ['a.rs'] });
    // now mark chunk B understood, then add B to verified (mirrors cli-verify flow)
    let p = loadProgress(file);
    expect(p.verified).toEqual(['a.rs']);          // verified survived the load
    p = markUnderstood(p, 'b.rs');
    expect(p.verified).toEqual(['a.rs']);          // mark didn't drop verified
    p = { ...p, verified: [...(p.verified ?? []), 'b.rs'] };
    saveProgress(file, p);
    const loaded = loadProgress(file);
    expect(loaded.understood).toEqual(['a.rs', 'b.rs']);
    expect(loaded.verified).toEqual(['a.rs', 'b.rs']); // A NOT dropped when B verified
  });
});
