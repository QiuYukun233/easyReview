import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDone } from '../src/serve/done.js';
import { makeViewerTree } from './viewer-fixture.js';

const A = 'crates/foo/src/a.rs';

let dirs: string[] = [];
afterEach(() => { dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); dirs = []; });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'easyrev-serve-')); dirs.push(d); return d; };

describe('applyDone', () => {
  it('writes understood to progress.json for a valid chunk (idempotent)', () => {
    const dir = tmp();
    const r1 = applyDone(makeViewerTree(), dir, A);
    expect(r1).toEqual({ status: 200, body: { ok: true } });
    const p = JSON.parse(readFileSync(join(dir, 'easyreview.progress.json'), 'utf8'));
    expect(p.understood).toEqual([A]);
    const r2 = applyDone(makeViewerTree(), dir, A);   // 重复标记不重复写入
    expect(r2.status).toBe(200);
    const p2 = JSON.parse(readFileSync(join(dir, 'easyreview.progress.json'), 'utf8'));
    expect(p2.understood).toEqual([A]);
  });

  it('rejects unknown chunk with 400 and writes nothing', () => {
    const dir = tmp();
    const r = applyDone(makeViewerTree(), dir, 'nope.rs');
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toContain('nope.rs');
    expect(existsSync(join(dir, 'easyreview.progress.json'))).toBe(false);
  });

  it('rejects missing/non-string chunkId with 400', () => {
    const dir = tmp();
    expect(applyDone(makeViewerTree(), dir, undefined).status).toBe(400);
    expect(applyDone(makeViewerTree(), dir, 42).status).toBe(400);
    expect(applyDone(makeViewerTree(), dir, '').status).toBe(400);
  });
});
