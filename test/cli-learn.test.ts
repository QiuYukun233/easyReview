import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { runMap } from '../src/cli.js';
import { runLearn, runDone } from '../src/cli-learn.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

describe('learn / done', () => {
  it('learn writes journey + progress; done advances progress', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'crates/foo/src/lib.rs', 'pub fn a() { b(); }\nfn b() {}');
    writeRepoFile(dir, 'crates/foo/src/util.rs', 'pub fn util() {}');
    writeRepoFile(dir, 'crates/foo/src/extra.rs', 'pub fn extra() {}');
    commitAll(dir, 'init');

    await runMap({ repo: dir, outDir: dir });
    await runLearn({ outDir: dir });

    expect(existsSync(join(dir, 'easyreview.journey.md'))).toBe(true);
    expect(existsSync(join(dir, 'easyreview.progress.json'))).toBe(true);
    const journey = readFileSync(join(dir, 'easyreview.journey.md'), 'utf8');
    expect(journey).toContain('# easyReview 学习旅程');
    expect(journey).toContain('0%');

    const firstDone = journey.match(/easyreview done (\S+)/)![1];
    await runDone({ outDir: dir, chunkId: firstDone });

    const progress = JSON.parse(readFileSync(join(dir, 'easyreview.progress.json'), 'utf8'));
    expect(progress.understood).toContain(firstDone);
    const journey2 = readFileSync(join(dir, 'easyreview.journey.md'), 'utf8');
    expect(journey2).not.toContain('0%');
  });
});
