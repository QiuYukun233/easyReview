import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { runMap } from '../src/cli.js';
import { runVerifyShow, runVerifyPredict } from '../src/cli-verify.js';
import { sandboxFor } from '../src/verify/sandbox.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

const vitestJson = (entries: Array<[string, boolean]>) =>
  JSON.stringify({ testResults: entries.map(([name, ok]) => ({ name: `/app/${name}`, status: ok ? 'passed' : 'failed', assertionResults: [] })) });

async function setup() {
  const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
  const sb = sandboxFor(dir);
  cleanups.push(() => rmSync(sb.dir, { recursive: true, force: true }));
  writeRepoFile(dir, 'app/javascript/helper/url.js',
    'export function make(a) {\n  doWork(a);\n  return a;\n}\n');
  writeRepoFile(dir, 'app/javascript/helper/specs/url.spec.js',
    "import { make } from '../url';\ndescribe('make', () => {});\n");
  writeRepoFile(dir, 'easyreview.runner.json',
    JSON.stringify({ version: 1, js: { cmd: ['fakedocker', 'vitest', '{specFiles}'], scanLimit: 20 } }));
  commitAll(dir, 'init');
  await runMap({ repo: dir, outDir: dir });
  return dir;
}

describe('verify js chunk end-to-end (fake exec)', () => {
  it('show: scopes mirror spec, writes baseline + spec-file predict prompt', async () => {
    const dir = await setup();
    const exec = async () => vitestJson([['app/javascript/helper/specs/url.spec.js', true]]);
    await runVerifyShow({ repo: dir, outDir: dir, chunkId: 'app/javascript/helper/url.js', exec });
    const baseline = JSON.parse(readFileSync(join(dir, 'easyreview.verify-baseline.json'), 'utf8'));
    expect(baseline.green).toEqual(['app/javascript/helper/specs/url.spec.js']);
    expect((baseline.scope as { specFiles: string[] }).specFiles).toEqual(['app/javascript/helper/specs/url.spec.js']);
    expect(baseline.op.mutated).toContain('// ');
    const md = readFileSync(join(dir, 'easyreview.verify.md'), 'utf8');
    expect(md).toContain('相关 spec 文件');
    expect(md).toContain('```javascript');
  });

  it('predict: mutation turns mirror spec red, hit → verified', async () => {
    const dir = await setup();
    const sb = sandboxFor(dir);
    const spec = 'app/javascript/helper/specs/url.spec.js';
    const green = async () => vitestJson([[spec, true]]);
    await runVerifyShow({ repo: dir, outDir: dir, chunkId: 'app/javascript/helper/url.js', exec: green });
    // 突变后:沙箱里的源文件包含被注释的行 → 返回红
    const after = async () => {
      const mutatedNow = readFileSync(join(sb.srcDir, 'app/javascript/helper/url.js'), 'utf8').includes('// doWork');
      return vitestJson([[spec, !mutatedNow]]);
    };
    await runVerifyPredict({ repo: dir, outDir: dir, chunkId: 'app/javascript/helper/url.js', predicted: [spec], exec: after });
    const progress = JSON.parse(readFileSync(join(dir, 'easyreview.progress.json'), 'utf8'));
    expect(progress.verified).toContain('app/javascript/helper/url.js');
    const md = readFileSync(join(dir, 'easyreview.verify.md'), 'utf8');
    expect(md).toContain('✅');
  });

  it('vue chunk routes to vitest runner (mirror spec of App.vue)', async () => {
    const dir = await setup();
    writeRepoFile(dir, 'app/javascript/widget/App.vue',
      '<template>\n  <div @click="go" />\n</template>\n<script setup>\nconst go = () => {\n  emit("done");\n};\n</script>\n');
    writeRepoFile(dir, 'app/javascript/widget/specs/App.spec.js', "import App from '../App.vue';\n");
    commitAll(dir, 'vue');
    await runMap({ repo: dir, outDir: dir });
    const exec = async () => vitestJson([['app/javascript/widget/specs/App.spec.js', true]]);
    await runVerifyShow({ repo: dir, outDir: dir, chunkId: 'app/javascript/widget/App.vue', exec });
    const baseline = JSON.parse(readFileSync(join(dir, 'easyreview.verify-baseline.json'), 'utf8'));
    expect(baseline.op.line).toBe(6); // emit("done") 在 script 区域内的真实文件行
    expect(baseline.op.mutated).toContain('// emit');
    const md = readFileSync(join(dir, 'easyreview.verify.md'), 'utf8');
    expect(md).toContain('```vue');
  });
});
