import { describe, it, expect } from 'vitest';
import { cargoRunner } from '../src/verify/runner.js';
import type { Exec } from '../src/verify/cargo.js';
import type { Chunk, GradedTree } from '../src/types.js';

const fakeChunk = { id: 'crates/a/src/lib.rs', crate: 'my_crate', file: 'crates/a/src/lib.rs' } as Chunk;
const fakeTree = {} as GradedTree;

describe('cargoRunner', () => {
  it('pickScope returns the chunk crate as serializable scope', () => {
    const { scope } = cargoRunner.pickScope(fakeTree, fakeChunk, '/repo');
    expect(scope).toEqual({ crate: 'my_crate' });
    expect(JSON.parse(JSON.stringify(scope))).toEqual({ crate: 'my_crate' });
  });

  it('run delegates to cargo with sandbox cwd + CARGO_TARGET_DIR', async () => {
    let seen: { args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv } = {};
    const fake: Exec = async (_c, args, cwd, env) => { seen = { args, cwd, env }; return 'test a::t1 ... ok'; };
    const run = await cargoRunner.run('/sb/src', '/sb/target', { crate: 'my_crate' }, fake);
    expect(run.compiled).toBe(true);
    expect(run.results).toEqual([{ name: 'a::t1', passed: true }]);
    expect(seen.cwd).toBe('/sb/src');
    expect(seen.env?.CARGO_TARGET_DIR).toBe('/sb/target');
    expect(seen.args).toContain('my_crate');
  });

  it('group delegates to module grouping', () => {
    const groups = cargoRunner.group(['core::field::t1', 'core::field::t2', 'lone']);
    expect(groups).toEqual([
      { module: '(crate 根)', tests: ['lone'] },
      { module: 'core::field', tests: ['core::field::t1', 'core::field::t2'] },
    ]);
  });
});
