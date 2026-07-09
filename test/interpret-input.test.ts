import { describe, it, expect } from 'vitest';
import { collectInterpretInput, computeInterpretHash, MAX_SOURCE_CHARS } from '../src/interpret/input.js';
import { makeViewerTree } from './viewer-fixture.js';

const A = 'crates/foo/src/a.rs';
const SRC = 'fn f1() {}\n\nfn f2() {}\n';

function inputFor(src = SRC) {
  const tree = makeViewerTree();
  return collectInterpretInput(tree, tree.chunks.find((c) => c.id === A)!, src);
}

describe('collectInterpretInput', () => {
  it('拼出确定性事实:桶/章/邻居/信号/函数名单', () => {
    const i = inputFor();
    expect(i.chunkId).toBe(A);
    expect(i.chapterName).toBe('foo::src');
    expect(i.riskBucket).toBe('none');
    expect(i.contribBucket).toBe('filler');
    expect(i.neighbors).toEqual(['b']);
    expect(i.functions).toEqual([{ name: 'f1', startLine: 1 }, { name: 'f2', startLine: 5 }]);
    expect(i.signals.coupling).toBe(0.1);
    expect(i.truncated).toBe(false);
    expect(i.source).toBe(SRC);
  });

  it('contentHash 稳定;改源码/改桶位各自翻 hash', () => {
    expect(inputFor().contentHash).toBe(inputFor().contentHash);
    expect(inputFor('fn f1() { changed }\n').contentHash).not.toBe(inputFor().contentHash);
    const tree = makeViewerTree();
    const chunk = tree.chunks.find((c) => c.id === A)!;
    const base = collectInterpretInput(tree, chunk, SRC).contentHash;
    tree.grades[A] = { ...tree.grades[A], riskBucket: 'high' };
    expect(collectInterpretInput(tree, chunk, SRC).contentHash).not.toBe(base);
  });

  it('改 PROMPT_VERSION 翻 hash(通过 computeInterpretHash 注入版本验证)', () => {
    const i = inputFor();
    expect(computeInterpretHash(i, 'v-a')).not.toBe(computeInterpretHash(i, 'v-b'));
  });

  it('超长源码截断并标记 truncated', () => {
    const i = inputFor('x'.repeat(MAX_SOURCE_CHARS + 10));
    expect(i.truncated).toBe(true);
    expect(i.source.length).toBe(MAX_SOURCE_CHARS);
  });
});
