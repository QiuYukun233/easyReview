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

/** 引用图入边(中心度 v2 顺产物;spec:2026-07-14-centrality-refgraph-design.md) */
export interface ChunkRefIn {
  from: NodeId;      // 引用方块 id
  weight: number;    // fin·多定义均分后的累计权重
  names: string[];   // 命中的名字,字典序
}

/** 引用图出边(refsOut;spec:2026-07-15-refsout-design.md) */
export interface ChunkRefOut {
  to: NodeId;        // 被依赖的块 id(恒为块)
  weight: number;    // 与入边同一张边表的权重
  names: string[];   // 命中的名字,字典序
}

export interface Tree {
  repo: string;
  chapters: Chapter[];
  chunks: Chunk[];
  leaves: Leaf[];
  refsIn?: Record<NodeId, ChunkRefIn[]>;  // 每块入边 top-10,权重降序;平权 from 字典序
  refsOut?: Record<NodeId, ChunkRefOut[]>;  // 每块出边 top-10,权重降序;平权 to 字典序
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

// ── 子项目B-AI 解读层 ──
export interface InterpretInput {
  chunkId: NodeId;
  chunkName: string;
  file: string;
  chapterName: string;
  riskBucket: RiskBucket;
  contribBucket: ContribBucket;
  signals: Signals;
  functions: { name: string; startLine: number }[];
  neighbors: string[];        // 同章其它块的名字
  source: string;             // 整文件源码(实时读盘,超长会被截断)
  truncated: boolean;
  contentHash: string;
}

export interface ChunkInterpretation {
  overview: string;           // 职责展开,3-5 句
  dataFlow: string;           // 数据怎么进、怎么变、怎么出
  calls: string;              // 调用关系:文件内可见的 + 事实里给的,跨文件不臆测
  functions: { name: string; gist: string }[]; // 逐函数一句话
}

export interface InterpretCacheEntry extends ChunkInterpretation {
  contentHash: string;
}

export interface InterpretCache {
  version: 1;
  entries: Record<NodeId, InterpretCacheEntry>;
}

export interface Interpreter {
  interpret(input: InterpretInput): Promise<ChunkInterpretation | null>;
}

/** 纵向切割:业务流程(spec:2026-07-15-flow-trace-pilot-design.md)。独立落盘 easyreview.flows.json,不进 tree.json。 */
export type FlowPhase = 'setup' | 'request';
export interface FlowStep {
  chunkId: NodeId;   // 文件级步骤;可能不是块(如 app/views ERB),前端降级纯文本
  methods: string[]; // 该步命中的方法名 top-N,频次降序
  hits: number;      // 原始调用序列中的命中次数(回访计数)
  phase?: FlowPhase; // 分相(spec:2026-07-16-flow-phase-design.md);旧数据无此字段=不分段
}
export interface Flow {
  id: string;
  name: string;      // 打样期由 CLI --name 人工给
  source: { kind: 'rspec-trace'; spec: string; tracedAt: string }; // kind 即多来源预留接口
  steps: FlowStep[];
  rawTrace: { file: string; method: string; line: number }[]; // 方法级原始序列,将来下钻用;不出前端
}
export interface FlowsFile { version: 1; flows: Flow[] }

/** 流程自动发现的候选(spec:2026-07-19-flow-discover-design.md)。独立落盘 easyreview.flow-candidates.json,不进 flows.json。 */
export interface FlowCandidate {
  id: string;    // flowIdFor(spec 文件, 行号)——与已追踪流程同 id 才能去重
  name: string;  // rspec full_description(describe+context+it 拼接)
  spec: string;  // "spec/xxx_spec.rb:行号",可直接喂 flow trace
}
export interface FlowCandidatesFile { version: 1; candidates: FlowCandidate[] }
