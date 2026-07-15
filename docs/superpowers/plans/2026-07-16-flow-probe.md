# 流程级突变探针(flow probe)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `flow probe <flowId> --step <N> --predict red|green` 斩流程第 N 步(优先落在流程命中方法体内)、真跑单 example、比对预测、产出 easyreview.flowprobe.md。

**Architecture:** 三个新单元:probe-site(方法体内位点,pick-site 切片复用+行偏移映射)、probe(判定纯函数+报告渲染)、runFlowProbe 编排(loadFlows 校验→沙箱→withMutation 斩→rspec file:line→parseRspecJson→判定→报告)。mutate.ts/pick-site.ts **只 import 不编辑**(mutate.ts 是含反斜杠正则的雷区文件)。

**Tech Stack:** TypeScript(tsx)、vitest、web-tree-sitter(Ruby method 节点定位)。

**Spec:** `docs/superpowers/specs/2026-07-16-flow-probe-design.md`
**基线:** 分支 feat/flow-probe(自 main ba425b8),65 文件 338 测试全绿。完成后约 351。

---

## 硬约束

1. 本计划代码块零反斜杠转义;**绝不编辑 src/verify/mutate.ts 与 src/verify/pick-site.ts**(前者含 `\b` 正则雷区,后者含词法细节——都只 import)。
2. 提交前对每个改动文件跑控制字节(0x00-0x08)扫描。
3. 唯一允许的实现期对齐:probe-site.ts 的 tree-sitter 节点类型 import 按 src/verify/pick-site.ts 现有写法照抄(先读它的 import 区)。

---

### Task 1: probe-site——流程命中方法体内挑位点

**Files:**
- Create: `src/flow/probe-site.ts`
- Create: `test/flow-probe-site.test.ts`(4 条)

- [ ] **Step 1: 写失败测试**

Create `test/flow-probe-site.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pickSiteInMethods } from '../src/flow/probe-site.js';

const RUBY_SRC = [
  'class Foo',
  '  def alpha',
  '    do_thing(1)',
  '  end',
  '',
  '  def beta',
  '    x = compute',
  '  end',
  '',
  '  def empty_guard',
  '  end',
  'end',
].join('\n');

describe('pickSiteInMethods(流程命中方法体内落刀,spec §4)', () => {
  it('定位含定义行的 method 节点,体内挑到语句且行号映射回全文件', async () => {
    const site = await pickSiteInMethods(RUBY_SRC, [{ method: 'alpha', line: 2 }]);
    expect(site).toEqual({ line: 3, original: '    do_thing(1)', scope: 'method', method: 'alpha' });
  });

  it('多方法按传入序优先(先命中先用)', async () => {
    const site = await pickSiteInMethods(RUBY_SRC, [
      { method: 'beta', line: 6 },
      { method: 'alpha', line: 2 },
    ]);
    expect(site!.method).toBe('beta');
    expect(site!.line).toBe(7);
  });

  it('方法体无可注释语句 → 试下一个方法', async () => {
    const site = await pickSiteInMethods(RUBY_SRC, [
      { method: 'empty_guard', line: 10 },
      { method: 'alpha', line: 2 },
    ]);
    expect(site!.method).toBe('alpha');
  });

  it('全部方法都挑不到 → null(调用方回退文件级)', async () => {
    const site = await pickSiteInMethods(RUBY_SRC, [{ method: 'empty_guard', line: 10 }]);
    expect(site).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/flow-probe-site.test.ts`
Expected: 全 FAIL(模块不存在)。

- [ ] **Step 3: 实现 src/flow/probe-site.ts**

先读 `src/verify/pick-site.ts` 的 import 区,节点遍历/类型写法与它对齐;实现:

```ts
import { getParser } from '../extract/parser.js';
import { RUBY } from '../extract/lang.js';
import { pickPreferredSite } from '../verify/pick-site.js';

export interface ProbeSite {
  line: number;        // 1-based,全文件行号
  original: string;    // 原行(含缩进)
  scope: 'method' | 'file-fallback';
  method?: string;     // scope='method' 时:刀所在的流程命中方法
}

/** 在流程命中的方法体内挑位点:按传入序(=步的 methods 频次序)逐个方法试,
 *  方法体切片交给既有 pickPreferredSite(Ruby 语句偏好),行号映射回全文件并做整行一致性守卫。
 *  全部失败 → null(调用方回退文件级 chooseMutation 并标注)。 */
export async function pickSiteInMethods(
  source: string,
  defLines: { method: string; line: number }[],
): Promise<ProbeSite | null> {
  const { parser } = await getParser(RUBY);
  const tree = parser.parse(source);
  const lines = source.split('\n');
  try {
    const methods = collectMethodNodes(tree.rootNode);
    for (const d of defLines) {
      const node =
        methods.find((n) => n.startPosition.row + 1 === d.line) ??
        methods.find((n) => n.startPosition.row + 1 <= d.line && n.endPosition.row + 1 >= d.line);
      if (!node) continue;
      const startRow = node.startPosition.row;
      const slice = lines.slice(startRow, node.endPosition.row + 1).join('\n');
      const site = await pickPreferredSite(slice, RUBY);
      if (!site) continue;
      const row = startRow + site.line - 1;
      if (lines[row] !== site.original) continue; // 整行一致性守卫(理论上恒真——切片是整行拼接)
      return { line: row + 1, original: site.original, scope: 'method', method: d.method };
    }
    return null;
  } finally {
    tree.delete();
  }
}

function collectMethodNodes(root: import('web-tree-sitter').Node): import('web-tree-sitter').Node[] {
  const out: import('web-tree-sitter').Node[] = [];
  const walk = (n: import('web-tree-sitter').Node): void => {
    if (n.type === 'method' || n.type === 'singleton_method') out.push(n);
    for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i)!);
  };
  walk(root);
  return out;
}
```

(若 `import('web-tree-sitter').Node` 与 pick-site.ts 的节点类型写法不一致,以 pick-site.ts 为准替换类型标注——硬约束 3 的唯一弹性点;逻辑一行不许变。)

- [ ] **Step 4: 跑测试确认通过 + typecheck + commit**

Run: `npx vitest run test/flow-probe-site.test.ts`(4/4)、`npm run typecheck`(干净)、字节扫描两文件 clean。

```bash
git add src/flow/probe-site.ts test/flow-probe-site.test.ts
git commit -m "feat: probe-site——流程命中方法体内挑突变位点,pick-site 切片复用"
```

---

### Task 2: probe——判定纯函数 + 报告渲染

**Files:**
- Create: `src/flow/probe.ts`
- Create: `test/flow-probe.test.ts`(4 条)

- [ ] **Step 1: 写失败测试**

Create `test/flow-probe.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { judgeProbe, renderProbeMd } from '../src/flow/probe.js';
import type { Flow } from '../src/types.js';

const flow: Flow = {
  id: 'flow-msg-L25', name: '发消息·单例',
  source: { kind: 'rspec-trace', spec: 'spec/m_spec.rb:25', tracedAt: '2026-07-16T00:00:00Z' },
  steps: [{ chunkId: 'app/models/m.rb', methods: ['save'], hits: 3, phase: 'request' }],
  rawTrace: [],
};
const target = flow.steps[0];
const site = { line: 7, original: '    save!', scope: 'method' as const, method: 'save' };

describe('judgeProbe(红绿×预测四象限,spec §5)', () => {
  it('example 失败 → red;加载崩(compiled=false)也 → red', () => {
    expect(judgeProbe({ compiled: true, results: [{ name: 's', passed: false }] }, 'red'))
      .toEqual({ actual: 'red', predicted: 'red', hit: true });
    expect(judgeProbe({ compiled: false, results: [] }, 'green'))
      .toEqual({ actual: 'red', predicted: 'green', hit: false });
  });

  it('全绿 → green;命中与未命中各一', () => {
    expect(judgeProbe({ compiled: true, results: [{ name: 's', passed: true }] }, 'green'))
      .toEqual({ actual: 'green', predicted: 'green', hit: true });
    expect(judgeProbe({ compiled: true, results: [{ name: 's', passed: true }] }, 'red'))
      .toEqual({ actual: 'green', predicted: 'red', hit: false });
  });
});

describe('renderProbeMd(报告,spec §6)', () => {
  it('命中:含流程名/步/刀落点方法/✅ 文案;非回退时无回退标注', () => {
    const md = renderProbeMd({ flow, step: 1, target, site, fallback: false,
      verdict: { actual: 'red', predicted: 'red', hit: true } });
    expect(md).toContain('发消息·单例');
    expect(md).toContain('第 1 步');
    expect(md).toContain('save');
    expect(md).toContain('✅ 预测命中');
    expect(md).not.toContain('回退');
  });

  it('回退+诚实绿:含回退标注;绿的两种解释只在非回退绿时出现', () => {
    const fb = { line: 2, original: '  x = 1', scope: 'file-fallback' as const };
    const md1 = renderProbeMd({ flow, step: 1, target, site: fb, fallback: true,
      verdict: { actual: 'green', predicted: 'red', hit: false } });
    expect(md1).toContain('刀落在流程未必经过的位置');
    expect(md1).toContain('❌ 预测未命中');
    const md2 = renderProbeMd({ flow, step: 1, target, site, fallback: false,
      verdict: { actual: 'green', predicted: 'green', hit: true } });
    expect(md2).toContain('防御性');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/flow-probe.test.ts` → 全 FAIL(模块不存在)。

- [ ] **Step 3: 实现 src/flow/probe.ts**

```ts
import type { Flow, FlowStep } from '../types.js';
import type { TestRun } from '../verify/runner.js';
import type { ProbeSite } from './probe-site.js';

export type ProbePrediction = 'red' | 'green';
export interface ProbeVerdict { actual: ProbePrediction; predicted: ProbePrediction; hit: boolean }

/** red = 该 example 失败或加载崩(compiled=false)——加载崩=正常爆炸半径(rspec 探针先例)。 */
export function judgeProbe(run: TestRun, predicted: ProbePrediction): ProbeVerdict {
  const actual: ProbePrediction = !run.compiled || run.results.some((r) => !r.passed) ? 'red' : 'green';
  return { actual, predicted, hit: actual === predicted };
}

export interface ProbeReportInput {
  flow: Flow; step: number; target: FlowStep; site: ProbeSite; fallback: boolean; verdict: ProbeVerdict;
}

export function renderProbeMd(a: ProbeReportInput): string {
  const lines: string[] = [
    '# 流程探针 · 判定',
    `流程:「${a.flow.name}」(${a.flow.source.spec})`,
    `目标:第 ${a.step} 步 \`${a.target.chunkId}\``,
    `刀落点:第 ${a.site.line} 行` + (a.site.scope === 'method' ? `(流程命中方法 \`${a.site.method}\` 体内)` : ''),
  ];
  if (a.fallback) {
    lines.push('⚠ 回退:方法体内无可注释语句,刀落在流程未必经过的位置——绿色结果不可作为理解凭据。');
  }
  lines.push(`- 你的预测:${a.verdict.predicted === 'red' ? '断(red)' : '不断(green)'}`);
  lines.push(`- 实际结果:${a.verdict.actual === 'red' ? '断了(red)' : '没断(green)'}`);
  if (a.verdict.actual === 'green' && !a.fallback) {
    lines.push('- 绿的两种解释:该行是防御性/旁路代码,或不在这条 example 的断言路径上——都值得回看。');
  }
  lines.push(a.verdict.hit
    ? '✅ 预测命中——你懂这一步在流程里的角色。'
    : '❌ 预测未命中——回去重读这一步:它在流程里干的事和你想的不一样。');
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck + commit**

Run: `npx vitest run test/flow-probe.test.ts`(4/4)、`npm run typecheck`、字节扫描 clean。

```bash
git add src/flow/probe.ts test/flow-probe.test.ts
git commit -m "feat: probe 判定与报告——红绿四象限,回退标注与诚实绿解释"
```

---

### Task 3: runFlowProbe 编排 + cli 接线

**Files:**
- Modify: `src/cli-flow.ts`(文件末尾追加 runFlowProbe 及其 import)
- Modify: `src/cli.ts`(flow 块整体替换为 trace|probe 双子命令)
- Modify: `test/cli-flow.test.ts`(追加一个 describe,5 条)

- [ ] **Step 1: 写失败测试**

`test/cli-flow.test.ts`:① 文件顶部既有的 `from '../src/cli-flow.js'` import 里加上 `runFlowProbe`;② node:fs import 列表补 `mkdirSync`(若缺);③ 文件末尾追加(新 describe,与既有 trace describe 并列):

```ts
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
```

(`mkdirSync` 需加进该文件顶部的 node:fs import 列表——若尚未引入。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/cli-flow.test.ts` → 新 describe 全 FAIL(runFlowProbe 不存在),既有 12 条 PASS。

- [ ] **Step 3: cli-flow.ts 追加 runFlowProbe**

import 区追加:

```ts
import { withMutation } from './verify/mutate.js';
import { parseRspecJson } from './verify/rspec-parse.js';
import { pickSiteInMethods, type ProbeSite } from './flow/probe-site.js';
import { judgeProbe, renderProbeMd, type ProbePrediction } from './flow/probe.js';
import type { MutationOp } from './types.js';
```

文件末尾追加:

```ts

export interface FlowProbeOpts {
  repo: string; outDir: string; flowId: string; step: number; predict: string;
  exec?: Exec;
}

/** 流程级突变探针:斩链上第 N 步(优先流程命中方法体内),真跑单 example,比对预测(spec:2026-07-16-flow-probe-design.md)。 */
export async function runFlowProbe(o: FlowProbeOpts): Promise<void> {
  if (o.predict !== 'red' && o.predict !== 'green') {
    throw new Error('--predict 只接受 red|green(断/不断)');
  }
  const predicted = o.predict as ProbePrediction;
  const flowsFile = loadFlows(o.outDir);
  const flow = flowsFile?.flows.find((f) => f.id === o.flowId);
  if (!flow) {
    const have = (flowsFile?.flows ?? []).map((f) => f.id).join(', ') || '(空)';
    throw new Error(`找不到流程「${o.flowId}」——现有:${have}`);
  }
  if (parseSpecRef(flow.source.spec).line === null) {
    throw new Error('该流程是全谱 trace(spec 无行号)——红绿会被其它 example 污染;先用 flow trace <spec>:<行号> 采单例流程');
  }
  if (!Number.isInteger(o.step) || o.step < 1 || o.step > flow.steps.length) {
    throw new Error(`--step 越界:${o.step}(该流程共 ${flow.steps.length} 步)`);
  }
  const target = flow.steps[o.step - 1];
  const config = loadRubyRunnerConfig(o.repo);
  const sb = sandboxFor(o.repo);
  console.error('⏳ 同步沙箱…');
  syncSandbox(o.repo, sb.srcDir);
  const absFile = join(sb.srcDir, target.chunkId);
  if (!existsSync(absFile)) throw new Error(`沙箱里没有 ${target.chunkId}`);
  const source = readFileSync(absFile, 'utf8');

  // 主路径:该步 methods(频次序)∩ rawTrace 定义行 → 方法体内落刀
  const defLines: { method: string; line: number }[] = [];
  for (const m of target.methods) {
    const hit = flow.rawTrace.find((c) => c.file === '/app/' + target.chunkId && c.method === m);
    if (hit) defLines.push({ method: m, line: hit.line });
  }
  let site: ProbeSite | null = await pickSiteInMethods(source, defLines);
  let fallback = false;
  if (!site) {
    // 回退:文件级既有 chooseMutation(报告显式标注)
    const { chooseMutation } = await import('./verify/mutate.js');
    const op = await chooseMutation(
      { id: target.chunkId, name: target.chunkId, file: target.chunkId, crate: '', leafIds: [] }, [], source);
    if (!op) throw new Error(`${target.chunkId} 找不到可注释的探针位点——换一步(与 verify 的 uncovered 先例一致)`);
    site = { line: op.line, original: op.original, scope: 'file-fallback' };
    fallback = true;
  }
  const indent = site.original.slice(0, site.original.length - site.original.trimStart().length);
  const op: MutationOp = {
    file: target.chunkId, line: site.line, original: site.original,
    mutated: indent + '# ' + site.original.trim(),
    description: `flow probe:斩「${flow.name}」第 ${o.step} 步`,
  };
  console.error(`⏳ 斩第 ${o.step} 步(${target.chunkId}:${site.line}${site.method ? ' · ' + site.method : ''})并重跑单 example…`);
  const [cmd, ...args] = expandCmd(config.cmd, [flow.source.spec]);
  const run = await withMutation(absFile, op, async () =>
    parseRspecJson(await (o.exec ?? realExec)(cmd, args, sb.srcDir)));
  const verdict = judgeProbe(run, predicted);
  writeFileSync(join(o.outDir, 'easyreview.flowprobe.md'),
    renderProbeMd({ flow, step: o.step, target, site, fallback, verdict }));
  console.log(verdict.hit
    ? '✓ 预测命中——报告已写入 easyreview.flowprobe.md'
    : '✗ 预测未命中——报告已写入 easyreview.flowprobe.md');
}
```

(注意:withMutation 的 finally 负责还原,探针自身无需清理;chooseMutation 用动态 import 以免顶层 import 未用告警——若 typecheck 无碍也可提升为顶层 import,二选一以 typecheck 干净为准。)

- [ ] **Step 4: cli.ts flow 块替换**

现有 `if (cmd === 'flow') { ... }` 整块替换为:

```ts
if (cmd === 'flow') {
  const rest = process.argv.slice(3);
  const sub = rest[0];
  const positional = rest.find((a, i) => i > 0 && !a.startsWith('--') && !(rest[i - 1] ?? '').startsWith('--'));
  if (sub === 'trace') {
    const ni = rest.indexOf('--name');
    const name = ni >= 0 && rest[ni + 1] ? rest[ni + 1] : null;
    if (!positional || !name) {
      console.error('用法: easyreview flow trace <specFile[:行号]> --name "<流程名>" [--repo <p>] [--out <d>]');
      process.exit(1);
    }
    const { repo, outDir } = parseArgs(rest);
    import('./cli-flow.js').then(({ runFlowTrace }) =>
      runFlowTrace({ repo, outDir, specFile: positional, name })
        .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); }),
    );
  } else if (sub === 'probe') {
    const si = rest.indexOf('--step');
    const step = si >= 0 && rest[si + 1] ? Number(rest[si + 1]) : NaN;
    const pi2 = rest.indexOf('--predict');
    const predict = pi2 >= 0 && rest[pi2 + 1] ? rest[pi2 + 1] : '';
    if (!positional || !predict || Number.isNaN(step)) {
      console.error('用法: easyreview flow probe <flowId> --step <N> --predict red|green [--repo <p>] [--out <d>]');
      process.exit(1);
    }
    const { repo, outDir } = parseArgs(rest);
    import('./cli-flow.js').then(({ runFlowProbe }) =>
      runFlowProbe({ repo, outDir, flowId: positional, step, predict })
        .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); }),
    );
  } else {
    console.error('用法: easyreview flow trace <specFile[:行号]> --name "<名>" | flow probe <flowId> --step <N> --predict red|green');
    process.exit(1);
  }
}
```

(行为保真:trace 分支与原逻辑等价——positional 查找规则相同,仅提取到公共变量。)

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/cli-flow.test.ts`(17 条)、`npx vitest run test/flow-probe-site.test.ts test/flow-probe.test.ts`。

- [ ] **Step 6: 全量回归 + typecheck + commit**

Run: `npm test` → **67 文件 351 测试**(338 + 4 + 4 + 5;新增 flow-probe-site/flow-probe 两个测试文件)全 PASS;`npm run typecheck` 干净;三改动文件字节扫描 clean。

```bash
git add src/cli-flow.ts src/cli.ts test/cli-flow.test.ts
git commit -m "feat: flow probe 子命令——斩链上一步真跑单 example,预测揭晓落报告"
```

---

## 真仓验收(主会话做)

1. 「发消息·单例」(flow-messages_controller-L25):`flow probe flow-messages_controller-L25 --step <message_builder 步号> --predict red` → 应真红、报告 ✅、刀落点标注方法名。
2. 挑一防御性/旁路步预测 green 或呈现诚实绿解释。
3. 全谱流程拒绝、探针后 flows.json 未变、沙箱字节还原、真实仓零接触。