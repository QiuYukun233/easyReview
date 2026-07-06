import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { Labeler, ChunkLabelInput, ChunkLabel, NodeId } from '../types.js';

const LabelSchema = z.object({
  responsibility: z.string(),
  whyNow: z.string(),
});

/** ClaudeLabeler 只依赖 messages.parse，便于测试注入 fake client。 */
export interface MessagesParseClient {
  messages: { parse(args: unknown): Promise<{ parsed_output: ChunkLabel | null }> };
}

const SYSTEM =
  '你是代码库导览助手。给定一个已经确定好的代码块（一个文件）及其函数源码，你只为它写两句中文：\n' +
  '- responsibility：一句话说清这个块对外的职责。\n' +
  '- whyNow：一句话说清现在学它的理由（承上启下 / 架构核心 / 简单填充 等）。\n' +
  '严禁发明输入中未出现的结构、依赖或调用关系。只描述给定的内容。';

function userPrompt(i: ChunkLabelInput): string {
  const fns = i.functions
    .map((f) => `### ${f.name}\n\`\`\`rust\n${f.source}\n\`\`\``)
    .join('\n\n');
  return (
    `块：${i.chunkName}（文件 ${i.file}，章 ${i.chapterName}）\n` +
    `风险：${i.riskBucket} · 架构贡献度：${i.contribBucket}\n` +
    `同章邻居：${i.neighbors.join('、') || '（无）'}\n\n` +
    `函数：\n${fns || '（本块无独立函数，可能是模块声明/重导出）'}`
  );
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < items.length) {
      const cur = idx++;
      out[cur] = await fn(items[cur]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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
          system: SYSTEM,
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
  // 双重 cast：call site 的 messages.parse({...}) 参数形状不再被编译器对照真实 SDK 校验
  // （靠上面的注释与人工核对保证），因此改动那段入参时需格外小心。
  return new ClaudeLabeler(new Anthropic() as unknown as MessagesParseClient, model);
}
