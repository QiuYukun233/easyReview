import { describe, it, expect, vi, afterEach } from 'vitest';
import { DeepSeekLabeler, makeDeepSeekLabelerFromEnv } from '../src/label/deepseek.js';
import type { ChunkLabelInput } from '../src/types.js';

const mkInput = (id: string, src: string): ChunkLabelInput => ({
  chunkId: id, chunkName: id, file: id, chapterName: 'c',
  riskBucket: 'low', contribBucket: 'filler',
  functions: [{ name: 'f', source: src }], neighbors: [], contentHash: 'h',
});

describe('DeepSeekLabeler', () => {
  it('calls chat.completions.create per chunk with json_object mode + json prompt, maps parsed labels', async () => {
    const create = vi.fn(async (_args: any) => ({ choices: [{ message: { content: JSON.stringify({ responsibility: 'R', whyNow: 'W' }) } }] }));
    const labeler = new DeepSeekLabeler({ chat: { completions: { create } } } as any, 'deepseek-v4-flash');
    const out = await labeler.label([mkInput('a.rs', 'fn f(){ SENTINEL }')]);
    expect(create).toHaveBeenCalledTimes(1);
    const args = create.mock.calls[0][0] as any;
    expect(args.model).toBe('deepseek-v4-flash');
    expect(args.response_format).toEqual({ type: 'json_object' });
    const promptText = args.messages.map((m: any) => m.content).join('\n');
    expect(promptText).toContain('SENTINEL');           // 源码进了 prompt
    expect(promptText.toLowerCase()).toContain('json');  // DeepSeek 硬性要求
    expect(promptText).toContain('responsibility');      // 示例键
    expect(out['a.rs']).toEqual({ responsibility: 'R', whyNow: 'W' });
  });

  it('drops a chunk on empty content / bad json / missing field (per-chunk resilience)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies: (string | null)[] = [
      null,                                    // 空内容
      'not json',                              // 坏 JSON
      JSON.stringify({ responsibility: 'x' }), // 缺 whyNow
    ];
    let n = 0;
    const create = vi.fn(async () => ({ choices: [{ message: { content: bodies[n++] } }] }));
    const labeler = new DeepSeekLabeler({ chat: { completions: { create } } } as any, 'deepseek-v4-flash');
    const out = await labeler.label([mkInput('a.rs', 'x'), mkInput('b.rs', 'y'), mkInput('c.rs', 'z')]);
    expect(out).toEqual({});               // 三块全被丢
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

describe('makeDeepSeekLabelerFromEnv', () => {
  const saved = process.env.DEEPSEEK_API_KEY;
  afterEach(() => { if (saved === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = saved; });

  it('returns null without DEEPSEEK_API_KEY', () => {
    delete process.env.DEEPSEEK_API_KEY;
    expect(makeDeepSeekLabelerFromEnv()).toBeNull();
  });

  it('returns a labeler when DEEPSEEK_API_KEY is set (no network on construct)', () => {
    process.env.DEEPSEEK_API_KEY = 'dummy';
    expect(makeDeepSeekLabelerFromEnv()).not.toBeNull();
  });
});
