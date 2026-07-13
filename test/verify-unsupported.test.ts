import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { runMap } from '../src/cli.js';
import { runVerifyShow, runVerifyPredict } from '../src/cli-verify.js';
import { sandboxFor } from '../src/verify/sandbox.js';
import { existsSync, rmSync } from 'node:fs';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

/** verify（突变探针）暂只支持 Rust/Ruby——vue/js 块必须在读源码、建沙箱、调 exec 之前
 *  就给出友好拒绝（runnerFor else 分支）。锁死文案与零副作用。 */
describe('verify rejects vue/js chunks up front', () => {
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

  it('vue chunk: show rejected with friendly message, exec untouched', async () => {
    const dir = await setup();
    let execCalled = false;
    await expect(
      runVerifyShow({ repo: dir, outDir: dir, chunkId: 'app/javascript/widget/App.vue',
        exec: async () => { execCalled = true; return ''; } }),
    ).rejects.toThrow(/不在支持范围/);
    expect(execCalled).toBe(false);
    expect(existsSync(sandboxFor(dir).dir)).toBe(false); // 拒绝在建沙箱之前——零磁盘副作用
  });

  it('js chunk: predict rejected the same way', async () => {
    const dir = await setup();
    let execCalled = false;
    await expect(
      runVerifyPredict({ repo: dir, outDir: dir, chunkId: 'app/javascript/helper/url.js',
        predicted: ['whatever'], exec: async () => { execCalled = true; return ''; } }),
    ).rejects.toThrow(/不在支持范围/);
    expect(execCalled).toBe(false);
    expect(existsSync(sandboxFor(dir).dir)).toBe(false); // 拒绝在建沙箱之前——零磁盘副作用
  });
});
