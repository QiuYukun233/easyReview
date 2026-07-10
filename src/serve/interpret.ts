import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GradedTree, Interpreter, ChunkInterpretation } from '../types.js';
import { collectInterpretInput } from '../interpret/input.js';
import { loadInterpretCache, saveInterpretCache } from '../interpret/cache.js';

export interface InterpretBody {
  ok: boolean;
  error?: string;
  interpretation?: ChunkInterpretation;
  cached?: boolean;
}

export interface InterpretResult { status: number; body: InterpretBody; }

/** 白名单 → 查缓存 → 未命中同步生成落盘。inflight 由 server 实例持有:同块并发请求共享同一在途生成。 */
export function applyInterpret(
  tree: GradedTree,
  outDir: string,
  chunkId: unknown,
  interpreter: Interpreter | null,
  inflight: Map<string, Promise<InterpretResult>>,
): Promise<InterpretResult> {
  if (typeof chunkId !== 'string' || chunkId === '') {
    return Promise.resolve({ status: 400, body: { ok: false, error: '缺少 chunk 参数' } });
  }
  const chunk = tree.chunks.find((c) => c.id === chunkId);
  if (!chunk) {
    return Promise.resolve({ status: 400, body: { ok: false, error: `未知块 ${chunkId}` } });
  }
  const abs = join(tree.repo, chunk.file);
  if (!existsSync(abs)) {
    return Promise.resolve({
      status: 404,
      body: { ok: false, error: `仓库路径 ${tree.repo} 下找不到 ${chunk.file}——repo 挪位置了?用 --repo 重新 map,或把仓库放回原处。` },
    });
  }
  const input = collectInterpretInput(tree, chunk, readFileSync(abs, 'utf8'));
  const cachePath = join(outDir, 'easyreview.interpret.json');
  const hit = loadInterpretCache(cachePath).entries[chunkId];
  if (hit && hit.contentHash === input.contentHash) {
    const interpretation: ChunkInterpretation = {
      overview: hit.overview, dataFlow: hit.dataFlow, calls: hit.calls, functions: hit.functions,
    };
    return Promise.resolve({ status: 200, body: { ok: true, interpretation, cached: true } });
  }
  if (!interpreter) {
    return Promise.resolve({ status: 503, body: { ok: false, error: '未配置 DEEPSEEK_API_KEY——解读不可用' } });
  }
  const running = inflight.get(chunkId);
  if (running) return running;
  const p = interpreter.interpret(input)
    .then((interp): InterpretResult => {
      if (!interp) return { status: 502, body: { ok: false, error: '解读生成失败——稍后重试' } };
      const cache = loadInterpretCache(cachePath); // 生成期间可能有别的块写入,重读再合并
      cache.entries[chunkId] = { ...interp, contentHash: input.contentHash };
      saveInterpretCache(cachePath, cache);
      return { status: 200, body: { ok: true, interpretation: interp, cached: false } };
    })
    .finally(() => { inflight.delete(chunkId); });
  inflight.set(chunkId, p);
  return p;
}
