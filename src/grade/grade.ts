import type {
  Tree, GradedTree, Grade, Signals, RiskBucket, ContribBucket, Leaf,
} from '../types.js';

export interface SignalMaps {
  relChurn: Record<string, number>;
  coupling: Record<string, number>;
  ownership: Record<string, number>;
  centrality: Record<string, number>;
}

function chunkLoc(chunkId: string, leaves: Leaf[]): number {
  return leaves.filter((l) => l.file === chunkId).reduce((s, l) => s + l.loc, 0);
}

function quantileBucket<T>(value: number, sorted: number[], labels: [T, T, T, T]): T {
  const n = sorted.length;
  if (n === 0) return labels[0];
  // Position-based percentile rank: spans the full [0,1] range for the
  // min/max regardless of n, unlike a raw count(v<=value)/n ratio, whose
  // smallest element always yields rank 1/n (e.g. 0.333 for n=3), which
  // can never fall into the <=0.25 bucket.
  const countLE = sorted.filter((v) => v <= value).length;
  const rank = n === 1 ? 0 : (countLE - 1) / (n - 1);
  if (rank <= 0.25) return labels[0];
  if (rank <= 0.5) return labels[1];
  if (rank <= 0.75) return labels[2];
  return labels[3];
}

export function gradeTree(tree: Tree, sig: SignalMaps): GradedTree {
  const locs: Record<string, number> = {};
  for (const c of tree.chunks) locs[c.id] = chunkLoc(c.id, tree.leaves);
  const maxLoc = Math.max(1, ...Object.values(locs));

  const risks: Record<string, number> = {};
  const contribs: Record<string, number> = {};
  const signalsById: Record<string, Signals> = {};

  for (const c of tree.chunks) {
    const relChurn = sig.relChurn[c.id] ?? 0;
    const coupling = sig.coupling[c.id] ?? 0;
    const ownership = sig.ownership[c.id] ?? 0;
    const centrality = sig.centrality[c.id] ?? 0;
    const sizeNorm = locs[c.id] / maxLoc;

    const risk = 0.5 * relChurn + 0.3 * coupling + 0.2 * sizeNorm;
    const contribution = 0.6 * centrality + 0.25 * sizeNorm + 0.15 * ownership;

    risks[c.id] = risk;
    contribs[c.id] = contribution;
    signalsById[c.id] = { relChurn, coupling, ownership, centrality, sizeNorm };
  }

  const riskSorted = Object.values(risks).sort((a, b) => a - b);
  const contribSorted = Object.values(contribs).sort((a, b) => a - b);

  const grades: Record<string, Grade> = {};
  for (const c of tree.chunks) {
    grades[c.id] = {
      risk: risks[c.id],
      riskBucket: quantileBucket<RiskBucket>(risks[c.id], riskSorted, ['none', 'low', 'med', 'high']),
      contribution: contribs[c.id],
      contribBucket: quantileBucket<ContribBucket>(contribs[c.id], contribSorted, ['filler', 'low', 'med', 'high']),
      signals: signalsById[c.id],
    };
  }

  return { ...tree, grades };
}
