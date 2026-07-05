import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { buildTree } from '../src/extract/tree.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

describe('buildTree', () => {
  it('groups tracked .rs files into chapters(crate/dir) → chunks(file) → leaves', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'crates/foo/Cargo.toml', '[package]\nname="foo"');
    writeRepoFile(dir, 'crates/foo/src/lib.rs', 'pub fn a() {}');
    writeRepoFile(dir, 'crates/foo/src/core/mod.rs', 'fn b() {}\nfn c() {}');
    writeRepoFile(dir, 'README.md', 'x');
    commitAll(dir, 'init');

    const tree = await buildTree(dir);

    expect(tree.chunks.map((c) => c.file).sort())
      .toEqual(['crates/foo/src/core/mod.rs', 'crates/foo/src/lib.rs']);
    expect(tree.chunks.every((c) => c.crate === 'foo')).toBe(true);
    const chapterDirs = tree.chapters.map((ch) => ch.dir).sort();
    expect(chapterDirs).toEqual(['src', 'src/core']);
    expect(tree.leaves).toHaveLength(3);
    const libChunk = tree.chunks.find((c) => c.file.endsWith('lib.rs'))!;
    expect(libChunk.leafIds).toHaveLength(1);
  });
});
