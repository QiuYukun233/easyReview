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

  it('includes ruby files with rails-style chapters; root file → crate root', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'app/models/user.rb', 'class User\n  def name; "n"; end\nend\n');
    writeRepoFile(dir, 'lib/util.rb', 'def helper; 1; end\n');
    writeRepoFile(dir, 'top.rb', 'def root_fn; 0; end\n');
    writeRepoFile(dir, 'README.md', 'x');
    commitAll(dir, 'init');

    const tree = await buildTree(dir);

    expect(tree.chunks.map((c) => c.file).sort()).toEqual(['app/models/user.rb', 'lib/util.rb', 'top.rb']);
    const user = tree.chunks.find((c) => c.file === 'app/models/user.rb')!;
    expect(user.crate).toBe('app');
    expect(user.name).toBe('user');
    const userChapter = tree.chapters.find((ch) => ch.chunkIds.includes(user.id))!;
    expect(userChapter.id).toBe('app:models');
    const top = tree.chunks.find((c) => c.file === 'top.rb')!;
    expect(top.crate).toBe('root');
    expect(tree.leaves.map((l) => l.name).sort()).toEqual(['helper', 'name', 'root_fn']);
  });

  it('mixes rust and ruby chunks in one repo', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'crates/foo/src/lib.rs', 'pub fn a() {}');
    writeRepoFile(dir, 'app/models/user.rb', 'def m; 1; end\n');
    commitAll(dir, 'init');

    const tree = await buildTree(dir);
    expect(tree.chunks).toHaveLength(2);
    expect(tree.leaves).toHaveLength(2);
  });

  it('applies include prefixes at directory boundaries', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'app/models/user.rb', 'def m; 1; end\n');
    writeRepoFile(dir, 'apps/other.rb', 'def o; 1; end\n');
    writeRepoFile(dir, 'lib/util.rb', 'def h; 1; end\n');
    commitAll(dir, 'init');

    const tree = await buildTree(dir, { include: ['app'] });
    expect(tree.chunks.map((c) => c.file)).toEqual(['app/models/user.rb']);
  });
});
