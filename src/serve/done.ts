import { join } from 'node:path';
import type { GradedTree } from '../types.js';
import { loadProgress, saveProgress, markUnderstood } from '../progress/progress.js';

export interface DoneResult {
  status: number;
  body: { ok: boolean; error?: string };
}

/** 校验 chunkId 后复用 progress 模块读改写——和 CLI done 同一条代码路径、同一份文件。 */
export function applyDone(tree: GradedTree, outDir: string, chunkId: unknown): DoneResult {
  if (typeof chunkId !== 'string' || chunkId === '') {
    return { status: 400, body: { ok: false, error: '缺少 chunkId' } };
  }
  if (!tree.chunks.some((c) => c.id === chunkId)) {
    return { status: 400, body: { ok: false, error: `未知块 ${chunkId}` } };
  }
  const file = join(outDir, 'easyreview.progress.json');
  saveProgress(file, markUnderstood(loadProgress(file), chunkId));
  return { status: 200, body: { ok: true } };
}
