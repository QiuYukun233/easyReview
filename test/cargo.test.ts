import { describe, it, expect } from 'vitest';
import { runCargoTests } from '../src/verify/cargo.js';

describe('runCargoTests', () => {
  it('uses injected exec and parses its output', async () => {
    const fakeExec = async (_cmd: string, _args: string[], _cwd: string) =>
      'running 2 tests\ntest a::t1 ... ok\ntest a::t2 ... FAILED\n\ntest result: FAILED. 1 passed; 1 failed';
    const run = await runCargoTests('/repo', 'chem_field', fakeExec);
    expect(run.compiled).toBe(true);
    expect(run.results).toEqual([
      { name: 'a::t1', passed: true },
      { name: 'a::t2', passed: false },
    ]);
  });

  it('treats compile-error output as not compiled', async () => {
    const fakeExec = async () => 'error[E0425]: cannot find value\nerror: could not compile `chem_field`';
    const run = await runCargoTests('/repo', 'chem_field', fakeExec);
    expect(run.compiled).toBe(false);
    expect(run.results).toEqual([]);
  });
});
