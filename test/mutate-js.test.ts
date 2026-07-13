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

  it('regex fallback never picks literal-closing lines (};/];)', async () => {
    const { chunk, leaves } = mk('app/javascript/widget/options.js');
    // 全文件无 call/assignment——必走 regex 回退;函数体内的候选只有字面量收尾与一条声明
    const src = [
      'export default {',      // 1
      '  data() {',            // 2
      '    return {',          // 3
      '      count: 0,',       // 4  以 , 结尾,不选
      '    };',                // 5  收尾行——绝不能选
      '  },',                  // 6
      '};',                    // 7
    ].join('\n');
    const op = await chooseMutation(chunk, leaves(2, 6), src);
    expect(op).toBeNull(); // 该范围内没有任何安全可注释行
  });

  it('regex fallback never picks multi-line call closers ());)', async () => {
    const { chunk, leaves } = mk('app/javascript/store/dispatcher.js');
    const src = [
      'export function f(store) {',    // 1
      '  store.dispatch(',             // 2  多行调用——tree-sitter 单行过滤不命中
      '    "conversation/fetch",',     // 3  以 , 结尾,不选
      '  );',                          // 4  闭括号行——绝不能选
      '}',                             // 5
    ].join('\n');
    expect(await chooseMutation(chunk, leaves(1, 5), src)).toBeNull();
  });

  it('vue regex fallback stays inside the script region (真正走回退路径)', async () => {
    const { chunk } = mk('app/javascript/widget/Decl.vue');
    // script 里只有声明,tree-sitter 无候选 → regex 回退;唯一 ; 结尾的安全行是声明行
    const sfc = [
      '<template>',                 // 1
      '  <div>{{ label }}</div>',   // 2
      '</template>',                // 3
      '<script setup>',             // 4
      'const label = computed(',    // 5  多行调用,tree-sitter 单行过滤不命中
      '  () => makeLabel,',         // 6
      ');',                         // 7  闭括号——新守卫拒绝
      'const alt = makeAlt;',       // 8  ← 回退应选这行
      '</script>',                  // 9
    ].join('\n');
    const vueLeaves: Leaf[] = [{ id: 'l', kind: 'fn', name: 'label', file: chunk.file, startLine: 5, endLine: 8, loc: 4 }];
    const op = (await chooseMutation(chunk, vueLeaves, sfc))!;
    expect(op.line).toBe(8);
    expect(op.mutated).toBe('// const alt = makeAlt;');
  });

  it('unknown language → null (不再回退 RUST——PR #11 终审回访)', async () => {
    const chunk: Chunk = { id: 'notes.txt', name: 'notes', file: 'notes.txt', crate: 'root', leafIds: [] };
    const leaves: Leaf[] = [{ id: 'l', kind: 'fn', name: 'x', file: 'notes.txt', startLine: 1, endLine: 3, loc: 3 }];
    expect(await chooseMutation(chunk, leaves, 'do_thing();\n')).toBeNull();
  });
});
