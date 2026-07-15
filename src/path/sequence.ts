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
    const chA = chunkChapter[a.id];
    const chB = chunkChapter[b.id];
    const ca = chapterMin[chA] ?? 1;
    const cb = chapterMin[chB] ?? 1;
    if (ca !== cb) return ca - cb;
    if (chA !== chB) return chA < chB ? -1 : 1; // chapterMin 打平时按 chapterId 保证章内连续
    return diff[a.id] - diff[b.id];
  });

  // 邻居三段:真实依赖(refsOut to,权重序)→ 真实被依赖(refsIn from,滤非块)→ 章内其余;按序去重。
  // 学习路径顺序不动,只富化「顺便看看」;老产物(无 refsIn/refsOut)自动退化为纯章内。
  const allChunkIds = new Set(g.chunks.map((c) => c.id));
  const neighborsOf = (id: NodeId): NodeId[] => {
    const seen = new Set<NodeId>([id]);
    const out: NodeId[] = [];
    const add = (x: NodeId) => { if (!seen.has(x)) { seen.add(x); out.push(x); } };
    for (const r of g.refsOut?.[id] ?? []) add(r.to); // to 恒为块(centrality.ts 建边时已 guard),不用像 from 一样过滤
    for (const r of g.refsIn?.[id] ?? []) if (allChunkIds.has(r.from)) add(r.from);
    const ch = g.chapters.find((c) => c.id === chunkChapter[id]);
    for (const x of ch ? ch.chunkIds : []) add(x);
    return out;
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
