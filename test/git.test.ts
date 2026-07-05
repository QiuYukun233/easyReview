import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { listTrackedFiles, logNameOnly } from '../src/git.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

describe('git', () => {
  it('lists tracked files (POSIX paths)', () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'src/a.rs', 'fn a() {}');
    writeRepoFile(dir, 'src/b.rs', 'fn b() {}');
    commitAll(dir, 'init');
    expect(listTrackedFiles(dir).sort()).toEqual(['src/a.rs', 'src/b.rs']);
  });

  it('logNameOnly returns one commit record per commit with its files', () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'a.rs', '1'); commitAll(dir, 'c1', 'alice');
    writeRepoFile(dir, 'a.rs', '2'); writeRepoFile(dir, 'b.rs', '1');
    commitAll(dir, 'c2', 'bob');
    const log = logNameOnly(dir);
    expect(log).toHaveLength(2);
    expect(log[0].files).toContain('a.rs');
    expect(log[0].files).toContain('b.rs');
    expect(log[0].author).toBe('bob');
    expect(log[1].files).toEqual(['a.rs']);
    expect(log[1].author).toBe('alice');
  });
});
