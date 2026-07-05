import { describe, it, expect } from 'vitest';
import { judge } from '../src/verify/judge.js';
import type { BlastRadius } from '../src/types.js';

const op = { file: 'x.rs', line: 2, original: 'a', mutated: 'b', description: '' };
const blast = (newlyFailing: string[], compileBroke = false): BlastRadius =>
  ({ chunkId: 'x.rs', mutation: op, newlyFailing, compileBroke, note: '' });

describe('judge', () => {
  it('exact hit passes', () => {
    const v = judge(blast(['t2', 't3']), ['t2', 't3']);
    expect(v.hits.sort()).toEqual(['t2', 't3']);
    expect(v.misses).toEqual([]);
    expect(v.falseAlarms).toEqual([]);
    expect(v.passed).toBe(true);
  });

  it('miss fails and reports what was missed / false-alarmed', () => {
    const v = judge(blast(['t2', 't3']), ['t2', 't9']);
    expect(v.hits).toEqual(['t2']);
    expect(v.misses).toEqual(['t3']);
    expect(v.falseAlarms).toEqual(['t9']);
    expect(v.passed).toBe(false);
  });

  it('compile break passes when learner predicted any impact', () => {
    const v = judge(blast(['<compile-error>'], true), ['t2']);
    expect(v.passed).toBe(true);
  });
});
