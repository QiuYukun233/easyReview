import OpenAI from 'openai';
import type { Labeler, ChunkLabelInput, ChunkLabel, NodeId } from '../types.js';
import { LabelSchema, BASE_SYSTEM, userPrompt } from './prompt.js';
import { mapWithConcurrency } from './concurrency.js';

/** DeepSeek 是 OpenAI 兼容；只依赖 chat.completions.create，便于测试注入 fake client。 */
export interface ChatCompletionsClient {
  chat: {
    completions: {
      create(args: unknown): Promise<{ choices: { message: { content: string | null } }[] }>;
    };
  };
}

// DeepSeek 要求 prompt 含 "json" 字样 + 示例，否则可能不返 JSON。
const DEEPSEEK_SYSTEM =
  BASE_SYSTEM +
  '\n\n请用 json 输出，且只输出 json，格式示例：{"responsibility": "一句话职责", "whyNow": "为什么现在学它"}';

export class DeepSeekLabeler implements Labeler {
  constructor(private client: ChatCompletionsClient, private model: string) {}

  async label(inputs: ChunkLabelInput[]): Promise<Record<NodeId, ChunkLabel>> {
    const results = await mapWithConcurrency(inputs, 5, async (i) => {
      // 逐块容错：网络错 / 空内容 / 坏 JSON / 缺字段 → 只丢自己（返回 null）。
      try {
        const resp = await this.client.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: DEEPSEEK_SYSTEM },
            { role: 'user', content: userPrompt(i) },
          ],
          response_format: { type: 'json_object' },
          max_tokens: 1024,
        });
        const content = resp.choices[0]?.message?.content;
        if (!content) throw new Error('空内容');
        const parsed = LabelSchema.safeParse(JSON.parse(content));
        if (!parsed.success) throw new Error('JSON 不符合 LabelSchema');
        return { id: i.chunkId, label: parsed.data as ChunkLabel };
      } catch (err) {
        console.warn(`[label] 跳过块 ${i.chunkId}：${String(err)}`);
        return { id: i.chunkId, label: null as ChunkLabel | null };
      }
    });
    const out: Record<NodeId, ChunkLabel> = {};
    for (const r of results) if (r.label) out[r.id] = r.label;
    return out;
  }
}

/** 无 DEEPSEEK_API_KEY → 返回 null（调用方据此跳过打标签，纯确定性 map 照常）。 */
export function makeDeepSeekLabelerFromEnv(
  model: string = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
): Labeler | null {
  if (!process.env.DEEPSEEK_API_KEY) return null;
  const client = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
  return new DeepSeekLabeler(client as unknown as ChatCompletionsClient, model);
}
