import type { GradedTree, JourneyPath, LearningStep, NodeId } from '../types.js';

function difficultyOf(g: GradedTree, chunkId: NodeId): number {
  const grade = g.grades[chunkId];
  if (!grade) return 1;
  return 0.5 * grade.contribution + 0.3 * grade.risk + 0.2 * grade.signals.sizeNorm;
}

export function buildPath(g: GradedTree): JourneyPath {
  const chunkChapter: Record<NodeId, NodeId> = {};
  for (const ch of g.chapters) for (const id of ch.chunkIds) chunkChapter[id] = ch.id;

  const diff: Record<NodeId, number> = {};
  for (const c of g.chunks) diff[c.id] = difficultyOf(g, c.id);

  const chapterMin: Record<NodeId, number> = {};
  for (const ch of g.chapters) {
    chapterMin[ch.id] = ch.chunkIds.length
      ? Math.min(...ch.chunkIds.map((id) => diff[id] ?? 1))
      : 1;
  }

  const ordered = [...g.chunks].sort((a, b) => {
    const ca = chapterMin[chunkChapter[a.id]] ?? 1;
    const cb = chapterMin[chunkChapter[b.id]] ?? 1;
    if (ca !== cb) return ca - cb;
    return diff[a.id] - diff[b.id];
  });

  const neighborsOf = (id: NodeId): NodeId[] => {
    const ch = g.chapters.find((c) => c.id === chunkChapter[id]);
    return ch ? ch.chunkIds.filter((x) => x !== id) : [];
  };

  const steps: LearningStep[] = ordered.map((c, i) => ({
    chunkId: c.id,
    order: i,
    chapterId: chunkChapter[c.id],
    difficulty: diff[c.id],
    neighbors: neighborsOf(c.id),
  }));

  return { repo: g.repo, steps };
}
