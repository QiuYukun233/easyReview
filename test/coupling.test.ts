import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { logNameOnly } from '../src/git.js';
import { changeCoupling } from '../src/grade/coupling.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

describe('changeCoupling', () => {
  it('counts distinct co-changed files, normalized to 0..1', () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'hub.rs', '1'); writeRepoFile(dir, 'a.rs', '1');
    commitAll(dir, 'c1');
    writeRepoFile(dir, 'hub.rs', '2'); writeRepoFile(dir, 'b.rs', '1');
    commitAll(dir, 'c2');
    writeRepoFile(dir, 'solo.rs', '1'); commitAll(dir, 'c3');

    const cp = changeCoupling(logNameOnly(dir));
    expect(cp['hub.rs']).toBe(1);
    expect(cp['a.rs']).toBeCloseTo(0.5);
    expect(cp['solo.rs'] ?? 0).toBe(0);
  });
});
