import { describe, it, expect } from 'vitest';
import { chooseMutation } from '../src/verify/mutate.js';
import type { Chunk, Leaf } from '../src/types.js';

const mk = (file: string): { chunk: Chunk; leaves: (s: number, e: number) => Leaf[] } => ({
  chunk: { id: file, name: 'x', file, crate: 'app', leafIds: [] },
  leaves: (s, e) => [{ id: 'l', kind: 'fn', name: 'x', file, startLine: s, endLine: e, loc: e - s + 1 }],
});

describe('chooseMutation (js)', () => {
  it('js chunk gets // prefix via tree-sitter site', async () => {
    const { chunk, leaves } = mk('app/javascript/helper/url.js');
    const src = 'export function f(a) {\n  doWork(a);\n  return a;\n}\n';
    const op = (await chooseMutation(chunk, leaves(1, 4), src))!;
    expect(op.line).toBe(2);
    expect(op.mutated).toBe('  // doWork(a);');
  });

  it('regex fallback: takes first ;-terminated line, skips backtick lines', async () => {
    const { chunk, leaves } = mk('app/javascript/helper/plain.js');
    // 无 tree-sitter 好语句(只有声明),回退 regex
    const src = [
      'export function f() {',        // 1  不以 ; 结尾
      '  const q = `has backtick`;',  // 2  含反引号——保守跳过
      '  const v = 1;',               // 3  ← 回退选这行
      '}',
    ].join('\n');
    const op = (await chooseMutation(chunk, leaves(1, 4), src))!;
    expect(op.line).toBe(3);
    expect(op.mutated).toBe('  // const v = 1;');
  });

  it('vue chunk mutates inside script region only', async () => {
    const { chunk } = mk('app/javascript/widget/App.vue');
    const sfc = [
      '<template>',
      '  <div @click="go" />',
      '</template>',
      '<script setup>',
      'const go = () => {',
      '  emit("done");',
      '};',
      '</script>',
    ].join('\n');
    const vueLeaves: Leaf[] = [{ id: 'l', kind: 'fn', name: 'go', file: chunk.file, startLine: 5, endLine: 7, loc: 3 }];
    const op = (await chooseMutation(chunk, vueLeaves, sfc))!;
    expect(op.line).toBe(6);
    expect(op.mutated).toBe('  // emit("done");');
  });

  it('unknown language → null (不再回退 RUST——PR #11 终审回访)', async () => {
    const chunk: Chunk = { id: 'notes.txt', name: 'notes', file: 'notes.txt', crate: 'root', leafIds: [] };
    const leaves: Leaf[] = [{ id: 'l', kind: 'fn', name: 'x', file: 'notes.txt', startLine: 1, endLine: 3, loc: 3 }];
    expect(await chooseMutation(chunk, leaves, 'do_thing();\n')).toBeNull();
  });
});
