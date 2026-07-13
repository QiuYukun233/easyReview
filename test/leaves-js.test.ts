import { describe, it, expect } from 'vitest';
import { extractLeaves } from '../src/extract/leaves.js';
import { JS, VUE } from '../src/extract/lang.js';

describe('extractLeaves for JS', () => {
  it('captures all four named-function forms, skips anonymous callbacks', async () => {
    const src = [
      'export function decl(a) { return a; }',            // L1
      'export const arrow = (x) => x + 1;',               // L2
      'export default {',                                  // L3
      '  methods: {',                                      // L4
      '    shorthand() { return 1; },',                    // L5
      '    pairArrow: () => 2,',                           // L6
      '  },',
      '};',
      'arr.map(x => x * 2);',
    ].join('\n');
    const leaves = await extractLeaves('a/b.js', src, JS);
    const byName = Object.fromEntries(leaves.map((l) => [l.name, l]));
    expect(Object.keys(byName).sort()).toEqual(['arrow', 'decl', 'pairArrow', 'shorthand']);
    expect(byName['decl'].startLine).toBe(1);
    expect(byName['shorthand'].startLine).toBe(5);
    expect(byName['pairArrow'].startLine).toBe(6);
    // methods:(值是 object)与匿名 map 回调不成叶子
  });
});

describe('extractLeaves for Vue SFC', () => {
  it('leaf line numbers point into the real .vue file (template offset applied)', async () => {
    const sfc = [
      '<template>',            // L1
      '  <div @click="go" />', // L2
      '</template>',           // L3
      '<script setup>',        // L4
      'const go = () => 1;',   // L5
      'function helper() {',   // L6
      '  return 2;',           // L7
      '}',                     // L8
      '</script>',             // L9
      '',
    ].join('\n');
    const leaves = await extractLeaves('w/App.vue', sfc, VUE);
    const byName = Object.fromEntries(leaves.map((l) => [l.name, l]));
    expect(byName['go'].startLine).toBe(5);
    expect(byName['helper'].startLine).toBe(6);
    expect(byName['helper'].endLine).toBe(8);
    expect(byName['helper'].loc).toBe(3);
    expect(byName['go'].id).toBe('w/App.vue::go::5'); // id 用还原后的真实行号
  });

  it('template-only SFC yields zero leaves', async () => {
    const leaves = await extractLeaves('w/Pure.vue', '<template>\n  <div />\n</template>\n', VUE);
    expect(leaves).toEqual([]);
  });

  it('dual <script> blocks: leaves from both segments, offsets independent', async () => {
    const sfc = [
      '<script>',               // L1
      'function legacy() {',    // L2
      '  return 1;',            // L3
      '}',                      // L4
      '</script>',              // L5
      '<script setup>',         // L6
      'const modern = () => 2;',// L7
      '</script>',              // L8
      '',
    ].join('\n');
    const leaves = await extractLeaves('w/Dual.vue', sfc, VUE);
    const byName = Object.fromEntries(leaves.map((l) => [l.name, l]));
    expect(Object.keys(byName).sort()).toEqual(['legacy', 'modern']);
    expect(byName['legacy'].startLine).toBe(2);
    expect(byName['legacy'].endLine).toBe(4);
    expect(byName['modern'].startLine).toBe(7);
  });
});

describe('extractLeaves 第六形态:标识符调用含函数实参(通用规则)', () => {
  it('single-line computed binding becomes a named leaf', async () => {
    const src = 'const label = computed(() => makeLabel(props));\n';
    const leaves = await extractLeaves('a/c.js', src, JS);
    expect(leaves.map((l) => l.name)).toEqual(['label']);
    expect(leaves[0].startLine).toBe(1);
    expect(leaves[0].loc).toBe(1); // 单行:loc=1,verify 回退的 loc≥3 过滤会天然挡住
  });

  it('multi-line computed body: endLine covers the whole declarator (regex 回退域的前提)', async () => {
    const src = [
      'const heavy = computed(() => {', // L1
      '  const x = props.a;',           // L2
      '  return x + 1;',                // L3
      '});',                            // L4
    ].join('\n');
    const leaves = await extractLeaves('a/c.js', src, JS);
    expect(leaves.map((l) => l.name)).toEqual(['heavy']);
    expect(leaves[0].startLine).toBe(1);
    expect(leaves[0].endLine).toBe(4);
    expect(leaves[0].loc).toBe(4);
  });

  it('multiple function arguments yield exactly one leaf (no dedup needed)', async () => {
    const src = 'const both = pipe(() => 1, () => 2);\n';
    const leaves = await extractLeaves('a/c.js', src, JS);
    expect(leaves.map((l) => l.name)).toEqual(['both']);
  });

  it('nested declarators: outer and inner each become a leaf', async () => {
    const src = [
      'const outer = computed(() => {',          // L1
      '  const inner = watch(x, () => sync());', // L2
      '  return inner;',                          // L3
      '});',                                      // L4
    ].join('\n');
    const leaves = await extractLeaves('a/c.js', src, JS);
    const byName = Object.fromEntries(leaves.map((l) => [l.name, l]));
    expect(Object.keys(byName).sort()).toEqual(['inner', 'outer']);
    expect(byName['outer'].startLine).toBe(1);
    expect(byName['outer'].endLine).toBe(4);
    expect(byName['inner'].startLine).toBe(2);
  });

  it('generic rule captures unknown wrappers (方案 2 与白名单的分水岭)', async () => {
    const src = 'const nope = randomWrapper(() => 1);\n';
    const leaves = await extractLeaves('a/c.js', src, JS);
    expect(leaves.map((l) => l.name)).toEqual(['nope']);
  });

  it('setTimeout binding is captured (接受的代价——值不是函数也成叶,勿加白名单挡它)', async () => {
    const src = 'const id = setTimeout(() => tick(), 100);\n';
    const leaves = await extractLeaves('a/c.js', src, JS);
    expect(leaves.map((l) => l.name)).toEqual(['id']);
  });

  it('function_expression argument is captured (与形态 3/5 对称)', async () => {
    const src = 'const fe = wrap(function () { return 1; });\n';
    const leaves = await extractLeaves('a/c.js', src, JS);
    expect(leaves.map((l) => l.name)).toEqual(['fe']);
  });

  it('member-expression calls and plain calls are NOT captured', async () => {
    const src = [
      'const member = _.debounce(() => save(), 300);', // function 是 member_expression
      'const chained = api.get(() => 1);',             // 同上
      'const plain = foo(1, 2);',                      // 无函数实参
    ].join('\n');
    const leaves = await extractLeaves('a/c.js', src, JS);
    expect(leaves).toEqual([]);
  });

  it('vue SFC: 第六形态行号经 lineOffset 还原到真实文件坐标', async () => {
    const sfc = [
      '<template>',                                   // L1
      '  <div />',                                    // L2
      '</template>',                                  // L3
      '<script setup>',                               // L4
      'const count = computed(() => props.n + 1);',   // L5
      '</script>',                                    // L6
      '',
    ].join('\n');
    const leaves = await extractLeaves('w/Count.vue', sfc, VUE);
    expect(leaves.map((l) => l.name)).toEqual(['count']);
    expect(leaves[0].startLine).toBe(5);
    expect(leaves[0].id).toBe('w/Count.vue::count::5');
  });
});
