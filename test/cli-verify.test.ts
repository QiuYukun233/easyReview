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

  it('works for a non-chem_field crate and groups tests by module', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'crates/grid_workshop/Cargo.toml', '[package]\nname="grid_workshop"');
    writeRepoFile(dir, 'crates/grid_workshop/src/build_ui/routing_fsm.rs',
      'pub fn route(x: i32) -> i32 {\n    let step = 1;\n    x + step\n}\n');
    commitAll(dir, 'init');
    await runMap({ repo: dir, outDir: dir });

    const chunkId = 'crates/grid_workshop/src/build_ui/routing_fsm.rs';
    let phase = 'baseline';
    let seenCrate = '';
    const fakeExec = async (_cmd: string, args: string[]) => {
      const pi = args.indexOf('-p');
      if (pi >= 0) seenCrate = args[pi + 1];
      return phase === 'baseline'
        ? 'test build_ui::routing_fsm::t1 ... ok\ntest build_ui::routing_fsm::t2 ... ok'
        : 'test build_ui::routing_fsm::t1 ... ok\ntest build_ui::routing_fsm::t2 ... FAILED';
    };

    await runVerifyShow({ repo: dir, outDir: dir, chunkId, exec: fakeExec });
    expect(seenCrate).toBe('grid_workshop');
    const show = readFileSync(join(dir, 'easyreview.verify.md'), 'utf8');
    expect(show).toContain('### build_ui::routing_fsm');
    expect(show).toContain('build_ui::routing_fsm::t1');
    expect(show).toContain('`grid_workshop` 的测试');

    phase = 'mutated';
    await runVerifyPredict({ repo: dir, outDir: dir, chunkId, predicted: ['build_ui::routing_fsm::t2'], exec: fakeExec });
    const verdict = readFileSync(join(dir, 'easyreview.verify.md'), 'utf8');
    expect(verdict).toContain('通过');
    const progress = JSON.parse(readFileSync(join(dir, 'easyreview.progress.json'), 'utf8'));
    expect(progress.verified).toContain(chunkId);
  });

  it('rejects a chunk whose baseline crate fails to compile', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'crates/broken/Cargo.toml', '[package]\nname="broken"');
    writeRepoFile(dir, 'crates/broken/src/lib.rs', 'pub fn f(x: i32) -> i32 {\n    let y = 1;\n    x + y\n}\n');
    commitAll(dir, 'init');
    await runMap({ repo: dir, outDir: dir });

    const chunkId = 'crates/broken/src/lib.rs';
    const fakeExec = async () => 'error[E0425]: cannot find value `foo` in this scope\nerror: could not compile `broken`';
    await expect(
      runVerifyShow({ repo: dir, outDir: dir, chunkId, exec: fakeExec }),
    ).rejects.toThrow(/无法编译/);
  });
});
