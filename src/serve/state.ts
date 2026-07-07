import type { GradedTree, LabelCache, Progress, NodeId, RiskBucket, ContribBucket } from '../types.js';
import { buildPath } from '../path/sequence.js';
import { whyNow } from '../render/journey-md.js';

export interface ViewerChunk {
  name: string; file: string; crate: string; chapterName: string;
  riskBucket: RiskBucket; contribBucket: ContribBucket;
  understood: boolean; verified: boolean;
  responsibility: string | null;  // labels.json 没有则 null
  whyNow: string;                 // LLM 的,或 journey-md 静态回退
  functions: string[];
  neighbors: NodeId[];
}

export interface ViewerState {
  generatedAt: string;
  progress: { understood: number; verified: number; total: number };
  grid: { riskBuckets: RiskBucket[]; contribBuckets: ContribBucket[]; cells: Record<string, NodeId[]> };
  chunks: Record<NodeId, ViewerChunk>;
  path: NodeId[];
  nextId: NodeId | null;
}

const RISK_ROWS: RiskBucket[] = ['high', 'med', 'low', 'none'];
const CONTRIB_COLS: ContribBucket[] = ['filler', 'low', 'med', 'high'];

export function buildViewerState(g: GradedTree, labels: LabelCache, progress: Progress): ViewerState {
  const path = buildPath(g);
  const understood = new Set(progress.understood);
  const verified = new Set(progress.verified ?? []);

  const cells: Record<string, NodeId[]> = {};
  for (const r of RISK_ROWS) for (const c of CONTRIB_COLS) cells[`${r}:${c}`] = [];

  const chapterName: Record<NodeId, string> = {};
  for (const ch of g.chapters) for (const id of ch.chunkIds) chapterName[id] = ch.name;

  const neighborsByChunk: Record<NodeId, NodeId[]> = {};
  for (const s of path.steps) neighborsByChunk[s.chunkId] = s.neighbors;

  const chunks: Record<NodeId, ViewerChunk> = {};
  for (const c of g.chunks) {
    const grade = g.grades[c.id];
    if (!grade) continue; // 无评级的块不进视图(map 产物中不应出现)
    cells[`${grade.riskBucket}:${grade.contribBucket}`].push(c.id);
    const label = labels.entries[c.id];
    chunks[c.id] = {
      name: c.name, file: c.file, crate: c.crate,
      chapterName: chapterName[c.id] ?? c.crate,
      riskBucket: grade.riskBucket, contribBucket: grade.contribBucket,
      understood: understood.has(c.id), verified: verified.has(c.id),
      responsibility: label ? label.responsibility : null,
      whyNow: label ? label.whyNow : whyNow(grade),
      functions: g.leaves.filter((l) => l.file === c.id).map((l) => l.name),
      neighbors: neighborsByChunk[c.id] ?? [],
    };
  }

  const pathIds = path.steps.map((s) => s.chunkId);
  return {
    generatedAt: new Date().toISOString(),
    progress: {
      understood: progress.understood.length,
      verified: (progress.verified ?? []).length,
      total: g.chunks.length,
    },
    grid: { riskBuckets: RISK_ROWS, contribBuckets: CONTRIB_COLS, cells },
    chunks,
    path: pathIds,
    nextId: pathIds.find((id) => !understood.has(id)) ?? null,
  };
}
