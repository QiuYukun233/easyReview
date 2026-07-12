import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { runMap } from '../src/cli.js';
import { runVerifyShow, runVerifyPredict } from '../src/cli-verify.js';
import { sandboxFor } from '../src/verify/sandbox.js';
import { rmSync } from 'node:fs';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

/** 2026-07-12 改写:Ruby 已获支持(rspec 探针)——本文件从「Ruby 一律拒绝」改锁新边界:
 *  无 easyreview.runner.json 时 show/predict 都给可操作报错,且绝不调用测试命令。 */
describe('verify ruby without runner config', () => {
  async function setup() {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    const sb = sandboxFor(dir);
    cleanups.push(() => rmSync(sb.dir, { recursive: true, force: true }));
    writeRepoFile(dir, 'app/models/widget.rb', 'class Widget\n  def go\n    x = 1\n  end\nend\n');
    writeRepoFile(dir, 'spec/models/widget_spec.rb', 'describe Widget do end');
    commitAll(dir, 'init');
    await runMap({ repo: dir, outDir: dir });
    return dir;
  }

  it('show: actionable config error before any exec call', async () => {
    const dir = await setup();
    let execCalled = false;
    await expect(
      runVerifyShow({ repo: dir, outDir: dir, chunkId: 'app/models/widget.rb', exec: async () => { execCalled = true; return ''; } }),
    ).rejects.toThrow(/easyreview\.runner\.json/);
    expect(execCalled).toBe(false);
  });

  it('predict: same config error, exec untouched', async () => {
    const dir = await setup();
    let execCalled = false;
    await expect(
      runVerifyPredict({ repo: dir, outDir: dir, chunkId: 'app/models/widget.rb', predicted: ['spec/models/widget_spec.rb'], exec: async () => { execCalled = true; return ''; } }),
    ).rejects.toThrow(/easyreview\.runner\.json/);
    expect(execCalled).toBe(false);
  });
});
