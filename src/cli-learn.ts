import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GradedTree } from './types.js';
import { buildPath } from './path/sequence.js';
import { loadProgress, saveProgress, markUnderstood } from './progress/progress.js';
import { renderJourneyMarkdown } from './render/journey-md.js';
import { renderMapMarkdown } from './render/map-md.js';
import { loadLabelCache } from './label/cache.js';

function loadTree(outDir: string): GradedTree {
  const p = join(outDir, 'easyreview.tree.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as GradedTree;
  } catch {
    throw new Error(`找不到 ${p}——先运行 \`easyreview map --repo <path> --out ${outDir}\``);
  }
}

function progressPath(outDir: string): string {
  return join(outDir, 'easyreview.progress.json');
}

function rerender(outDir: string, tree: GradedTree): void {
  const path = buildPath(tree);
  const progress = loadProgress(progressPath(outDir));
  const labels = loadLabelCache(join(outDir, 'easyreview.labels.json'));
  writeFileSync(join(outDir, 'easyreview.journey.md'), renderJourneyMarkdown(tree, path, progress, labels));
  writeFileSync(join(outDir, 'easyreview.map.md'), renderMapMarkdown(tree, new Set(progress.understood)));
}

export interface LearnOptions { outDir: string; }
export async function runLearn(opts: LearnOptions): Promise<void> {
  const tree = loadTree(opts.outDir);
  const p = loadProgress(progressPath(opts.outDir));
  saveProgress(progressPath(opts.outDir), p);
  rerender(opts.outDir, tree);
}

export interface DoneOptions { outDir: string; chunkId: string; }
export async function runDone(opts: DoneOptions): Promise<void> {
  const tree = loadTree(opts.outDir);
  const file = progressPath(opts.outDir);
  const updated = markUnderstood(loadProgress(file), opts.chunkId);
  saveProgress(file, updated);
  rerender(opts.outDir, tree);
}
