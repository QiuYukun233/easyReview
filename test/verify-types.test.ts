import { describe, it, expect } from 'vitest';
import type { TestResult, CargoTestRun, MutationOp, BlastRadius, Verdict } from '../src/types.js';

describe('verify types', () => {
  it('shapes are usable', () => {
    const tr: TestResult = { name: 'core::field::tests::x', passed: true };
    const run: CargoTestRun = { compiled: true, results: [tr] };
    const op: MutationOp = { file: 'a.rs', line: 5, original: '  x += 1;', mutated: '  // x += 1;', description: '注释一行' };
    const blast: BlastRadius = { chunkId: 'a.rs', mutation: op, newlyFailing: ['t1'], compileBroke: false, note: '' };
    const v: Verdict = { chunkId: 'a.rs', predicted: ['t1'], actual: ['t1'], hits: ['t1'], misses: [], falseAlarms: [], passed: true };
    expect(run.results[0].passed).toBe(true);
    expect(v.passed).toBe(true);
  });
});
