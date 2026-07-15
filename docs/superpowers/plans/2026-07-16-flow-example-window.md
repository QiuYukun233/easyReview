# 单 example 切窗 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `flow trace spec/xxx_spec.rb:55` 只跑该行 example,恢复双相判定语义;纯文件形式行为不变。

**Architecture:** cli-flow.ts 加 `parseSpecRef`(尾部 `:<正整数>` 识别,非法行号友好拒绝);存在性检查用文件部分、rspec 参数透传完整 file:line、id 带 `-L<行号>` 后缀共存、source.spec 落盘完整引用。serve/UI/tracer/foldTrace 全部零改动。

**Tech Stack:** TypeScript(tsx 直跑)、vitest。

**Spec:** `docs/superpowers/specs/2026-07-16-flow-example-window-design.md`
**基线:** 分支 feat/flow-example-window(自 main ea26c49),65 文件 332 测试全绿。完成后 337。

---

## 硬约束

1. 本计划代码块零反斜杠转义;cli-flow.ts 是普通 TS 文件(模板字面量/`${}` 合法,与 page.ts 不同)。
2. 只改 src/cli-flow.ts 与 test/cli-flow.test.ts 两个文件。
3. 提交前两文件跑控制字节(0x00-0x08)扫描。

---

### Task 1(唯一任务): parseSpecRef + runFlowTrace 接线

**Files:**
- Modify: `src/cli-flow.ts`(整文件替换,下面给全文)
- Modify: `test/cli-flow.test.ts`(追加 5 条 it)

- [ ] **Step 1: 写失败测试**

`test/cli-flow.test.ts` 的 describe 内末尾追加:

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/cli-flow.test.ts`
Expected: 新增 5 条 FAIL(现状把 `spec/msg_spec.rb:55` 当整个文件名 → endsWith('_spec.rb') 为 false → 抛「只支持 Ruby rspec」,与期望错误/id 不符),原有 6 条 PASS。

- [ ] **Step 3: src/cli-flow.ts 整文件替换**

```ts
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRubyRunnerConfig, expandCmd } from './verify/rspec.js';
import { sandboxFor, syncSandbox } from './verify/sandbox.js';
import { realExec, type Exec } from './verify/cargo.js';
import { TRACER_RB, foldTrace, type RawCall } from './flow/trace.js';
import { loadFlows, saveFlows, upsertFlow } from './flow/flows.js';

const TRACER_NAME = 'easyreview_tracer.rb';
const TRACE_OUT = 'easyreview-trace.json';

export interface SpecRef { file: string; line: number | null }

/** 解析 spec 引用:尾部 :<正整数> 定位单 example(spec:2026-07-16-flow-example-window-design.md)。
 *  多 example spec 下每个 example 重建工厂数据会污染双相判定——单 example 窗口恢复其语义。 */
export function parseSpecRef(ref: string): SpecRef {
  const i = ref.lastIndexOf(':');
  if (i > 0 && ref.slice(0, i).endsWith('_spec.rb')) {
    const tail = ref.slice(i + 1);
    const digits = tail.length > 0 && [...tail].every((ch) => ch >= '0' && ch <= '9');
    if (!digits || Number(tail) < 1) {
      throw new Error(`行号非法:「${tail}」——用法 spec/xxx_spec.rb:55(正整数行号定位单 example)`);
    }
    return { file: ref.slice(0, i), line: Number(tail) };
  }
  return { file: ref, line: null };
}

export interface FlowTraceOpts {
  repo: string; outDir: string; specFile: string; name: string;
  exec?: Exec; // 测试注入;缺省 realExec(非零退出不抛——trace 不受 spec 红绿影响)
}

/** 编排:沙箱同步→tracer 写进沙箱(compose 挂沙箱,真实仓零污染)→rspec -r 注入→读回→折叠→落盘→finally 清理。 */
export async function runFlowTrace(o: FlowTraceOpts): Promise<void> {
  const ref = parseSpecRef(o.specFile);
  if (!ref.file.endsWith('_spec.rb')) {
    throw new Error('flow trace 打样期只支持 Ruby rspec——传 *_spec.rb 文件(spec §1,web 栈先行)');
  }
  const specArg = ref.line ? ref.file + ':' + ref.line : ref.file;
  const config = loadRubyRunnerConfig(o.repo);
  const sb = sandboxFor(o.repo);
  console.error('⏳ 同步沙箱…');
  syncSandbox(o.repo, sb.srcDir);
  if (!existsSync(join(sb.srcDir, ref.file))) throw new Error(`仓里没有 ${ref.file}`);
  writeFileSync(join(sb.srcDir, TRACER_NAME), TRACER_RB);
  try {
    console.error('⏳ 跑 rspec + TracePoint(docker 冷启动可能较慢)…');
    const [cmd, ...args] = expandCmd(config.cmd, ['-r./' + TRACER_NAME, specArg]);
    await (o.exec ?? realExec)(cmd, args, sb.srcDir);
    const tracePath = join(sb.srcDir, TRACE_OUT);
    if (!existsSync(tracePath)) {
      throw new Error('trace 输出不存在——rspec 可能在加载期崩了或进程被超时杀死(at_exit 没跑到);先手跑该 spec 确认环境(配方:docs/recipes/chatwoot-rspec.md)');
    }
    let raw: { truncated: boolean; calls: RawCall[] };
    try {
      raw = JSON.parse(readFileSync(tracePath, 'utf8')) as { truncated: boolean; calls: RawCall[] };
    } catch {
      throw new Error('trace 输出损坏(非法 JSON)——容器可能在落盘中途被杀,重跑一次;反复出现则先手跑该 spec 确认环境');
    }
    const steps = foldTrace(raw.calls);
    if (!steps.length) throw new Error('trace 没有触达 app/ 代码——换一条 request/controller spec');
    if (raw.truncated) console.error('⚠ trace 达上限被截断——首现序步链仍可用,hits 偏低');
    const flow = {
      id: 'flow-' + ref.file.split('/').pop()!.replace('_spec.rb', '') + (ref.line ? '-L' + ref.line : ''),
      name: o.name,
      source: { kind: 'rspec-trace' as const, spec: specArg, tracedAt: new Date().toISOString() },
      steps,
      rawTrace: raw.calls,
    };
    saveFlows(o.outDir, upsertFlow(loadFlows(o.outDir), flow));
    // 成功横幅在编排层打印(不走 cli.ts 的 .then 收口):横幅要用 steps.length,cli.ts 拿不到
    console.log(`✓ flow 「${o.name}」:${steps.length} 步已写入 easyreview.flows.json`);
  } finally {
    for (const f of [TRACER_NAME, TRACE_OUT]) {
      const p = join(sb.srcDir, f);
      if (existsSync(p)) unlinkSync(p);
    }
  }
}
```

(与现状差异:新增 SpecRef/parseSpecRef;runFlowTrace 开头改 parse+文件部分校验;specArg 用于 rspec 参数与 source.spec;id 带可选 -L 后缀;其余逐字保留。)

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/cli-flow.test.ts`
Expected: 11 条全 PASS。

- [ ] **Step 5: 全量回归 + typecheck**

Run: `npm test` → **65 文件 337 测试**全 PASS;`npm run typecheck` 干净。

- [ ] **Step 6: Commit**

```bash
git add src/cli-flow.ts test/cli-flow.test.ts
git commit -m "feat: flow trace 支持 spec:行号定位单 example——恢复双相判定语义,流程共存"
```

---

## 真仓验收(主会话做)

1. 从 chatwoot messages_controller_spec 挑一个 POST create example 行号(grep 'it .*create' 或读文件)。
2. `npm run flow -- trace <spec>:<行号> --name "发消息·单例" --repo ... --out out/chatwoot`。
3. **核心物证:setup 段步数显著回升**(全 spec 版是 3/81);request 段短而干净、以 controller 开场。
4. 流程 Tab 两条流程并存(全谱版 + 单例版);真实仓零接触。