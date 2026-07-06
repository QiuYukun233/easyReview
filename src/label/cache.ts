import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { ChunkLabelInput, LabelCache, ChunkLabel, NodeId } from '../types.js';

export function computeContentHash(parts: {
  functions: { name: string; source: string }[];
  riskBucket: string;
  contribBucket: string;
  neighbors: string[];
}): string {
  const h = createHash('sha256');
  h.update(parts.riskBucket); h.update('\0');
  h.update(parts.contribBucket); h.update('\0');
  for (const n of parts.neighbors) { h.update(n); h.update('\0'); }
  h.update('\0');
  for (const f of parts.functions) {
    h.update(f.name); h.update('\0'); h.update(f.source); h.update('\0');
  }
  return h.digest('hex');
}

export function selectStale(inputs: ChunkLabelInput[], cache: LabelCache): ChunkLabelInput[] {
  return inputs.filter((i) => {
    const e = cache.entries[i.chunkId];
    return !e || e.contentHash !== i.contentHash;
  });
}

export function mergeLabels(
  cache: LabelCache,
  inputs: ChunkLabelInput[],
  fresh: Record<NodeId, ChunkLabel>,
): LabelCache {
  const entries = { ...cache.entries };
  const byId: Record<NodeId, ChunkLabelInput> = {};
  for (const i of inputs) byId[i.chunkId] = i;
  for (const [id, label] of Object.entries(fresh)) {
    const inp = byId[id];
    if (!inp) continue;
    entries[id] = { responsibility: label.responsibility, whyNow: label.whyNow, contentHash: inp.contentHash };
  }
  return { version: 1, entries };
}

export function loadLabelCache(path: string): LabelCache {
  if (!existsSync(path)) return { version: 1, entries: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LabelCache;
  } catch {
    console.warn('⚠ easyreview.labels.json 解析失败，忽略并重建缓存');
    return { version: 1, entries: {} };
  }
}

export function saveLabelCache(path: string, cache: LabelCache): void {
  writeFileSync(path, JSON.stringify(cache, null, 2));
}
