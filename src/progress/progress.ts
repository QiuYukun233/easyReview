import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { Progress, NodeId } from '../types.js';

export function loadProgress(file: string): Progress {
  if (!existsSync(file)) return { version: 1, understood: [] };
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const understood = Array.isArray(raw?.understood) ? (raw.understood as NodeId[]) : [];
  const p: Progress = { version: 1, understood };
  if (Array.isArray(raw?.verified)) p.verified = raw.verified as NodeId[];
  return p;
}

export function saveProgress(file: string, p: Progress): void {
  writeFileSync(file, JSON.stringify(p, null, 2));
}

export function markUnderstood(p: Progress, chunkId: NodeId): Progress {
  if (p.understood.includes(chunkId)) return p;
  return { ...p, understood: [...p.understood, chunkId] };
}

export function percentComplete(total: number, p: Progress): number {
  if (total === 0) return 0;
  return Math.round((p.understood.length / total) * 100);
}
