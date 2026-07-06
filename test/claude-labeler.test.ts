import { describe, it, expect, vi } from 'vitest';
import { ClaudeLabeler } from '../src/label/claude.js';
import type { ChunkLabelInput } from '../src/types.js';

const mkInput = (id: string, src: string): ChunkLabelInput => ({
  chunkId: id, chunkName: id, file: id, chapterName: 'c',
  riskBucket: 'low', contribBucket: 'filler',
  functions: [{ name: 'f', source: src }], neighbors: [], contentHash: 'h',
});

describe('ClaudeLabeler', () => {
  it('calls messages.parse once per chunk, includes source, maps parsed output', async () => {
    const parse = vi.fn(async (args: any) => ({
      parsed_output: { responsibility: `R:${args.messages[0].content.length}`, whyNow: 'W' },
    }));
    const client = { messages: { parse } };
    const labeler = new ClaudeLabeler(client as any, 'claude-haiku-4-5');
    const out = await labeler.label([mkInput('a.rs', 'fn f(){ SENTINEL }'), mkInput('b.rs', 'fn f(){}')]);

    expect(parse).toHaveBeenCalledTimes(2);
    // 不传 effort（haiku 会 400）
    expect(parse.mock.calls[0][0].output_config.effort).toBeUndefined();
    expect(parse.mock.calls[0][0].model).toBe('claude-haiku-4-5');
    // prompt 含源码
    const prompts = parse.mock.calls.map((c) => c[0].messages[0].content).join('\n');
    expect(prompts).toContain('SENTINEL');
    expect(out['a.rs'].whyNow).toBe('W');
    expect(out['b.rs'].responsibility).toBe('R:' + parse.mock.calls[1][0].messages[0].content.length);
  });

  it('drops chunks whose parsed_output is null', async () => {
    const parse = vi.fn(async () => ({ parsed_output: null }));
    const labeler = new ClaudeLabeler({ messages: { parse } } as any, 'claude-haiku-4-5');
    const out = await labeler.label([mkInput('a.rs', 'x')]);
    expect(out).toEqual({});
  });
});
