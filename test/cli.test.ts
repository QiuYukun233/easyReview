import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { runMap } from '../src/cli.js';
import type { Labeler } from '../src/types.js';
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

  it('writes easyreview.labels.json using an injected labeler', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'crates/foo/src/lib.rs', 'pub fn a() { b(); }\nfn b() {}');
    commitAll(dir, 'init');

    const labeler: Labeler = {
      label: async (inputs) =>
        Object.fromEntries(inputs.map((i) => [i.chunkId, { responsibility: `职责:${i.chunkName}`, whyNow: '现在学' }])),
    };
    await runMap({ repo: dir, outDir: dir, labeler });

    const labels = JSON.parse(readFileSync(join(dir, 'easyreview.labels.json'), 'utf8'));
    expect(labels.version).toBe(1);
    expect(labels.entries['crates/foo/src/lib.rs'].responsibility).toBe('职责:lib');
    expect(labels.entries['crates/foo/src/lib.rs'].contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('with labeler=null (no key) still writes tree+map, labels empty', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'crates/foo/src/lib.rs', 'pub fn a() {}');
    commitAll(dir, 'init');

    await runMap({ repo: dir, outDir: dir, labeler: null });

    expect(readFileSync(join(dir, 'easyreview.tree.json'), 'utf8')).toContain('grades');
    const labels = JSON.parse(readFileSync(join(dir, 'easyreview.labels.json'), 'utf8'));
    expect(labels.entries).toEqual({});
  });
});
