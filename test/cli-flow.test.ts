import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFlowTrace } from '../src/cli-flow.js';
import { sandboxFor } from '../src/verify/sandbox.js';
import type { Exec } from '../src/verify/cargo.js';

/** 造最小仓:runner 配置 + spec 文件。 */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'er-flow-'));
  writeFileSync(join(repo, 'easyreview.runner.json'), JSON.stringify({
    version: 1,
    ruby: { cmd: ['fake-rspec', '{specFiles}'] },
  }));
  mkdirSync(join(repo, 'spec'), { recursive: true });
  writeFileSync(join(repo, 'spec', 'msg_spec.rb'), 'it works');
  return repo;
}

/** fake exec:模拟容器侧 tracer 落盘(写沙箱根的 easyreview-trace.json)。 */
const fakeExec = (trace: unknown): Exec => async (_cmd, _args, cwd) => {
  writeFileSync(join(cwd, 'easyreview-trace.json'), JSON.stringify(trace));
  return 'ok';
};

describe('runFlowTrace(编排:沙箱注入→trace→折叠→落盘→清理)', () => {
  it('非 _spec.rb 友好拒绝', async () => {
    const repo = makeRepo();
    await expect(runFlowTrace({ repo, outDir: repo, specFile: 'spec/foo.test.js', name: 'x' }))
      .rejects.toThrow('只支持 Ruby rspec');
  });

  it('成功路径:flows.json 落盘(含链与来源),沙箱 tracer/trace 清理干净', async () => {
    const repo = makeRepo();
    const out = mkdtempSync(join(tmpdir(), 'er-out-'));
    await runFlowTrace({
      repo, outDir: out, specFile: 'spec/msg_spec.rb', name: '发消息',
      exec: fakeExec({ truncated: false, calls: [
        { file: '/app/app/controllers/m.rb', method: 'create', line: 1 },
        { file: '/app/app/models/c.rb', method: 'save', line: 2 },
      ] }),
    });
    const flows = JSON.parse(readFileSync(join(out, 'easyreview.flows.json'), 'utf8'));
    expect(flows.flows).toHaveLength(1);
    expect(flows.flows[0].id).toBe('flow-msg');
    expect(flows.flows[0].name).toBe('发消息');
    expect(flows.flows[0].source.kind).toBe('rspec-trace');
    expect(flows.flows[0].steps.map((s: { chunkId: string }) => s.chunkId))
      .toEqual(['app/controllers/m.rb', 'app/models/c.rb']);
    const sb = sandboxFor(repo);
    expect(existsSync(join(sb.srcDir, 'easyreview_tracer.rb'))).toBe(false);
    expect(existsSync(join(sb.srcDir, 'easyreview-trace.json'))).toBe(false);
  });

  it('trace 输出缺失 → 报环境排查错(且沙箱 tracer 已清理)', async () => {
    const repo = makeRepo();
    const noWrite: Exec = async () => 'boom';
    await expect(runFlowTrace({ repo, outDir: repo, specFile: 'spec/msg_spec.rb', name: 'x', exec: noWrite }))
      .rejects.toThrow('trace 输出不存在');
    expect(existsSync(join(sandboxFor(repo).srcDir, 'easyreview_tracer.rb'))).toBe(false);
  });

  it('trace 全被过滤成空链 → 报换 spec', async () => {
    const repo = makeRepo();
    await expect(runFlowTrace({
      repo, outDir: repo, specFile: 'spec/msg_spec.rb', name: 'x',
      exec: fakeExec({ truncated: false, calls: [{ file: '/gems/x.rb', method: 'f', line: 1 }] }),
    })).rejects.toThrow('没有触达 app/ 代码');
  });
});
