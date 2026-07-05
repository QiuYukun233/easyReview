import type { CargoTestRun, TestResult } from '../types.js';

const LINE = /^test\s+(\S+)\s+\.\.\.\s+(ok|FAILED)$/;

export function parseCargoTest(stdout: string): CargoTestRun {
  const results: TestResult[] = [];
  for (const raw of stdout.split('\n')) {
    const m = raw.trim().match(LINE);
    if (m) results.push({ name: m[1], passed: m[2] === 'ok' });
  }
  const compileError = /error\[E\d+\]|error: could not compile/.test(stdout);
  const compiled = results.length > 0 || !compileError;
  return { compiled, results };
}
