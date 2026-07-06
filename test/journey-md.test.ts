import { describe, it, expect } from 'vitest';
import { renderJourneyMarkdown } from '../src/render/journey-md.js';
import { buildPath } from '../src/path/sequence.js';
import type { GradedTree, JourneyPath, Progress, Grade, LabelCache } from '../src/types.js';

const g: GradedTree = {
  repo: '/x',
  chapters: [{ id: 'foo:util', name: 'foo::util', crate: 'foo', dir: 'util', chunkIds: ['easy.rs', 'mid.rs'] }],
  chunks: [
    { id: 'easy.rs', name: 'easy', file: 'easy.rs', crate: 'foo', leafIds: ['easy.rs::a::1'] },
    { id: 'mid.rs', name: 'mid', file: 'mid.rs', crate: 'foo', leafIds: [] },
  ],
  leaves: [{ id: 'easy.rs::a::1', kind: 'fn', name: 'a', file: 'easy.rs', startLine: 1, endLine: 3, loc: 3 }],
  grades: {
    'easy.rs': { risk:0, riskBucket:'none', contribution:0, contribBucket:'filler', signals:{relChurn:0,coupling:0,ownership:0,centrality:0,sizeNorm:0} },
    'mid.rs': { risk:0.3, riskBucket:'low', contribution:0.5, contribBucket:'med', signals:{relChurn:0,coupling:0,ownership:0,centrality:0.5,sizeNorm:0.4} },
  },
};
const path: JourneyPath = {
  repo: '/x',
  steps: [
    { chunkId: 'easy.rs', order: 0, chapterId: 'foo:util', difficulty: 0, neighbors: ['mid.rs'] },
    { chunkId: 'mid.rs', order: 1, chapterId: 'foo:util', difficulty: 0.4, neighbors: ['easy.rs'] },
  ],
};

describe('renderJourneyMarkdown', () => {
  it('shows progress bar and the next unmastered step card', () => {
    const progress: Progress = { version: 1, understood: [] };
    const md = renderJourneyMarkdown(g, path, progress);
    expect(md).toContain('# easyReview 学习旅程');
    expect(md).toContain('0%');
    expect(md).toContain('easy');
    expect(md).toContain('easyreview done easy.rs');
    expect(md).toContain('`a`');
    expect(md).toContain('mid');
  });

  it('advances to next step and updates percent when one is understood', () => {
    const progress: Progress = { version: 1, understood: ['easy.rs'] };
    const md = renderJourneyMarkdown(g, path, progress);
    expect(md).toContain('50%');
    expect(md).toContain('easyreview done mid.rs');
  });

  it('celebrates when all understood', () => {
    const progress: Progress = { version: 1, understood: ['easy.rs', 'mid.rs'] };
    const md = renderJourneyMarkdown(g, path, progress);
    expect(md).toContain('100%');
    expect(md).toContain('🎉');
  });
});

function gradedForLabels(): GradedTree {
  const grade: Grade = {
    risk: 0.1, riskBucket: 'low', contribution: 0.1, contribBucket: 'filler',
    signals: { relChurn: 0, coupling: 0, ownership: 0, centrality: 0, sizeNorm: 0 },
  };
  return {
    repo: 'r',
    chapters: [{ id: 'k:', name: 'k::', crate: 'k', dir: '', chunkIds: ['a.rs'] }],
    chunks: [{ id: 'a.rs', name: 'a', file: 'a.rs', crate: 'k', leafIds: ['a.rs::f::1'] }],
    leaves: [{ id: 'a.rs::f::1', kind: 'fn', name: 'f', file: 'a.rs', startLine: 1, endLine: 1, loc: 1 }],
    grades: { 'a.rs': grade },
  };
}
const emptyProgress = { version: 1 as const, understood: [] };

describe('renderJourneyMarkdown labels', () => {
  it('uses LLM label + adds a 职责 line when a label exists', () => {
    const g = gradedForLabels();
    const labels: LabelCache = { version: 1, entries: { 'a.rs': { responsibility: '管理 XY 状态', whyNow: 'LLM 理由', contentHash: 'h' } } };
    const md = renderJourneyMarkdown(g, buildPath(g), emptyProgress, labels);
    expect(md).toContain('- 职责：管理 XY 状态');
    expect(md).toContain('为什么现在学它：LLM 理由');
  });

  it('falls back to static whyNow and omits 职责 line when no label', () => {
    const g = gradedForLabels();
    const md = renderJourneyMarkdown(g, buildPath(g), emptyProgress);
    expect(md).not.toContain('- 职责：');
    expect(md).toContain('用来先熟悉项目的词汇与惯用法'); // filler 静态文案
  });
});
