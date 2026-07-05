import type { BlastRadius, Verdict } from '../types.js';

export function judge(blast: BlastRadius, predicted: string[]): Verdict {
  const actual = blast.newlyFailing;
  const actualSet = new Set(actual);
  const predSet = new Set(predicted);

  const hits = predicted.filter((t) => actualSet.has(t));
  const misses = actual.filter((t) => !predSet.has(t));
  const falseAlarms = predicted.filter((t) => !actualSet.has(t));

  const passed = blast.compileBroke
    ? predicted.length > 0
    : misses.length === 0 && falseAlarms.length === 0;

  return { chunkId: blast.chunkId, predicted, actual, hits, misses, falseAlarms, passed };
}
