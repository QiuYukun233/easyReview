import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe } from '../src/verify/probe.js';
import type { MutationOp, CargoTestRun } from '../src/types.js';

let dirs: string[] = [];
afterEach(() => { dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); dirs = []; });

function tmp(content: string): string {
  const d = mkdtempSync(join(tmpdir(), 'ezpr-')); dirs.push(d);
  const f = join(d, 'x.rs'); writeFileSync(f, content); return f;
}
const SRC = 'fn a() {\n    let x = 1;\n    x + 1\n}\n';
const op: MutationOp = { file: 'x.rs', line: 2, original: '    let x = 1;', mutated: '    // let x = 1;', description: '' };

describe('probe', () => {
  it('computes newly-failing tests and restores the file', async () => {
    const f = tmp(SRC);
    const after: CargoTestRun = { compiled: true, results: [
      { name: 't1', passed: true }, { name: 't2', passed: false }, { name: 't3', passed: false },
    ] };
    const blast = await probe({
      chunkId: 'x.rs', absFile: f, op,
      baselineGreen: ['t1', 't2', 't3'],
      runAfter: async () => after,
    });
    expect(blast.compileBroke).toBe(false);
    expect(blast.newlyFailing.sort()).toEqual(['t2', 't3']);
    expect(readFileSync(f, 'utf8')).toBe(SRC);
  });

  it('flags compile break', async () => {
    const f = tmp(SRC);
    const blast = await probe({
      chunkId: 'x.rs', absFile: f, op,
      baselineGreen: ['t1'],
      runAfter: async () => ({ compiled: false, results: [] }),
    });
    expect(blast.compileBroke).toBe(true);
    expect(blast.newlyFailing).toEqual(['<compile-error>']);
    expect(readFileSync(f, 'utf8')).toBe(SRC);
  });
});
