import { describe, it, expect } from 'vitest';
import { foldTrace, TRACER_RB, TRACE_LIMIT, type RawCall } from '../src/flow/trace.js';

const call = (file: string, method: string, line = 1): RawCall => ({ file, method, line });

describe('foldTrace(调用序列→文件级链,spec §4)', () => {
  it('去容器前缀、只保 app/,步序=首次出现', () => {
    const steps = foldTrace([
      call('/app/app/controllers/msg_controller.rb', 'create'),
      call('/app/app/models/conversation.rb', 'save'),
      call('/app/lib/helper.rb', 'x'),          // 非 app/ 目录,丢
      call('/usr/local/bundle/gems/foo.rb', 'y'), // 容器前缀外,丢
      call('/app/app/models/message.rb', 'build'),
    ]);
    expect(steps.map((s) => s.chunkId)).toEqual([
      'app/controllers/msg_controller.rb',
      'app/models/conversation.rb',
      'app/models/message.rb',
    ]);
  });

  it('回访不重复成步,hits 记原始命中次数(相邻合并被首现序+计数覆盖)', () => {
    const steps = foldTrace([
      call('/app/app/a.rb', 'f1'),
      call('/app/app/b.rb', 'g'),
      call('/app/app/a.rb', 'f2'),  // 回访 a
      call('/app/app/a.rb', 'f2'),  // 相邻重复
    ]);
    expect(steps.map((s) => s.chunkId)).toEqual(['app/a.rb', 'app/b.rb']);
    expect(steps[0].hits).toBe(3);
    expect(steps[1].hits).toBe(1);
  });

  it('methods 频次降序、平频名字字典序、截 top-8', () => {
    const calls: RawCall[] = [];
    for (let i = 0; i < 3; i++) calls.push(call('/app/app/x.rb', 'hot'));
    for (const m of ['zeta', 'alpha']) calls.push(call('/app/app/x.rb', m)); // 各 1 次,平频
    for (let i = 0; i < 9; i++) calls.push(call('/app/app/x.rb', 'm' + i)); // 再来 9 个各 1 次
    const steps = foldTrace(calls);
    expect(steps[0].methods).toHaveLength(8);
    expect(steps[0].methods[0]).toBe('hot');
    expect(steps[0].methods[1]).toBe('alpha'); // 平频字典序
  });

  it('空序列 → 空链', () => {
    expect(foldTrace([])).toEqual([]);
  });

  it('全部被过滤 → 空链', () => {
    expect(foldTrace([call('/gems/x.rb', 'f'), call('/app/spec/a_spec.rb', 'it')])).toEqual([]);
  });
});

describe('TRACER_RB(容器内 Ruby tracer)', () => {
  it('含 TracePoint/:call 过滤/app 路径过滤/at_exit 落盘/上限,且无反引号与美元花括号(外层模板安全)', () => {
    expect(TRACER_RB).toContain('TracePoint.new(:call)');
    expect(TRACER_RB).toContain("start_with?('/app/app/')");
    expect(TRACER_RB).toContain('at_exit');
    expect(TRACER_RB).toContain('easyreview-trace.json');
    expect(TRACER_RB).toContain(String(TRACE_LIMIT));
    expect(TRACER_RB).toContain('rescue');
    expect(TRACER_RB).not.toContain('`');
    expect(TRACER_RB).not.toContain('${');
  });
});

describe('foldTrace 分相(spec:2026-07-16-flow-phase-design.md)', () => {
  it('controller 分界:自身与其后命中者归 request(分界含自身)', () => {
    const steps = foldTrace([
      call('/app/app/models/factory_only.rb', 'build'),
      call('/app/app/controllers/msg_controller.rb', 'create'),
      call('/app/app/models/message.rb', 'save'),
    ]);
    expect(steps.map((s) => [s.chunkId, s.phase])).toEqual([
      ['app/models/factory_only.rb', 'setup'],
      ['app/controllers/msg_controller.rb', 'request'],
      ['app/models/message.rb', 'request'],
    ]);
  });

  it('跨相文件(分界前首现+分界后命中)归 request,hits 仍全链统计(conversation.rb 场景)', () => {
    const steps = foldTrace([
      call('/app/app/models/conversation.rb', 'create'),
      call('/app/app/controllers/c.rb', 'act'),
      call('/app/app/models/conversation.rb', 'save'),
    ]);
    const conv = steps.find((s) => s.chunkId === 'app/models/conversation.rb')!;
    expect(conv.phase).toBe('request');
    expect(conv.hits).toBe(2);
  });

  it('工厂专属(分界后零命中)归 setup', () => {
    const steps = foldTrace([
      call('/app/app/models/factory_only.rb', 'build'),
      call('/app/app/models/factory_only.rb', 'build'),
      call('/app/app/controllers/c.rb', 'act'),
    ]);
    const fo = steps.find((s) => s.chunkId === 'app/models/factory_only.rb')!;
    expect(fo.phase).toBe('setup');
    expect(fo.hits).toBe(2);
  });

  it('无 controller → 全部 request 且无 setup 步(model spec 场景,行为同现状)', () => {
    const steps = foldTrace([call('/app/app/models/a.rb', 'f'), call('/app/app/models/b.rb', 'g')]);
    expect(steps.map((s) => s.chunkId)).toEqual(['app/models/a.rb', 'app/models/b.rb']);
    expect(steps.every((s) => s.phase === 'request')).toBe(true);
  });

  it('步序:setup 段首现序在前(非字典序),request 段按分界后首次命中序', () => {
    const steps = foldTrace([
      call('/app/app/models/z_setup.rb', 'f'),
      call('/app/app/models/a_setup.rb', 'f'),
      call('/app/app/models/late.rb', 'f'),
      call('/app/app/controllers/c.rb', 'act'),
      call('/app/app/models/late.rb', 'f'),
      call('/app/app/models/early.rb', 'f'),
    ]);
    expect(steps.map((s) => s.chunkId)).toEqual([
      'app/models/z_setup.rb', 'app/models/a_setup.rb',
      'app/controllers/c.rb', 'app/models/late.rb', 'app/models/early.rb',
    ]);
    expect(steps.map((s) => s.phase)).toEqual(['setup', 'setup', 'request', 'request', 'request']);
  });
});
