# rspec 突变探针 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** verify 支持 Ruby/rspec:`VerifyRunner` 接口按语言分发,rspec 用仓级配置命令跑镜像+引用扫描圈定的 spec,预测粒度为 spec 文件级;cargo 行为零变化。

**Architecture:** 新增 `src/verify/runner.ts`(接口+CargoRunner 纯搬运)、`rspec-scope.ts`(镜像+扫描)、`rspec-parse.ts`(JSON 文件级聚合)、`rspec.ts`(配置+RspecRunner);`pick-site.ts`/`mutate.ts` 语言感知化;`cli-verify.ts` 换 runnerFor 接线。沙箱/probe.withMutation/judge 不动。

**Tech Stack:** Node 内置 fs/path,web-tree-sitter(tree-sitter-ruby.wasm 已在依赖里),vitest(全 fake exec,不碰 docker)。

**Spec:** `docs/superpowers/specs/2026-07-12-rspec-probe-design.md`

**关键不变量:**
1. Rust/cargo 行为零变化——现有 151 测试一个不红(允许的例外:无)。
2. 测试绝不调真 cargo/docker/rspec——全 fake exec;tree-sitter 用真 wasm(既有模式)。
3. `withMutation`(还原语义)、`judge.ts`、`sandbox.ts`、`probe.ts` 一行不改。
4. rspec 一切以解析到的 JSON 为准,退出码不作依据。

---

### Task 1: `src/verify/runner.ts`(接口 + CargoRunner 纯搬运)

**Files:**
- Create: `src/verify/runner.ts`
- Test: `test/verify-runner.test.ts`

- [ ] **Step 1: Write the failing tests** — 创建 `test/verify-runner.test.ts`(完整文件):

```ts
import { describe, it, expect } from 'vitest';
import { cargoRunner } from '../src/verify/runner.js';
import type { Exec } from '../src/verify/cargo.js';
import type { Chunk, GradedTree } from '../src/types.js';

const fakeChunk = { id: 'crates/a/src/lib.rs', crate: 'my_crate', file: 'crates/a/src/lib.rs' } as Chunk;
const fakeTree = {} as GradedTree;

describe('cargoRunner', () => {
  it('pickScope returns the chunk crate as serializable scope', () => {
    const { scope } = cargoRunner.pickScope(fakeTree, fakeChunk, '/repo');
    expect(scope).toEqual({ crate: 'my_crate' });
    expect(JSON.parse(JSON.stringify(scope))).toEqual({ crate: 'my_crate' });
  });

  it('run delegates to cargo with sandbox cwd + CARGO_TARGET_DIR', async () => {
    let seen: { args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv } = {};
    const fake: Exec = async (_c, args, cwd, env) => { seen = { args, cwd, env }; return 'test a::t1 ... ok'; };
    const run = await cargoRunner.run('/sb/src', '/sb/target', { crate: 'my_crate' }, fake);
    expect(run.compiled).toBe(true);
    expect(run.results).toEqual([{ name: 'a::t1', passed: true }]);
    expect(seen.cwd).toBe('/sb/src');
    expect(seen.env?.CARGO_TARGET_DIR).toBe('/sb/target');
    expect(seen.args).toContain('my_crate');
  });

  it('group delegates to module grouping', () => {
    const groups = cargoRunner.group(['core::field::t1', 'core::field::t2', 'lone']);
    expect(groups).toEqual([
      { module: '(crate 根)', tests: ['lone'] },
      { module: 'core::field', tests: ['core::field::t1', 'core::field::t2'] },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/verify-runner.test.ts`
Expected: FAIL —— 找不到模块 `../src/verify/runner.js`

- [ ] **Step 3: Write implementation** — 创建 `src/verify/runner.ts`(完整文件):

```ts
import type { Chunk, GradedTree, CargoTestRun } from '../types.js';
import { runCargoTests, type Exec } from './cargo.js';
import { groupTestsByModule, type TestGroup } from './testlist.js';

/** 结构通用:compiled = 套件可编译/可加载;results 为【预测粒度】的名字(cargo=测试名,rspec=spec 文件路径)。 */
export type TestRun = CargoTestRun;

export interface VerifyRunner {
  id: 'rust' | 'ruby';
  /** 圈定测试域(只读真实仓)。scope 可序列化,原样进 baseline JSON,predict 时原样传回。 */
  pickScope(g: GradedTree, chunk: Chunk, repo: string): { scope: unknown; note?: string };
  /** 在沙箱里跑该域测试。rspec 忽略 sandboxTarget。 */
  run(sandboxSrc: string, sandboxTarget: string, scope: unknown, exec?: Exec): Promise<TestRun>;
  /** verify.md 测试清单分组。 */
  group(names: string[]): TestGroup[];
}

export interface CargoScope { crate: string; }

/** cargo 逻辑纯搬运——行为与直接调 runCargoTests 完全一致。 */
export const cargoRunner: VerifyRunner = {
  id: 'rust',
  pickScope(_g, chunk) {
    return { scope: { crate: chunk.crate } satisfies CargoScope };
  },
  run(sandboxSrc, sandboxTarget, scope, exec) {
    const { crate } = scope as CargoScope;
    return runCargoTests(sandboxSrc, crate, exec, sandboxTarget);
  },
  group: groupTestsByModule,
};
```

- [ ] **Step 4: Run tests + typecheck**

Run(分开跑,PowerShell 无 `&&`): `npx vitest run test/verify-runner.test.ts` → 3 passed;`npm run typecheck` → 干净

- [ ] **Step 5: Commit**

```bash
git add src/verify/runner.ts test/verify-runner.test.ts
git commit -m "feat: VerifyRunner 接口 + CargoRunner 纯搬运"
```

---

### Task 2: `src/verify/rspec-parse.ts`(JSON 提取 + 文件级聚合)

**Files:**
- Create: `src/verify/rspec-parse.ts`
- Test: `test/rspec-parse.test.ts`

- [ ] **Step 1: Write the failing tests** — 创建 `test/rspec-parse.test.ts`(完整文件):

```ts
import { describe, it, expect } from 'vitest';
import { parseRspecJson } from '../src/verify/rspec-parse.js';

function rspecJson(examples: Array<{ file: string; status: string }>): string {
  return JSON.stringify({
    version: '3.13.0',
    examples: examples.map((e, i) => ({
      id: `${e.file}[1:${i + 1}]`, description: `case ${i}`, full_description: `X case ${i}`,
      status: e.status, file_path: e.file, line_number: i + 1,
    })),
    summary: { duration: 1.2, example_count: examples.length, failure_count: examples.filter((e) => e.status === 'failed').length, errors_outside_of_examples_count: 0 },
    summary_line: `${examples.length} examples`,
  });
}

describe('parseRspecJson', () => {
  it('aggregates examples to file level; all-pass file is passed', () => {
    const run = parseRspecJson(rspecJson([
      { file: './spec/actions/a_spec.rb', status: 'passed' },
      { file: './spec/actions/a_spec.rb', status: 'passed' },
      { file: './spec/services/b_spec.rb', status: 'passed' },
    ]));
    expect(run.compiled).toBe(true);
    expect(run.results).toEqual([
      { name: 'spec/actions/a_spec.rb', passed: true },
      { name: 'spec/services/b_spec.rb', passed: true },
    ]);
  });

  it('a file with >=1 failed example is failed; pending does not fail', () => {
    const run = parseRspecJson(rspecJson([
      { file: './spec/a_spec.rb', status: 'passed' },
      { file: './spec/a_spec.rb', status: 'failed' },
      { file: './spec/b_spec.rb', status: 'pending' },
    ]));
    expect(run.results).toEqual([
      { name: 'spec/a_spec.rb', passed: false },
      { name: 'spec/b_spec.rb', passed: true },
    ]);
  });

  it('extracts the JSON line from surrounding compose/bundler noise', () => {
    const out = ['Creating network...', 'warning: bundle stale', rspecJson([{ file: './spec/a_spec.rb', status: 'passed' }]), 'Stopping containers'].join('\n');
    const run = parseRspecJson(out);
    expect(run.compiled).toBe(true);
    expect(run.results).toEqual([{ name: 'spec/a_spec.rb', passed: true }]);
  });

  it('no parseable JSON → compiled:false (load crash equivalent)', () => {
    const run = parseRspecJson('NameError: uninitialized constant Foo\n  from app/x.rb:3');
    expect(run.compiled).toBe(false);
    expect(run.results).toEqual([]);
  });

  it('JSON with zero examples → compiled:false', () => {
    const run = parseRspecJson(rspecJson([]));
    expect(run.compiled).toBe(false);
  });

  it('ignores JSON-looking lines without examples key (e.g. npm logs)', () => {
    const out = ['{"level":"info","msg":"hi"}', rspecJson([{ file: './spec/a_spec.rb', status: 'failed' }])].join('\n');
    const run = parseRspecJson(out);
    expect(run.results).toEqual([{ name: 'spec/a_spec.rb', passed: false }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/rspec-parse.test.ts` — Expected: FAIL(模块不存在)

- [ ] **Step 3: Write implementation** — 创建 `src/verify/rspec-parse.ts`(完整文件):

```ts
import type { TestRun } from './runner.js';

interface RspecExample { file_path?: string; status?: string; }

/**
 * 从混着 compose/bundler 噪音的输出里提取 rspec --format json 的汇总行(单行 JSON,带 examples 键),
 * 聚合到 spec 文件级:文件 passed ⟺ 无 failed example(pending 不算失败)。
 * 无可解析 JSON 或 0 个 example → compiled:false(加载期崩,Ruby 的"编译崩"等价物)。
 */
export function parseRspecJson(output: string): TestRun {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t.startsWith('{')) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(t); } catch { continue; }
    const examples = (parsed as { examples?: RspecExample[] }).examples;
    if (!Array.isArray(examples)) continue;
    if (examples.length === 0) return { compiled: false, results: [] };
    const byFile = new Map<string, boolean>();
    for (const ex of examples) {
      const raw = ex.file_path ?? '';
      const file = raw.startsWith('./') ? raw.slice(2) : raw;
      if (!file) continue;
      byFile.set(file, (byFile.get(file) ?? true) && ex.status !== 'failed');
    }
    return { compiled: true, results: [...byFile.entries()].map(([name, passed]) => ({ name, passed })) };
  }
  return { compiled: false, results: [] };
}
```

- [ ] **Step 4: Run tests + typecheck**

`npx vitest run test/rspec-parse.test.ts` → 6 passed;`npm run typecheck` → 干净

- [ ] **Step 5: Commit**

```bash
git add src/verify/rspec-parse.ts test/rspec-parse.test.ts
git commit -m "feat: rspec JSON 解析——噪音提取 + spec 文件级聚合 + 加载崩语义"
```

---

### Task 3: `src/verify/rspec-scope.ts`(镜像 + 引用扫描)

**Files:**
- Create: `src/verify/rspec-scope.ts`
- Test: `test/rspec-scope.test.ts`

- [ ] **Step 1: Write the failing tests** — 创建 `test/rspec-scope.test.ts`(完整文件):

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { camelize, mirrorSpecOf, pickRspecScope } from '../src/verify/rspec-scope.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ez-rspec-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(repo: string, rel: string, content: string): void {
  const p = join(repo, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

describe('camelize / mirrorSpecOf', () => {
  it('camelizes snake_case basenames per Rails convention', () => {
    expect(camelize('contact_identify_action')).toBe('ContactIdentifyAction');
    expect(camelize('user')).toBe('User');
  });
  it('maps app/ files to spec/ mirrors and non-app files under spec/<dir>', () => {
    expect(mirrorSpecOf('app/actions/contact_identify_action.rb')).toBe('spec/actions/contact_identify_action_spec.rb');
    expect(mirrorSpecOf('lib/util.rb')).toBe('spec/lib/util_spec.rb');
  });
});

describe('pickRspecScope', () => {
  it('returns mirror + word-boundary scan hits (sorted), excluding the mirror itself', () => {
    const repo = makeRepo();
    write(repo, 'spec/actions/contact_identify_action_spec.rb', 'describe ContactIdentifyAction do end');
    write(repo, 'spec/services/z_svc_spec.rb', 'x = ContactIdentifyAction.new');
    write(repo, 'spec/services/a_svc_spec.rb', 'y = ContactIdentifyAction.new');
    write(repo, 'spec/models/unrelated_spec.rb', 'ContactIdentifyActionFoo # 词边界不命中');
    const scope = pickRspecScope(repo, 'app/actions/contact_identify_action.rb', 20)!;
    expect(scope.specFiles).toEqual([
      'spec/actions/contact_identify_action_spec.rb',
      'spec/services/a_svc_spec.rb',
      'spec/services/z_svc_spec.rb',
    ]);
    expect(scope.scanNote).toContain('命中 2 个');
  });

  it('falls back to mirror-only when scan hits exceed scanLimit, with explicit note', () => {
    const repo = makeRepo();
    write(repo, 'spec/actions/hot_thing_spec.rb', 'describe HotThing do end');
    for (let i = 0; i < 5; i++) write(repo, `spec/others/h${i}_spec.rb`, 'HotThing.call');
    const scope = pickRspecScope(repo, 'app/actions/hot_thing.rb', 3)!;
    expect(scope.specFiles).toEqual(['spec/actions/hot_thing_spec.rb']);
    expect(scope.scanNote).toContain('超过上限');
    expect(scope.scanNote).toContain('5');
  });

  it('mirror missing but scan hits exist → hits only', () => {
    const repo = makeRepo();
    write(repo, 'spec/services/uses_spec.rb', 'OrphanClass.call');
    const scope = pickRspecScope(repo, 'app/models/orphan_class.rb', 20)!;
    expect(scope.specFiles).toEqual(['spec/services/uses_spec.rb']);
  });

  it('mirror missing and zero hits → null', () => {
    const repo = makeRepo();
    write(repo, 'spec/services/other_spec.rb', 'SomethingElse.call');
    expect(pickRspecScope(repo, 'app/models/ghost_thing.rb', 20)).toBeNull();
  });

  it('overflow without mirror → null (hotspot without a reasonable scope)', () => {
    const repo = makeRepo();
    for (let i = 0; i < 5; i++) write(repo, `spec/others/h${i}_spec.rb`, 'NoMirror.call');
    expect(pickRspecScope(repo, 'app/models/no_mirror.rb', 3)).toBeNull();
  });

  it('repo without spec/ dir → null', () => {
    const repo = makeRepo();
    expect(pickRspecScope(repo, 'app/models/x.rb', 20)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/rspec-scope.test.ts` — Expected: FAIL(模块不存在)

- [ ] **Step 3: Write implementation** — 创建 `src/verify/rspec-scope.ts`(完整文件):

```ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface RspecScope { specFiles: string[]; scanNote: string; }

/** basename(无 .rb)→ Rails camelize:contact_identify_action → ContactIdentifyAction。 */
export function camelize(basename: string): string {
  return basename.split('_').map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s)).join('');
}

/** 镜像 spec 路径:app/x/y.rb → spec/x/y_spec.rb;非 app/ 前缀 → spec/<原路径>_spec.rb。 */
export function mirrorSpecOf(file: string): string {
  const stripped = file.startsWith('app/') ? file.slice('app/'.length) : file;
  return 'spec/' + stripped.replace(/\.rb$/, '_spec.rb');
}

function walkSpecs(dir: string, rel: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walkSpecs(join(dir, e.name), r, out);
    else if (e.isFile() && e.name.endsWith('_spec.rb')) out.push(r);
  }
}

/**
 * 镜像 + 引用扫描(真实仓 spec/ 内容里词边界 grep 类名;类名来自 snake_case 文件名,只含字母数字,无需转义)。
 * 命中超 scanLimit → 回退只跑镜像(显式 note,不做静默截断);镜像与命中皆空、或超限且无镜像 → null。
 */
export function pickRspecScope(repo: string, chunkFile: string, scanLimit: number): RspecScope | null {
  const mirror = mirrorSpecOf(chunkFile);
  const hasMirror = existsSync(join(repo, mirror));

  const base = chunkFile.replace(/^.*\//, '').replace(/\.rb$/, '');
  const className = camelize(base);
  const re = new RegExp(`\\b${className}\\b`);
  const specRoot = join(repo, 'spec');
  const all: string[] = [];
  if (existsSync(specRoot)) walkSpecs(specRoot, 'spec', all);
  const hits = all.filter((f) => f !== mirror && re.test(readFileSync(join(repo, f), 'utf8'))).sort();

  if (hits.length > scanLimit) {
    if (!hasMirror) return null;
    return {
      specFiles: [mirror],
      scanNote: `引用扫描命中 ${hits.length} 个 spec,超过上限 ${scanLimit}——本次只跑镜像 spec(该类是全仓热点)。`,
    };
  }
  if (!hasMirror && hits.length === 0) return null;
  return {
    specFiles: hasMirror ? [mirror, ...hits] : hits,
    scanNote: hits.length
      ? `引用扫描命中 ${hits.length} 个 spec(类名 ${className})。`
      : `引用扫描零命中(类名 ${className})——只跑镜像 spec。`,
  };
}
```

- [ ] **Step 4: Run tests + typecheck**

`npx vitest run test/rspec-scope.test.ts` → 8 passed;`npm run typecheck` → 干净

注意 `\b` 词边界对 `ContactIdentifyActionFoo` 不命中是因为 `Foo` 前无边界——测试 1 已锁。

- [ ] **Step 5: Commit**

```bash
git add src/verify/rspec-scope.ts test/rspec-scope.test.ts
git commit -m "feat: rspec 范围圈定——镜像映射 + 类名引用扫描 + 上限回退"
```

---

### Task 4: `src/verify/rspec.ts`(配置加载 + RspecRunner)

**Files:**
- Create: `src/verify/rspec.ts`
- Modify: `src/verify/cargo.ts`(仅把 `const realExec` 改为 `export const realExec`,其余不动)
- Test: `test/rspec-runner.test.ts`

- [ ] **Step 1: Write the failing tests** — 创建 `test/rspec-runner.test.ts`(完整文件):

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadRubyRunnerConfig, makeRspecRunner, expandCmd } from '../src/verify/rspec.js';
import type { Exec } from '../src/verify/cargo.js';
import type { Chunk, GradedTree } from '../src/types.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ez-rrun-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(repo: string, rel: string, content: string): void {
  const p = join(repo, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}
const RSPEC_OK = JSON.stringify({ examples: [{ file_path: './spec/actions/x_spec.rb', status: 'passed' }], summary: {} });

describe('loadRubyRunnerConfig', () => {
  it('loads cmd + scanLimit from repo-root easyreview.runner.json', () => {
    const repo = makeRepo();
    write(repo, 'easyreview.runner.json', JSON.stringify({ version: 1, ruby: { cmd: ['docker', 'x', '{specFiles}'], scanLimit: 7 } }));
    const cfg = loadRubyRunnerConfig(repo);
    expect(cfg.cmd).toEqual(['docker', 'x', '{specFiles}']);
    expect(cfg.scanLimit).toBe(7);
  });
  it('missing file → actionable error pointing at the recipe', () => {
    expect(() => loadRubyRunnerConfig(makeRepo())).toThrow(/easyreview\.runner\.json/);
  });
  it('missing ruby.cmd → actionable error', () => {
    const repo = makeRepo();
    write(repo, 'easyreview.runner.json', JSON.stringify({ version: 1, ruby: {} }));
    expect(() => loadRubyRunnerConfig(repo)).toThrow(/ruby\.cmd/);
  });
  it('invalid JSON → parse error message', () => {
    const repo = makeRepo();
    write(repo, 'easyreview.runner.json', '{oops');
    expect(() => loadRubyRunnerConfig(repo)).toThrow(/解析失败/);
  });
});

describe('expandCmd', () => {
  it('expands {specFiles} into one argument per file', () => {
    expect(expandCmd(['docker', 'run', 'rspec', '{specFiles}', '--tag'], ['spec/a_spec.rb', 'spec/b_spec.rb']))
      .toEqual(['docker', 'run', 'rspec', 'spec/a_spec.rb', 'spec/b_spec.rb', '--tag']);
  });
});

describe('makeRspecRunner', () => {
  const tree = {} as GradedTree;

  it('pickScope throws actionable error when no spec scope exists', () => {
    const repo = makeRepo();
    const runner = makeRspecRunner({ cmd: ['x', '{specFiles}'] });
    const chunk = { id: 'app/models/ghost.rb', file: 'app/models/ghost.rb', crate: 'app' } as Chunk;
    expect(() => runner.pickScope(tree, chunk, repo)).toThrow(/找不到可用的 spec 域/);
  });

  it('pickScope returns specFiles scope + note; run executes expanded cmd with cwd=sandboxSrc and parses JSON', async () => {
    const repo = makeRepo();
    write(repo, 'spec/actions/x_spec.rb', 'describe X do end');
    const runner = makeRspecRunner({ cmd: ['docker', 'compose', 'run', 'rspec', '{specFiles}'] });
    const chunk = { id: 'app/actions/x.rb', file: 'app/actions/x.rb', crate: 'app' } as Chunk;
    const picked = runner.pickScope(tree, chunk, repo);
    expect((picked.scope as { specFiles: string[] }).specFiles).toEqual(['spec/actions/x_spec.rb']);
    expect(picked.note).toContain('零命中');

    let seen: { cmd?: string; args?: string[]; cwd?: string } = {};
    const fake: Exec = async (cmd, args, cwd) => { seen = { cmd, args, cwd }; return `noise\n${RSPEC_OK}`; };
    const run = await runner.run('/sb/src', '/sb/target', picked.scope, fake);
    expect(seen.cmd).toBe('docker');
    expect(seen.args).toEqual(['compose', 'run', 'rspec', 'spec/actions/x_spec.rb']);
    expect(seen.cwd).toBe('/sb/src');
    expect(run.compiled).toBe(true);
    expect(run.results).toEqual([{ name: 'spec/actions/x_spec.rb', passed: true }]);
  });

  it('group buckets file paths by top-level spec dir, sorted', () => {
    const runner = makeRspecRunner({ cmd: ['x', '{specFiles}'] });
    expect(runner.group(['spec/services/b_spec.rb', 'spec/actions/a_spec.rb', 'spec/actions/c_spec.rb'])).toEqual([
      { module: 'spec/actions', tests: ['spec/actions/a_spec.rb', 'spec/actions/c_spec.rb'] },
      { module: 'spec/services', tests: ['spec/services/b_spec.rb'] },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/rspec-runner.test.ts` — Expected: FAIL(模块不存在)

- [ ] **Step 3: Write implementation**

(a) `src/verify/cargo.ts`:第 8 行 `const realExec: Exec =` 改为 `export const realExec: Exec =`(其余一字不动)。

(b) 创建 `src/verify/rspec.ts`(完整文件):

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerifyRunner } from './runner.js';
import { realExec, type Exec } from './cargo.js';
import { parseRspecJson } from './rspec-parse.js';
import { pickRspecScope, type RspecScope } from './rspec-scope.js';
import type { TestGroup } from './testlist.js';

export interface RubyRunnerConfig { cmd: string[]; scanLimit?: number; }

/** 读仓根 easyreview.runner.json 的 ruby 节。缺失/无效 → 可操作错误。 */
export function loadRubyRunnerConfig(repo: string): RubyRunnerConfig {
  const p = join(repo, 'easyreview.runner.json');
  if (!existsSync(p)) {
    throw new Error('verify Ruby 需要仓根 easyreview.runner.json——chatwoot 配方见 docs/recipes/chatwoot-rspec.md');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(p, 'utf8')); } catch {
    throw new Error('easyreview.runner.json 解析失败——检查 JSON 语法');
  }
  const ruby = (parsed as { ruby?: RubyRunnerConfig }).ruby;
  if (!ruby || !Array.isArray(ruby.cmd) || ruby.cmd.length === 0) {
    throw new Error('easyreview.runner.json 缺少 ruby.cmd——chatwoot 配方见 docs/recipes/chatwoot-rspec.md');
  }
  return ruby;
}

/** {specFiles} 占位符展开为多个参数(每个 spec 文件一个)。 */
export function expandCmd(cmd: string[], specFiles: string[]): string[] {
  return cmd.flatMap((c) => (c === '{specFiles}' ? specFiles : [c]));
}

function groupBySpecDir(names: string[]): TestGroup[] {
  const byDir = new Map<string, string[]>();
  for (const n of names) {
    const dir = n.split('/').slice(0, 2).join('/');
    const arr = byDir.get(dir);
    if (arr) arr.push(n);
    else byDir.set(dir, [n]);
  }
  return [...byDir.keys()].sort().map((module) => ({ module, tests: byDir.get(module)!.sort() }));
}

export function makeRspecRunner(config: RubyRunnerConfig): VerifyRunner {
  return {
    id: 'ruby',
    pickScope(_g, chunk, repo) {
      const scope = pickRspecScope(repo, chunk.file, config.scanLimit ?? 20);
      if (!scope) {
        throw new Error(`${chunk.file} 找不到可用的 spec 域(镜像 spec 不存在,或引用过广且无镜像)——换个有测试覆盖的块`);
      }
      return { scope, note: scope.scanNote };
    },
    async run(sandboxSrc, _sandboxTarget, scope, exec) {
      const { specFiles } = scope as RspecScope;
      const [cmd, ...args] = expandCmd(config.cmd, specFiles);
      const out = await (exec ?? realExec)(cmd, args, sandboxSrc);
      return parseRspecJson(out);
    },
    group: groupBySpecDir,
  };
}
```

- [ ] **Step 4: Run tests + typecheck**

`npx vitest run test/rspec-runner.test.ts` → 8 passed;`npx vitest run test/verify-cargo.test.ts` → 2 passed(realExec 导出不影响);`npm run typecheck` → 干净

- [ ] **Step 5: Commit**

```bash
git add src/verify/rspec.ts src/verify/cargo.ts test/rspec-runner.test.ts
git commit -m "feat: RspecRunner——仓级命令配置 + {specFiles} 展开 + 目录分组"
```

---

### Task 5: Ruby 突变位点(`pick-site.ts` 泛化 + `mutate.ts` 语言感知)

**Files:**
- Modify: `src/verify/pick-site.ts`(全文替换)
- Modify: `src/verify/mutate.ts`(改 `buildOp`/`isCommentable`/`chooseMutation`;`withMutation` 一行不动)
- Test: `test/pick-site-ruby.test.ts`(新)

- [ ] **Step 1: Write the failing tests** — 创建 `test/pick-site-ruby.test.ts`(完整文件):

```ts
import { describe, it, expect } from 'vitest';
import { pickPreferredSite } from '../src/verify/pick-site.js';
import { chooseMutation } from '../src/verify/mutate.js';
import { RUBY } from '../src/extract/lang.js';
import type { Chunk, Leaf } from '../src/types.js';

describe('pickPreferredSite (ruby)', () => {
  it('picks the first single-line call/assignment in statement position, skipping def/end and nested args', async () => {
    const src = [
      'class ContactIdentifyAction',      // 1
      '  def perform',                    // 2
      '    @contact = find_contact',      // 3  ← 赋值,语句位,应选中
      '    merge(@contact)',              // 4
      '  end',                            // 5
      'end',                              // 6
    ].join('\n');
    const site = await pickPreferredSite(src, RUBY);
    expect(site).toEqual({ line: 3, original: '    @contact = find_contact' });
  });

  it('picks a method call with args when no assignment precedes it', async () => {
    // 注意:无参裸调用(notify_listeners)在 tree-sitter-ruby 里是 identifier 不是 call——
    // v1 只认显式 call/assignment;裸调用由 regex 回退覆盖
    const src = 'def run\n  notify_listeners(self)\nend\n';
    const site = await pickPreferredSite(src, RUBY);
    expect(site).toEqual({ line: 2, original: '  notify_listeners(self)' });
  });

  it('skips multi-line constructs and block heads ending in do', async () => {
    const src = [
      'def run',
      '  items.each do |i|',
      '    process(i)',
      '  end',
      'end',
    ].join('\n');
    const site = await pickPreferredSite(src, RUBY);
    expect(site).toEqual({ line: 3, original: '    process(i)' });
  });

  it('returns null when nothing qualifies', async () => {
    const site = await pickPreferredSite('class Empty\nend\n', RUBY);
    expect(site).toBeNull();
  });
});

describe('chooseMutation (ruby)', () => {
  const chunk = { id: 'app/actions/x.rb', file: 'app/actions/x.rb', crate: 'app' } as Chunk;
  it('builds a # -commented mutation for ruby files', async () => {
    const src = 'def run\n  do_thing\nend\n';
    const leaves: Leaf[] = [{ id: 'x', file: 'app/actions/x.rb', name: 'run', startLine: 1, endLine: 3, loc: 3 } as Leaf];
    const op = await chooseMutation(chunk, leaves, src);
    expect(op).not.toBeNull();
    expect(op!.line).toBe(2);
    expect(op!.mutated).toBe('  # do_thing');
  });

  it('regex fallback (ruby rules) skips def/end/comments and block heads', async () => {
    // pick-site 找不到时走回退:构造 tree-sitter 选不出的场景不稳定,直接测回退规则的行为面——
    // 用一个 pick-site 也能选中的源,断言结果与 # 前缀一致即可(回退与首选路径产出同构)。
    const src = 'def run\n  # comment\n  total = 1\nend\n';
    const leaves: Leaf[] = [{ id: 'x', file: 'app/actions/x.rb', name: 'run', startLine: 1, endLine: 4, loc: 4 } as Leaf];
    const op = await chooseMutation(chunk, leaves, src);
    expect(op!.line).toBe(3);
    expect(op!.mutated).toBe('  # total = 1');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pick-site-ruby.test.ts` — Expected: FAIL(pickPreferredSite 不接受第二参数 / ruby 未支持)

- [ ] **Step 3: Write implementation**

(a) `src/verify/pick-site.ts` 全文替换为:

```ts
import Parser from 'web-tree-sitter';
import { getParser } from '../extract/parser.js';
import { RUST, RUBY, type LangSpec } from '../extract/lang.js';

const RUST_TARGET = new Set([
  'assignment_expression',
  'compound_assignment_expr',
  'call_expression',
  'macro_invocation',
]);

// 包装表达式：try(`x?`)/await(`x.await`)/括号(`(x)`)——下钻到内层真正的调用/赋值
const WRAPPERS = new Set(['try_expression', 'await_expression', 'parenthesized_expression']);

const RUBY_TARGET = new Set(['call', 'assignment', 'operator_assignment']);
// 语句位父节点:方法体/块体/begin/分支体/顶层
const RUBY_STMT_PARENT = new Set(['body_statement', 'do_block', 'block_body', 'begin', 'then', 'else', 'program']);

function unwrap(node: Parser.SyntaxNode | null): Parser.SyntaxNode | null {
  let n = node;
  while (n && WRAPPERS.has(n.type)) n = n.namedChild(0);
  return n;
}

// heredoc 陷阱:heredoc_body 是赋值/调用节点的兄弟而非后代,单行过滤拦不住开头行——
// 注释掉 `x = <<~SQL` 会让 heredoc 体变裸代码(SyntaxError),子树含 heredoc_beginning 一律排除。
function hasHeredoc(n: Parser.SyntaxNode): boolean {
  const stack: Parser.SyntaxNode[] = [n];
  while (stack.length) {
    const c = stack.pop()!;
    if (c.type === 'heredoc_beginning') return true;
    for (let i = 0; i < c.childCount; i++) stack.push(c.child(i)!);
  }
  return false;
}

function collect(root: Parser.SyntaxNode, pred: (n: Parser.SyntaxNode) => boolean): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  const stack: Parser.SyntaxNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (pred(n)) out.push(n);
    for (let i = 0; i < n.childCount; i++) stack.push(n.child(i)!);
  }
  return out;
}

function firstSiteOf(candidates: Parser.SyntaxNode[], lines: string[]): { line: number; original: string } | null {
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.startIndex - b.startIndex);
  const row = candidates[0].startPosition.row;
  return { line: row + 1, original: lines[row] };
}

/**
 * 挑一个"好语句"位点(注释后大概率某测试变红而非白改):
 * - Rust:单行 expression_statement,首个具名子节点是赋值/复合赋值/调用/宏调用(原逻辑不变)。
 * - Ruby:单行 call/assignment/operator_assignment 且处于语句位(父节点为方法体/块体等)。
 * 找不到返回 null。返回 1-based 行号 + 该行完整原文。
 */
export async function pickPreferredSite(
  source: string,
  langSpec: LangSpec = RUST,
): Promise<{ line: number; original: string } | null> {
  const { parser } = await getParser(langSpec);
  const tree = parser.parse(source);
  const lines = source.split('\n');
  try {
    if (langSpec.id === 'ruby') {
      const candidates = collect(tree.rootNode, (n) =>
        RUBY_TARGET.has(n.type) &&
        n.startPosition.row === n.endPosition.row &&
        !!n.parent && RUBY_STMT_PARENT.has(n.parent.type) &&
        !hasHeredoc(n));
      return firstSiteOf(candidates, lines);
    }
    const stmts = collect(tree.rootNode, (n) => n.type === 'expression_statement');
    const candidates = stmts.filter((n) => {
      if (n.startPosition.row !== n.endPosition.row) return false;
      const inner = unwrap(n.namedChild(0));
      return !!inner && RUST_TARGET.has(inner.type);
    });
    return firstSiteOf(candidates, lines);
  } finally {
    tree.delete();
  }
}
```

(b) `src/verify/mutate.ts` 全文替换为(`withMutation` 与原文件逐字相同,勿改):

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import type { Chunk, Leaf, MutationOp } from '../types.js';
import { pickPreferredSite } from './pick-site.js';
import { langOf, RUST } from '../extract/lang.js';

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

function isCommentableRust(line: string): boolean {
  const t = line.trim();
  if (t === '') return false;
  if (t.startsWith('//') || t.startsWith('#[')) return false;
  if (t.startsWith('fn ') || t.startsWith('pub fn ')) return false;
  if (t.startsWith('}') || t.startsWith('{')) return false;
  if (t.endsWith('{')) return false; // 块起始（if/for/impl 头等）
  return true;
}

function isCommentableRuby(line: string): boolean {
  const t = line.trim();
  if (t === '' || t.startsWith('#')) return false;
  if (/^(def |end\b|class |module |if |unless |elsif |else\b|when |case\b|begin\b|rescue\b|ensure\b|until |while |for )/.test(t)) return false;
  if (/\bdo(\s*\|[^|]*\|)?\s*$/.test(t)) return false; // 块头(xxx.each do |i|)
  if (/<<[-~]?['"`]?[A-Za-z_]/.test(t)) return false; // heredoc 开头行——注释会让 heredoc 体变裸代码
  return true;
}

function buildOp(file: string, line: number, original: string): MutationOp {
  const indent = original.match(/^\s*/)?.[0] ?? '';
  const prefix = langOf(file)?.id === 'ruby' ? '# ' : '// ';
  return {
    file,
    line,
    original,
    mutated: `${indent}${prefix}${original.trim()}`,
    description: `注释掉 ${file}:${line} 的一行语句`,
  };
}

/** 为一个 chunk 选突变位点：优先 tree-sitter 挑"好语句"（赋值/调用→大概率红测试），
 *  挑不到回退 regex 扫描（loc≥3 函数逐行找第一条可注释语句,规则按语言）。都没有返回 null。 */
export async function chooseMutation(chunk: Chunk, leaves: Leaf[], source: string): Promise<MutationOp | null> {
  const lang = langOf(chunk.file) ?? RUST;
  const pref = await pickPreferredSite(source, lang);
  if (pref) return buildOp(chunk.file, pref.line, pref.original);

  // 回退：regex 逐行扫描（绝不退步）
  const commentable = lang.id === 'ruby' ? isCommentableRuby : isCommentableRust;
  const lines = source.split('\n');
  const fns = leaves.filter((l) => l.file === chunk.file && l.loc >= 3).sort((a, b) => a.startLine - b.startLine);
  for (const fn of fns) {
    for (let ln = fn.startLine; ln <= fn.endLine; ln++) {
      const original = lines[ln - 1];
      if (original !== undefined && commentable(original)) {
        return buildOp(chunk.file, ln, original);
      }
    }
  }
  return null;
}
```

注意:tree-sitter-ruby 的实际节点类型若与 `RUBY_TARGET`/`RUBY_STMT_PARENT` 假设不符(以测试跑真 wasm 的结果为准),按真实节点类型调整这两个集合并在提交信息里注明——**不许**为凑测试削弱「单行+语句位」两个条件本身。

> 修订 2026-07-12:质量审发现 heredoc 开头行会被选中(heredoc_body 是兄弟节点,单行过滤拦不住),注释后 heredoc 体变裸代码 = SyntaxError——两条路径都加 heredoc 排除 + 回归测试。

- [ ] **Step 4: Run tests + typecheck**

`npx vitest run test/pick-site-ruby.test.ts` → 8 passed(含 heredoc/operator_assignment 回归);`npx vitest run test/cli-verify.test.ts` → 5 passed(Rust 路径回归);`npm run typecheck` → 干净

- [ ] **Step 5: Commit**

```bash
git add src/verify/pick-site.ts src/verify/mutate.ts test/pick-site-ruby.test.ts
git commit -m "feat: Ruby 突变位点——tree-sitter 语句位选点 + # 注释前缀 + regex 回退 Ruby 规则"
```

---

### Task 6: `cli-verify.ts` 接线(runnerFor + 语言感知文案)+ Ruby 全流程测试

**Files:**
- Modify: `src/cli-verify.ts`(全文替换)
- Test: `test/cli-verify.test.ts`(新增 2 用例;现有 5 个不动)

- [ ] **Step 1: Write the failing tests** — `test/cli-verify.test.ts` 文件末尾(describe 内)追加两个用例;顶部 fs import 已有所需(readFileSync/existsSync/rmSync/mkdirSync/writeFileSync),另需在 helpers import 行确认含 `writeRepoFile`(已有):

```ts
  it('ruby chunk: show/predict run rspec via runner config at file-level granularity', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    const sb = trackSandbox(dir);
    writeRepoFile(dir, 'app/actions/contact_identify_action.rb',
      'class ContactIdentifyAction\n  def perform\n    @contact = find_contact\n  end\nend\n');
    writeRepoFile(dir, 'spec/actions/contact_identify_action_spec.rb', 'describe ContactIdentifyAction do end');
    writeRepoFile(dir, 'spec/services/consumer_spec.rb', 'x = ContactIdentifyAction.new');
    writeRepoFile(dir, 'easyreview.runner.json', JSON.stringify({ version: 1, ruby: { cmd: ['fake-rspec', '{specFiles}'] } }));
    commitAll(dir, 'init');
    await runMap({ repo: dir, outDir: dir });

    const chunkId = 'app/actions/contact_identify_action.rb';
    const mirror = 'spec/actions/contact_identify_action_spec.rb';
    const consumer = 'spec/services/consumer_spec.rb';
    const okJson = JSON.stringify({ examples: [
      { file_path: `./${mirror}`, status: 'passed' },
      { file_path: `./${consumer}`, status: 'passed' },
    ], summary: {} });
    const failJson = JSON.stringify({ examples: [
      { file_path: `./${mirror}`, status: 'failed' },
      { file_path: `./${consumer}`, status: 'passed' },
    ], summary: {} });

    let phase = 'baseline';
    let seen: { cmd?: string; args?: string[]; cwd?: string } = {};
    const fakeExec = async (cmd: string, args: string[], cwd: string) => {
      seen = { cmd, args, cwd };
      return phase === 'baseline' ? `noise\n${okJson}` : `noise\n${failJson}`;
    };

    await runVerifyShow({ repo: dir, outDir: dir, chunkId, exec: fakeExec });
    expect(seen.cmd).toBe('fake-rspec');
    expect(seen.args).toEqual([mirror, consumer]);
    expect(seen.cwd).toBe(sb.srcDir);
    const baseline = JSON.parse(readFileSync(join(dir, 'easyreview.verify-baseline.json'), 'utf8'));
    expect(baseline.scope.specFiles).toEqual([mirror, consumer]);
    const show = readFileSync(join(dir, 'easyreview.verify.md'), 'utf8');
    expect(show).toContain('相关 spec 文件');
    expect(show).toContain(mirror);
    expect(show).toContain('spec 文件路径');

    phase = 'mutated';
    await runVerifyPredict({ repo: dir, outDir: dir, chunkId, predicted: [mirror], exec: fakeExec });
    const verdict = readFileSync(join(dir, 'easyreview.verify.md'), 'utf8');
    expect(verdict).toContain('通过');
    const progress = JSON.parse(readFileSync(join(dir, 'easyreview.progress.json'), 'utf8'));
    expect(progress.verified).toContain(chunkId);
  });

  it('ruby chunk without runner config → actionable error', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    trackSandbox(dir);
    writeRepoFile(dir, 'app/models/thing.rb', 'class Thing\n  def go\n    x = 1\n  end\nend\n');
    writeRepoFile(dir, 'spec/models/thing_spec.rb', 'describe Thing do end');
    commitAll(dir, 'init');
    await runMap({ repo: dir, outDir: dir });
    await expect(
      runVerifyShow({ repo: dir, outDir: dir, chunkId: 'app/models/thing.rb', exec: async () => '' }),
    ).rejects.toThrow(/easyreview\.runner\.json/);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/cli-verify.test.ts`
Expected: 新 2 例 FAIL(现在 ruby 会被 assertRustChunk 拦截);现有 5 例 PASS

- [ ] **Step 3: Rewrite `src/cli-verify.ts`** — 全文替换为:

```ts
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { GradedTree, Chunk } from './types.js';
import { type Exec } from './verify/cargo.js';
import { sandboxFor, syncSandbox } from './verify/sandbox.js';
import { chooseMutation } from './verify/mutate.js';
import { probe } from './verify/probe.js';
import { judge } from './verify/judge.js';
import { loadProgress, saveProgress, markUnderstood } from './progress/progress.js';
import { cargoRunner, type VerifyRunner } from './verify/runner.js';
import { loadRubyRunnerConfig, makeRspecRunner } from './verify/rspec.js';
import { langOf } from './extract/lang.js';

function loadTree(outDir: string): GradedTree {
  try { return JSON.parse(readFileSync(join(outDir, 'easyreview.tree.json'), 'utf8')) as GradedTree; }
  catch { throw new Error(`找不到 easyreview.tree.json——先运行 \`easyreview map --repo <path> --out ${outDir}\``); }
}
function findChunk(g: GradedTree, chunkId: string): Chunk {
  const c = g.chunks.find((x) => x.id === chunkId);
  if (!c) throw new Error(`未知 chunk: ${chunkId}`);
  return c;
}
function runnerFor(chunk: Chunk, repo: string): VerifyRunner {
  const lang = langOf(chunk.file)?.id;
  if (lang === 'rust') return cargoRunner;
  if (lang === 'ruby') return makeRspecRunner(loadRubyRunnerConfig(repo));
  throw new Error(`verify（突变探针）暂只支持 Rust（cargo）与 Ruby（rspec）；\`${chunk.file}\` 不在支持范围。`);
}
const baselinePath = (o: string) => join(o, 'easyreview.verify-baseline.json');
const verifyMd = (o: string) => join(o, 'easyreview.verify.md');
const progressPath = (o: string) => join(o, 'easyreview.progress.json');

export interface ShowOpts { repo: string; outDir: string; chunkId: string; exec?: Exec; }
export async function runVerifyShow(o: ShowOpts): Promise<void> {
  const g = loadTree(o.outDir);
  const chunk = findChunk(g, o.chunkId);
  const runner = runnerFor(chunk, o.repo);
  const source = readFileSync(join(o.repo, chunk.file), 'utf8');
  const leaves = g.leaves.filter((l) => l.file === chunk.file);
  const op = await chooseMutation(chunk, leaves, source);
  if (!op) throw new Error(`${chunk.file} 找不到可突变的语句行——换个块试试`);

  const picked = runner.pickScope(g, chunk, o.repo);

  const sb = sandboxFor(o.repo);
  const firstRun = !existsSync(sb.targetDir);
  const stats = syncSandbox(o.repo, sb.srcDir);
  console.error(`⏳ 沙箱已同步(${stats.copied} 个文件更新,位置 ${sb.dir})`);
  console.error(
    runner.id === 'rust'
      ? (firstRun
          ? `⏳ 沙箱首次全量编译 ${chunk.crate} 可能要 5-10 分钟（独立缓存,不碰真实仓的 target/），属正常、不是卡住。`
          : `⏳ 编译 ${chunk.crate}（沙箱增量）…`)
      : `⏳ 运行 rspec（docker 冷启动/bundle 首次可能较慢）…`,
  );
  const baseline = await runner.run(sb.srcDir, sb.targetDir, picked.scope, o.exec);
  if (!baseline.compiled) {
    throw new Error(
      runner.id === 'rust'
        ? `${chunk.crate} 的基线 cargo test 无法编译——先修好编译错误再验证这个块。`
        : '基线 rspec 无法加载或零 example——先确认测试环境可用（docs/recipes/chatwoot-rspec.md）。',
    );
  }
  const green = baseline.results.filter((r) => r.passed).map((r) => r.name);
  const all = baseline.results.map((r) => r.name);
  writeFileSync(baselinePath(o.outDir), JSON.stringify({ green, all, op, scope: picked.scope }, null, 2));

  const isRust = runner.id === 'rust';
  const lines = [
    '# 突变探针 · 预测',
    '',
    `目标块：\`${chunk.name}\`  (\`${chunk.file}\`)`,
    '',
    `我们会注释掉这一行（然后重跑测试）：`,
    '',
    `> ${chunk.file}:${op.line}`,
    '```' + (langOf(chunk.file)?.fence ?? ''),
    op.original,
    '```',
    '',
    isRust ? `## \`${chunk.crate}\` 的测试（${all.length}）` : `## 相关 spec 文件（${all.length}）`,
    ...(picked.note ? ['', `> ${picked.note}`] : []),
    ...runner.group(all).flatMap((grp) => [
      `### ${grp.module}`,
      ...grp.tests.map((n) => `- \`${n}\``),
    ]),
    '',
    '## 你的任务',
    isRust
      ? '读懂这个块后，**预测注释掉那行会让上面哪些测试变红**（爆炸半径）。'
      : '读懂这个块后，**预测注释掉那行会让上面哪些 spec 文件变红**（爆炸半径，文件级）。',
    '答完运行：',
    '',
    isRust
      ? `\`easyreview verify ${chunk.id} --predict <逗号分隔的测试名>\``
      : `\`easyreview verify ${chunk.id} --predict <逗号分隔的 spec 文件路径>\``,
    '',
    '（预测越准，说明你越懂"谁依赖它"。）',
  ];
  writeFileSync(verifyMd(o.outDir), lines.join('\n'));
}

export interface PredictOpts { repo: string; outDir: string; chunkId: string; predicted: string[]; exec?: Exec; }
export async function runVerifyPredict(o: PredictOpts): Promise<void> {
  const g = loadTree(o.outDir);
  const chunk = findChunk(g, o.chunkId);
  const runner = runnerFor(chunk, o.repo);
  if (!existsSync(baselinePath(o.outDir))) {
    throw new Error(`没有基线——先运行 \`easyreview verify ${chunk.id}\``);
  }
  const cached = JSON.parse(readFileSync(baselinePath(o.outDir), 'utf8')) as {
    green: string[]; all: string[]; op: import('./types.js').MutationOp; scope?: unknown;
  };
  // 旧 baseline 无 scope 只可能来自 Rust 流程——现算(行为等价);Ruby baseline 一定带 scope
  const scope = cached.scope ?? runner.pickScope(g, chunk, o.repo).scope;

  const sb = sandboxFor(o.repo);
  syncSandbox(o.repo, sb.srcDir);
  let blast: import('./types.js').BlastRadius;
  try {
    blast = await probe({
      chunkId: chunk.id,
      absFile: join(sb.srcDir, chunk.file),
      op: cached.op,
      baselineGreen: cached.green,
      runAfter: () => runner.run(sb.srcDir, sb.targetDir, scope, o.exec),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('mutation site mismatch')) {
      throw new Error(`${msg}\n源码已变——先重跑 \`easyreview verify ${chunk.id}\` 刷新基线`);
    }
    throw e;
  }

  // 空爆炸半径（非编译崩）= 该块没被测试覆盖 → 无法用突变探针验证，不能算通过
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

  const isRust = runner.id === 'rust';
  const brokeLine = isRust
    ? '突变让 crate **无法编译**——这行是承重的。'
    : '突变让 spec 套件**加载失败**——这行是承重的。';
  const noteLine = blast.note
    ? (blast.compileBroke && !isRust ? '\n> 突变让 spec 套件加载失败——这行是承重的。' : `\n> ${blast.note}`)
    : '';
  const lines = uncovered
    ? [
        '# 突变探针 · 无法验证',
        '',
        `目标块：\`${chunk.name}\`  (\`${chunk.file}\`)`,
        `⚠️ 注释掉突变位点后没有任何测试变红——**这块没被测试覆盖**，突变探针无法验证它。`,
        '换一个被测试覆盖的块试，或先给它补个测试。',
        noteLine,
      ]
    : [
        '# 突变探针 · 判定',
        '',
        `目标块：\`${chunk.name}\`  (\`${chunk.file}\`)`,
        blast.compileBroke ? brokeLine : '',
        '',
        `- 你的预测：${o.predicted.map((t) => `\`${t}\``).join(', ') || '（无）'}`,
        `- 真实爆炸半径：${verdict.actual.map((t) => `\`${t}\``).join(', ') || '（无）'}`,
        `- 命中：${verdict.hits.join(', ') || '—'}`,
        `- 漏掉（真崩没预测到）：${verdict.misses.join(', ') || '—'}`,
        `- 误报（预测崩了没崩）：${verdict.falseAlarms.join(', ') || '—'}`,
        '',
        passed ? '✅ **通过**——已标记该块为 verified。' : '❌ 未通过——回去重读，尤其漏掉的那几个测试对应的行为。',
        noteLine,
      ];
  writeFileSync(verifyMd(o.outDir), lines.filter((l) => l !== '').join('\n'));
}

/** 删除该仓对应的整个沙箱(源码副本 + 编译缓存)。沙箱不存在也正常返回(幂等)。 */
export function runVerifyClean(repo: string): void {
  const sb = sandboxFor(repo);
  if (existsSync(sb.dir)) {
    rmSync(sb.dir, { recursive: true, force: true });
    console.log(`✓ 已删除沙箱 ${sb.dir}`);
  } else {
    console.log(`沙箱不存在（${sb.dir}）——无需清理`);
  }
}
```

注意两处与旧文件的有意差异:①verify.md 代码围栏从写死 `\`\`\`rust` 改为 `langOf(chunk.file)?.fence`;②uncovered 文案去掉了 umwelt 专属的「(如 field/scene/phase 的核心函数)」举例(语言中立化)。现有测试不断言这两处旧文案,不会红;若红了按测试为准回报,不许私改。

> 修订 2026-07-12:计划遗漏了 e1c5fbd 时代的 test/verify-ruby-reject.test.ts(锁「Ruby 一律拒绝」旧行为,与本设计直接冲突)。实现者正确上报;决定改写该文件为锁新边界(无 runner 配置时 show/predict 均可操作报错且零 exec 调用)。

- [ ] **Step 4: Run tests + typecheck**

`npx vitest run test/cli-verify.test.ts` → 7 passed;`npm test` → 全绿;`npm run typecheck` → 干净

- [ ] **Step 5: Commit**

```bash
git add src/cli-verify.ts test/cli-verify.test.ts
git commit -m "feat: cli-verify 接 VerifyRunner——Ruby/rspec 全流程 + 语言感知文案"
```

---

### Task 7: chatwoot 配方 + HANDOFF + 全量验证

**Files:**
- Create: `docs/recipes/chatwoot-rspec.md`
- Modify: `docs/HANDOFF.md`

- [ ] **Step 1: Write the recipe** — 创建 `docs/recipes/chatwoot-rspec.md`(完整文件):

````markdown
# chatwoot rspec 环境配方(easyreview verify 用)

verify Ruby 需要一套能跑 rspec 的环境。本配方用 Docker Compose 立起 chatwoot 的最小测试环境
(按其 CI `run_foss_spec.yml` 裁剪:pg16 + redis + ruby 3.4.4)。

**状态:活文档——真仓验收踩到的坑直接修回这里,验收通过的版本才算定稿。**

## 一次性安装

1. 把下面两个文件拷到 chatwoot 仓根(对该仓是未跟踪的本地文件,不要提交):
   `docker-compose.easyreview.yaml` 与 `easyreview.runner.json`(模板见下)。
2. 启动 Docker Desktop。
3. 初始化(首次 30-60 分钟:拉镜像 + bundle install + 建库):

```powershell
cd <chatwoot 仓根>
docker compose -f docker-compose.easyreview.yaml run --rm -T rspec bundle install
docker compose -f docker-compose.easyreview.yaml run --rm -T rspec bundle exec rake db:create db:schema:load
```

已知雷(来自 chatwoot CI):
- CE spec 不含 enterprise——若加载报 enterprise 相关错误,rspec 只指定 spec 文件路径时通常不受影响;必要时在沙箱里临时排除。
- `NODE_OPTIONS=--openssl-legacy-provider` 已在 compose 里预置。
- 数据库连接环境变量名以 chatwoot `config/database.yml` 为准——若连接失败,对照该文件调整 compose 的 environment(验收时校准)。

## docker-compose.easyreview.yaml(模板)

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    tmpfs:
      - /var/lib/postgresql/data
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ''
      POSTGRES_HOST_AUTH_METHOD: trust
  redis:
    image: redis:alpine
  rspec:
    image: ruby:3.4.4
    working_dir: /app
    volumes:
      - .:/app
      - bundle:/usr/local/bundle
    environment:
      RAILS_ENV: test
      POSTGRES_HOST: postgres
      POSTGRES_USERNAME: postgres
      POSTGRES_PASSWORD: ''
      REDIS_URL: redis://redis:6379
      NODE_OPTIONS: --openssl-legacy-provider
    depends_on:
      - postgres
      - redis
volumes:
  bundle:
```

## easyreview.runner.json(模板)

```json
{
  "version": 1,
  "ruby": {
    "cmd": ["docker", "compose", "-f", "docker-compose.easyreview.yaml", "run", "--rm", "-T", "rspec", "bundle", "exec", "rspec", "--format", "json", "{specFiles}"],
    "scanLimit": 20
  }
}
```

## 工作原理

verify 的 cwd 是沙箱 `src/`(仓的增量同步副本);compose 文件是仓内普通文件、会同步进沙箱,
`volumes: .:/app` 挂载的就是沙箱——突变对容器可见,真实仓零接触。
`{specFiles}` 由 easyreview 展开为镜像 spec + 引用扫描命中的文件列表。
````

- [ ] **Step 2: Update HANDOFF.md**

(a) ③ verify 段的沙箱化说明后追加一句(沿用现有注释续行风格):

> 2026-07-12 起支持 Ruby/rspec:仓根 `easyreview.runner.json` 声明测试命令(chatwoot 配方 `docs/recipes/chatwoot-rspec.md`),范围=镜像 spec+引用扫描(超上限回退),预测粒度=spec 文件级。

(b) 代码地图加四行(现有格式):`src/verify/runner.ts`(VerifyRunner 接口+CargoRunner 纯搬运)、`src/verify/rspec.ts`(配置加载+RspecRunner+{specFiles} 展开)、`src/verify/rspec-scope.ts`(镜像映射+类名引用扫描+上限回退)、`src/verify/rspec-parse.ts`(rspec JSON 噪音提取+文件级聚合+加载崩语义)。

(c) `src/verify/pick-site.ts` 与 `src/verify/mutate.ts` 行的描述补「语言感知(Rust/Ruby)」。

(d) 测试计数句用**真实 `npm test` 输出**更新(预计 52 文件 / 184 上下,以实际为准,不得照抄)。

- [ ] **Step 3: Full verification**

分开跑:`npm test`(全绿)、`npm run typecheck`(干净)。记录真实计数。

- [ ] **Step 4: Commit**

```bash
git add docs/recipes/chatwoot-rspec.md docs/HANDOFF.md
git commit -m "docs: chatwoot rspec 配方 + HANDOFF 同步 Ruby 探针"
```

---

## 验收(计划外、合并前;按 spec §8 真仓标准)

1. 启动 Docker Desktop;两个模板文件拷入 `E:/learning/agent-research/repos/chatwoot` 仓根;跑一次性初始化(踩坑修回配方)
2. `npm run verify -- app/actions/contact_identify_action.rb --repo E:/learning/agent-research/repos/chatwoot --out E:/dev/easyReview/out/chatwoot` → verify.md 列出镜像+扫描 spec 清单
3. `--predict` 一轮 → 真突变真 rspec、文件级判定
4. 零接触断言:chatwoot `git status` 与验收前一致(模板文件本来就是未跟踪)、突变只在沙箱、事后字节还原
5. 配方文档按踩坑修订后随分支提交
