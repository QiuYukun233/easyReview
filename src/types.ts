export type NodeId = string;

export interface Leaf {
  id: NodeId;          // `${file}::${name}::${startLine}`
  kind: 'fn';
  name: string;
  file: string;        // 相对 repo 根的 POSIX 路径
  startLine: number;   // 1-based
  endLine: number;
  loc: number;
}

export interface Chunk {
  id: NodeId;          // 相对文件路径
  name: string;        // v1: 文件名（无扩展名）
  file: string;
  crate: string;
  leafIds: NodeId[];
}

export interface Chapter {
  id: NodeId;          // `${crate}:${dir}`
  name: string;        // `${crate}::${dir}` 人读标签
  crate: string;
  dir: string;         // crate 内相对目录，'' = crate 根
  chunkIds: NodeId[];
}

export interface Tree {
  repo: string;
  chapters: Chapter[];
  chunks: Chunk[];
  leaves: Leaf[];
}

export type RiskBucket = 'none' | 'low' | 'med' | 'high';
export type ContribBucket = 'filler' | 'low' | 'med' | 'high';

export interface Signals {
  relChurn: number;    // 0..1
  coupling: number;    // 0..1
  ownership: number;   // 0..1
  centrality: number;  // 0..1
  sizeNorm: number;    // 0..1
}

export interface Grade {
  risk: number;
  riskBucket: RiskBucket;
  contribution: number;
  contribBucket: ContribBucket;
  signals: Signals;
}

export interface GradedTree extends Tree {
  grades: Record<NodeId, Grade>;
}

export interface LearningStep {
  chunkId: NodeId;
  order: number;          // 0-based 路径位置
  chapterId: NodeId;
  difficulty: number;     // 0..1 复合（越低越早学）
  neighbors: NodeId[];    // 同章其它 chunk（防盲区觅食）
}

export interface JourneyPath {
  repo: string;
  steps: LearningStep[];  // 已按学习序排好
}

export interface Progress {
  version: 1;
  understood: NodeId[];   // 已标记理解的 chunk id
  verified?: NodeId[];   // 通过突变探针验证的块（Plan ③）
}

export interface TestResult { name: string; passed: boolean; }
export interface CargoTestRun { compiled: boolean; results: TestResult[]; }

export interface MutationOp {
  file: string;       // 相对 repo 根
  line: number;       // 1-based
  original: string;   // 原行（含缩进）
  mutated: string;    // 替换行
  description: string;
}

export interface BlastRadius {
  chunkId: NodeId;
  mutation: MutationOp;
  newlyFailing: string[]; // 突变后由绿转红的测试名
  compileBroke: boolean;  // 突变导致编译失败（load-bearing）
  note: string;
}

export interface Verdict {
  chunkId: NodeId;
  predicted: string[];
  actual: string[];
  hits: string[];
  misses: string[];
  falseAlarms: string[];
  passed: boolean;
}

// ── 计划②-LLM 块标签 ──
export interface ChunkLabelInput {
  chunkId: NodeId;
  chunkName: string;
  file: string;
  chapterName: string;
  riskBucket: RiskBucket;
  contribBucket: ContribBucket;
  functions: { name: string; source: string }[];
  neighbors: string[];       // 同章其它块的名字
  contentHash: string;       // sha256(函数源码拼接)
}

export interface ChunkLabel {
  responsibility: string;    // 一句话职责
  whyNow: string;            // 为什么现在学它
}

export interface LabelCacheEntry extends ChunkLabel {
  contentHash: string;
}

export interface LabelCache {
  version: 1;
  entries: Record<NodeId, LabelCacheEntry>;
}

export interface Labeler {
  label(inputs: ChunkLabelInput[]): Promise<Record<NodeId, ChunkLabel>>;
}
