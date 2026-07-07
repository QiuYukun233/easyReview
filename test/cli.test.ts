import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { runMap, resolveLabeler, parseArgs } from '../src/cli.js';
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
    // labeler: null——避免环境里恰好有 DEEPSEEK_API_KEY 时本用例真触网（这里只测 tree/map 产出）
    await runMap({ repo: dir, outDir, labeler: null });

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

describe('resolveLabeler provider routing', () => {
  const savedD = process.env.DEEPSEEK_API_KEY;
  const savedA = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (savedD === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = savedD;
    if (savedA === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedA;
  });

  it('noLabel wins over everything', () => {
    expect(resolveLabeler({ repo: '', outDir: '', noLabel: true })).toBeNull();
  });

  it('an injected labeler wins over provider', () => {
    const fake: Labeler = { label: async () => ({}) };
    expect(resolveLabeler({ repo: '', outDir: '', labeler: fake })).toBe(fake);
  });

  it('defaults to deepseek: uses DEEPSEEK_API_KEY; provider=claude ignores it', () => {
    process.env.DEEPSEEK_API_KEY = 'dummy';
    delete process.env.ANTHROPIC_API_KEY;
    expect(resolveLabeler({ repo: '', outDir: '' })).not.toBeNull();               // 默认 deepseek，有 key
    expect(resolveLabeler({ repo: '', outDir: '', provider: 'claude' })).toBeNull(); // claude，无 ANTHROPIC key
  });

  it('provider=claude uses ANTHROPIC_API_KEY; default deepseek ignores it', () => {
    delete process.env.DEEPSEEK_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'dummy';
    expect(resolveLabeler({ repo: '', outDir: '', provider: 'claude' })).not.toBeNull();
    expect(resolveLabeler({ repo: '', outDir: '' })).toBeNull(); // 默认 deepseek，无 DEEPSEEK key
  });
});

describe('parseArgs --include', () => {
  it('defaults to undefined, parses comma-separated prefixes', () => {
    expect(parseArgs(['--repo', 'r']).include).toBeUndefined();
    expect(parseArgs(['--include', 'app,lib']).include).toEqual(['app', 'lib']);
    expect(parseArgs(['--include', ' app , ,lib ']).include).toEqual(['app', 'lib']);
  });
});

describe('runMap with ruby + include', () => {
  it('maps only chunks under the included prefix', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'app/models/user.rb', 'def m; 1; end\n');
    writeRepoFile(dir, 'lib/util.rb', 'def h; 1; end\n');
    commitAll(dir, 'init');

    await runMap({ repo: dir, outDir: dir, labeler: null, include: ['app'] });

    const tree = JSON.parse(readFileSync(join(dir, 'easyreview.tree.json'), 'utf8'));
    expect(tree.chunks.map((c: { file: string }) => c.file)).toEqual(['app/models/user.rb']);
  });
});
