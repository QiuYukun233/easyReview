import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { runMap } from '../src/cli.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

describe('runMap', () => {
  it('produces graded-tree JSON + map markdown for a repo', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'crates/foo/src/lib.rs', 'pub fn a() { b(); }\nfn b() {}');
    writeRepoFile(dir, 'crates/foo/src/util.rs', 'pub fn util() {}');
    commitAll(dir, 'init');

    const outDir = dir;
    await runMap({ repo: dir, outDir });

    const tree = JSON.parse(readFileSync(join(outDir, 'easyreview.tree.json'), 'utf8'));
    expect(tree.chunks.length).toBe(2);
    expect(tree.grades).toBeDefined();
    const md = readFileSync(join(outDir, 'easyreview.map.md'), 'utf8');
    expect(md).toContain('# easyReview 地图');
  });
});
