import { createHash } from 'node:crypto';
import type { GradedTree, Chunk, InterpretInput } from '../types.js';

/** 改 prompt 时递增此常量 → 全部缓存自然失效重生成。 */
export const PROMPT_VERSION = 'interpret-v1';
/** 源码超长兜底:截前 8 万字符(≈2 万 token),prompt 里注明被截断。 */
export const MAX_SOURCE_CHARS = 80000;

export function computeInterpretHash(
  i: Omit<InterpretInput, 'contentHash'>,
  version: string = PROMPT_VERSION,
): string {
  const h = createHash('sha256');
  h.update(version); h.update('\0');
  h.update(i.source); h.update('\0');
  h.update(i.riskBucket); h.update('\0');
  h.update(i.contribBucket); h.update('\0');
  h.update(String(i.signals.relChurn)); h.update('\0');
  h.update(String(i.signals.coupling)); h.update('\0');
  h.update(String(i.signals.ownership)); h.update('\0');
  h.update(String(i.signals.centrality)); h.update('\0');
  for (const n of i.neighbors) { h.update(n); h.update('\0'); }
  h.update('\0');
  for (const f of i.functions) { h.update(f.name); h.update(':'); h.update(String(f.startLine)); h.update('\0'); }
  return h.digest('hex');
}

/** 整文件源码 + tree 已有确定性事实 → 喂料与缓存键。不新增任何分析。
 *  注意:tree 里没有 coupling 伙伴名单(map 只落数值),跨文件事实上限 = 邻居名单 + 信号档位。 */
export function collectInterpretInput(g: GradedTree, chunk: Chunk, source: string): InterpretInput {
  const grade = g.grades[chunk.id];
  const chapter = g.chapters.find((ch) => ch.chunkIds.includes(chunk.id));
  const neighbors = chapter
    ? chapter.chunkIds.filter((x) => x !== chunk.id).map((x) => g.chunks.find((c) => c.id === x)?.name ?? x)
    : [];
  const functions = g.leaves
    .filter((l) => l.file === chunk.id)
    .map((l) => ({ name: l.name, startLine: l.startLine }));
  const truncated = source.length > MAX_SOURCE_CHARS;
  const base = {
    chunkId: chunk.id, chunkName: chunk.name, file: chunk.file,
    chapterName: chapter?.name ?? chunk.crate,
    riskBucket: grade.riskBucket, contribBucket: grade.contribBucket,
    signals: grade.signals,
    functions, neighbors,
    source: truncated ? source.slice(0, MAX_SOURCE_CHARS) : source,
    truncated,
  };
  return { ...base, contentHash: computeInterpretHash(base) };
}
