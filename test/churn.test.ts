import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { logNameOnly } from '../src/git.js';
import { relativeChurn } from '../src/grade/churn.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

describe('relativeChurn', () => {
  it('normalizes commit-touch counts to 0..1 (max file = 1)', () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'hot.rs', '1'); commitAll(dir, 'c1');
    writeRepoFile(dir, 'hot.rs', '2'); commitAll(dir, 'c2');
    writeRepoFile(dir, 'hot.rs', '3'); writeRepoFile(dir, 'cold.rs', '1');
    commitAll(dir, 'c3');

    const churn = relativeChurn(logNameOnly(dir));
    expect(churn['hot.rs']).toBe(1);
    expect(churn['cold.rs']).toBeCloseTo(1 / 3);
  });

  it('returns 0 map for empty log', () => {
    expect(relativeChurn([])).toEqual({});
  });
});
