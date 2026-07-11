import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { runMap } from '../src/cli.js';
import { runVerifyShow, runVerifyPredict, runVerifyClean } from '../src/cli-verify.js';
import { sandboxFor } from '../src/verify/sandbox.js';
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

describe('verify show/predict', () => {
  function trackSandbox(repo: string) {
    const sb = sandboxFor(repo);
    cleanups.push(() => rmSync(sb.dir, { recursive: true, force: true }));
    return sb;
  }

  it('show caches baseline + writes prompt; predict judges + marks verified', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    trackSandbox(dir);
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
    trackSandbox(dir);
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
    trackSandbox(dir);
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

  it('mutates only the sandbox; the real repo stays byte-identical throughout', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    const sb = trackSandbox(dir);
    writeRepoFile(dir, 'crates/chem_field/Cargo.toml', '[package]\nname="chem_field"');
    writeRepoFile(dir, 'crates/chem_field/src/core/field.rs',
      'pub fn step(v: f32) -> f32 {\n    let dt = 0.1;\n    v + dt\n}\n');
    commitAll(dir, 'init');
    await runMap({ repo: dir, outDir: dir });

    const chunkId = 'crates/chem_field/src/core/field.rs';
    const realFile = join(dir, chunkId);
    const realBefore = readFileSync(realFile);

    let phase = 'baseline';
    let seenCwd = '';
    let seenTarget: string | undefined;
    let mutationSeenInSandbox = false;
    let realCleanDuringMutation = true;
    const fakeExec = async (_cmd: string, _args: string[], cwd: string, env?: NodeJS.ProcessEnv) => {
      seenCwd = cwd;
      seenTarget = env?.CARGO_TARGET_DIR;
      if (phase === 'mutated') {
        const sbNow = readFileSync(join(sb.srcDir, chunkId), 'utf8');
        if (sbNow !== realBefore.toString('utf8')) mutationSeenInSandbox = true;
        if (!readFileSync(realFile).equals(realBefore)) realCleanDuringMutation = false;
        return 'test core::field::t1 ... ok\ntest core::field::t2 ... FAILED';
      }
      return 'test core::field::t1 ... ok\ntest core::field::t2 ... ok';
    };

    await runVerifyShow({ repo: dir, outDir: dir, chunkId, exec: fakeExec });
    expect(seenCwd).toBe(sb.srcDir);
    expect(seenTarget).toBe(sb.targetDir);
    expect(readFileSync(realFile).equals(realBefore)).toBe(true);

    phase = 'mutated';
    await runVerifyPredict({ repo: dir, outDir: dir, chunkId, predicted: ['core::field::t2'], exec: fakeExec });
    expect(seenCwd).toBe(sb.srcDir);
    expect(seenTarget).toBe(sb.targetDir);
    expect(mutationSeenInSandbox).toBe(true);
    expect(realCleanDuringMutation).toBe(true);
    expect(readFileSync(realFile).equals(realBefore)).toBe(true);
    expect(readFileSync(join(sb.srcDir, chunkId), 'utf8')).toBe(realBefore.toString('utf8'));
  });

  it('verify --clean removes the whole sandbox and is idempotent', () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    const sb = trackSandbox(dir);
    mkdirSync(sb.srcDir, { recursive: true });
    mkdirSync(sb.targetDir, { recursive: true });
    writeFileSync(join(sb.srcDir, 'x.rs'), 'x');
    expect(existsSync(sb.dir)).toBe(true);

    runVerifyClean(dir);
    expect(existsSync(sb.dir)).toBe(false);

    runVerifyClean(dir); // 沙箱已不存在——幂等,不抛
  });

  it('ruby chunk: show/predict run rspec via runner config at file-level granularity', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    const sb = trackSandbox(dir);
    writeRepoFile(dir, 'app/actions/contact_identify_action.rb',
      'class ContactIdentifyAction\n  def perform\n    @contact = find_contact\n  end\nend\n');
    writeRepoFile(dir, 'spec/actions/contact_identify_action_spec.rb', 'describe ContactIdentifyAction do end');
    writeRepoFile(dir, 'spec/services/consumer_spec.rb', 'x = ContactIdentifyAction.new');
    writeRepoFile(dir, 'easyreview.runner.json', JSON.stringify({ version: 1, ruby: { cmd: ['fake-rspec', '{specFiles}'] } }));
    commitAll(dir, 'init');
    await runMap({ repo: dir, outDir: dir });

    const chunkId = 'app/actions/contact_identify_action.rb';
    const mirror = 'spec/actions/contact_identify_action_spec.rb';
    const consumer = 'spec/services/consumer_spec.rb';
    const okJson = JSON.stringify({ examples: [
      { file_path: `./${mirror}`, status: 'passed' },
      { file_path: `./${consumer}`, status: 'passed' },
    ], summary: {} });
    const failJson = JSON.stringify({ examples: [
      { file_path: `./${mirror}`, status: 'failed' },
      { file_path: `./${consumer}`, status: 'passed' },
    ], summary: {} });

    let phase = 'baseline';
    let seen: { cmd?: string; args?: string[]; cwd?: string } = {};
    const fakeExec = async (cmd: string, args: string[], cwd: string) => {
      seen = { cmd, args, cwd };
      return phase === 'baseline' ? `noise\n${okJson}` : `noise\n${failJson}`;
    };

    await runVerifyShow({ repo: dir, outDir: dir, chunkId, exec: fakeExec });
    expect(seen.cmd).toBe('fake-rspec');
    expect(seen.args).toEqual([mirror, consumer]);
    expect(seen.cwd).toBe(sb.srcDir);
    const baseline = JSON.parse(readFileSync(join(dir, 'easyreview.verify-baseline.json'), 'utf8'));
    expect(baseline.scope.specFiles).toEqual([mirror, consumer]);
    const show = readFileSync(join(dir, 'easyreview.verify.md'), 'utf8');
    expect(show).toContain('相关 spec 文件');
    expect(show).toContain(mirror);
    expect(show).toContain('spec 文件路径');

    phase = 'mutated';
    await runVerifyPredict({ repo: dir, outDir: dir, chunkId, predicted: [mirror], exec: fakeExec });
    const verdict = readFileSync(join(dir, 'easyreview.verify.md'), 'utf8');
    expect(verdict).toContain('通过');
    const progress = JSON.parse(readFileSync(join(dir, 'easyreview.progress.json'), 'utf8'));
    expect(progress.verified).toContain(chunkId);
  });

  it('ruby chunk without runner config → actionable error', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    trackSandbox(dir);
    writeRepoFile(dir, 'app/models/thing.rb', 'class Thing\n  def go\n    x = 1\n  end\nend\n');
    writeRepoFile(dir, 'spec/models/thing_spec.rb', 'describe Thing do end');
    commitAll(dir, 'init');
    await runMap({ repo: dir, outDir: dir });
    await expect(
      runVerifyShow({ repo: dir, outDir: dir, chunkId: 'app/models/thing.rb', exec: async () => '' }),
    ).rejects.toThrow(/easyreview\.runner\.json/);
  });
});
