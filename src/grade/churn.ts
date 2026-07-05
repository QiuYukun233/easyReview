import type { CommitRecord } from '../git.js';

/** 每文件相对 churn（0..1）：提交触及次数 / 仓库最大触及次数。 */
export function relativeChurn(log: CommitRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of log) {
    for (const f of c.files) counts[f] = (counts[f] ?? 0) + 1;
  }
  const max = Math.max(0, ...Object.values(counts));
  if (max === 0) return {};
  const out: Record<string, number> = {};
  for (const [f, n] of Object.entries(counts)) out[f] = n / max;
  return out;
}
