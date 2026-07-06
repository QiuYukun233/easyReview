import type { GradedTree, ChunkLabelInput, LabelCache, Labeler, ChunkLabel, NodeId } from '../types.js';
import { computeContentHash, selectStale, mergeLabels } from './cache.js';

export function collectLabelInputs(g: GradedTree, sources: Record<string, string>): ChunkLabelInput[] {
  return g.chunks.map((c) => {
    const grade = g.grades[c.id];
    const leaves = g.leaves.filter((l) => l.file === c.id);
    const lines = (sources[c.file] ?? '').split('\n');
    const functions = leaves.map((l) => ({
      name: l.name,
      source: lines.slice(l.startLine - 1, l.endLine).join('\n'),
    }));
    const chapter = g.chapters.find((ch) => ch.chunkIds.includes(c.id));
    const neighbors = chapter
      ? chapter.chunkIds
          .filter((x) => x !== c.id)
          .map((x) => g.chunks.find((cc) => cc.id === x)?.name ?? x)
      : [];
    return {
      chunkId: c.id,
      chunkName: c.name,
      file: c.file,
      chapterName: chapter?.name ?? '',
      riskBucket: grade.riskBucket,
      contribBucket: grade.contribBucket,
      functions,
      neighbors,
      contentHash: computeContentHash(functions),
    };
  });
}

export async function labelChunks(
  inputs: ChunkLabelInput[],
  cache: LabelCache,
  labeler: Labeler | null,
): Promise<LabelCache> {
  const stale = selectStale(inputs, cache);
  let fresh: Record<NodeId, ChunkLabel> = {};
  if (labeler && stale.length) {
    try {
      fresh = await labeler.label(stale);
    } catch (e) {
      console.warn(`⚠ 标签生成失败，跳过（保留旧缓存）：${e instanceof Error ? e.message : e}`);
      fresh = {};
    }
  }
  return mergeLabels(cache, inputs, fresh);
}
