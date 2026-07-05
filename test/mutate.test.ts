import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withMutation } from '../src/verify/mutate.js';
import type { MutationOp } from '../src/types.js';

let dirs: string[] = [];
afterEach(() => { dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); dirs = []; });

function tmp(content: string): string {
  const d = mkdtempSync(join(tmpdir(), 'ezm-')); dirs.push(d);
  const f = join(d, 'x.rs'); writeFileSync(f, content); return f;
}

const SRC = 'fn a() {\n    let x = 1;\n    x + 1\n}\n';

describe('withMutation', () => {
  it('applies mutation during fn, restores after', async () => {
    const f = tmp(SRC);
    const op: MutationOp = { file: 'x.rs', line: 2, original: '    let x = 1;', mutated: '    // let x = 1;', description: '' };
    let seen = '';
    await withMutation(f, op, async () => { seen = readFileSync(f, 'utf8'); });
    expect(seen).toContain('// let x = 1;');
    expect(readFileSync(f, 'utf8')).toBe(SRC);
  });

  it('restores even if fn throws', async () => {
    const f = tmp(SRC);
    const op: MutationOp = { file: 'x.rs', line: 2, original: '    let x = 1;', mutated: '    // let x = 1;', description: '' };
    await expect(withMutation(f, op, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(readFileSync(f, 'utf8')).toBe(SRC);
  });

  it('refuses if the target line does not match op.original', async () => {
    const f = tmp(SRC);
    const op: MutationOp = { file: 'x.rs', line: 2, original: 'WRONG', mutated: 'X', description: '' };
    await expect(withMutation(f, op, async () => {})).rejects.toThrow(/mismatch/i);
    expect(readFileSync(f, 'utf8')).toBe(SRC);
  });
});
