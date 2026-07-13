import { describe, it, expect } from 'vitest';
import { pickPreferredSite } from '../src/verify/pick-site.js';
import { JS, VUE } from '../src/extract/lang.js';

describe('pickPreferredSite (js)', () => {
  it('picks the first statement-position call/assignment', async () => {
    const src = [
      "import { x } from './x';",        // 1  import 不是表达式语句
      'export function f(a) {',           // 2
      '  const local = calc(a);',         // 3  声明不是目标
      '  doWork(a);',                      // 4  ← 首个好语句
      '  state.value = a + 1;',            // 5
      '  total += a;',                     // 6
      '}',
    ].join('\n');
    const site = (await pickPreferredSite(src, JS))!;
    expect(site.line).toBe(4);
    expect(site.original).toBe('  doWork(a);');
  });

  it('assignment and augmented assignment are targets too', async () => {
    const src = 'function g() {\n  state.value = 1;\n}\n';
    expect((await pickPreferredSite(src, JS))!.line).toBe(2);
    const src2 = 'function h() {\n  total += 1;\n}\n';
    expect((await pickPreferredSite(src2, JS))!.line).toBe(2);
  });

  it('await-wrapped call unwraps (existing WRAPPERS reused)', async () => {
    const src = 'async function f() {\n  await save();\n}\n';
    expect((await pickPreferredSite(src, JS))!.line).toBe(2);
  });

  it('multi-line template literal statement is excluded by single-line filter', async () => {
    const src = [
      'function f(a) {',
      '  notify(`multi',   // 2-3 跨行——不能选
      '  line ${a}`);',
      '}',
    ].join('\n');
    expect(await pickPreferredSite(src, JS)).toBeNull();
  });

  it('single-line template literal call is a safe target', async () => {
    const src = 'function f(a) {\n  notify(`one ${a}`);\n}\n';
    expect((await pickPreferredSite(src, JS))!.line).toBe(2);
  });
});

describe('pickPreferredSite (vue, carve 感知)', () => {
  it('site lands inside <script> region with real-file line numbers', async () => {
    const sfc = [
      '<template>',              // 1
      '  <div @click="go" />',   // 2  模板里的"调用"不可选
      '</template>',             // 3
      '<script setup>',          // 4
      'const go = () => {',      // 5
      '  emit("done");',         // 6  ← 目标,真实文件行 6
      '};',                      // 7
      '</script>',               // 8
    ].join('\n');
    const site = (await pickPreferredSite(sfc, VUE))!;
    expect(site.line).toBe(6);
    expect(site.original).toBe('  emit("done");');
  });

  it('statement on the opening-tag line is excluded (整行注释会连标签一起注释)', async () => {
    const sfc = '<script setup>doNow();\nrest();\n</script>\n';
    const site = (await pickPreferredSite(sfc, VUE))!;
    expect(site.line).toBe(2);
    expect(site.original).toBe('rest();');
  });

  it('template-only SFC → null', async () => {
    expect(await pickPreferredSite('<template><div /></template>\n', VUE)).toBeNull();
  });

  it('closing tag on the same line as the statement: candidate rejected (守卫回归)', async () => {
    expect(await pickPreferredSite('<script setup>\nfoo();</script>\n', VUE)).toBeNull();
  });

  it('dual script blocks: falls through to a site in the second segment', async () => {
    const sfc = [
      '<script>',            // 1
      'const a = 1;',        // 2  声明,非目标
      '</script>',           // 3
      '<script setup>',      // 4
      'boot();',             // 5  ← 第二段的目标,真实行 5
      '</script>',           // 6
    ].join('\n');
    const site = (await pickPreferredSite(sfc, VUE))!;
    expect(site.line).toBe(5);
    expect(site.original).toBe('boot();');
  });

  it('multi-line attribute opening tag: offset still lands on the real line', async () => {
    const sfc = [
      '<script',             // 1
      '  setup',             // 2
      '>',                   // 3
      'boot();',             // 4  ← 真实行 4
      '</script>',           // 5
    ].join('\n');
    const site = (await pickPreferredSite(sfc, VUE))!;
    expect(site.line).toBe(4);
    expect(site.original).toBe('boot();');
  });
});
