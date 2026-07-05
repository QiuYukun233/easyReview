import type { CommitRecord } from '../git.js';

/** 每文件所有权集中度（0..1）= 最大单作者提交数 / 该文件总提交数。 */
export function ownershipConcentration(log: CommitRecord[]): Record<string, number> {
  const perFile = new Map<string, Map<string, number>>();
  for (const c of log) {
    for (const f of c.files) {
      if (!perFile.has(f)) perFile.set(f, new Map());
      const m = perFile.get(f)!;
      m.set(c.author, (m.get(c.author) ?? 0) + 1);
    }
  }
  const out: Record<string, number> = {};
  for (const [f, authors] of perFile) {
    const total = [...authors.values()].reduce((a, b) => a + b, 0);
    const top = Math.max(...authors.values());
    out[f] = total === 0 ? 0 : top / total;
  }
  return out;
}
