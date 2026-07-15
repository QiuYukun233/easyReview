import type { GradedTree, LabelCache, ChunkRefIn, ChunkRefOut } from '../src/types.js';

/** 2 章 3 块 2 叶的小树：a.rs(有函数/有标签/filler..none)、b.rs(核心 high:high)、c.rs(另一章、无叶子)。 */
export function makeViewerTree(): GradedTree {
  return {
    repo: '/fake',
    chapters: [
      { id: 'foo:src', name: 'foo::src', crate: 'foo', dir: 'src', chunkIds: ['crates/foo/src/a.rs', 'crates/foo/src/b.rs'] },
      { id: 'bar:src', name: 'bar::src', crate: 'bar', dir: 'src', chunkIds: ['crates/bar/src/c.rs'] },
    ],
    chunks: [
      { id: 'crates/foo/src/a.rs', name: 'a', file: 'crates/foo/src/a.rs', crate: 'foo', leafIds: ['crates/foo/src/a.rs::f1::1', 'crates/foo/src/a.rs::f2::5'] },
      { id: 'crates/foo/src/b.rs', name: 'b', file: 'crates/foo/src/b.rs', crate: 'foo', leafIds: [] },
      { id: 'crates/bar/src/c.rs', name: 'c', file: 'crates/bar/src/c.rs', crate: 'bar', leafIds: [] },
    ],
    leaves: [
      { id: 'crates/foo/src/a.rs::f1::1', kind: 'fn', name: 'f1', file: 'crates/foo/src/a.rs', startLine: 1, endLine: 3, loc: 3 },
      { id: 'crates/foo/src/a.rs::f2::5', kind: 'fn', name: 'f2', file: 'crates/foo/src/a.rs', startLine: 5, endLine: 8, loc: 4 },
    ],
    grades: {
      'crates/foo/src/a.rs': { risk: 0.1, riskBucket: 'none', contribution: 0.1, contribBucket: 'filler',
        signals: { relChurn: 0.1, coupling: 0.1, ownership: 1, centrality: 0.1, sizeNorm: 0.1 } },
      'crates/foo/src/b.rs': { risk: 0.9, riskBucket: 'high', contribution: 0.9, contribBucket: 'high',
        signals: { relChurn: 0.9, coupling: 0.9, ownership: 0.5, centrality: 0.9, sizeNorm: 0.5 } },
      'crates/bar/src/c.rs': { risk: 0.4, riskBucket: 'med', contribution: 0.4, contribBucket: 'low',
        signals: { relChurn: 0.4, coupling: 0.4, ownership: 0.7, centrality: 0.4, sizeNorm: 0.3 } },
    },
  };
}

export function makeViewerLabels(): LabelCache {
  return {
    version: 1,
    entries: {
      'crates/foo/src/a.rs': { responsibility: '演示职责', whyNow: 'LLM说现在学', contentHash: 'h' },
    },
  };
}

/** makeViewerTree 之上加 refsIn:a.rs 被 b.rs(块)与 util.rs(范围内非块文件)引用;b/c 无键。 */
export function makeViewerTreeWithRefs(): GradedTree {
  const refsIn: Record<string, ChunkRefIn[]> = {
    'crates/foo/src/a.rs': [
      { from: 'crates/foo/src/b.rs', weight: 1, names: ['a', 'helper'] },
      { from: 'crates/foo/src/util.rs', weight: 0.5, names: ['a'] },
    ],
  };
  return { ...makeViewerTree(), refsIn };
}

/** makeViewerTreeWithRefs 之上再加 refsOut:b.rs 依赖 a.rs。 */
export function makeViewerTreeWithRefsOut(): GradedTree {
  const refsOut: Record<string, ChunkRefOut[]> = {
    'crates/foo/src/b.rs': [{ to: 'crates/foo/src/a.rs', weight: 1, names: ['a'] }],
  };
  return { ...makeViewerTreeWithRefs(), refsOut };
}
