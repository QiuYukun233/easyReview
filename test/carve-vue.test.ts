import { describe, it, expect } from 'vitest';
import { carveVueScript } from '../src/extract/carve-vue.js';

describe('carveVueScript', () => {
  it('single <script setup>: body content and lineOffset point back into the real file', () => {
    const sfc = '<template>\n  <div />\n</template>\n<script setup>\nconst f = () => 1;\n</script>\n';
    const segs = carveVueScript(sfc);
    expect(segs).toHaveLength(1);
    // 区段从开标签的 > 之后开始(含该行剩余部分),lineOffset = 开标签结尾所在 0 基行号
    expect(segs[0].source).toBe('\nconst f = () => 1;\n');
    expect(segs[0].lineOffset).toBe(3);
    // 验证行号还原:区段内 row 1(const f 行)+ 1 + lineOffset = 文件真实第 5 行
  });

  it('plain <script> with attributes', () => {
    const sfc = '<script lang="js">\nexport default {};\n</script>\n<template><div /></template>\n';
    const segs = carveVueScript(sfc);
    expect(segs).toHaveLength(1);
    expect(segs[0].source).toBe('\nexport default {};\n');
    expect(segs[0].lineOffset).toBe(0);
  });

  it('<script> and <script setup> coexisting: two segments in order', () => {
    const sfc = '<script>\nconst a = 1;\n</script>\n<script setup>\nconst b = 2;\n</script>\n';
    const segs = carveVueScript(sfc);
    expect(segs).toHaveLength(2);
    expect(segs[0].source).toContain('const a');
    expect(segs[0].lineOffset).toBe(0);
    expect(segs[1].source).toContain('const b');
    expect(segs[1].lineOffset).toBe(3);
  });

  it('no script block: empty array (纯模板组件)', () => {
    expect(carveVueScript('<template>\n  <div />\n</template>\n')).toEqual([]);
  });

  it('opening tag not at line start: offset still correct', () => {
    const sfc = '<template><div /></template><script setup>\nconst g = () => 2;\n</script>\n';
    const segs = carveVueScript(sfc);
    expect(segs).toHaveLength(1);
    expect(segs[0].lineOffset).toBe(0); // 开标签结尾仍在第 0 行
    expect(segs[0].source).toBe('\nconst g = () => 2;\n');
  });

  it('unclosed <script>: lenient, carve to EOF', () => {
    const segs = carveVueScript('<script setup>\nconst h = 3;\n');
    expect(segs).toHaveLength(1);
    expect(segs[0].source).toBe('\nconst h = 3;\n');
  });

  it('hyphenated custom elements are NOT script tags', () => {
    const sfc = '<script-runner foo="bar">\nnot js\n</script-runner>\n<script setup>\nconst k = 4;\n</script>\n';
    const segs = carveVueScript(sfc);
    expect(segs).toHaveLength(1);
    expect(segs[0].source).toBe('\nconst k = 4;\n');
    expect(segs[0].lineOffset).toBe(3);
  });

  it('attributes spanning multiple lines: lineOffset counts to end of opening tag', () => {
    const sfc = '<script\n  setup\n  lang="js"\n>\nconst m = 5;\n</script>\n';
    const segs = carveVueScript(sfc);
    expect(segs).toHaveLength(1);
    expect(segs[0].source).toBe('\nconst m = 5;\n');
    expect(segs[0].lineOffset).toBe(3); // 开标签的 > 在 0 基第 3 行
  });
});
