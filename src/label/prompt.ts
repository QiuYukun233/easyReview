import { z } from 'zod';
import type { ChunkLabelInput } from '../types.js';

export const LabelSchema = z.object({
  responsibility: z.string(),
  whyNow: z.string(),
});

/** 铁律框架 + 两字段说明。两个 provider 共用；DeepSeek 在此基础上追加 JSON 指令。 */
export const BASE_SYSTEM =
  '你是代码库导览助手。给定一个已经确定好的代码块（一个文件）及其函数源码，你只为它写两句中文：\n' +
  '- responsibility：一句话说清这个块对外的职责。\n' +
  '- whyNow：一句话说清现在学它的理由（承上启下 / 架构核心 / 简单填充 等）。\n' +
  '严禁发明输入中未出现的结构、依赖或调用关系。只描述给定的内容。';

export function userPrompt(i: ChunkLabelInput): string {
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
