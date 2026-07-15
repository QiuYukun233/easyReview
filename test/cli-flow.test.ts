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

/** fake exec:同步写文件模拟「容器内 tracer at_exit 落盘、经挂载对宿主可见」——只测编排逻辑,
 *  不测容器时序/挂载/TracePoint 本身(那些靠真仓验收,spec §9)。 */
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

  it('同 spec 重跑 → 覆盖旧流程而非追加(用户改代码后重采链的常见路径)', async () => {
    const repo = makeRepo();
    const out = mkdtempSync(join(tmpdir(), 'er-out-'));
    const trace = { truncated: false, calls: [{ file: '/app/app/a.rb', method: 'f', line: 1 }] };
    await runFlowTrace({ repo, outDir: out, specFile: 'spec/msg_spec.rb', name: '旧名', exec: fakeExec(trace) });
    await runFlowTrace({ repo, outDir: out, specFile: 'spec/msg_spec.rb', name: '新名', exec: fakeExec(trace) });
    const flows = JSON.parse(readFileSync(join(out, 'easyreview.flows.json'), 'utf8'));
    expect(flows.flows).toHaveLength(1);
    expect(flows.flows[0].name).toBe('新名');
  });

  it('trace 文件存在但非法 JSON → 友好报损坏', async () => {
    const repo = makeRepo();
    const halfWrite: Exec = async (_c, _a, cwd) => {
      writeFileSync(join(cwd, 'easyreview-trace.json'), '{"truncated":false,"calls":[{');
      return 'killed';
    };
    await expect(runFlowTrace({ repo, outDir: repo, specFile: 'spec/msg_spec.rb', name: 'x', exec: halfWrite }))
      .rejects.toThrow('trace 输出损坏');
  });

  it('file:line 定位:id 带 -L、rspec 参数含行号、存在性检查用文件部分', async () => {
    const repo = makeRepo();
    const out = mkdtempSync(join(tmpdir(), 'er-out-'));
    let seenArgs: string[] = [];
    const exec: Exec = async (_c, args, cwd) => {
      seenArgs = args;
      writeFileSync(join(cwd, 'easyreview-trace.json'), JSON.stringify({ truncated: false, calls: [
        { file: '/app/app/a.rb', method: 'f', line: 1 },
      ] }));
      return 'ok';
    };
    await runFlowTrace({ repo, outDir: out, specFile: 'spec/msg_spec.rb:55', name: '单例', exec });
    expect(seenArgs).toContain('spec/msg_spec.rb:55');
    const flows = JSON.parse(readFileSync(join(out, 'easyreview.flows.json'), 'utf8'));
    expect(flows.flows[0].id).toBe('flow-msg-L55');
    expect(flows.flows[0].source.spec).toBe('spec/msg_spec.rb:55');
  });

  it('行号非法(:abc)友好拒绝', async () => {
    const repo = makeRepo();
    await expect(runFlowTrace({ repo, outDir: repo, specFile: 'spec/msg_spec.rb:abc', name: 'x' }))
      .rejects.toThrow('行号非法');
  });

  it('行号非法(:0)友好拒绝', async () => {
    const repo = makeRepo();
    await expect(runFlowTrace({ repo, outDir: repo, specFile: 'spec/msg_spec.rb:0', name: 'x' }))
      .rejects.toThrow('行号非法');
  });

  it('纯文件与 file:line 共存:id 分别为 flow-msg 与 flow-msg-L55', async () => {
    const repo = makeRepo();
    const out = mkdtempSync(join(tmpdir(), 'er-out-'));
    const trace = { truncated: false, calls: [{ file: '/app/app/a.rb', method: 'f', line: 1 }] };
    await runFlowTrace({ repo, outDir: out, specFile: 'spec/msg_spec.rb', name: '全谱', exec: fakeExec(trace) });
    await runFlowTrace({ repo, outDir: out, specFile: 'spec/msg_spec.rb:55', name: '单例', exec: fakeExec(trace) });
    const flows = JSON.parse(readFileSync(join(out, 'easyreview.flows.json'), 'utf8'));
    expect(flows.flows.map((f: { id: string }) => f.id)).toEqual(['flow-msg', 'flow-msg-L55']);
  });

  it('同 file:line 重跑覆盖自己,不动同 spec 其它行号', async () => {
    const repo = makeRepo();
    const out = mkdtempSync(join(tmpdir(), 'er-out-'));
    const trace = { truncated: false, calls: [{ file: '/app/app/a.rb', method: 'f', line: 1 }] };
    await runFlowTrace({ repo, outDir: out, specFile: 'spec/msg_spec.rb:55', name: 'A', exec: fakeExec(trace) });
    await runFlowTrace({ repo, outDir: out, specFile: 'spec/msg_spec.rb:120', name: 'B', exec: fakeExec(trace) });
    await runFlowTrace({ repo, outDir: out, specFile: 'spec/msg_spec.rb:55', name: 'A2', exec: fakeExec(trace) });
    const flows = JSON.parse(readFileSync(join(out, 'easyreview.flows.json'), 'utf8'));
    expect(flows.flows.map((f: { id: string; name: string }) => [f.id, f.name]))
      .toEqual([['flow-msg-L55', 'A2'], ['flow-msg-L120', 'B']]);
  });
});
