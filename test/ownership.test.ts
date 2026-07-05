import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { logNameOnly } from '../src/git.js';
import { ownershipConcentration } from '../src/grade/ownership.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

describe('ownershipConcentration', () => {
  it('top-author commit share per file', () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'solo.rs', '1'); commitAll(dir, 'c1', 'alice');
    writeRepoFile(dir, 'solo.rs', '2'); commitAll(dir, 'c2', 'alice');
    writeRepoFile(dir, 'shared.rs', '1'); commitAll(dir, 'c3', 'alice');
    writeRepoFile(dir, 'shared.rs', '2'); commitAll(dir, 'c4', 'bob');

    const own = ownershipConcentration(logNameOnly(dir));
    expect(own['solo.rs']).toBe(1);
    expect(own['shared.rs']).toBeCloseTo(0.5);
  });
});
