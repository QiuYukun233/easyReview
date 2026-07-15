# 纵向切割打样(flow trace)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `easyreview flow trace <spec> --name <名>` 用 rspec+TracePoint 真跑采一条业务流程的执行链,落盘 easyreview.flows.json,viewer 第三 Tab「流程」纵向步骤列表可点跳转。

**Architecture:** 新 `src/flow/` 模块(tracer Ruby 脚本常量 + 链折叠纯函数 + flows 文件读写)+ `src/cli-flow.ts` 编排(复用 verify 的沙箱/runner 配置/realExec:tracer 写进沙箱→`rspec -r./tracer` 注入→读回 trace→折叠→落盘→清理);serve 层可选第 4 参传 flows(rawTrace 不出前端);page.ts 第三 Tab。关键事实:compose `.:/app` 挂的是**沙箱**,tracer 天然零污染真实仓;realExec 不因非零退出抛错,trace 不受 spec 红绿影响。

**Tech Stack:** TypeScript(tsx 直跑)、vitest、Ruby TracePoint(容器内)、既有 Docker rspec 环境(chatwoot-easyreview)。

**Spec:** `docs/superpowers/specs/2026-07-15-flow-trace-pilot-design.md`
**基线:** 分支 feat/flow-trace-pilot(自 main 06faf96),300 测试全绿。完成后约 317。

---

## 全计划硬约束

1. 本计划所有代码块**不含任何反斜杠转义序列**(连正则都没用——basename 处理全用 split/replace 字符串版),照抄即可;若自行改写字符串,提交前用 `node -e "const b=require('fs').readFileSync('<file>');let n=0;for(const x of b)if(x<=8)n++;console.log(n?'CONTROL '+n:'clean')"` 校验改动文件。
2. page.ts 内嵌 JS 禁反引号与 `\${`;动态文本全过 esc()。
3. TRACER_RB 用 TS 模板字面量书写(真实换行,零转义);Ruby 内容里不许出现反引号与 `${`(会撞外层)。

---

### Task 1: flow 核心——types + tracer 常量 + 链折叠 + flows 文件读写

**Files:**
- Modify: `src/types.ts`(末尾追加 Flow 类型组)
- Create: `src/flow/trace.ts`
- Create: `src/flow/flows.ts`
- Create: `test/flow-trace.test.ts`(6 条)
- Create: `test/flow-files.test.ts`(4 条)

- [ ] **Step 1: types.ts 追加类型**

`src/types.ts` 文件末尾追加:

```ts

/** 纵向切割:业务流程(spec:2026-07-15-flow-trace-pilot-design.md)。独立落盘 easyreview.flows.json,不进 tree.json。 */
export interface FlowStep {
  chunkId: NodeId;   // 文件级步骤;可能不是块(如 app/views ERB),前端降级纯文本
  methods: string[]; // 该步命中的方法名 top-N,频次降序
  hits: number;      // 原始调用序列中的命中次数(回访计数)
}
export interface Flow {
  id: string;
  name: string;      // 打样期由 CLI --name 人工给
  source: { kind: 'rspec-trace'; spec: string; tracedAt: string }; // kind 即多来源预留接口
  steps: FlowStep[];
  rawTrace: { file: string; method: string; line: number }[]; // 方法级原始序列,将来下钻用;不出前端
}
export interface FlowsFile { version: 1; flows: Flow[] }
```

- [ ] **Step 2: 写失败测试(折叠 + tracer 常量)**

Create `test/flow-trace.test.ts`:

```ts
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
    expect(TRACER_RB).not.toContain('`');
    expect(TRACER_RB).not.toContain('${');
  });
});
```

Create `test/flow-files.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFlows, saveFlows, upsertFlow } from '../src/flow/flows.js';
import type { Flow } from '../src/types.js';

const flow = (id: string, name: string): Flow => ({
  id, name,
  source: { kind: 'rspec-trace', spec: 'spec/x_spec.rb', tracedAt: '2026-07-15T00:00:00Z' },
  steps: [{ chunkId: 'app/a.rb', methods: ['f'], hits: 1 }],
  rawTrace: [{ file: '/app/app/a.rb', method: 'f', line: 1 }],
});

describe('flows 文件读写(独立 easyreview.flows.json,spec §5)', () => {
  it('文件不存在 → null(视同无流程)', () => {
    expect(loadFlows(mkdtempSync(join(tmpdir(), 'er-')))).toBeNull();
  });

  it('损坏 JSON → null(容错,不抛)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'er-'));
    writeFileSync(join(dir, 'easyreview.flows.json'), '{broken');
    expect(loadFlows(dir)).toBeNull();
  });

  it('save→load 往返一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'er-'));
    saveFlows(dir, { version: 1, flows: [flow('flow-a', 'A 流程')] });
    expect(loadFlows(dir)).toEqual({ version: 1, flows: [flow('flow-a', 'A 流程')] });
  });

  it('upsertFlow:同 id 替换、新 id 追加、null 起新文件', () => {
    const f1 = upsertFlow(null, flow('flow-a', '旧名'));
    expect(f1.flows).toHaveLength(1);
    const f2 = upsertFlow(f1, flow('flow-b', 'B'));
    expect(f2.flows.map((f) => f.id)).toEqual(['flow-a', 'flow-b']);
    const f3 = upsertFlow(f2, flow('flow-a', '新名'));
    expect(f3.flows).toHaveLength(2);
    expect(f3.flows[0].name).toBe('新名');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run test/flow-trace.test.ts test/flow-files.test.ts`
Expected: 两文件全 FAIL(模块不存在)。

- [ ] **Step 4: 实现 src/flow/trace.ts**

```ts
import type { FlowStep } from '../types.js';

export interface RawCall { file: string; method: string; line: number }

export const TRACE_LIMIT = 50000;
const METHODS_TOP_N = 8;

/** 容器内 tracer:TracePoint 采 app/ 调用序列,at_exit 落盘 JSON。
 *  经 rspec -r./easyreview_tracer.rb 注入(写进沙箱,compose 挂沙箱→真实仓零污染)。
 *  Ruby 内容禁反引号与美元花括号(本文件是 TS 模板字面量)。 */
export const TRACER_RB = `# easyreview flow tracer(自动生成,用后即删)
require 'json'
EASYREVIEW_CALLS = []
EASYREVIEW_TP = TracePoint.new(:call) do |t|
  path = t.path.to_s
  next unless path.start_with?('/app/app/')
  next if EASYREVIEW_CALLS.length >= ${TRACE_LIMIT}
  EASYREVIEW_CALLS << { 'file' => path, 'method' => t.method_id.to_s, 'line' => t.lineno }
end
EASYREVIEW_TP.enable
at_exit do
  File.write('/app/easyreview-trace.json', JSON.generate({
    'truncated' => EASYREVIEW_CALLS.length >= ${TRACE_LIMIT},
    'calls' => EASYREVIEW_CALLS,
  }))
end
`;

/** 调用序列 → 文件级链:去容器前缀、只保 app/、步序=首现、hits=命中次数(相邻合并被此规则覆盖)。 */
export function foldTrace(calls: RawCall[], containerPrefix = '/app/'): FlowStep[] {
  const order: string[] = [];
  const byFile = new Map<string, { hits: number; methodCounts: Map<string, number> }>();
  for (const c of calls) {
    if (!c.file.startsWith(containerPrefix)) continue;
    const rel = c.file.slice(containerPrefix.length);
    if (!rel.startsWith('app/')) continue;
    let e = byFile.get(rel);
    if (!e) { e = { hits: 0, methodCounts: new Map() }; byFile.set(rel, e); order.push(rel); }
    e.hits++;
    e.methodCounts.set(c.method, (e.methodCounts.get(c.method) ?? 0) + 1);
  }
  return order.map((f) => {
    const e = byFile.get(f)!;
    const methods = [...e.methodCounts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, METHODS_TOP_N)
      .map(([m]) => m);
    return { chunkId: f, methods, hits: e.hits };
  });
}
```

注意:TRACER_RB 里的 `${TRACE_LIMIT}` 是**外层 TS 模板插值**(数字),Ruby 文本落盘后是纯数字——测试断言 `not.toContain('${')` 验的是**导出的字符串值**,插值后自然不含。

- [ ] **Step 5: 实现 src/flow/flows.ts**

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Flow, FlowsFile } from '../types.js';

const FILE = 'easyreview.flows.json';

/** 读不出/损坏 → null(视同不存在,serve 与 CLI 共用此容错口径)。 */
export function loadFlows(outDir: string): FlowsFile | null {
  const p = join(outDir, FILE);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as FlowsFile;
    return Array.isArray(parsed.flows) ? parsed : null;
  } catch { return null; }
}

export function saveFlows(outDir: string, flows: FlowsFile): void {
  writeFileSync(join(outDir, FILE), JSON.stringify(flows, null, 2));
}

/** 同 id 替换(保位),新 id 追加;null 起新文件。 */
export function upsertFlow(file: FlowsFile | null, flow: Flow): FlowsFile {
  const flows = file ? [...file.flows] : [];
  const i = flows.findIndex((f) => f.id === flow.id);
  if (i >= 0) flows[i] = flow; else flows.push(flow);
  return { version: 1, flows };
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run test/flow-trace.test.ts test/flow-files.test.ts`
Expected: 10 条全 PASS。再跑 `npm run typecheck`,干净。

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/flow/trace.ts src/flow/flows.ts test/flow-trace.test.ts test/flow-files.test.ts
git commit -m "feat: flow 核心——TracePoint tracer 常量、链折叠纯函数、flows 文件读写"
```

---

### Task 2: cli-flow 编排 + cli 接线

**Files:**
- Create: `src/cli-flow.ts`
- Modify: `src/cli.ts`(verify 块之后加 flow 块)
- Create: `test/cli-flow.test.ts`(4 条)

- [ ] **Step 1: 写失败测试**

Create `test/cli-flow.test.ts`:

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/cli-flow.test.ts`
Expected: 全 FAIL(cli-flow 模块不存在)。

- [ ] **Step 3: 实现 src/cli-flow.ts**

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

export interface FlowTraceOpts {
  repo: string; outDir: string; specFile: string; name: string;
  exec?: Exec; // 测试注入;缺省 realExec(非零退出不抛——trace 不受 spec 红绿影响)
}

/** 编排:沙箱同步→tracer 写进沙箱(compose 挂沙箱,真实仓零污染)→rspec -r 注入→读回→折叠→落盘→finally 清理。 */
export async function runFlowTrace(o: FlowTraceOpts): Promise<void> {
  if (!o.specFile.endsWith('_spec.rb')) {
    throw new Error('flow trace 打样期只支持 Ruby rspec——传 *_spec.rb 文件(spec §1,web 栈先行)');
  }
  const config = loadRubyRunnerConfig(o.repo);
  const sb = sandboxFor(o.repo);
  console.log('⏳ 同步沙箱…');
  syncSandbox(o.repo, sb.srcDir);
  if (!existsSync(join(sb.srcDir, o.specFile))) throw new Error(`仓里没有 ${o.specFile}`);
  writeFileSync(join(sb.srcDir, TRACER_NAME), TRACER_RB);
  try {
    console.log('⏳ 跑 rspec + TracePoint(docker 冷启动可能较慢)…');
    const [cmd, ...args] = expandCmd(config.cmd, ['-r./' + TRACER_NAME, o.specFile]);
    await (o.exec ?? realExec)(cmd, args, sb.srcDir);
    const tracePath = join(sb.srcDir, TRACE_OUT);
    if (!existsSync(tracePath)) {
      throw new Error('trace 输出不存在——rspec 可能在加载期就崩了;先手跑该 spec 确认环境(配方:docs/recipes/chatwoot-rspec.md)');
    }
    const raw = JSON.parse(readFileSync(tracePath, 'utf8')) as { truncated: boolean; calls: RawCall[] };
    const steps = foldTrace(raw.calls);
    if (!steps.length) throw new Error('trace 没有触达 app/ 代码——换一条 request/controller spec');
    if (raw.truncated) console.log('⚠ trace 达上限被截断——首现序步链仍可用,hits 偏低');
    const flow = {
      id: 'flow-' + o.specFile.split('/').pop()!.replace('_spec.rb', ''),
      name: o.name,
      source: { kind: 'rspec-trace' as const, spec: o.specFile, tracedAt: new Date().toISOString() },
      steps,
      rawTrace: raw.calls,
    };
    saveFlows(o.outDir, upsertFlow(loadFlows(o.outDir), flow));
    console.log(`✓ flow 「${o.name}」:${steps.length} 步已写入 easyreview.flows.json`);
  } finally {
    for (const f of [TRACER_NAME, TRACE_OUT]) {
      const p = join(sb.srcDir, f);
      if (existsSync(p)) unlinkSync(p);
    }
  }
}
```

- [ ] **Step 4: cli.ts 接线**

`src/cli.ts` 中 `if (cmd === 'verify') { ... }` 块的收尾 `}` 之后、`if (cmd === 'serve')` 之前插入:

```ts

if (cmd === 'flow') {
  const rest = process.argv.slice(3);
  const specFile = rest.find((a, i) => i > 0 && !a.startsWith('--') && !(rest[i - 1] ?? '').startsWith('--'));
  const ni = rest.indexOf('--name');
  const name = ni >= 0 && rest[ni + 1] ? rest[ni + 1] : null;
  if (rest[0] !== 'trace' || !specFile || !name) {
    console.error('用法: easyreview flow trace <specFile> --name "<流程名>" [--repo <p>] [--out <d>]');
    process.exit(1);
  }
  const { repo, outDir } = parseArgs(rest);
  import('./cli-flow.js').then(({ runFlowTrace }) =>
    runFlowTrace({ repo, outDir, specFile, name })
      .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); }),
  );
}
```

并在 package.json 的 scripts 里(与 verify 并列)加:

```json
    "flow": "tsx src/cli.ts flow",
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/cli-flow.test.ts`
Expected: 4 条全 PASS。`npm run typecheck` 干净。

- [ ] **Step 6: Commit**

```bash
git add src/cli-flow.ts src/cli.ts package.json test/cli-flow.test.ts
git commit -m "feat: flow trace 子命令——沙箱注入 tracer,真跑采链落盘 flows.json"
```

---

### Task 3: serve 层——ViewerState.flows + hasFlows

**Files:**
- Modify: `src/serve/state.ts`
- Modify: `src/serve/server.ts`
- Modify: `test/viewer-state.test.ts`(追加一个 describe,3 条)

- [ ] **Step 1: 写失败测试**

`test/viewer-state.test.ts` 文件末尾追加(import 行不用动,flows 用内联字面量):

```ts
describe('buildViewerState flows(纵向切割,spec §7)', () => {
  const FLOWS = { version: 1 as const, flows: [{
    id: 'flow-msg', name: '发消息',
    source: { kind: 'rspec-trace' as const, spec: 'spec/m_spec.rb', tracedAt: '2026-07-15T00:00:00Z' },
    steps: [{ chunkId: A, methods: ['f1'], hits: 2 }],
    rawTrace: [{ file: '/app/app/x.rb', method: 'f1', line: 1 }],
  }] };

  it('flows 进 state:steps/名字/来源 spec 保留,rawTrace 不出(payload 卫生)', () => {
    const s = buildViewerState(makeViewerTree(), makeViewerLabels(), { version: 1, understood: [] }, FLOWS);
    expect(s.hasFlows).toBe(true);
    expect(s.flows).toEqual([{ id: 'flow-msg', name: '发消息', spec: 'spec/m_spec.rb',
      steps: [{ chunkId: A, methods: ['f1'], hits: 2 }] }]);
  });

  it('第 4 参缺省(既有调用方)→ hasFlows=false 且 flows=[]', () => {
    const s = buildViewerState(makeViewerTree(), makeViewerLabels(), { version: 1, understood: [] });
    expect(s.hasFlows).toBe(false);
    expect(s.flows).toEqual([]);
  });

  it('空 flows 文件 → hasFlows=false(Tab 不该出现)', () => {
    const s = buildViewerState(makeViewerTree(), makeViewerLabels(), { version: 1, understood: [] },
      { version: 1, flows: [] });
    expect(s.hasFlows).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/viewer-state.test.ts`
Expected: 新增 3 条 FAIL,原有 11 条 PASS。

- [ ] **Step 3: 实现 state.ts**

`src/serve/state.ts` 第 1 行 import 的类型列表加 `FlowsFile, FlowStep`(即 `import type { GradedTree, LabelCache, Progress, NodeId, RiskBucket, ContribBucket, FlowsFile, FlowStep } from '../types.js';`)。

`ViewerState` 接口中 `hasRefsOut: ...` 行之后加两行:

```ts
  flows: { id: string; name: string; spec: string; steps: FlowStep[] }[]; // rawTrace 不出前端
  hasFlows: boolean; // 有至少一条流程才渲染 Tab
```

`buildViewerState` 签名改为:

```ts
export function buildViewerState(g: GradedTree, labels: LabelCache, progress: Progress, flowsFile?: FlowsFile | null): ViewerState {
```

return 对象的 `hasRefsOut: ...` 行之后加:

```ts
    flows: (flowsFile?.flows ?? []).map((f) => ({ id: f.id, name: f.name, spec: f.source.spec, steps: f.steps })),
    hasFlows: (flowsFile?.flows ?? []).length > 0,
```

- [ ] **Step 4: server.ts 接线**

import 区加:

```ts
import { loadFlows } from '../flow/flows.js';
```

`/api/state` 分支的 `sendJson(res, 200, buildViewerState(tree, labels, progress));` 改为:

```ts
    sendJson(res, 200, buildViewerState(tree, labels, progress, loadFlows(outDir)));
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/viewer-state.test.ts test/serve-http.test.ts`
Expected: 全 PASS(serve-http 既有测试不受影响——flows 缺省即空)。`npm run typecheck` 干净。

- [ ] **Step 6: Commit**

```bash
git add src/serve/state.ts src/serve/server.ts test/viewer-state.test.ts
git commit -m "feat: serve 层暴露 flows(去 rawTrace)与 hasFlows 旗标"
```

---

### Task 4: page.ts——第三 Tab「流程」

**Files:**
- Modify: `test/serve-page.test.ts`(追加 2 条 it)
- Modify: `src/serve/page.ts`(六处编辑,全部逐字给出)

- [ ] **Step 1: 写失败测试**

`test/serve-page.test.ts` 的 describe 末尾追加:

```ts
  it('flows: 第三 Tab 与容器都在,仍自包含', () => {
    const html = renderPage();
    expect(html).toContain('id="tab-flows"');
    expect(html).toContain('id="flows"');
    expect(html).not.toContain('src=');
  });

  it('flows: 流程文案/来源标注/步骤跳转类都在', () => {
    const html = renderPage();
    expect(html).toContain('rspec 真跑采集');
    expect(html).toContain('flow-jump');
    expect(html).toContain('renderFlows');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/serve-page.test.ts`
Expected: 新增 2 条 FAIL,原有全 PASS。

- [ ] **Step 3: page.ts 六处编辑**

**编辑 ①(CSS)**——`#legend { ... }` 规则行之后插入:

```css
#flows { max-width: 720px; }
.flow-card { border: 1px solid var(--border); border-radius: 10px; background: var(--panel-bg); padding: 12px 16px; margin-bottom: 12px; }
.flow-card h3 { margin: 0 0 6px; font-size: 14px; }
.flow-step { display: flex; gap: 8px; padding: 3px 0; align-items: baseline; }
.flow-step .no { color: var(--muted); flex: none; width: 34px; text-align: right; }
.flow-step .hits { color: var(--muted); font-size: 12px; }
.flow-step code { font: 12px ui-monospace, monospace; color: var(--muted); }
```

**编辑 ②(HTML)**——Tab 区 `<button id="tab-tree">文件树</button>` 之后加一行:

```html
    <button id="tab-flows" hidden>流程</button>
```

`<div id="tree" hidden></div>` 之后加一行:

```html
    <div id="flows" hidden></div>
```

**编辑 ③(view 状态)**——

```js
var view = localStorage.getItem('easyreview-view') === 'tree' ? 'tree' : 'grid';
```

改为:

```js
var view = ['tree', 'flows'].indexOf(localStorage.getItem('easyreview-view')) >= 0 ? localStorage.getItem('easyreview-view') : 'grid';
```

**编辑 ④(legend 常量与 renderTabs)**——`var TREE_LEGEND = ...` 行之后加:

```js
var FLOWS_LEGEND = '纵向切片:一条真实业务流程的执行链(rspec 真跑采集,非静态猜测)· 步骤=文件首现序 · ×N=命中次数 · 点步骤看源码';
```

renderTabs 整个函数(现为 grid/tree 二态)替换为:

```js
function renderTabs() {
  $('tab-grid').className = view === 'grid' ? 'active' : '';
  $('tab-tree').className = view === 'tree' ? 'active' : '';
  $('tab-flows').className = view === 'flows' ? 'active' : '';
  $('tab-flows').hidden = !state.hasFlows;
  if (view === 'flows' && !state.hasFlows) { view = 'grid'; localStorage.setItem('easyreview-view', view); }
  $('grid').hidden = view !== 'grid';
  $('tree').hidden = view !== 'tree';
  $('flows').hidden = view !== 'flows';
  $('legend').innerHTML = view === 'grid' ? GRID_LEGEND : (view === 'tree' ? TREE_LEGEND : FLOWS_LEGEND);
}
```

**编辑 ⑤(渲染函数)**——`renderTree` 函数收尾 `}` 之后插入:

```js
// ── 流程视图(纵向切片,easyreview.flows.json;hasFlows=false 时 Tab 不出现) ──
function renderFlows() {
  var html = '';
  for (var i = 0; i < state.flows.length; i++) {
    var f = state.flows[i];
    html += '<div class="flow-card"><h3>' + esc(f.name) + '</h3>';
    html += '<div class="muted">来源:rspec 真跑采集(' + esc(f.spec) + ')</div>';
    for (var j = 0; j < f.steps.length; j++) {
      var s = f.steps[j];
      var c = state.chunks[s.chunkId];
      var label = c
        ? '<span class="nb flow-jump" data-ref="' + esc(s.chunkId) + '" title="' + esc(s.chunkId) + '">' + esc(c.name) + '</span>'
        : '<span class="muted" title="' + esc(s.chunkId) + '">' + esc(s.chunkId.split('/').pop()) + '</span>';
      html += '<div class="flow-step"><span class="no">' + (j + 1) + '.</span>' + label +
        ' <code>' + esc(s.methods.slice(0, 3).join(', ')) + '</code>' +
        ' <span class="hits">×' + s.hits + '</span></div>';
    }
    html += '</div>';
  }
  $('flows').innerHTML = html;
  var els = $('flows').querySelectorAll('.flow-jump');
  for (var k = 0; k < els.length; k++) {
    els[k].addEventListener('click', function (ev) {
      selectedId = ev.currentTarget.getAttribute('data-ref');
      openDrawer(selectedId);
      render();
    });
  }
}
```

**编辑 ⑥(接线)**——render() 中:

```js
  if (view === 'grid') renderGrid(); else renderTree();
```

改为:

```js
  if (view === 'grid') renderGrid(); else if (view === 'tree') renderTree(); else renderFlows();
```

全局交互区 `$('tab-tree').addEventListener(...)` 行之后加:

```js
$('tab-flows').addEventListener('click', function () { view = 'flows'; localStorage.setItem('easyreview-view', view); render(); });
```

- [ ] **Step 4: 跑 page 测试确认通过**

Run: `npx vitest run test/serve-page.test.ts`
Expected: 全 PASS。

- [ ] **Step 5: 全量回归 + typecheck**

Run: `npm test`
Expected: **65 文件 319 测试**全 PASS(基线 62/300;Task1 新增两测试文件 +10、Task2 新增一文件 +4、Task3 +3、Task4 +2,合计 +19)。
Run: `npm run typecheck`
Expected: 干净。

- [ ] **Step 6: Commit**

```bash
git add test/serve-page.test.ts src/serve/page.ts
git commit -m "feat: viewer 第三 Tab「流程」——纵向步骤列表,真跑来源标注,步骤可点跳抽屉"
```

---

## 真仓验收(主会话做,不在任务内)

1. Docker Desktop 起、容器就绪(pg tmpfs 蒸发则先 `rake db:create db:schema:load`)。
2. `npm run flow -- trace spec/controllers/api/v1/accounts/conversations/messages_controller_spec.rb --name "发消息(API→模型→分发)" --repo E:/learning/agent-research/repos/chatwoot --out E:/dev/easyReview/out/chatwoot`(候选首选;不满足 spec §2 三标准则按标准换)。
3. 链上物证人工核对:应含 conversation.rb、message.rb、某分发 job/listener;与 spec 行为对照。
4. 真实仓零接触:chatwoot `git status` 干净;沙箱内 tracer/trace 文件已清理。
5. viewer:流程 Tab 出现、步骤点击开抽屉;老产物(无 flows.json)Tab 不出现。
6. umwelt 回归:零接触零变化。