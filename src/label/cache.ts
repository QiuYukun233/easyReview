import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { ChunkLabelInput, LabelCache, ChunkLabel, NodeId } from '../types.js';

export function computeContentHash(functions: { name: string; source: string }[]): string {
  const h = createHash('sha256');
  for (const f of functions) {
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
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LabelCache;
  } catch {
    return { version: 1, entries: {} };
  }
}

export function saveLabelCache(path: string, cache: LabelCache): void {
  writeFileSync(path, JSON.stringify(cache, null, 2));
}
