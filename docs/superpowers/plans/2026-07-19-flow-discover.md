# 流程自动发现(flow discover)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 rspec `--dry-run` 权威枚举业务流程 spec 的每个 example,产出命名候选,viewer「流程」Tab 列出可追踪候选 + 可复制的 `flow trace` 命令,让新人不必先知道 spec 路径。

**Architecture:** 新增纯函数 `flowIdFor`(trace 与 discover 共用的路径 slug id)与 `parseDryRun`(dry-run JSON → 候选);`runFlowDiscover` 编排复用现有 ruby runner、cwd=repo 只读跑 dry-run、落盘 `easyreview.flow-candidates.json`(不碰 flows.json);serve 层加载候选、滤掉已追踪(同 id)、传给前端;page.ts「流程」Tab 新增候选段按 spec 文件折叠。

**Tech Stack:** Node 20 / TypeScript(ESM,`.js` 导入后缀)/ vitest / 既有 docker rspec runner。无构建步骤(tsx 直跑);`npm run typecheck` = `tsc --noEmit` 是类型真门。

**铁律与雷区(每个 subagent 必读):**
- `src/verify/mutate.ts`、`src/verify/pick-site.ts` 是雷区文件——本项**完全不碰**。
- 落盘任何含反斜杠转义序列的文本一律走 Write 工具、`String.fromCharCode` 构造,**绝不过 shell 内联**;每个改动文件跑字节扫描(见每任务末步)确认无 0x00-0x08 控制字节。
- `src/serve/page.ts` 内嵌 JS 是被 TS 字符串包起来的:**禁止反引号和 `${`**,只用 `'...'` 拼接、`var`、老式 for 循环。

---

### Task 1: `flowIdFor` 路径 slug id + trace 改用它

统一 id 方案:现有 `flow trace` 用 basename(`flow-<basename>-L<line>`),1525 条候选规模下跨目录会撞(多个 `base_controller_spec`)。改为路径 slug。`spec/msg_spec.rb`(顶层)仍得 `flow-msg`(现有 trace 测试不破),嵌套 spec 得全路径 slug。

**Files:**
- Create: `src/flow/flow-id.ts`
- Modify: `src/cli-flow.ts:69-70`(runFlowTrace 里的 id 拼接)
- Test: `test/flow-id.test.ts`

- [ ] **Step 1: 写失败测试**

`test/flow-id.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { flowIdFor } from '../src/flow/flow-id.js';

describe('flowIdFor(路径 slug + 可选行号)', () => {
  it('顶层 spec 保持 basename 结果(与旧 trace id 兼容)', () => {
    expect(flowIdFor('spec/msg_spec.rb', null)).toBe('flow-msg');
    expect(flowIdFor('spec/msg_spec.rb', 25)).toBe('flow-msg-L25');
  });

  it('嵌套 spec 用全路径 slug 防 basename 撞名', () => {
    expect(flowIdFor('spec/controllers/api/v1/accounts/conversations/messages_controller_spec.rb', 25))
      .toBe('flow-controllers-api-v1-accounts-conversations-messages_controller-L25');
  });

  it('无 spec/ 前缀也不炸;无行号无 -L 尾缀', () => {
    expect(flowIdFor('other/x_spec.rb', null)).toBe('flow-other-x');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/flow-id.test.ts`
Expected: FAIL —— `flowIdFor` 未定义 / 模块不存在。

- [ ] **Step 3: 实现 `flowIdFor`**

`src/flow/flow-id.ts`:

```ts
/** 流程 id:去 spec/ 前缀与 _spec.rb 后缀、/ → -,前缀 flow-,带行号则尾 -L<line>。
 *  trace 与 discover 共用此一处——候选与已追踪流程靠同 id 去重对号(spec:2026-07-19-flow-discover-design.md §5)。 */
export function flowIdFor(spec: string, line: number | null): string {
  const slug = spec
    .replace(/^spec\//, '')
    .replace(/_spec\.rb$/, '')
    .replace(/\//g, '-');
  return 'flow-' + slug + (line != null ? '-L' + line : '');
}
```

注意:`messages_controller_spec.rb` 去 `_spec.rb` 得 `messages_controller`(下划线保留),故嵌套断言里是 `...-messages_controller-L25`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/flow-id.test.ts`
Expected: PASS(3 个)。

- [ ] **Step 5: trace 改用 flowIdFor**

`src/cli-flow.ts` 顶部加导入(与既有 flow 导入同组):

```ts
import { flowIdFor } from './flow/flow-id.js';
```

把 `runFlowTrace` 里的 id 拼接(现为):

```ts
      id: 'flow-' + ref.file.split('/').pop()!.replace('_spec.rb', '') + (ref.line ? '-L' + ref.line : ''),
```

替换为:

```ts
      id: flowIdFor(ref.file, ref.line),
```

- [ ] **Step 6: 跑受影响测试 + 类型门确认无回归**

Run: `npx vitest run test/cli-flow.test.ts test/flow-id.test.ts && npm run typecheck`
Expected: PASS —— cli-flow.test.ts 里断言 `id === 'flow-msg'` / `flow-msg-L...` 仍绿(顶层 spec slug 不变);typecheck 0 error。

- [ ] **Step 7: 字节扫描 + 提交**

```bash
node -e "for (const f of ['src/flow/flow-id.ts','src/cli-flow.ts']){const b=require('fs').readFileSync(f);for(let i=0;i<b.length;i++)if(b[i]<=8){console.error('CTRL BYTE in '+f);process.exit(1)}}console.log('clean')"
git add src/flow/flow-id.ts src/cli-flow.ts test/flow-id.test.ts
git commit -m "feat: flowIdFor 路径 slug id,trace 改用(防 basename 撞名)"
```

---

### Task 2: 候选类型 + 落盘容错

`FlowCandidate` 类型进 types.ts(与 Flow 同处),读写函数镜像 `src/flow/flows.ts` 的容错口径(读不出/损坏 → null)。

**Files:**
- Modify: `src/types.ts:205`(FlowsFile 之后追加)
- Create: `src/flow/candidates.ts`
- Test: `test/flow-candidates.test.ts`

- [ ] **Step 1: 加类型**

`src/types.ts`,在 `export interface FlowsFile { version: 1; flows: Flow[] }` 之后追加:

```ts
/** 流程自动发现的候选(spec:2026-07-19-flow-discover-design.md)。独立落盘 easyreview.flow-candidates.json,不进 flows.json。 */
export interface FlowCandidate {
  id: string;    // flowIdFor(spec 文件, 行号)——与已追踪流程同 id 才能去重
  name: string;  // rspec full_description(describe+context+it 拼接)
  spec: string;  // "spec/xxx_spec.rb:行号",可直接喂 flow trace
}
export interface FlowCandidatesFile { version: 1; candidates: FlowCandidate[] }
```

- [ ] **Step 2: 写失败测试**

`test/flow-candidates.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCandidates, saveCandidates } from '../src/flow/candidates.js';

describe('候选落盘容错(镜像 flows.ts)', () => {
  it('save 后 load 往返一致', () => {
    const out = mkdtempSync(join(tmpdir(), 'er-cand-'));
    saveCandidates(out, { version: 1, candidates: [{ id: 'flow-a-L1', name: 'A', spec: 'spec/a_spec.rb:1' }] });
    expect(loadCandidates(out)!.candidates).toHaveLength(1);
    expect(loadCandidates(out)!.candidates[0].id).toBe('flow-a-L1');
  });

  it('文件不存在 → null(老产物,不渲染候选段)', () => {
    const out = mkdtempSync(join(tmpdir(), 'er-cand-'));
    expect(loadCandidates(out)).toBeNull();
  });

  it('损坏 JSON → null(不抛)', () => {
    const out = mkdtempSync(join(tmpdir(), 'er-cand-'));
    writeFileSync(join(out, 'easyreview.flow-candidates.json'), '{ not json');
    expect(loadCandidates(out)).toBeNull();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run test/flow-candidates.test.ts`
Expected: FAIL —— `src/flow/candidates.js` 不存在。

- [ ] **Step 4: 实现存储(parseDryRun 下个任务补)**

`src/flow/candidates.ts`:

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FlowCandidatesFile } from '../types.js';

const FILE = 'easyreview.flow-candidates.json';

/** 读不出/损坏 → null(视同没跑过 discover,serve 与 CLI 共用此容错口径,同 flows.ts)。 */
export function loadCandidates(outDir: string): FlowCandidatesFile | null {
  const p = join(outDir, FILE);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as FlowCandidatesFile;
    return Array.isArray(parsed.candidates) ? parsed : null;
  } catch {
    console.warn('⚠ easyreview.flow-candidates.json 解析失败,忽略(候选段将不显示)');
    return null;
  }
}

export function saveCandidates(outDir: string, file: FlowCandidatesFile): void {
  writeFileSync(join(outDir, FILE), JSON.stringify(file, null, 2));
}
```

- [ ] **Step 5: 跑测试确认通过 + 类型门**

Run: `npx vitest run test/flow-candidates.test.ts && npm run typecheck`
Expected: PASS(3 个);typecheck 0 error。

- [ ] **Step 6: 字节扫描 + 提交**

```bash
node -e "for (const f of ['src/types.ts','src/flow/candidates.ts']){const b=require('fs').readFileSync(f);for(let i=0;i<b.length;i++)if(b[i]<=8){console.error('CTRL BYTE in '+f);process.exit(1)}}console.log('clean')"
git add src/types.ts src/flow/candidates.ts test/flow-candidates.test.ts
git commit -m "feat: FlowCandidate 类型 + 候选落盘容错(镜像 flows.ts)"
```

---

### Task 3: `parseDryRun` —— dry-run JSON → 候选

rspec `--dry-run --format json` 吐单行 JSON,`examples[]` 每条含 `full_description`/`file_path`/`line_number`。沿用 `rspec-parse.ts` 的「从底向上找可解析的 `{` 行」容错(dry-run 输出同样可能被容器提示语粘污染)。

**Files:**
- Modify: `src/flow/candidates.ts`(追加 `parseDryRun`)
- Test: `test/flow-candidates.test.ts`(追加 describe)

- [ ] **Step 1: 写失败测试**

在 `test/flow-candidates.test.ts` 顶部导入补上 `parseDryRun`:

```ts
import { loadCandidates, saveCandidates, parseDryRun } from '../src/flow/candidates.js';
```

追加 describe:

```ts
describe('parseDryRun(dry-run JSON → 候选)', () => {
  const sample = JSON.stringify({
    examples: [
      { full_description: 'POST messages creates a new outgoing message',
        file_path: './spec/controllers/api/v1/messages_controller_spec.rb', line_number: 25 },
      { full_description: 'POST messages returns unauthorized',
        file_path: './spec/controllers/api/v1/messages_controller_spec.rb', line_number: 11 },
    ],
  });

  it('取 full_description 为名、归一 ./ 前缀、slug id、spec=文件:行号', () => {
    const cands = parseDryRun(sample);
    expect(cands).toHaveLength(2);
    expect(cands[0].name).toBe('POST messages creates a new outgoing message');
    expect(cands[0].spec).toBe('spec/controllers/api/v1/messages_controller_spec.rb:25');
    expect(cands[0].id).toBe('flow-controllers-api-v1-messages_controller-L25');
  });

  it('容忍容器提示语粘在 JSON 前后(取最后一个可解析的 { 行)', () => {
    const noisy = 'Creating network...\n' + sample + '\nRun options: ...';
    expect(parseDryRun(noisy)).toHaveLength(2);
  });

  it('无 examples / 无可解析 JSON → 空数组', () => {
    expect(parseDryRun('boot failed, nothing here')).toEqual([]);
    expect(parseDryRun(JSON.stringify({ examples: [] }))).toEqual([]);
  });

  it('缺 file_path 或 line_number 的 example 跳过', () => {
    const partial = JSON.stringify({ examples: [
      { full_description: 'no path', line_number: 3 },
      { full_description: 'ok', file_path: './spec/a_spec.rb', line_number: 7 },
    ] });
    const cands = parseDryRun(partial);
    expect(cands).toHaveLength(1);
    expect(cands[0].spec).toBe('spec/a_spec.rb:7');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/flow-candidates.test.ts`
Expected: FAIL —— `parseDryRun` 未导出。

- [ ] **Step 3: 实现 `parseDryRun`**

`src/flow/candidates.ts` 顶部加导入:

```ts
import { flowIdFor } from './flow-id.js';
import type { FlowCandidate } from '../types.js';
```

(把已有的 `import type { FlowCandidatesFile }` 合并为 `import type { FlowCandidate, FlowCandidatesFile } from '../types.js';`。)

文件末尾追加:

```ts
interface DryRunExample { full_description?: string; file_path?: string; line_number?: number }

/** rspec --dry-run --format json 的 examples[] → 候选。从底向上找可解析的 { 行,
 *  容忍容器/bundler 提示语粘污染(同 rspec-parse.ts 口径)。缺 file_path/line_number 的跳过。 */
export function parseDryRun(output: string): FlowCandidate[] {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t.startsWith('{')) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(t); } catch { continue; }
    const examples = (parsed as { examples?: DryRunExample[] }).examples;
    if (!Array.isArray(examples)) continue;
    const out: FlowCandidate[] = [];
    for (const ex of examples) {
      const raw = ex.file_path ?? '';
      const file = raw.startsWith('./') ? raw.slice(2) : raw;
      if (!file || ex.line_number == null) continue;
      const spec = file + ':' + ex.line_number;
      out.push({ id: flowIdFor(file, ex.line_number), name: ex.full_description ?? spec, spec });
    }
    return out;
  }
  return [];
}
```

- [ ] **Step 4: 跑测试确认通过 + 类型门**

Run: `npx vitest run test/flow-candidates.test.ts && npm run typecheck`
Expected: PASS(全部 7 个);typecheck 0 error。

- [ ] **Step 5: 字节扫描 + 提交**

```bash
node -e "const b=require('fs').readFileSync('src/flow/candidates.ts');for(let i=0;i<b.length;i++)if(b[i]<=8){console.error('CTRL BYTE');process.exit(1)}console.log('clean')"
git add src/flow/candidates.ts test/flow-candidates.test.ts
git commit -m "feat: parseDryRun 把 rspec dry-run JSON 折成命名候选"
```

---

### Task 4: `runFlowDiscover` 编排 + CLI 接线

复用 ruby runner 的 cmd,展开 `['--dry-run', <存在的 spec 目录>]`,cwd=repo(**不走沙箱**,只读),解析落盘。

**Files:**
- Modify: `src/cli-flow.ts`(末尾追加 `runFlowDiscover` + 导入)
- Modify: `src/cli.ts:149-166`(flow 分发加 `discover` 分支)
- Test: `test/cli-flow.test.ts`(追加 describe)

- [ ] **Step 1: 写失败测试**

`test/cli-flow.test.ts` 顶部导入补 `runFlowDiscover`:

```ts
import { runFlowTrace, runFlowProbe, runFlowDiscover } from '../src/cli-flow.js';
```

追加 describe(注意:`makeRepo` 只建了 `spec/`,本组自建 spec 子目录):

```ts
describe('runFlowDiscover(dry-run 枚举 → 候选落盘)', () => {
  const dryRunOut = (specDir: string) => JSON.stringify({ examples: [
    { full_description: 'creates a message', file_path: './' + specDir + '/messages_controller_spec.rb', line_number: 25 },
  ] });

  it('成功:候选文件落盘,cwd=repo(不建沙箱)', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'spec', 'controllers'), { recursive: true });
    const out = mkdtempSync(join(tmpdir(), 'er-out-'));
    let seenCwd = '';
    const exec: Exec = async (_c, args, cwd) => {
      seenCwd = cwd;
      expect(args).toContain('--dry-run');
      expect(args).toContain('spec/controllers');
      return dryRunOut('spec/controllers');
    };
    await runFlowDiscover({ repo, outDir: out, specDirs: ['spec/controllers'], exec });
    expect(seenCwd).toBe(repo); // 不是沙箱
    const file = JSON.parse(readFileSync(join(out, 'easyreview.flow-candidates.json'), 'utf8'));
    expect(file.candidates).toHaveLength(1);
    expect(file.candidates[0].id).toBe('flow-controllers-messages_controller-L25');
  });

  it('指定目录都不存在 → 友好拒绝', async () => {
    const repo = makeRepo();
    await expect(runFlowDiscover({ repo, outDir: repo, specDirs: ['spec/nope'], exec: async () => '' }))
      .rejects.toThrow('没有可发现的 spec 目录');
  });

  it('dry-run 零 example → 落空候选文件(不抛)', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'spec', 'requests'), { recursive: true });
    const out = mkdtempSync(join(tmpdir(), 'er-out-'));
    await runFlowDiscover({ repo, outDir: out, specDirs: ['spec/requests'],
      exec: async () => JSON.stringify({ examples: [] }) });
    const file = JSON.parse(readFileSync(join(out, 'easyreview.flow-candidates.json'), 'utf8'));
    expect(file.candidates).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/cli-flow.test.ts`
Expected: FAIL —— `runFlowDiscover` 未导出。

- [ ] **Step 3: 实现 `runFlowDiscover`**

`src/cli-flow.ts` 顶部导入区补上(与既有 candidates/flow-id 无关的导入并列):

```ts
import { parseDryRun, saveCandidates } from './flow/candidates.js';
```

文件末尾追加:

```ts
export interface FlowDiscoverOpts {
  repo: string; outDir: string; specDirs?: string[]; exec?: Exec;
}

const DEFAULT_SPEC_DIRS = ['spec/requests', 'spec/system', 'spec/controllers'];

/** 流程自动发现:dry-run 业务流程 spec、枚举 example、落盘候选(spec:2026-07-19-flow-discover-design.md)。
 *  不走沙箱——dry-run 纯只读、往仓里写零文件,cwd=repo 直跑(runner 本就 docker 隔离)。不碰 flows.json。 */
export async function runFlowDiscover(o: FlowDiscoverOpts): Promise<void> {
  const config = loadRubyRunnerConfig(o.repo);
  const dirs = (o.specDirs ?? DEFAULT_SPEC_DIRS).filter((d) => existsSync(join(o.repo, d)));
  if (!dirs.length) {
    throw new Error('没有可发现的 spec 目录(默认找 spec/requests,spec/system,spec/controllers)——用 --specs 指定,或确认仓库结构');
  }
  console.error('⏳ dry-run 枚举 ' + dirs.join(', ') + '(docker 冷启动可能较慢)…');
  const [cmd, ...args] = expandCmd(config.cmd, ['--dry-run', ...dirs]);
  const out = await (o.exec ?? realExec)(cmd, args, o.repo);
  const candidates = parseDryRun(out);
  if (!candidates.length) {
    console.warn('⚠ dry-run 没枚举到任何 example——确认 spec 目录非空、runner 能加载 rails_helper(配方:docs/recipes/chatwoot-rspec.md)');
  }
  saveCandidates(o.outDir, { version: 1, candidates });
  console.log('✓ 发现 ' + candidates.length + ' 条可追踪流程 → easyreview.flow-candidates.json');
}
```

- [ ] **Step 4: CLI 接线**

`src/cli.ts` 的 `if (cmd === 'flow')` 块,把 `else if (sub === 'probe')` 分支之后、`else {` 之前插入 discover 分支:

```ts
  } else if (sub === 'discover') {
    const si2 = rest.indexOf('--specs');
    const specDirs = si2 >= 0 && rest[si2 + 1]
      ? rest[si2 + 1].split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const { repo, outDir } = parseArgs(rest);
    import('./cli-flow.js').then(({ runFlowDiscover }) =>
      runFlowDiscover({ repo, outDir, specDirs })
        .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); }),
    );
  } else {
```

并把最后的 else 用法串更新为:

```ts
    console.error('用法: easyreview flow trace <specFile[:行号]> --name "<名>" | flow probe <flowId> --step <N> --predict red|green | flow discover [--specs dir,dir] [--repo <p>] [--out <d>]');
```

- [ ] **Step 5: 跑测试 + 类型门**

Run: `npx vitest run test/cli-flow.test.ts && npm run typecheck`
Expected: PASS(原有 + 新增 3 个);typecheck 0 error。

- [ ] **Step 6: 字节扫描 + 提交**

```bash
node -e "for (const f of ['src/cli-flow.ts','src/cli.ts']){const b=require('fs').readFileSync(f);for(let i=0;i<b.length;i++)if(b[i]<=8){console.error('CTRL BYTE in '+f);process.exit(1)}}console.log('clean')"
git add src/cli-flow.ts src/cli.ts test/cli-flow.test.ts
git commit -m "feat: flow discover 命令 —— dry-run 枚举业务流程候选落盘"
```

---

### Task 5: serve 层 —— 候选进 state,滤掉已追踪

`buildViewerState` 收候选文件,滤掉 id 已在 flows.json 的,加 `candidates` + `hasCandidates`。server.ts 加载候选传入。

**Files:**
- Modify: `src/serve/state.ts:1`(导入)、`:17-28`(ViewerState)、`:33`(签名)、`:68-84`(返回)
- Modify: `src/serve/server.ts:9`(导入)、`:75`(调用)
- Test: `test/viewer-state.test.ts`(追加 describe)

- [ ] **Step 1: 写失败测试**

`test/viewer-state.test.ts` 追加(复用顶部已有的 `makeViewerTree`/`makeViewerLabels` 与常量;`FlowsFile`/`FlowCandidatesFile` 现造):

```ts
describe('buildViewerState 候选(flow discover)', () => {
  const P = { version: 1 as const, understood: [] };
  const candFile = { version: 1 as const, candidates: [
    { id: 'flow-a-L1', name: 'A 流程', spec: 'spec/a_spec.rb:1' },
    { id: 'flow-b-L2', name: 'B 流程', spec: 'spec/b_spec.rb:2' },
  ] };

  it('无候选文件 → hasCandidates=false、candidates 空', () => {
    const s = buildViewerState(makeViewerTree(), makeViewerLabels(), P, null, null);
    expect(s.hasCandidates).toBe(false);
    expect(s.candidates).toEqual([]);
  });

  it('有候选文件 → hasCandidates=true、候选透出', () => {
    const s = buildViewerState(makeViewerTree(), makeViewerLabels(), P, null, candFile);
    expect(s.hasCandidates).toBe(true);
    expect(s.candidates.map((c) => c.id)).toEqual(['flow-a-L1', 'flow-b-L2']);
  });

  it('已追踪(同 id)的候选被滤掉', () => {
    const flowsFile = { version: 1 as const, flows: [
      { id: 'flow-a-L1', name: 'A', source: { kind: 'rspec-trace' as const, spec: 'spec/a_spec.rb:1', tracedAt: 't' }, steps: [], rawTrace: [] },
    ] };
    const s = buildViewerState(makeViewerTree(), makeViewerLabels(), P, flowsFile, candFile);
    expect(s.candidates.map((c) => c.id)).toEqual(['flow-b-L2']); // a 已追踪,只剩 b
    expect(s.hasCandidates).toBe(true); // 跑过 discover 就是 true(即使全被滤空也保持)
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/viewer-state.test.ts`
Expected: FAIL —— `buildViewerState` 第 5 参数不接受 / `hasCandidates` 不存在。

- [ ] **Step 3: 改 state.ts**

导入行(`:1`)追加类型:

```ts
import type { GradedTree, LabelCache, Progress, NodeId, RiskBucket, ContribBucket, FlowsFile, FlowStep, FlowCandidatesFile } from '../types.js';
```

`ViewerState` 里 `hasFlows` 之后追加两字段:

```ts
  candidates: { id: string; name: string; spec: string }[]; // 未追踪的可追踪候选(已追踪的滤掉)
  hasCandidates: boolean; // 跑过 flow discover(候选文件存在)才渲染候选段;区别于"跑了但零候选"
```

函数签名(`:33`)加第 5 参:

```ts
export function buildViewerState(g: GradedTree, labels: LabelCache, progress: Progress, flowsFile?: FlowsFile | null, candidatesFile?: FlowCandidatesFile | null): ViewerState {
```

`const flowList = flowsFile?.flows ?? [];`(`:68`)之后追加:

```ts
  const tracedIds = new Set(flowList.map((f) => f.id));
  const candidates = (candidatesFile?.candidates ?? []).filter((c) => !tracedIds.has(c.id));
```

return 对象里 `hasFlows: flowList.length > 0,` 之后追加:

```ts
    candidates: candidates.map((c) => ({ id: c.id, name: c.name, spec: c.spec })),
    hasCandidates: candidatesFile != null,
```

- [ ] **Step 4: 改 server.ts**

导入(`:9`)后加:

```ts
import { loadCandidates } from '../flow/candidates.js';
```

`/api/state` 的 buildViewerState 调用(`:75`)改为:

```ts
    sendJson(res, 200, buildViewerState(tree, labels, progress, loadFlows(outDir), loadCandidates(outDir)));
```

- [ ] **Step 5: 跑测试 + 类型门**

Run: `npx vitest run test/viewer-state.test.ts && npm run typecheck`
Expected: PASS(原有 + 新增 3 个);typecheck 0 error。

- [ ] **Step 6: 字节扫描 + 提交**

```bash
node -e "for (const f of ['src/serve/state.ts','src/serve/server.ts']){const b=require('fs').readFileSync(f);for(let i=0;i<b.length;i++)if(b[i]<=8){console.error('CTRL BYTE in '+f);process.exit(1)}}console.log('clean')"
git add src/serve/state.ts src/serve/server.ts test/viewer-state.test.ts
git commit -m "feat: serve 层候选进 state,滤掉已追踪(同 id)"
```

---

### Task 6: page.ts —— 候选段渲染 + 分组折叠 + Tab 可达

「流程」Tab 在已追踪流程下方加「可追踪的流程」段,按 spec 文件折叠;`hasFlows=false && hasCandidates=true` 时 Tab 仍出现。

**⚠ 内嵌 JS 铁律:禁止反引号和 `${`,只用 `'...'` 拼接、`var`、老式 for。**

**Files:**
- Modify: `src/serve/page.ts:62`(CSS)、`:168`(candCollapsed 声明)、`:235`+`:239`(Tab 可达)、`:396`(renderFlows 尾部插候选段)、`:413`(候选折叠 handler)
- Test: `test/serve-page.test.ts`(追加断言 —— 与该文件既有风格一致,断字符串出现)

- [ ] **Step 1: 写失败测试**

先看 `test/serve-page.test.ts` 现有断言风格(多为 `expect(html).toContain(...)`)。追加:

```ts
describe('候选段(flow discover)静态渲染契约', () => {
  it('页面含候选段渲染分支与命令文案骨架', () => {
    const html = renderPage();
    expect(html).toContain('可追踪的流程');            // 段标题
    expect(html).toContain('state.hasCandidates');     // 渲染门
    expect(html).toContain('flow trace ');             // 可复制命令前缀
    expect(html).toContain('cand-group-head');         // 分组折叠头
  });

  it('Tab 可达同时看 hasFlows 与 hasCandidates(有候选无流程也出 Tab)', () => {
    const html = renderPage();
    expect(html).toContain('!state.hasFlows && !state.hasCandidates');
  });
});
```

(若 `renderPage` 未在该测试文件导入,顶部加 `import { renderPage } from '../src/serve/page.js';`。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/serve-page.test.ts`
Expected: FAIL —— 这些字符串还不在页面里。

- [ ] **Step 3: 加 CSS(`:62` 附近,`#flows` 规则旁)**

在 `#flows { max-width: 720px; }` 之后追加(单行,和周边风格一致):

```
    .cand-group-head { cursor: pointer; padding: 4px 0; opacity: 0.7; user-select: none; }
    .cand-item { margin: 4px 0 8px 12px; }
    .cand-name { font-size: 13px; }
    .cand-cmd { display: block; margin-top: 2px; font-size: 12px; opacity: 0.85; word-break: break-all; }
```

(用 `opacity` 而非颜色变量,避免依赖页面里不一定存在的 CSS 变量。)

- [ ] **Step 4: candCollapsed 声明(`:168`,flowSetupCollapsed 旁)**

在 `var flowSetupCollapsed = ...` 之后追加:

```js
var candCollapsed = {};
try { candCollapsed = JSON.parse(localStorage.getItem('easyreview-cand-collapsed') || '{}') || {}; } catch (e) { candCollapsed = {}; }
```

- [ ] **Step 5: Tab 可达(`:235` 与 `:239`)**

`:235` 的回退条件:

```js
  if (view === 'flows' && !state.hasFlows) { view = 'grid'; localStorage.setItem('easyreview-view', view); }
```

改为:

```js
  if (view === 'flows' && !state.hasFlows && !state.hasCandidates) { view = 'grid'; localStorage.setItem('easyreview-view', view); }
```

`:239` 的 hidden:

```js
  $('tab-flows').hidden = !state.hasFlows;
```

改为:

```js
  $('tab-flows').hidden = !state.hasFlows && !state.hasCandidates;
```

- [ ] **Step 6: renderFlows 尾部插候选段(`:396` 的 `}` 之后、`$('flows').innerHTML = html;` 之前)**

在已追踪流程 for 循环闭合(`:395-396` 的 `html += '</div>'; }`)之后、`$('flows').innerHTML = html;`(`:397`)之前插入:

```js
  // ── 可追踪的流程候选(easyreview.flow-candidates.json;hasCandidates=false 不渲染) ──
  if (state.hasCandidates) {
    html += '<div class="flow-card"><h3>可追踪的流程(' + state.candidates.length + ' 条)</h3>';
    if (!state.candidates.length) {
      html += '<div class="muted">(没有未追踪的候选——要么还没跑 flow discover,要么发现到的都已追踪)</div>';
    } else {
      html += '<div class="muted">复制命令到终端一跑即得该流程(trace 较慢,懒加载):</div>';
      var groups = {}; var order = [];
      for (var ci = 0; ci < state.candidates.length; ci++) {
        var cand = state.candidates[ci];
        var gfile = cand.spec.split(':')[0];
        if (!groups[gfile]) { groups[gfile] = []; order.push(gfile); }
        groups[gfile].push(cand);
      }
      for (var gi = 0; gi < order.length; gi++) {
        var gf = order[gi];
        var collapsed = candCollapsed[gf] !== false; // 默认折叠(undefined → 折叠)
        html += '<div class="cand-group-head" data-file="' + esc(gf) + '">' +
          (collapsed ? '▸ ' : '▾ ') + esc(gf.split('/').pop()) + ' (' + groups[gf].length + ')</div>';
        if (!collapsed) {
          for (var xi = 0; xi < groups[gf].length; xi++) {
            var cc = groups[gf][xi];
            var ctext = 'flow trace ' + cc.spec + ' --name "' + cc.name + '"';
            html += '<div class="cand-item"><div class="cand-name">' + esc(cc.name) + '</div>' +
              '<code class="cand-cmd">' + esc(ctext) + '</code></div>';
          }
        }
      }
    }
    html += '</div>';
  }
```

- [ ] **Step 7: 候选折叠 handler(`:413` 的 flow-jump handler 之后、renderFlows 闭合 `}` 之前)**

在 flow-jump 的 for 循环(`:406-413`)之后插入:

```js
  var chs = $('flows').querySelectorAll('.cand-group-head');
  for (var g2 = 0; g2 < chs.length; g2++) {
    chs[g2].addEventListener('click', function (ev) {
      var f = ev.currentTarget.getAttribute('data-file');
      candCollapsed[f] = candCollapsed[f] === false ? true : false;
      localStorage.setItem('easyreview-cand-collapsed', JSON.stringify(candCollapsed));
      renderFlows();
    });
  }
```

- [ ] **Step 8: 跑测试 + 类型门 + 全量**

Run: `npx vitest run test/serve-page.test.ts && npm run typecheck && npm test`
Expected: 全 PASS;typecheck 0 error;总测试数较基线(356)+约 16。

- [ ] **Step 9: 字节扫描 + 提交**

```bash
node -e "const b=require('fs').readFileSync('src/serve/page.ts');for(let i=0;i<b.length;i++)if(b[i]<=8){console.error('CTRL BYTE at '+i);process.exit(1)}console.log('clean')"
git add src/serve/page.ts test/serve-page.test.ts
git commit -m "feat: 流程 Tab 候选段 —— 按 spec 文件折叠 + 可复制 trace 命令"
```

---

### Task 7: 真仓验收(chatwoot)

**手动验收,非自动测试。** 前置:chatwoot docker 环境(compose 项目 `chatwoot-easyreview`)可用;仓根有 `easyreview.runner.json` 与 rspec 配方;out 目录 `E:/dev/easyReview/out/chatwoot` 已有 tree/labels。

- [ ] **Step 1: 跑 discover**

```bash
cd E:/dev/easyReview
npx tsx src/cli.ts flow discover --repo E:/learning/agent-research/repos/chatwoot --out E:/dev/easyReview/out/chatwoot
```

Expected:打印「发现 N 条可追踪流程」(N 约 1500+,以 controllers 为主);`out/chatwoot/easyreview.flow-candidates.json` 生成。

- [ ] **Step 2: 物证核对**

在候选文件里确认 `messages_controller_spec.rb` 的「creates a new outgoing message」在列,其 `spec` 为 `spec/controllers/api/v1/accounts/conversations/messages_controller_spec.rb:25`(与打样期 trace 用的 spec:line 一致),`id` = `flow-controllers-api-v1-accounts-conversations-messages_controller-L25`。

- [ ] **Step 3: 真实仓零接触**

```bash
cd E:/learning/agent-research/repos/chatwoot && git status --short
```

Expected:干净(discover 只读、cwd=repo、dry-run 不写跟踪文件)。

- [ ] **Step 4: viewer 走查**

```bash
cd E:/dev/easyReview
npx tsx src/cli.ts serve --out E:/dev/easyReview/out/chatwoot --port 4872
```

浏览器 `http://localhost:4872`:「流程」Tab 出现(即使没 trace 过任何流程也在,因 hasCandidates);候选段「可追踪的流程(N 条)」按 spec 文件折叠、展开见 examples 名 + 可复制命令。复制 messages 那条命令跑一次 `flow trace`,重启 serve(或 F5)后该流程进「已追踪」段、并从候选段消失(去重生效)。

> 端口 4872 若被占:`Get-NetTCPConnection -LocalPort 4872 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`。浏览器可视走查按惯例交用户自点;HTTP 层可用 `curl -s localhost:4872/api/state` 抽验 candidates 字段。

- [ ] **Step 5: 老产物回归**

临时把候选文件挪走验证降级:

```bash
mv E:/dev/easyReview/out/chatwoot/easyreview.flow-candidates.json /tmp/cand-bak.json
curl -s localhost:4872/api/state | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d);console.log('hasCandidates=',s.hasCandidates,'candidates=',s.candidates.length)})"
mv /tmp/cand-bak.json E:/dev/easyReview/out/chatwoot/easyreview.flow-candidates.json
```

Expected:`hasCandidates= false candidates= 0`(候选段不渲染,与 hasFlows 一个路数)。

---

## 收尾(全部任务后)

- [ ] `npm test` 全绿 + `npm run typecheck` 0 error;总测试数记入 HANDOFF(约 356 + 16 = 372,以实跑为准)。
- [ ] `requesting-code-review`:两阶段(spec 合规 → 代码质量)+ 终审。
- [ ] HANDOFF.md 加 item 18(flow discover)、更新文件/测试计数;design-pivot-state.md 加 FD 条目;MEMORY.md 索引行更新。
- [ ] `finishing-a-development-branch`:PR(分支 `feat/flow-discover`,spec+plan+实现同 PR)。
