import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { runMap } from '../src/cli.js';
import { runVerifyShow, runVerifyPredict } from '../src/cli-verify.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

describe('verify show/predict', () => {
  it('show caches baseline + writes prompt; predict judges + marks verified', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'crates/chem_field/Cargo.toml', '[package]\nname="chem_field"');
    writeRepoFile(dir, 'crates/chem_field/src/core/field.rs',
      'pub fn step(v: f32) -> f32 {\n    let dt = 0.1;\n    v + dt\n}\n');
    commitAll(dir, 'init');
    await runMap({ repo: dir, outDir: dir });

    const chunkId = 'crates/chem_field/src/core/field.rs';
    let phase = 'baseline';
    const fakeExec = async () =>
      phase === 'baseline'
        ? 'test core::field::t1 ... ok\ntest core::field::t2 ... ok'
        : 'test core::field::t1 ... ok\ntest core::field::t2 ... FAILED';

    await runVerifyShow({ repo: dir, outDir: dir, chunkId, exec: fakeExec });
    expect(existsSync(join(dir, 'easyreview.verify-baseline.json'))).toBe(true);
    const show = readFileSync(join(dir, 'easyreview.verify.md'), 'utf8');
    expect(show).toContain('core::field::t1');
    expect(show).toContain('--predict');

    phase = 'mutated';
    await runVerifyPredict({ repo: dir, outDir: dir, chunkId, predicted: ['core::field::t2'], exec: fakeExec });
    const verdict = readFileSync(join(dir, 'easyreview.verify.md'), 'utf8');
    expect(verdict).toContain('通过');
    const progress = JSON.parse(readFileSync(join(dir, 'easyreview.progress.json'), 'utf8'));
    expect(progress.verified).toContain(chunkId);
    expect(progress.understood).toContain(chunkId);
  });
});
