import { describe, it, expect } from 'vitest';
import { parseCargoTest } from '../src/verify/parse.js';

const OK = `
   Compiling chem_field v0.1.0
    Finished test [unoptimized] target(s)
     Running unittests src/lib.rs

running 3 tests
test core::channel::tests::mix ... ok
test core::field::tests::sample_zero ... FAILED
test core::phase::tests::evolve ... ok

failures:
    core::field::tests::sample_zero

test result: FAILED. 2 passed; 1 failed; 0 ignored
`;

const BROKE = `
   Compiling chem_field v0.1.0
error[E0425]: cannot find value \`x\` in this scope
 --> crates/chem_field/src/core/field.rs:20:5
error: could not compile \`chem_field\` due to previous error
`;

describe('parseCargoTest', () => {
  it('parses per-test ok/FAILED into results', () => {
    const run = parseCargoTest(OK);
    expect(run.compiled).toBe(true);
    expect(run.results).toEqual([
      { name: 'core::channel::tests::mix', passed: true },
      { name: 'core::field::tests::sample_zero', passed: false },
      { name: 'core::phase::tests::evolve', passed: true },
    ]);
  });

  it('flags compile break with no test lines', () => {
    const run = parseCargoTest(BROKE);
    expect(run.compiled).toBe(false);
    expect(run.results).toEqual([]);
  });
});
