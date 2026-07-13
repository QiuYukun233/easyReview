import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { runMap } from '../src/cli.js';
import { runVerifyShow, runVerifyPredict } from '../src/cli-verify.js';
import { sandboxFor } from '../src/verify/sandbox.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

/** 2026-07-13 改写:JS/Vue 已获支持(vitest 探针)——本文件从「vue/js 一律拒绝」改锁新边界:
 *  无 easyreview.runner.json 时 show/predict 都给可操作报错,且零 exec 调用、零沙箱副作用。 */
describe('verify js/vue without runner config', () => {
  async function setup() {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    const sb = sandboxFor(dir);
    cleanups.push(() => rmSync(sb.dir, { recursive: true, force: true }));
    writeRepoFile(dir, 'app/javascript/widget/App.vue',
      '<template><div /></template>\n<script setup>\nconst go = () => 1;\n</script>\n');
    writeRepoFile(dir, 'app/javascript/helper/url.js', 'export const make = () => 2;\n');
    commitAll(dir, 'init');
    await runMap({ repo: dir, outDir: dir });
    return dir;
  }

  it('vue chunk show: actionable config error, exec untouched, no sandbox', async () => {
    const dir = await setup();
    let execCalled = false;
    await expect(
      runVerifyShow({ repo: dir, outDir: dir, chunkId: 'app/javascript/widget/App.vue',
        exec: async () => { execCalled = true; return ''; } }),
    ).rejects.toThrow(/easyreview\.runner\.json/);
    expect(execCalled).toBe(false);
    expect(existsSync(sandboxFor(dir).dir)).toBe(false);
  });

  it('js chunk predict: same config error, zero side effects', async () => {
    const dir = await setup();
    let execCalled = false;
    await expect(
      runVerifyPredict({ repo: dir, outDir: dir, chunkId: 'app/javascript/helper/url.js',
        predicted: ['whatever'], exec: async () => { execCalled = true; return ''; } }),
    ).rejects.toThrow(/easyreview\.runner\.json/);
    expect(execCalled).toBe(false);
    expect(existsSync(sandboxFor(dir).dir)).toBe(false);
  });
});
