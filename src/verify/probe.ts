import type { BlastRadius, CargoTestRun, MutationOp, NodeId } from '../types.js';
import { withMutation } from './mutate.js';

export interface ProbeParams {
  chunkId: NodeId;
  absFile: string;
  op: MutationOp;
  baselineGreen: string[];
  runAfter: () => Promise<CargoTestRun>;
}

export async function probe(p: ProbeParams): Promise<BlastRadius> {
  const green = new Set(p.baselineGreen);
  return withMutation(p.absFile, p.op, async () => {
    const after = await p.runAfter();
    if (!after.compiled) {
      return {
        chunkId: p.chunkId, mutation: p.op,
        newlyFailing: ['<compile-error>'], compileBroke: true,
        note: '突变导致该 crate 无法编译——这行是承重的。',
      } satisfies BlastRadius;
    }
    const stillGreen = new Set(after.results.filter((r) => r.passed).map((r) => r.name));
    const newlyFailing = [...green].filter((name) => !stillGreen.has(name));
    return {
      chunkId: p.chunkId, mutation: p.op,
      newlyFailing, compileBroke: false,
      note: newlyFailing.length === 0 ? '突变没让任何测试变红——这块可能没被测试覆盖。' : '',
    } satisfies BlastRadius;
  });
}
