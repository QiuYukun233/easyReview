import { describe, it, expect } from 'vitest';
import { judgeProbe, renderProbeMd } from '../src/flow/probe.js';
import type { Flow } from '../src/types.js';

const flow: Flow = {
  id: 'flow-msg-L25', name: '发消息·单例',
  source: { kind: 'rspec-trace', spec: 'spec/m_spec.rb:25', tracedAt: '2026-07-16T00:00:00Z' },
  steps: [{ chunkId: 'app/models/m.rb', methods: ['save'], hits: 3, phase: 'request' }],
  rawTrace: [],
};
const target = flow.steps[0];
const site = { line: 7, original: '    save!', scope: 'method' as const, method: 'save' };

describe('judgeProbe(红绿×预测四象限,spec §5)', () => {
  it('example 失败 → red;加载崩(compiled=false)也 → red', () => {
    expect(judgeProbe({ compiled: true, results: [{ name: 's', passed: false }] }, 'red'))
      .toEqual({ actual: 'red', predicted: 'red', hit: true });
    expect(judgeProbe({ compiled: false, results: [] }, 'green'))
      .toEqual({ actual: 'red', predicted: 'green', hit: false });
  });

  it('全绿 → green;命中与未命中各一', () => {
    expect(judgeProbe({ compiled: true, results: [{ name: 's', passed: true }] }, 'green'))
      .toEqual({ actual: 'green', predicted: 'green', hit: true });
    expect(judgeProbe({ compiled: true, results: [{ name: 's', passed: true }] }, 'red'))
      .toEqual({ actual: 'green', predicted: 'red', hit: false });
  });
});

describe('renderProbeMd(报告,spec §6)', () => {
  it('命中:含流程名/步/刀落点方法/✅ 文案;非回退时无回退标注', () => {
    const md = renderProbeMd({ flow, step: 1, target, site, fallback: false,
      verdict: { actual: 'red', predicted: 'red', hit: true } });
    expect(md).toContain('发消息·单例');
    expect(md).toContain('第 1 步');
    expect(md).toContain('save');
    expect(md).toContain('✅ 预测命中');
    expect(md).not.toContain('回退');
  });

  it('回退+诚实绿:含回退标注;绿的两种解释只在非回退绿时出现', () => {
    const fb = { line: 2, original: '  x = 1', scope: 'file-fallback' as const };
    const md1 = renderProbeMd({ flow, step: 1, target, site: fb, fallback: true,
      verdict: { actual: 'green', predicted: 'red', hit: false } });
    expect(md1).toContain('刀落在流程未必经过的位置');
    expect(md1).toContain('❌ 预测未命中');
    const md2 = renderProbeMd({ flow, step: 1, target, site, fallback: false,
      verdict: { actual: 'green', predicted: 'green', hit: true } });
    expect(md2).toContain('防御性');
  });

  it('回退×红:警示存在但不再说绿色不可信,标注红色结论仍有效', () => {
    const fb = { line: 2, original: '  x = 1', scope: 'file-fallback' as const };
    const md = renderProbeMd({ flow, step: 1, target, site: fb, fallback: true,
      verdict: { actual: 'red', predicted: 'red', hit: true } });
    expect(md).toContain('刀落在流程未必经过的位置');
    expect(md).toContain('红色结论仍有效');
    expect(md).not.toContain('不可作为理解凭据');
    expect(md).toContain('✅ 预测命中');
  });
});
