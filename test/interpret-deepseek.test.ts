import { describe, it, expect } from 'vitest';
import { DeepSeekInterpreter } from '../src/interpret/deepseek.js';
import { interpretUserPrompt, INTERPRET_SYSTEM } from '../src/interpret/prompt.js';
import { collectInterpretInput } from '../src/interpret/input.js';
import { makeViewerTree } from './viewer-fixture.js';

const A = 'crates/foo/src/a.rs';
const GOOD = { overview: '职责', dataFlow: '数据', calls: '调用', functions: [{ name: 'f1', gist: '一句话' }] };

function fakeClient(content: string | null) {
  return { chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } } };
}
function inputFor(src = 'fn f1() {}\n') {
  const tree = makeViewerTree();
  return collectInterpretInput(tree, tree.chunks.find((c) => c.id === A)!, src);
}

describe('DeepSeekInterpreter', () => {
  it('好 JSON → 四字段齐', async () => {
    const r = await new DeepSeekInterpreter(fakeClient(JSON.stringify(GOOD)), 'm').interpret(inputFor());
    expect(r).toEqual(GOOD);
  });

  it('坏 JSON / 缺字段 / 空内容 / 抛错 → null 不炸', async () => {
    expect(await new DeepSeekInterpreter(fakeClient('not json'), 'm').interpret(inputFor())).toBeNull();
    expect(await new DeepSeekInterpreter(fakeClient(JSON.stringify({ overview: '缺仨字段' })), 'm').interpret(inputFor())).toBeNull();
    expect(await new DeepSeekInterpreter(fakeClient(null), 'm').interpret(inputFor())).toBeNull();
    const boom = { chat: { completions: { create: async () => { throw new Error('网络挂了'); } } } };
    expect(await new DeepSeekInterpreter(boom, 'm').interpret(inputFor())).toBeNull();
  });

  it('函数名单不一致 → 过滤未知名并保留命中的', async () => {
    const bad = { ...GOOD, functions: [{ name: 'f1', gist: 'g' }, { name: 'invented', gist: 'x' }] };
    const r = await new DeepSeekInterpreter(fakeClient(JSON.stringify(bad)), 'm').interpret(inputFor());
    expect(r!.functions).toEqual([{ name: 'f1', gist: 'g' }]);
  });
});

describe('interpretUserPrompt / INTERPRET_SYSTEM', () => {
  it('含事实与源码围栏;系统提示含铁律与 json 指令', () => {
    const p = interpretUserPrompt(inputFor());
    expect(p).toContain('同章邻居:b');
    expect(p).toContain('```rust');
    expect(p).toContain('fn f1()');
    expect(p).toContain('(0.10)');
    expect(INTERPRET_SYSTEM).toContain('严禁发明');
    expect(INTERPRET_SYSTEM).toContain('json');
  });

  it('超长截断 → prompt 注明被截断', () => {
    expect(interpretUserPrompt(inputFor('x'.repeat(90000)))).toContain('截断');
  });
});
