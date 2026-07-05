import type { CommitRecord } from '../git.js';

/** 每文件的 change coupling（0..1）：曾共同变更的不同文件数 / 仓库最大值。 */
export function changeCoupling(log: CommitRecord[]): Record<string, number> {
  const partners = new Map<string, Set<string>>();
  for (const c of log) {
    for (const f of c.files) {
      if (!partners.has(f)) partners.set(f, new Set());
      for (const g of c.files) if (g !== f) partners.get(f)!.add(g);
    }
  }
  const counts: Record<string, number> = {};
  for (const [f, set] of partners) counts[f] = set.size;
  const max = Math.max(0, ...Object.values(counts));
  if (max === 0) return {};
  const out: Record<string, number> = {};
  for (const [f, n] of Object.entries(counts)) out[f] = n / max;
  return out;
}
