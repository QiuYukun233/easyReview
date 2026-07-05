# easyReview 计划③ — 突变探针执行验证 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 easyReview 加护城河——用"突变探针"做可执行的、可证伪的理解验证：对某块施一个小突变，跑 `cargo test` 看真实"爆炸半径"（哪些测试新失败），让学习者**先预测再揭晓**，二元/分级判定，并把通过的块标记 `verified`。v1 只做 `chem_field`（纯 ECS 逻辑 + headless 测试，编译可控）。

**Architecture:** 引擎 Node/TS 复用 Plan ① 的 `easyreview.tree.json` 与 chunk 概念。机制 = 「基线 `cargo test -p chem_field`（缓存绿集）」→「对目标块施突变（注释一行）」→「重跑」→「新失败集 = 爆炸半径 ground truth」→「与学习者预测比对判定」→「还原突变」。**cargo 编译慢，所以核心铁律：跑 cargo/解析输出全部抽到可注入接口后，单测用 fake 喂罐装 cargo 输出（零真实编译）；真实 cargo 只在 observe 冒烟步跑。** 突变的应用/还原保证还原（finally + 校验），绝不损坏 umwelt-bevy。

**Tech Stack:** Node 20+, TypeScript(ESM), vitest。承接 Plan ① `src/types.ts`/`GradedTree`。目标仓库 `D:\dev\umwelt-bevy`，crate `chem_field`（依赖全 bevy，`cargo` 1.95）。

**前置：** Plan ①②已并入 main。本计划在新分支 `impl/mutation-probe` 上做。**已确认外部事实（本机实跑，2026-07-06）**：`cargo test -p chem_field` 编译+运行成功，**21 个测试全绿**——20 个 `core::{channel,contributor,field,phase,scene}::tests::*` 纯逻辑单测 + 1 个 `plugin_steps_scene_each_update`（headless Bevy App，断言 `scene.sample(ChemA,ZERO)∈(0.2,0.5)`）；**热编译 ~35 秒**（每个探针一次重编译，可接受）；输出正是 `test <name> ... ok` 格式（Task 2 解析器直接吃）。示例：注释掉 `field.rs` 里推进场演化的一行 → `field_step_advances_all_contributors` 与/或 `plugin_steps_scene_each_update` 变红 = 真实爆炸半径。

---

## 文件结构

```
easyReview/
  src/
    types.ts               # T1 追加 TestResult/CargoTestRun/MutationOp/BlastRadius/Verdict；Progress 加 verified
    verify/
      parse.ts             # T2 解析 cargo test 输出
      cargo.ts             # T3 runCargoTests（真实 execFile，测试注入 fake exec）
      mutate.ts            # T4 withMutation（保证还原）+ T5 chooseMutation
      probe.ts             # T6 爆炸半径探针（基线→突变→diff）
      judge.ts             # T7 判定预测 vs 真实
    cli-verify.ts          # T8 runVerifyShow / runVerifyPredict
    cli.ts                 # T8 wire `verify` 命令
  test/*.test.ts
```

工作流：`easyreview verify <chunkId>`（跑基线、缓存绿集、显示测试名+突变位点+"预测哪些会崩"）→ `easyreview verify <chunkId> --predict a,b`（施突变重跑、比对、判定、通过则标 verified）。

---

### Task 1: 真实 cargo 冒烟（观察）+ 验证类型

**Files:** Modify: `src/types.ts`; Test: `test/verify-types.test.ts`

- [ ] **Step 1: 真实观察——确认 cargo 可跑（非单测）**

Run: `cd /d/dev/umwelt-bevy && cargo test -p chem_field 2>&1 | tail -30`
预期：编译成功，跑出若干 `test <name> ... ok` 行 + `test result: ok. N passed`。记录：测试名列表、大致耗时（冷/热）。若失败（缺 feature/需 headless），记录所需 flag——后续 `runCargoTests` 要带上。**若完全跑不起来，STOP 上报**（整个机制依赖它）。

- [ ] **Step 2: 写会失败的测试 test/verify-types.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import type { TestResult, CargoTestRun, MutationOp, BlastRadius, Verdict } from '../src/types.js';

describe('verify types', () => {
  it('shapes are usable', () => {
    const tr: TestResult = { name: 'core::field::tests::x', passed: true };
    const run: CargoTestRun = { compiled: true, results: [tr] };
    const op: MutationOp = { file: 'a.rs', line: 5, original: '  x += 1;', mutated: '  // x += 1;', description: '注释一行' };
    const blast: BlastRadius = { chunkId: 'a.rs', mutation: op, newlyFailing: ['t1'], compileBroke: false, note: '' };
    const v: Verdict = { chunkId: 'a.rs', predicted: ['t1'], actual: ['t1'], hits: ['t1'], misses: [], falseAlarms: [], passed: true };
    expect(run.results[0].passed).toBe(true);
    expect(v.passed).toBe(true);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npm test -- verify-types`  Expected: FAIL。

- [ ] **Step 4: 在 src/types.ts 末尾追加**

```ts
export interface TestResult { name: string; passed: boolean; }
export interface CargoTestRun { compiled: boolean; results: TestResult[]; }

export interface MutationOp {
  file: string;       // 相对 repo 根
  line: number;       // 1-based
  original: string;   // 原行（含缩进）
  mutated: string;    // 替换行
  description: string;
}

export interface BlastRadius {
  chunkId: NodeId;
  mutation: MutationOp;
  newlyFailing: string[]; // 突变后由绿转红的测试名
  compileBroke: boolean;  // 突变导致编译失败（load-bearing）
  note: string;
}

export interface Verdict {
  chunkId: NodeId;
  predicted: string[];
  actual: string[];       // = blast.newlyFailing（或 compileBroke 时的 ['<compile-error>']）
  hits: string[];
  misses: string[];       // 真实崩了但没预测到
  falseAlarms: string[];  // 预测崩了但没崩
  passed: boolean;
}
```

同时把 `Progress` 接口（Plan ②，已在 types.ts）加一个可选 `verified`：找到
```ts
export interface Progress {
  version: 1;
  understood: NodeId[];
}
```
改为
```ts
export interface Progress {
  version: 1;
  understood: NodeId[];
  verified?: NodeId[];   // 通过突变探针验证的块（Plan ③）
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test -- verify-types`  Expected: PASS。全量 `npm test` 仍应通过（Progress 加可选字段不破坏 Plan ② 测试）。

- [ ] **Step 6: Commit**

```bash
git add src/types.ts test/verify-types.test.ts
git commit -m "feat(types): mutation-probe verification types + Progress.verified"
```

---

### Task 2: 解析 cargo test 输出

**Files:** Create: `src/verify/parse.ts`, `test/parse.test.ts`

说明：解析 `cargo test` 人类输出。每行形如 `test <name> ... ok` 或 `test <name> ... FAILED`。若输出含编译错误（`error[E` 或 `error: could not compile`）且无 test 行 → `compiled:false`。

- [ ] **Step 1: 写会失败的测试 test/parse.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { parseCargoTest } from '../src/verify/parse.js';

const OK = `
   Compiling chem_field v0.1.0
    Finished test [unoptimized] target(s)
     Running unittests src/lib.rs

running 3 tests
test core::channel::tests::mix ... ok
test core::field::tests::sample_zero ... FAILED
test core::phase::tests::evolve ... ok

failures:
    core::field::tests::sample_zero

test result: FAILED. 2 passed; 1 failed; 0 ignored
`;

const BROKE = `
   Compiling chem_field v0.1.0
error[E0425]: cannot find value \`x\` in this scope
 --> crates/chem_field/src/core/field.rs:20:5
error: could not compile \`chem_field\` due to previous error
`;

describe('parseCargoTest', () => {
  it('parses per-test ok/FAILED into results', () => {
    const run = parseCargoTest(OK);
    expect(run.compiled).toBe(true);
    expect(run.results).toEqual([
      { name: 'core::channel::tests::mix', passed: true },
      { name: 'core::field::tests::sample_zero', passed: false },
      { name: 'core::phase::tests::evolve', passed: true },
    ]);
  });

  it('flags compile break with no test lines', () => {
    const run = parseCargoTest(BROKE);
    expect(run.compiled).toBe(false);
    expect(run.results).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- parse`  Expected: FAIL。

- [ ] **Step 3: 实现 src/verify/parse.ts**

```ts
import type { CargoTestRun, TestResult } from '../types.js';

const LINE = /^test\s+(\S+)\s+\.\.\.\s+(ok|FAILED)$/;

export function parseCargoTest(stdout: string): CargoTestRun {
  const results: TestResult[] = [];
  for (const raw of stdout.split('\n')) {
    const m = raw.trim().match(LINE);
    if (m) results.push({ name: m[1], passed: m[2] === 'ok' });
  }
  const compileError = /error\[E\d+\]|error: could not compile/.test(stdout);
  const compiled = results.length > 0 || !compileError;
  return { compiled, results };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- parse`  Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/verify/parse.ts test/parse.test.ts
git commit -m "feat(verify): parse cargo test output (results + compile-break)"
```

---

### Task 3: runCargoTests（可注入 exec）

**Files:** Create: `src/verify/cargo.ts`, `test/cargo.test.ts`

说明：`runCargoTests(repo, crate, exec?)` 默认用 `execFile('cargo', ['test','-p',crate,'--','--test-threads=1'])`，把 stdout+stderr 合并交给 `parseCargoTest`。`exec` 可注入，测试传 fake 返回罐装输出（**零真实编译**）。`cargo test` 失败退出码不抛（我们靠解析），故 exec 要捕获输出而非 throw。

- [ ] **Step 1: 写会失败的测试 test/cargo.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { runCargoTests } from '../src/verify/cargo.js';

describe('runCargoTests', () => {
  it('uses injected exec and parses its output', async () => {
    const fakeExec = async (_cmd: string, _args: string[], _cwd: string) =>
      'running 2 tests\ntest a::t1 ... ok\ntest a::t2 ... FAILED\n\ntest result: FAILED. 1 passed; 1 failed';
    const run = await runCargoTests('/repo', 'chem_field', fakeExec);
    expect(run.compiled).toBe(true);
    expect(run.results).toEqual([
      { name: 'a::t1', passed: true },
      { name: 'a::t2', passed: false },
    ]);
  });

  it('treats compile-error output as not compiled', async () => {
    const fakeExec = async () => 'error[E0425]: cannot find value\nerror: could not compile `chem_field`';
    const run = await runCargoTests('/repo', 'chem_field', fakeExec);
    expect(run.compiled).toBe(false);
    expect(run.results).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- cargo`  Expected: FAIL。

- [ ] **Step 3: 实现 src/verify/cargo.ts**

```ts
import { execFile } from 'node:child_process';
import type { CargoTestRun } from '../types.js';
import { parseCargoTest } from './parse.js';

/** (cmd, args, cwd) → 合并的 stdout+stderr。不因非零退出码抛出。 */
export type Exec = (cmd: string, args: string[], cwd: string) => Promise<string>;

const realExec: Exec = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (_err, stdout, stderr) => {
      resolve(`${stdout ?? ''}\n${stderr ?? ''}`);
    });
  });

export async function runCargoTests(repo: string, crate: string, exec: Exec = realExec): Promise<CargoTestRun> {
  const out = await exec('cargo', ['test', '-p', crate, '--', '--test-threads=1'], repo);
  return parseCargoTest(out);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- cargo`  Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/verify/cargo.ts test/cargo.test.ts
git commit -m "feat(verify): runCargoTests with injectable exec"
```

---

### Task 4: withMutation（保证还原）

**Files:** Create: `src/verify/mutate.ts`, `test/mutate.test.ts`（本任务只做 withMutation；chooseMutation 在 Task 5 追加到同文件）

说明：`withMutation(absFile, op, fn)` 读原文件 → 校验 `op.line` 处正是 `op.original` → 写入突变 → `await fn()` → **finally 无条件写回原文件** → 再读校验已还原。任何路径都不留下改动。

- [ ] **Step 1: 写会失败的测试 test/mutate.test.ts**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withMutation } from '../src/verify/mutate.js';
import type { MutationOp } from '../src/types.js';

let dirs: string[] = [];
afterEach(() => { dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); dirs = []; });

function tmp(content: string): string {
  const d = mkdtempSync(join(tmpdir(), 'ezm-')); dirs.push(d);
  const f = join(d, 'x.rs'); writeFileSync(f, content); return f;
}

const SRC = 'fn a() {\n    let x = 1;\n    x + 1\n}\n';

describe('withMutation', () => {
  it('applies mutation during fn, restores after', async () => {
    const f = tmp(SRC);
    const op: MutationOp = { file: 'x.rs', line: 2, original: '    let x = 1;', mutated: '    // let x = 1;', description: '' };
    let seen = '';
    await withMutation(f, op, async () => { seen = readFileSync(f, 'utf8'); });
    expect(seen).toContain('// let x = 1;');       // 突变期间已改
    expect(readFileSync(f, 'utf8')).toBe(SRC);     // 结束后已还原
  });

  it('restores even if fn throws', async () => {
    const f = tmp(SRC);
    const op: MutationOp = { file: 'x.rs', line: 2, original: '    let x = 1;', mutated: '    // let x = 1;', description: '' };
    await expect(withMutation(f, op, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(readFileSync(f, 'utf8')).toBe(SRC);     // 抛错也还原
  });

  it('refuses if the target line does not match op.original', async () => {
    const f = tmp(SRC);
    const op: MutationOp = { file: 'x.rs', line: 2, original: 'WRONG', mutated: 'X', description: '' };
    await expect(withMutation(f, op, async () => {})).rejects.toThrow(/mismatch/i);
    expect(readFileSync(f, 'utf8')).toBe(SRC);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- mutate`  Expected: FAIL。

- [ ] **Step 3: 实现 src/verify/mutate.ts**

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import type { MutationOp } from '../types.js';

/**
 * 在 absFile 上临时施突变、跑 fn、无条件还原。
 * 用 \n join 写回；要求文件用 \n 行尾（Rust 源通常如此）。
 */
export async function withMutation<T>(absFile: string, op: MutationOp, fn: () => Promise<T>): Promise<T> {
  const original = readFileSync(absFile, 'utf8');
  const lines = original.split('\n');
  const idx = op.line - 1;
  if (lines[idx] !== op.original) {
    throw new Error(`mutation site mismatch at ${op.file}:${op.line} — expected ${JSON.stringify(op.original)}, found ${JSON.stringify(lines[idx])}`);
  }
  const mutated = [...lines];
  mutated[idx] = op.mutated;
  writeFileSync(absFile, mutated.join('\n'));
  try {
    return await fn();
  } finally {
    writeFileSync(absFile, original);
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- mutate`  Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/verify/mutate.ts test/mutate.test.ts
git commit -m "feat(verify): withMutation with guaranteed restore"
```

---

### Task 5: chooseMutation（挑突变位点）

**Files:** Modify: `src/verify/mutate.ts`（追加 `chooseMutation`）; Test: `test/choose-mutation.test.ts`

说明：从块的叶子里挑第一个 loc≥3 的函数，在其行范围内找第一个"可注释的语句行"——trim 后非空、不以 `//`、`#[`、`fn `、`pub fn`、`}`、`{` 开头、且不以 `{` 结尾。产出 `MutationOp`（把该行改成 `// ` + 原行）。找不到返回 `null`。

- [ ] **Step 1: 写会失败的测试 test/choose-mutation.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { chooseMutation } from '../src/verify/mutate.js';
import type { Chunk, Leaf } from '../src/types.js';

const chunk: Chunk = { id: 'crates/chem_field/src/core/field.rs', name: 'field', file: 'crates/chem_field/src/core/field.rs', crate: 'chem_field', leafIds: ['f::step::5'] };
const leaves: Leaf[] = [
  { id: 'f::step::5', kind: 'fn', name: 'step', file: chunk.file, startLine: 5, endLine: 9, loc: 5 },
];
// 源码（1-based 行）：5 fn 签名, 6 { , 7 let, 8 语句, 9 }
const source = [
  'line1', 'line2', 'line3', 'line4',
  'pub fn step(&mut self) {',        // 5
  '    let dt = 0.1;',               // 6  ← 第一个可注释语句
  '    self.value += dt;',           // 7
  '}',                               // 8
].join('\n');

describe('chooseMutation', () => {
  it('picks the first commentable statement line inside the function', () => {
    const op = chooseMutation(chunk, leaves, source)!;
    expect(op).not.toBeNull();
    expect(op.file).toBe(chunk.file);
    expect(op.line).toBe(6);
    expect(op.original).toBe('    let dt = 0.1;');
    expect(op.mutated).toBe('    // let dt = 0.1;');
  });

  it('returns null when no commentable line exists', () => {
    const emptyLeaf: Leaf[] = [{ id: 'x', kind: 'fn', name: 'x', file: chunk.file, startLine: 1, endLine: 2, loc: 2 }];
    expect(chooseMutation(chunk, emptyLeaf, 'pub fn x() {}\n')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- choose-mutation`  Expected: FAIL。

- [ ] **Step 3: 在 src/verify/mutate.ts 追加 chooseMutation**

```ts
import type { Chunk, Leaf, MutationOp } from '../types.js';

function isCommentable(line: string): boolean {
  const t = line.trim();
  if (t === '') return false;
  if (t.startsWith('//') || t.startsWith('#[')) return false;
  if (t.startsWith('fn ') || t.startsWith('pub fn ')) return false;
  if (t.startsWith('}') || t.startsWith('{')) return false;
  if (t.endsWith('{')) return false; // 块起始（if/for/impl 头等）
  return true;
}

/** 为一个 chunk 选一个突变位点（注释掉某函数体内第一条语句）。找不到返回 null。 */
export function chooseMutation(chunk: Chunk, leaves: Leaf[], source: string): MutationOp | null {
  const lines = source.split('\n');
  const fns = leaves.filter((l) => l.file === chunk.file && l.loc >= 3).sort((a, b) => a.startLine - b.startLine);
  for (const fn of fns) {
    for (let ln = fn.startLine; ln <= fn.endLine; ln++) {
      const original = lines[ln - 1];
      if (original !== undefined && isCommentable(original)) {
        const indent = original.match(/^\s*/)?.[0] ?? '';
        return {
          file: chunk.file,
          line: ln,
          original,
          mutated: `${indent}// ${original.trim()}`,
          description: `注释掉 ${chunk.file}:${ln} 的一行语句`,
        };
      }
    }
  }
  return null;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- choose-mutation`  Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/verify/mutate.ts test/choose-mutation.test.ts
git commit -m "feat(verify): chooseMutation — pick a commentable statement site"
```

---

### Task 6: 爆炸半径探针

**Files:** Create: `src/verify/probe.ts`, `test/probe.test.ts`

说明：`probe(params)`：给定基线绿集 `baselineGreen`、突变 `op`、目标文件绝对路径、`runAfter`（施突变后跑一次 cargo 的函数，可注入 fake）。施突变→`runAfter()`→算 newlyFailing = 基线绿集里、突变后**变红或消失**的测试；若突变后 `!compiled` → `compileBroke:true`，`newlyFailing=['<compile-error>']`→还原→返回 `BlastRadius`。

- [ ] **Step 1: 写会失败的测试 test/probe.test.ts**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe } from '../src/verify/probe.js';
import type { MutationOp, CargoTestRun } from '../src/types.js';

let dirs: string[] = [];
afterEach(() => { dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); dirs = []; });

function tmp(content: string): string {
  const d = mkdtempSync(join(tmpdir(), 'ezpr-')); dirs.push(d);
  const f = join(d, 'x.rs'); writeFileSync(f, content); return f;
}
const SRC = 'fn a() {\n    let x = 1;\n    x + 1\n}\n';
const op: MutationOp = { file: 'x.rs', line: 2, original: '    let x = 1;', mutated: '    // let x = 1;', description: '' };

describe('probe', () => {
  it('computes newly-failing tests and restores the file', async () => {
    const f = tmp(SRC);
    const after: CargoTestRun = { compiled: true, results: [
      { name: 't1', passed: true }, { name: 't2', passed: false }, { name: 't3', passed: false },
    ] };
    const blast = await probe({
      chunkId: 'x.rs', absFile: f, op,
      baselineGreen: ['t1', 't2', 't3'],
      runAfter: async () => after,
    });
    expect(blast.compileBroke).toBe(false);
    expect(blast.newlyFailing.sort()).toEqual(['t2', 't3']); // t2/t3 由绿转红
    expect(readFileSync(f, 'utf8')).toBe(SRC);               // 已还原
  });

  it('flags compile break', async () => {
    const f = tmp(SRC);
    const blast = await probe({
      chunkId: 'x.rs', absFile: f, op,
      baselineGreen: ['t1'],
      runAfter: async () => ({ compiled: false, results: [] }),
    });
    expect(blast.compileBroke).toBe(true);
    expect(blast.newlyFailing).toEqual(['<compile-error>']);
    expect(readFileSync(f, 'utf8')).toBe(SRC);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- probe`  Expected: FAIL。

- [ ] **Step 3: 实现 src/verify/probe.ts**

```ts
import type { BlastRadius, CargoTestRun, MutationOp, NodeId } from '../types.js';
import { withMutation } from './mutate.js';

export interface ProbeParams {
  chunkId: NodeId;
  absFile: string;            // 目标文件绝对路径
  op: MutationOp;
  baselineGreen: string[];    // 未突变时通过的测试名
  runAfter: () => Promise<CargoTestRun>; // 施突变后跑一次（真实=runCargoTests；测试=fake）
}

export async function probe(p: ProbeParams): Promise<BlastRadius> {
  const green = new Set(p.baselineGreen);
  return withMutation(p.absFile, p.op, async () => {
    const after = await p.runAfter();
    if (!after.compiled) {
      return {
        chunkId: p.chunkId, mutation: p.op,
        newlyFailing: ['<compile-error>'], compileBroke: true,
        note: '突变导致该 crate 无法编译——这行是承重的。',
      } satisfies BlastRadius;
    }
    const stillGreen = new Set(after.results.filter((r) => r.passed).map((r) => r.name));
    const newlyFailing = [...green].filter((name) => !stillGreen.has(name));
    return {
      chunkId: p.chunkId, mutation: p.op,
      newlyFailing, compileBroke: false,
      note: newlyFailing.length === 0 ? '突变没让任何测试变红——这块可能没被测试覆盖。' : '',
    } satisfies BlastRadius;
  });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- probe`  Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/verify/probe.ts test/probe.test.ts
git commit -m "feat(verify): blast-radius probe (mutate → run → diff → restore)"
```

---

### Task 7: 判定预测 vs 真实

**Files:** Create: `src/verify/judge.ts`, `test/judge.test.ts`

说明：`judge(blast, predicted)`：actual = blast.newlyFailing；hits=预测∩真实；misses=真实−预测；falseAlarms=预测−真实。`passed` = misses 为空且 falseAlarms 为空（完全命中）。compileBroke 时 actual=['<compile-error>']，若学习者预测非空即视为命中承重（passed = predicted 非空且无 falseAlarm 之外的错——简化：compileBroke 时 passed = predicted.length>0）。

- [ ] **Step 1: 写会失败的测试 test/judge.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { judge } from '../src/verify/judge.js';
import type { BlastRadius } from '../src/types.js';

const op = { file: 'x.rs', line: 2, original: 'a', mutated: 'b', description: '' };
const blast = (newlyFailing: string[], compileBroke = false): BlastRadius =>
  ({ chunkId: 'x.rs', mutation: op, newlyFailing, compileBroke, note: '' });

describe('judge', () => {
  it('exact hit passes', () => {
    const v = judge(blast(['t2', 't3']), ['t2', 't3']);
    expect(v.hits.sort()).toEqual(['t2', 't3']);
    expect(v.misses).toEqual([]);
    expect(v.falseAlarms).toEqual([]);
    expect(v.passed).toBe(true);
  });

  it('miss fails and reports what was missed / false-alarmed', () => {
    const v = judge(blast(['t2', 't3']), ['t2', 't9']);
    expect(v.hits).toEqual(['t2']);
    expect(v.misses).toEqual(['t3']);
    expect(v.falseAlarms).toEqual(['t9']);
    expect(v.passed).toBe(false);
  });

  it('compile break passes when learner predicted any impact', () => {
    const v = judge(blast(['<compile-error>'], true), ['t2']);
    expect(v.passed).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- judge`  Expected: FAIL。

- [ ] **Step 3: 实现 src/verify/judge.ts**

```ts
import type { BlastRadius, Verdict } from '../types.js';

export function judge(blast: BlastRadius, predicted: string[]): Verdict {
  const actual = blast.newlyFailing;
  const actualSet = new Set(actual);
  const predSet = new Set(predicted);

  const hits = predicted.filter((t) => actualSet.has(t));
  const misses = actual.filter((t) => !predSet.has(t));
  const falseAlarms = predicted.filter((t) => !actualSet.has(t));

  const passed = blast.compileBroke
    ? predicted.length > 0                    // 承重：只要预测到有影响即算懂
    : misses.length === 0 && falseAlarms.length === 0;

  return { chunkId: blast.chunkId, predicted, actual, hits, misses, falseAlarms, passed };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- judge`  Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/verify/judge.ts test/judge.test.ts
git commit -m "feat(verify): judge learner prediction vs real blast radius"
```

---

### Task 8: CLI `verify` 两步命令 + 真实冒烟

**Files:** Create: `src/cli-verify.ts`, `test/cli-verify.test.ts`; Modify: `src/cli.ts`

说明：两步。`runVerifyShow`：跑基线 cargo（可注入）、缓存绿集+全测试名到 `easyreview.verify-baseline.json`、选突变位点、写 `easyreview.verify.md`（显示块、突变位点、全测试名、"预测哪些会崩"指令）。`runVerifyPredict`：读缓存基线（无则报错让先 show）、施突变跑 cargo、`probe`→`judge`、写 verdict 到 `easyreview.verify.md`、通过则把 chunk 加入 `progress.verified` 与 `understood`。仅支持 chem_field 的 chunk。cargo 通过可注入 `exec` 测试（fake），真实在冒烟步。

- [ ] **Step 1: 写会失败的测试 test/cli-verify.test.ts**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { runMap } from '../src/cli.js';
import { runVerifyShow, runVerifyPredict } from '../src/cli-verify.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

describe('verify show/predict', () => {
  it('show caches baseline + writes prompt; predict judges + marks verified', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    // 一个 chem_field 块，含一个可突变函数
    writeRepoFile(dir, 'crates/chem_field/Cargo.toml', '[package]\nname="chem_field"');
    writeRepoFile(dir, 'crates/chem_field/src/core/field.rs',
      'pub fn step(v: f32) -> f32 {\n    let dt = 0.1;\n    v + dt\n}\n');
    commitAll(dir, 'init');
    await runMap({ repo: dir, outDir: dir });

    const chunkId = 'crates/chem_field/src/core/field.rs';
    // fake exec：基线两测全绿；突变后 t2 变红
    let phase = 'baseline';
    const fakeExec = async () =>
      phase === 'baseline'
        ? 'test core::field::t1 ... ok\ntest core::field::t2 ... ok'
        : 'test core::field::t1 ... ok\ntest core::field::t2 ... FAILED';

    await runVerifyShow({ repo: dir, outDir: dir, chunkId, exec: fakeExec });
    expect(existsSync(join(dir, 'easyreview.verify-baseline.json'))).toBe(true);
    const show = readFileSync(join(dir, 'easyreview.verify.md'), 'utf8');
    expect(show).toContain('core::field::t1');   // 列出测试名
    expect(show).toContain('--predict');

    phase = 'mutated';
    await runVerifyPredict({ repo: dir, outDir: dir, chunkId, predicted: ['core::field::t2'], exec: fakeExec });
    const verdict = readFileSync(join(dir, 'easyreview.verify.md'), 'utf8');
    expect(verdict).toContain('通过'); // 精确命中 t2
    const progress = JSON.parse(readFileSync(join(dir, 'easyreview.progress.json'), 'utf8'));
    expect(progress.verified).toContain(chunkId);
    expect(progress.understood).toContain(chunkId);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- cli-verify`  Expected: FAIL。

- [ ] **Step 3: 实现 src/cli-verify.ts**

```ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GradedTree, Chunk } from './types.js';
import { runCargoTests, type Exec } from './verify/cargo.js';
import { chooseMutation } from './verify/mutate.js';
import { probe } from './verify/probe.js';
import { judge } from './verify/judge.js';
import { loadProgress, saveProgress, markUnderstood } from './progress/progress.js';

const CRATE = 'chem_field';

function loadTree(outDir: string): GradedTree {
  try { return JSON.parse(readFileSync(join(outDir, 'easyreview.tree.json'), 'utf8')) as GradedTree; }
  catch { throw new Error(`找不到 easyreview.tree.json——先运行 \`easyreview map --repo <path> --out ${outDir}\``); }
}
function findChunk(g: GradedTree, chunkId: string): Chunk {
  const c = g.chunks.find((x) => x.id === chunkId);
  if (!c) throw new Error(`未知 chunk: ${chunkId}`);
  if (c.crate !== CRATE) throw new Error(`v1 突变探针仅支持 ${CRATE} 的块（该块属于 ${c.crate}）`);
  return c;
}
const baselinePath = (o: string) => join(o, 'easyreview.verify-baseline.json');
const verifyMd = (o: string) => join(o, 'easyreview.verify.md');
const progressPath = (o: string) => join(o, 'easyreview.progress.json');

export interface ShowOpts { repo: string; outDir: string; chunkId: string; exec?: Exec; }
export async function runVerifyShow(o: ShowOpts): Promise<void> {
  const g = loadTree(o.outDir);
  const chunk = findChunk(g, o.chunkId);
  const source = readFileSync(join(o.repo, chunk.file), 'utf8');
  const leaves = g.leaves.filter((l) => l.file === chunk.file);
  const op = chooseMutation(chunk, leaves, source);
  if (!op) throw new Error(`${chunk.file} 找不到可突变的语句行——换个块试试`);

  const baseline = await runCargoTests(o.repo, CRATE, o.exec);
  const green = baseline.results.filter((r) => r.passed).map((r) => r.name);
  const all = baseline.results.map((r) => r.name);
  writeFileSync(baselinePath(o.outDir), JSON.stringify({ green, all, op }, null, 2));

  const lines = [
    '# 突变探针 · 预测',
    '',
    `目标块：\`${chunk.name}\`  (\`${chunk.file}\`)`,
    '',
    `我们会注释掉这一行（然后重跑测试）：`,
    '',
    `> ${chunk.file}:${op.line}`,
    '```rust',
    op.original,
    '```',
    '',
    `## ${CRATE} 的测试（${all.length}）`,
    ...all.map((n) => `- \`${n}\``),
    '',
    '## 你的任务',
    '读懂这个块后，**预测注释掉那行会让上面哪些测试变红**（爆炸半径）。',
    '答完运行：',
    '',
    `\`easyreview verify ${chunk.id} --predict <逗号分隔的测试名>\``,
    '',
    '（预测越准，说明你越懂"谁依赖它"。）',
  ];
  writeFileSync(verifyMd(o.outDir), lines.join('\n'));
}

export interface PredictOpts { repo: string; outDir: string; chunkId: string; predicted: string[]; exec?: Exec; }
export async function runVerifyPredict(o: PredictOpts): Promise<void> {
  const g = loadTree(o.outDir);
  const chunk = findChunk(g, o.chunkId);
  if (!existsSync(baselinePath(o.outDir))) {
    throw new Error(`没有基线——先运行 \`easyreview verify ${chunk.id}\``);
  }
  const cached = JSON.parse(readFileSync(baselinePath(o.outDir), 'utf8')) as {
    green: string[]; all: string[]; op: import('./types.js').MutationOp;
  };

  const blast = await probe({
    chunkId: chunk.id,
    absFile: join(o.repo, chunk.file),
    op: cached.op,
    baselineGreen: cached.green,
    runAfter: () => runCargoTests(o.repo, CRATE, o.exec),
  });
  // 空爆炸半径（非编译崩）= 该块没被测试覆盖 → 无法用突变探针验证，不能算通过（否则预测空即 vacuous pass）
  const uncovered = !blast.compileBroke && blast.newlyFailing.length === 0;
  const verdict = judge(blast, o.predicted);
  const passed = verdict.passed && !uncovered;

  if (passed) {
    const file = progressPath(o.outDir);
    let p = loadProgress(file);
    p = markUnderstood(p, chunk.id);
    p = { ...p, verified: [...new Set([...(p.verified ?? []), chunk.id])] };
    saveProgress(file, p);
  }

  const lines = uncovered
    ? [
        '# 突变探针 · 无法验证',
        '',
        `目标块：\`${chunk.name}\`  (\`${chunk.file}\`)`,
        `⚠️ 注释掉突变位点后没有任何测试变红——**这块没被测试覆盖**，突变探针无法验证它。`,
        '换一个被测试覆盖的块试（如 field/scene/phase 的核心函数），或先给它补个测试。',
        blast.note ? `\n> ${blast.note}` : '',
      ]
    : [
        '# 突变探针 · 判定',
        '',
        `目标块：\`${chunk.name}\`  (\`${chunk.file}\`)`,
        blast.compileBroke ? '突变让 crate **无法编译**——这行是承重的。' : '',
        '',
        `- 你的预测：${o.predicted.map((t) => `\`${t}\``).join(', ') || '（无）'}`,
        `- 真实爆炸半径：${verdict.actual.map((t) => `\`${t}\``).join(', ') || '（无）'}`,
        `- 命中：${verdict.hits.join(', ') || '—'}`,
        `- 漏掉（真崩没预测到）：${verdict.misses.join(', ') || '—'}`,
        `- 误报（预测崩了没崩）：${verdict.falseAlarms.join(', ') || '—'}`,
        '',
        passed ? '✅ **通过**——已标记该块为 verified。' : '❌ 未通过——回去重读，尤其漏掉的那几个测试对应的行为。',
        blast.note ? `\n> ${blast.note}` : '',
      ];
  writeFileSync(verifyMd(o.outDir), lines.filter((l) => l !== '').join('\n'));
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- cli-verify`  Expected: PASS。

- [ ] **Step 5: wire 命令进 src/cli.ts（追加，不改已有分支）**

```ts
if (cmd === 'verify') {
  const rest = process.argv.slice(3);
  const chunkId = rest.find((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
  if (!chunkId) { console.error('用法: easyreview verify <chunkId> [--predict a,b] [--repo <p>] [--out <d>]'); process.exit(1); }
  const { repo, outDir } = parseArgs(rest);
  const pi = rest.indexOf('--predict');
  const predicted = pi >= 0 && rest[pi + 1] ? rest[pi + 1].split(',').map((s) => s.trim()).filter(Boolean) : null;
  import('./cli-verify.js').then(({ runVerifyShow, runVerifyPredict }) =>
    (predicted
      ? runVerifyPredict({ repo, outDir, chunkId, predicted })
      : runVerifyShow({ repo, outDir, chunkId }))
      .then(() => console.log('✓ wrote easyreview.verify.md'))
      .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); }),
  );
}
```

在 package.json scripts 加：`"verify": "tsx src/cli.ts verify"`。

- [ ] **Step 6: 运行确认通过 + 全量**

Run: `npm test -- cli-verify`  Expected: PASS。
Run: `npm test`  Expected: 全部 PASS。
Run: `npx tsc --noEmit`  Expected: 干净。

- [ ] **Step 7: 真实 chem_field 冒烟（观察验证，非单测——会真编译，慢）**

```bash
npm run map -- --repo D:/dev/umwelt-bevy --out .
npm run verify -- crates/chem_field/src/core/field.rs --repo D:/dev/umwelt-bevy --out .
```
看 `easyreview.verify.md`：应显示突变位点 + chem_field 全测试名 + 预测指令。人工读代码预测（如猜 `plugin_steps_scene_each_update` 会崩），再：
```bash
npm run verify -- crates/chem_field/src/core/field.rs --predict <你的预测> --repo D:/dev/umwelt-bevy --out .
```
看判定：真实爆炸半径（注释掉 field 的一行后哪些测试变红）、命中/漏/误报、是否通过、progress.verified 是否记录。**核对**：注释掉 field.rs 里一条真正影响场演化的语句，应让 `plugin_smoke` 的断言失败（v 落出 (0.2,0.5)）——即真实执行验证在起作用。若突变落在无关行导致空爆炸半径，note 会提示"未覆盖"，也是有效信号。

- [ ] **Step 8: Commit + gitignore**

```bash
git add src/cli-verify.ts test/cli-verify.test.ts src/cli.ts package.json
git commit -m "feat(cli): verify — mutation-probe comprehension check (show/predict)"
printf 'easyreview.verify.md\neasyreview.verify-baseline.json\n' >> .gitignore
git add .gitignore
git commit -m "chore: ignore generated verify artifacts"
```

---

## 自查（Self-Review）

**Spec 覆盖**（对 `2026-07-05-easyreview-design.md` §8 + §9 v1b）：
- Gistify 式可执行验证、复用现成测试作 ground truth → 突变探针 + `cargo test -p chem_field`（Task 3/6）✓
- 每块可证伪断言 → 撞真实运行 → 二元判定 → 学习者先预测再揭晓 → judge（Task 7）✓
- 难度集中在高风险核心 → chem_field 起步，机制可推向 grid_workshop ✓
- 验收驱动进度（verified）→ Task 8 通过标 verified+understood ✓；轻触（不硬闸门 journey）✓
- 防盲区：空爆炸半径显式提示"未覆盖"（Task 6 note）✓

**占位符扫描**：无 TBD/TODO；每步含完整代码。真实 cargo 只在 Task 1 观察步与 Task 8 冒烟步（明确标"非单测"）。

**类型一致性**：`TestResult/CargoTestRun/MutationOp/BlastRadius/Verdict` 源自 Task 1；`Exec` 源自 Task 3；`withMutation/chooseMutation` 同在 mutate.ts；`probe(ProbeParams)→BlastRadius`、`judge(BlastRadius,string[])→Verdict` 贯穿一致；chunk.id=文件路径贯穿；`loadProgress/saveProgress/markUnderstood`、`parseArgs`、`runMap`、`GradedTree/Chunk/Leaf` 复用既有导出；`Progress.verified` 为可选，不破坏 Plan ②。

**跨计划修复**：Plan ③ 给 `Progress` 加了可选 `verified`，但 Plan ② 的 `src/progress/progress.ts` 的 `loadProgress`/`markUnderstood` 原样重建对象、会丢掉 `verified`——已修（loadProgress 保留 `raw.verified`、markUnderstood 用 spread），否则验证第二块会覆盖第一块的 verified。含多块回归测试。

**关键安全**：`withMutation` finally 无条件写回原文件 + 施突变前校验目标行 == op.original（不匹配即拒绝并不改文件）→ 绝不损坏 umwelt-bevy。测试覆盖"抛错也还原""行不匹配拒绝"。

**已知 v1 近似（诚实标注）**：突变=注释单行（可能编译失败→当承重信号；可能空爆炸半径→当未覆盖信号）；断言由确定性模板生成（LLM 生成留后续）；仅 chem_field（grid_workshop 编译更重，后续扩）；judge 是精确集合匹配（compileBroke 时放宽）。均在 spec §11 风险清单内。
