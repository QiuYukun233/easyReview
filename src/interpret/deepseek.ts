import OpenAI from 'openai';
import type { Interpreter, InterpretInput, ChunkInterpretation } from '../types.js';
import type { ChatCompletionsClient } from '../label/deepseek.js';
import { InterpretSchema, INTERPRET_SYSTEM, interpretUserPrompt } from './prompt.js';

/** 单块解读:任何错误(网络/空内容/坏 JSON)→ null 不抛,由 serve 层决定降级。 */
export class DeepSeekInterpreter implements Interpreter {
  constructor(private client: ChatCompletionsClient, private model: string) {}

  async interpret(input: InterpretInput): Promise<ChunkInterpretation | null> {
    try {
      const resp = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: INTERPRET_SYSTEM },
          { role: 'user', content: interpretUserPrompt(input) },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 4096,
      });
      const content = resp.choices[0]?.message?.content;
      if (!content) throw new Error('空内容');
      const parsed = InterpretSchema.safeParse(JSON.parse(content));
      if (!parsed.success) throw new Error('JSON 不符合 InterpretSchema');
      const known = new Set(input.functions.map((f) => f.name));
      const kept = parsed.data.functions.filter((f) => known.has(f.name));
      if (kept.length !== parsed.data.functions.length || kept.length !== input.functions.length) {
        console.warn(`[interpret] 块 ${input.chunkId} 函数名单与事实不一致(返回 ${parsed.data.functions.length},命中 ${kept.length}/${input.functions.length})——已过滤未知名`);
      }
      return { ...parsed.data, functions: kept };
    } catch (err) {
      console.warn(`[interpret] 块 ${input.chunkId} 解读失败:${String(err)}`);
      return null;
    }
  }
}

/** 无 DEEPSEEK_API_KEY → null(serve 据此回 503,viewer 灰字降级)。 */
export function makeInterpreterFromEnv(
  model: string = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
): Interpreter | null {
  if (!process.env.DEEPSEEK_API_KEY) return null;
  const client = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
  return new DeepSeekInterpreter(client as unknown as ChatCompletionsClient, model);
}
