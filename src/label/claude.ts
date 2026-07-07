import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Labeler, ChunkLabelInput, ChunkLabel, NodeId } from '../types.js';
import { LabelSchema, BASE_SYSTEM, userPrompt } from './prompt.js';
import { mapWithConcurrency } from './concurrency.js';

/** ClaudeLabeler 只依赖 messages.parse，便于测试注入 fake client。 */
export interface MessagesParseClient {
  messages: { parse(args: unknown): Promise<{ parsed_output: ChunkLabel | null }> };
}

export class ClaudeLabeler implements Labeler {
  constructor(private client: MessagesParseClient, private model: string) {}

  async label(inputs: ChunkLabelInput[]): Promise<Record<NodeId, ChunkLabel>> {
    const results = await mapWithConcurrency(inputs, 5, async (i) => {
      // 逐块容错：单块失败只丢自己（返回 null），不让整批 label() reject。
      try {
        const resp = await this.client.messages.parse({
          model: this.model,
          max_tokens: 1024,
          system: BASE_SYSTEM,
          messages: [{ role: 'user', content: userPrompt(i) }],
          // 只约束输出格式；不传 effort（haiku-4-5 不接受 effort，会 400）
          output_config: { format: zodOutputFormat(LabelSchema) },
        });
        return { id: i.chunkId, label: resp.parsed_output };
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

/** 无 ANTHROPIC_API_KEY → 返回 null（调用方据此跳过打标签，纯确定性 map 照常）。 */
export function makeClaudeLabelerFromEnv(
  model: string = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
): Labeler | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  // 双重 cast：call site 的 messages.parse({...}) 参数形状不再被编译器对照真实 SDK 校验（人工核对保证）。
  return new ClaudeLabeler(new Anthropic() as unknown as MessagesParseClient, model);
}
