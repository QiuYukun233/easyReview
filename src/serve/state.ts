import type { GradedTree, LabelCache, Progress, NodeId, RiskBucket, ContribBucket, FlowsFile, FlowStep, FlowCandidatesFile } from '../types.js';
import { buildPath } from '../path/sequence.js';
import { whyNow } from '../render/journey-md.js';

export interface ViewerChunk {
  name: string; file: string; crate: string; chapterName: string;
  riskBucket: RiskBucket; contribBucket: ContribBucket;
  understood: boolean; verified: boolean;
  responsibility: string | null;  // labels.json 没有则 null
  whyNow: string;                 // LLM 的,或 journey-md 静态回退
  functions: { name: string; startLine: number }[];
  neighbors: NodeId[];
  refsIn: { from: NodeId; names: string[] }[]; // 入边(落盘已按权重降序);weight 不出——内部量纲对读者无意义
  refsOut: { to: NodeId; names: string[] }[]; // 出边(落盘已按权重降序);weight 不出,同 refsIn
}

export interface ViewerState {
  generatedAt: string;
  progress: { understood: number; verified: number; total: number };
  grid: { riskBuckets: RiskBucket[]; contribBuckets: ContribBucket[]; cells: Record<string, NodeId[]> };
  chunks: Record<NodeId, ViewerChunk>;
  path: NodeId[];
  nextId: NodeId | null;
  hasRefs: boolean; // tree.refsIn 是否存在;false=老产物两处不渲染(区别于"有数据但此块无入边")
  hasRefsOut: boolean; // tree.refsOut 是否存在;仅 refsIn 的中间期产物此旗标 false
  flows: { id: string; name: string; spec: string; steps: FlowStep[] }[]; // rawTrace 不出前端
  hasFlows: boolean; // 有至少一条流程才渲染 Tab
  candidates: { id: string; name: string; spec: string }[]; // 未追踪的可追踪候选(已追踪的滤掉)
  hasCandidates: boolean; // 跑过 flow discover(候选文件存在)才渲染候选段;区别于"跑了但零候选"
}

const RISK_ROWS: RiskBucket[] = ['high', 'med', 'low', 'none'];
const CONTRIB_COLS: ContribBucket[] = ['filler', 'low', 'med', 'high'];

export function buildViewerState(g: GradedTree, labels: LabelCache, progress: Progress, flowsFile?: FlowsFile | null, candidatesFile?: FlowCandidatesFile | null): ViewerState {
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
      functions: g.leaves.filter((l) => l.file === c.id).map((l) => ({ name: l.name, startLine: l.startLine })),
      neighbors: neighborsByChunk[c.id] ?? [],
      refsIn: (g.refsIn?.[c.id] ?? []).map((r) => ({ from: r.from, names: r.names })),
      refsOut: (g.refsOut?.[c.id] ?? []).map((r) => ({ to: r.to, names: r.names })),
    };
  }

  const pathIds = path.steps.map((s) => s.chunkId);
  const flowList = flowsFile?.flows ?? [];
  const tracedIds = new Set(flowList.map((f) => f.id));
  const candidates = (candidatesFile?.candidates ?? []).filter((c) => !tracedIds.has(c.id));
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
    hasRefs: g.refsIn !== undefined,
    hasRefsOut: g.refsOut !== undefined,
    flows: flowList.map((f) => ({ id: f.id, name: f.name, spec: f.source.spec, steps: f.steps })),
    hasFlows: flowList.length > 0,
    candidates: candidates.map((c) => ({ id: c.id, name: c.name, spec: c.spec })),
    hasCandidates: candidatesFile != null,
  };
}
