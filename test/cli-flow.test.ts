import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFlowTrace, runFlowProbe } from '../src/cli-flow.js';
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

  it('前导零行号(:007)接受为 7(Number 语义,锁定防将来误改)', async () => {
    const repo = makeRepo();
    const out = mkdtempSync(join(tmpdir(), 'er-out-'));
    const trace = { truncated: false, calls: [{ file: '/app/app/a.rb', method: 'f', line: 1 }] };
    await runFlowTrace({ repo, outDir: out, specFile: 'spec/msg_spec.rb:007', name: 'x', exec: fakeExec(trace) });
    const flows = JSON.parse(readFileSync(join(out, 'easyreview.flows.json'), 'utf8'));
    expect(flows.flows[0].id).toBe('flow-msg-L7');
    expect(flows.flows[0].source.spec).toBe('spec/msg_spec.rb:7');
  });
});

/** 最小 rspec --format json 输出(形状对齐 test/rspec-parse.test.ts 的夹具)。 */
function rspecOut(status: 'passed' | 'failed'): string {
  return JSON.stringify({
    version: '3.13.0',
    examples: [{ id: 'spec/m_spec.rb[1:1]', description: 'c', full_description: 'X c',
      status, file_path: './spec/m_spec.rb', line_number: 25 }],
    summary: { duration: 1, example_count: 1, failure_count: status === 'failed' ? 1 : 0, errors_outside_of_examples_count: 0 },
    summary_line: '1 example',
  });
}

/** 造带流程数据的仓:app 文件(含方法)+ runner 配置 + outDir 落一条单例流程。 */
function makeProbeRepo(): { repo: string; out: string } {
  const repo = mkdtempSync(join(tmpdir(), 'er-probe-'));
  const out = mkdtempSync(join(tmpdir(), 'er-probe-out-'));
  writeFileSync(join(repo, 'easyreview.runner.json'), JSON.stringify({
    version: 1, ruby: { cmd: ['fake-rspec', '{specFiles}'] },
  }));
  mkdirSync(join(repo, 'app', 'models'), { recursive: true });
  writeFileSync(join(repo, 'app', 'models', 'm.rb'), [
    'class M',
    '  def save_it',
    '    persist(1)',
    '  end',
    'end',
  ].join('\n'));
  mkdirSync(join(repo, 'spec'), { recursive: true });
  writeFileSync(join(repo, 'spec', 'm_spec.rb'), 'it works');
  writeFileSync(join(out, 'easyreview.flows.json'), JSON.stringify({
    version: 1,
    flows: [{
      id: 'flow-m-L25', name: '单例流程',
      source: { kind: 'rspec-trace', spec: 'spec/m_spec.rb:25', tracedAt: '2026-07-16T00:00:00Z' },
      steps: [{ chunkId: 'app/models/m.rb', methods: ['save_it'], hits: 2, phase: 'request' }],
      rawTrace: [{ file: '/app/app/models/m.rb', method: 'save_it', line: 2 }],
    }, {
      id: 'flow-full', name: '全谱流程',
      source: { kind: 'rspec-trace', spec: 'spec/m_spec.rb', tracedAt: '2026-07-16T00:00:00Z' },
      steps: [{ chunkId: 'app/models/m.rb', methods: ['save_it'], hits: 2, phase: 'request' }],
      rawTrace: [],
    }],
  }));
  return { repo, out };
}

describe('runFlowProbe(编排:校验→沙箱→斩→单例跑→判定→报告)', () => {
  it('红预测命中:报告落盘含 ✅,突变经 withMutation 已还原(沙箱文件原样)', async () => {
    const { repo, out } = makeProbeRepo();
    let mutatedSeen = '';
    const exec: Exec = async (_c, _a, cwd) => {
      mutatedSeen = readFileSync(join(cwd, 'app', 'models', 'm.rb'), 'utf8');
      return rspecOut('failed');
    };
    await runFlowProbe({ repo, outDir: out, flowId: 'flow-m-L25', step: 1, predict: 'red', exec });
    expect(mutatedSeen).toContain('# persist(1)');           // 跑时确实斩了(方法体内那行被注释)
    const md = readFileSync(join(out, 'easyreview.flowprobe.md'), 'utf8');
    expect(md).toContain('✅ 预测命中');
    expect(md).toContain('save_it');
    const sb = sandboxFor(repo);
    expect(readFileSync(join(sb.srcDir, 'app', 'models', 'm.rb'), 'utf8')).toContain('    persist(1)'); // 还原
  });

  it('绿结果+预测 red:报告 ❌ 且含绿的两种解释', async () => {
    const { repo, out } = makeProbeRepo();
    const exec: Exec = async () => rspecOut('passed');
    await runFlowProbe({ repo, outDir: out, flowId: 'flow-m-L25', step: 1, predict: 'red', exec });
    const md = readFileSync(join(out, 'easyreview.flowprobe.md'), 'utf8');
    expect(md).toContain('❌ 预测未命中');
    expect(md).toContain('防御性');
  });

  it('全谱流程(spec 无行号)友好拒绝', async () => {
    const { repo, out } = makeProbeRepo();
    await expect(runFlowProbe({ repo, outDir: out, flowId: 'flow-full', step: 1, predict: 'red' }))
      .rejects.toThrow('全谱');
  });

  it('flowId 不存在/step 越界/predict 非法:各自友好拒绝', async () => {
    const { repo, out } = makeProbeRepo();
    await expect(runFlowProbe({ repo, outDir: out, flowId: 'flow-nope', step: 1, predict: 'red' }))
      .rejects.toThrow('找不到流程');
    await expect(runFlowProbe({ repo, outDir: out, flowId: 'flow-m-L25', step: 9, predict: 'red' }))
      .rejects.toThrow('--step 越界');
    await expect(runFlowProbe({ repo, outDir: out, flowId: 'flow-m-L25', step: 1, predict: 'boom' }))
      .rejects.toThrow('--predict');
  });

  it('探针不改 flows.json(一次性考试,报告即产物)', async () => {
    const { repo, out } = makeProbeRepo();
    const before = readFileSync(join(out, 'easyreview.flows.json'), 'utf8');
    const exec: Exec = async () => rspecOut('failed');
    await runFlowProbe({ repo, outDir: out, flowId: 'flow-m-L25', step: 1, predict: 'red', exec });
    expect(readFileSync(join(out, 'easyreview.flows.json'), 'utf8')).toBe(before);
  });
});
