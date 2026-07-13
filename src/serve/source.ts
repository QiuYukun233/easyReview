import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GradedTree } from '../types.js';
import { langOf, type LangSpec } from '../extract/lang.js';
import { highlightLines } from './highlight.js';

export interface SourceBody {
  ok: boolean;
  error?: string;
  file?: string;
  lang?: LangSpec['id'] | null;
  lines?: string[]; // 逐行已转义+已高亮的 HTML
}

export interface SourceResult { status: number; body: SourceBody; }

/** chunk id 必须先在 tree.chunks 命中才读盘——白名单,天然挡掉 ../ 路径穿越。 */
export function readSource(tree: GradedTree, chunkId: unknown): SourceResult {
  if (typeof chunkId !== 'string' || chunkId === '') {
    return { status: 400, body: { ok: false, error: '缺少 chunk 参数' } };
  }
  const chunk = tree.chunks.find((c) => c.id === chunkId);
  if (!chunk) {
    return { status: 400, body: { ok: false, error: `未知块 ${chunkId}` } };
  }
  const abs = join(tree.repo, chunk.file);
  if (!existsSync(abs)) {
    return {
      status: 404,
      body: { ok: false, error: `仓库路径 ${tree.repo} 下找不到 ${chunk.file}——repo 挪位置了?用 --repo 重新 map,或把仓库放回原处。` },
    };
  }
  const lang = langOf(chunk.file);
  const langId = lang ? lang.id : null;
  return {
    status: 200,
    body: { ok: true, file: chunk.file, lang: langId, lines: highlightLines(readFileSync(abs, 'utf8'), langId) },
  };
}
