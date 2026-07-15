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
