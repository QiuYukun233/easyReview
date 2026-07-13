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
