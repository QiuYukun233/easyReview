# vitest 突变探针 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** verify(突变探针)支持 js/vue 块——vitest runner、basename 索引 spec 圈定、carve 感知位点选择,chatwoot 前端真仓验收。

**Architecture:** `runnerFor` 对 js/vue 分发到 `makeVitestRunner`(一个 runner 服务两种块);圈定 = spec 文件索引 basename 镜像(撞名取最长公共目录前缀)+ 引用扫描;位点 = pick-site 加 JS 语句目标 + vue 按 carve 区段挑并还原行号;顺带拆掉"未知语言回退 RUST"死码(PR #11 终审回访项)。

**Tech Stack:** Node20+/TypeScript(ESM)/vitest;chatwoot 侧 Docker(node:24 + pnpm 命名卷)。

**Spec:** `docs/superpowers/specs/2026-07-13-vitest-probe-design.md`

**约定(全任务适用):**
- 分支 `feat/vitest-probe`(已存在,spec 已在其上)。测试 `npx vitest run test/<file>.test.ts`;全量 `npm test`;类型门 `npm run typecheck`。
- 测试绝不真调 docker/vitest/cargo——一律 fake exec 注入。
- 遇计划外必改的文件,先报 NEEDS_CONTEXT 等确认,不许自行扩界。

**实测记录(2026-07-13,写计划时定稿):**
1. **JS 语句节点**(真实 tree-sitter-javascript.wasm):`doWork(a);` → `expression_statement` 子 `call_expression`;`state.value = a+1;` → 子 `assignment_expression`;`total += a;` → 子 `augmented_assignment_expression`;父节点 `statement_block`/`program`。**多行模板串使节点跨行**(`const tpl = \`multi\nline\`` 的声明节点 L7-8)→ 单行过滤天然排除,无 Ruby heredoc 式兄弟节点陷阱;单行模板串调用(`notify(\`one line ${a}\`);`)是安全的单行语句。JS 的 `await x();` 为 `expression_statement > await_expression > call_expression`——现有 `WRAPPERS`(含 `await_expression`/`parenthesized_expression`)可直接复用下钻。
2. **vitest JSON**(easyReview 本仓 vitest 2 实测;chatwoot 3.0.5 同为 jest 兼容格式,验收时校准):`--reporter=json` 输出**单行** JSON 到 stdout,`testResults[]` 每项 `name`=spec **绝对路径(正斜杠,Windows 也是)**、`status`='passed'|'failed';加载失败也是该文件条目 failed(vitest 逐文件隔离)。
3. **既有测试依赖**:`choose-mutation.test.ts` 全 .rs,不依赖"未知语言回退 RUST";唯一锁旧边界的是 `test/verify-unsupported.test.ts`(Task 6 计划内改写,先例同 rspec 轮的 verify-ruby-reject)。

---

### Task 1: parseVitestJson(vitest JSON 输出解析)

**Files:**
- Create: `src/verify/vitest-parse.ts`
- Test: `test/vitest-parse.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { parseVitestJson } from '../src/verify/vitest-parse.js';

const line = (results: Array<{ name: string; status: string }>) =>
  JSON.stringify({ numTotalTests: results.length, success: true, testResults: results.map((r) => ({ ...r, assertionResults: [] })) });

describe('parseVitestJson', () => {
  it('aggregates file-level pass/fail from jest-compatible JSON', () => {
    const out = line([
      { name: '/app/app/javascript/helper/specs/url.spec.js', status: 'passed' },
      { name: '/app/app/javascript/store/specs/actions.spec.js', status: 'failed' },
    ]);
    const run = parseVitestJson(out);
    expect(run.compiled).toBe(true);
    expect(run.results).toEqual([
      { name: 'app/javascript/helper/specs/url.spec.js', passed: true },
      { name: 'app/javascript/store/specs/actions.spec.js', passed: false },
    ]);
  });

  it('finds the JSON line under docker/vitest noise (bottom-up scan)', () => {
    const out = ['Pulling image...', 'stderr noise {not json}', line([{ name: '/app/a.spec.js', status: 'passed' }]), ''].join('\n');
    const run = parseVitestJson(out);
    expect(run.compiled).toBe(true);
    expect(run.results).toEqual([{ name: 'a.spec.js', passed: true }]);
  });

  it('strips windows/sandbox absolute paths via app/javascript anchor', () => {
    const out = line([{ name: 'E:/tmp/easyreview-sandbox/abc/src/app/javascript/x/specs/y.spec.js', status: 'passed' }]);
    expect(parseVitestJson(out).results[0].name).toBe('app/javascript/x/specs/y.spec.js');
  });

  it('empty testResults → compiled:false(套件没跑起来)', () => {
    expect(parseVitestJson(line([]))).toEqual({ compiled: false, results: [] });
  });

  it('no parseable JSON → compiled:false', () => {
    expect(parseVitestJson('docker: error\nnothing here')).toEqual({ compiled: false, results: [] });
  });

  it('a JSON line without testResults key is skipped, real one above it still found', () => {
    const out = [line([{ name: '/app/a.spec.js', status: 'passed' }]), '{"unrelated": true}'].join('\n');
    expect(parseVitestJson(out).compiled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/vitest-parse.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: Write implementation**

```ts
import type { TestRun } from './runner.js';

/** 解析 vitest --reporter=json(jest 兼容)输出,聚合到文件级。
 *  实测(2026-07-13):单行 JSON,testResults[].name=spec 绝对路径(正斜杠,Windows 也是),
 *  status='passed'|'failed';加载失败也是对应文件条目 failed(vitest 逐文件隔离,
 *  无 rspec 式全套件崩)。输出可能混杂 docker/编译噪音:自底向上找含 testResults 键的 JSON 行。
 *  解析不出 / testResults 空 → compiled:false(套件没跑起来)。 */
export function parseVitestJson(output: string): TestRun {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t.startsWith('{')) continue;
    let j: { testResults?: Array<{ name?: string; status?: string }> };
    try { j = JSON.parse(t) as typeof j; } catch { continue; }
    if (!Array.isArray(j.testResults)) continue;
    if (j.testResults.length === 0) return { compiled: false, results: [] };
    const results = j.testResults.map((r) => ({
      name: toRepoRelative(String(r.name ?? '')),
      passed: r.status === 'passed',
    }));
    return { compiled: true, results };
  }
  return { compiled: false, results: [] };
}

/** 绝对→仓相对:剥容器 /app/ 前缀(配方 working_dir=/app);不中按 /app/javascript/ 锚点截取
 *  (chatwoot 前端 spec 全在其下);再不中原样保留(确定性降级,不抛)。 */
function toRepoRelative(p: string): string {
  const n = p.replace(/\\/g, '/');
  if (n.startsWith('/app/')) return n.slice('/app/'.length);
  const i = n.indexOf('/app/javascript/');
  if (i >= 0) return n.slice(i + 1);
  return n;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/vitest-parse.test.ts`
Expected: PASS(6 用例)

- [ ] **Step 5: Commit**

```bash
git add src/verify/vitest-parse.ts test/vitest-parse.test.ts
git commit -m "feat: parseVitestJson——jest 兼容输出的文件级聚合与路径归一"
```

---

### Task 2: pickVitestScope(basename 索引圈定)

**Files:**
- Create: `src/verify/vitest-scope.ts`
- Test: `test/vitest-scope.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile } from './helpers.js';
import { mirrorSpecOf, pickVitestScope } from '../src/verify/vitest-scope.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

function setup() {
  const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
  return dir;
}

describe('mirrorSpecOf', () => {
  const specs = [
    'app/javascript/dashboard/helper/specs/URLHelper.spec.js',
    'app/javascript/dashboard/store/modules/contacts/specs/actions.spec.js',
    'app/javascript/dashboard/store/modules/labels/specs/actions.spec.js',
    'app/javascript/widget/store/spec/actions.spec.js',
  ];

  it('basename match regardless of specs/ nesting level', () => {
    expect(mirrorSpecOf('app/javascript/dashboard/helper/URLHelper.js', specs))
      .toBe('app/javascript/dashboard/helper/specs/URLHelper.spec.js');
  });

  it('collision resolved by longest common dir prefix', () => {
    expect(mirrorSpecOf('app/javascript/dashboard/store/modules/labels/actions.js', specs))
      .toBe('app/javascript/dashboard/store/modules/labels/specs/actions.spec.js');
    expect(mirrorSpecOf('app/javascript/widget/store/actions.js', specs))
      .toBe('app/javascript/widget/store/spec/actions.spec.js');
  });

  it('tie broken alphabetically (determinism)', () => {
    expect(mirrorSpecOf('app/javascript/other/actions.js', specs))
      .toBe('app/javascript/dashboard/store/modules/contacts/specs/actions.spec.js');
  });

  it('vue source maps to its spec.js mirror', () => {
    const s = ['app/javascript/widget/components/specs/App.spec.js'];
    expect(mirrorSpecOf('app/javascript/widget/components/App.vue', s)).toBe(s[0]);
  });

  it('no candidate → null', () => {
    expect(mirrorSpecOf('app/javascript/nowhere/Thing.js', specs)).toBeNull();
  });
});

describe('pickVitestScope', () => {
  it('mirror + reference-scan hits merged', () => {
    const dir = setup();
    writeRepoFile(dir, 'app/javascript/helper/url.js', 'export const make = () => 1;');
    writeRepoFile(dir, 'app/javascript/helper/specs/url.spec.js', "import { make } from '../url';");
    writeRepoFile(dir, 'app/javascript/other/specs/nav.spec.js', "import url from 'helper/url';");
    writeRepoFile(dir, 'app/javascript/other/specs/pure.spec.js', 'no reference here');
    const scope = pickVitestScope(dir, 'app/javascript/helper/url.js', 20)!;
    expect(scope.specFiles).toEqual([
      'app/javascript/helper/specs/url.spec.js',
      'app/javascript/other/specs/nav.spec.js',
    ]);
    expect(scope.scanNote).toBeUndefined();
  });

  it('scan over limit → mirror-only with explicit note', () => {
    const dir = setup();
    writeRepoFile(dir, 'app/javascript/helper/hot.js', 'export const hot = 1;');
    writeRepoFile(dir, 'app/javascript/helper/specs/hot.spec.js', 'hot');
    for (let i = 0; i < 4; i++) writeRepoFile(dir, `app/javascript/x/specs/s${i}.spec.js`, 'uses hot here');
    const scope = pickVitestScope(dir, 'app/javascript/helper/hot.js', 3)!;
    expect(scope.specFiles).toEqual(['app/javascript/helper/specs/hot.spec.js']);
    expect(scope.scanNote).toMatch(/超上限/);
  });

  it('over limit AND no mirror → null; both empty → null', () => {
    const dir = setup();
    writeRepoFile(dir, 'app/javascript/helper/wide.js', 'export const wide = 1;');
    for (let i = 0; i < 4; i++) writeRepoFile(dir, `app/javascript/x/specs/w${i}.spec.js`, 'wide everywhere');
    expect(pickVitestScope(dir, 'app/javascript/helper/wide.js', 3)).toBeNull();
    writeRepoFile(dir, 'app/javascript/helper/lonely.js', 'export const lonely = 1;');
    expect(pickVitestScope(dir, 'app/javascript/helper/lonely.js', 20)).toBeNull();
  });

  it('word boundary: basename "url" does not match "curl" in spec content', () => {
    const dir = setup();
    writeRepoFile(dir, 'app/javascript/helper/url.js', 'export const make = () => 1;');
    writeRepoFile(dir, 'app/javascript/helper/specs/url.spec.js', 'mirror');
    writeRepoFile(dir, 'app/javascript/x/specs/net.spec.js', 'const c = curl();');
    const scope = pickVitestScope(dir, 'app/javascript/helper/url.js', 20)!;
    expect(scope.specFiles).toEqual(['app/javascript/helper/specs/url.spec.js']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/vitest-scope.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: Write implementation**

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface VitestScope { specFiles: string[]; scanNote?: string; }

const SPEC_RE = /\.(spec|test)\.js$/;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'target']);

/** 收集仓内全部 *.spec.js / *.test.js(仓相对、正斜杠)。 */
export function walkSpecs(repo: string, dir = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(repo, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...walkSpecs(repo, rel)); }
    else if (SPEC_RE.test(e.name)) out.push(rel);
  }
  return out;
}

function commonPrefixLen(a: string, b: string): number {
  const as = a.split('/'); const bs = b.split('/');
  let n = 0;
  while (n < as.length && n < bs.length && as[n] === bs[n]) n++;
  return n;
}

function baseOf(file: string): string {
  return file.split('/').pop()!.replace(/\.[^.]+$/, '');
}

/** 镜像 = basename 命中(URLHelper.js → URLHelper.spec.js,specs/ 在哪层都认);
 *  撞名(各 Vuex 模块的 actions.spec.js)取与源文件目录公共前缀最长者,平手取字典序第一。 */
export function mirrorSpecOf(chunkFile: string, specs: string[]): string | null {
  const base = baseOf(chunkFile);
  const candidates = specs
    .filter((s) => { const m = s.split('/').pop()!.match(/^(.*)\.(spec|test)\.js$/); return m?.[1] === base; })
    .sort();
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestLen = commonPrefixLen(chunkFile, best);
  for (const c of candidates.slice(1)) {
    const len = commonPrefixLen(chunkFile, c);
    if (len > bestLen) { best = c; bestLen = len; }
  }
  return best;
}

/** 圈定:镜像 + 引用扫描(词边界 grep 源 basename——JS import 语句天然含它);
 *  超上限回退只跑镜像+显式 note(不静默截断);镜像与扫描皆空 → null。 */
export function pickVitestScope(repo: string, chunkFile: string, scanLimit: number): VitestScope | null {
  const specs = walkSpecs(repo);
  const mirror = mirrorSpecOf(chunkFile, specs);
  const base = baseOf(chunkFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${base}\\b`);
  const hits: string[] = [];
  for (const s of specs) {
    if (s === mirror) continue;
    if (re.test(readFileSync(join(repo, s), 'utf8'))) hits.push(s);
  }
  if (hits.length > scanLimit) {
    if (!mirror) return null;
    return { specFiles: [mirror], scanNote: `引用扫描命中 ${hits.length} 个 spec(超上限 ${scanLimit})——本次只跑镜像 spec。` };
  }
  const specFiles = [...(mirror ? [mirror] : []), ...hits.sort()];
  if (specFiles.length === 0) return null;
  return { specFiles };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/vitest-scope.test.ts`
Expected: PASS(9 用例)

- [ ] **Step 5: Commit**

```bash
git add src/verify/vitest-scope.ts test/vitest-scope.test.ts
git commit -m "feat: pickVitestScope——basename 索引镜像(最长公共前缀消歧)+ 引用扫描"
```

---

### Task 3: vitest runner + id 联合加宽 + rspec 共享导出

**Files:**
- Create: `src/verify/vitest.ts`
- Modify: `src/verify/runner.ts:9`(id 联合)
- Modify: `src/verify/rspec.ts:33`(groupBySpecDir 加 export)
- Test: `test/vitest-runner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadJsRunnerConfig, makeVitestRunner } from '../src/verify/vitest.js';

function tempDir(): string { return mkdtempSync(join(tmpdir(), 'easyrev-vt-')); }

describe('loadJsRunnerConfig', () => {
  it('missing file → actionable error mentioning the recipe', () => {
    const dir = tempDir();
    try { expect(() => loadJsRunnerConfig(dir)).toThrow(/easyreview\.runner\.json/); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('bad JSON → parse error; missing js.cmd → actionable error', () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'easyreview.runner.json'), '{oops');
      expect(() => loadJsRunnerConfig(dir)).toThrow(/解析失败/);
      writeFileSync(join(dir, 'easyreview.runner.json'), JSON.stringify({ version: 1, ruby: { cmd: ['x'] } }));
      expect(() => loadJsRunnerConfig(dir)).toThrow(/js\.cmd/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('valid js section loads (ruby section may coexist)', () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'easyreview.runner.json'),
        JSON.stringify({ version: 1, ruby: { cmd: ['r'] }, js: { cmd: ['node', 'vitest.mjs', '{specFiles}'], scanLimit: 5 } }));
      expect(loadJsRunnerConfig(dir)).toEqual({ cmd: ['node', 'vitest.mjs', '{specFiles}'], scanLimit: 5 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('makeVitestRunner.run', () => {
  it('expands {specFiles}, execs in sandbox src, parses vitest JSON', async () => {
    const runner = makeVitestRunner({ cmd: ['docker', 'run', '{specFiles}'] });
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const fake = async (cmd: string, args: string[], cwd: string) => {
      calls.push({ cmd, args, cwd });
      return JSON.stringify({ testResults: [{ name: '/app/a/specs/b.spec.js', status: 'passed', assertionResults: [] }] });
    };
    const run = await runner.run('/sb/src', '/sb/target', { specFiles: ['a/specs/b.spec.js', 'c.spec.js'] }, fake);
    expect(calls).toEqual([{ cmd: 'docker', args: ['run', 'a/specs/b.spec.js', 'c.spec.js'], cwd: '/sb/src' }]);
    expect(run).toEqual({ compiled: true, results: [{ name: 'a/specs/b.spec.js', passed: true }] });
  });

  it('groups prediction names by top-2 path segments (shared with rspec)', () => {
    const runner = makeVitestRunner({ cmd: ['x'] });
    const groups = runner.group(['app/javascript/x/a.spec.js', 'app/javascript/y/b.spec.js']);
    expect(groups).toHaveLength(1);
    expect(groups[0].module).toBe('app/javascript');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/vitest-runner.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: Write implementation**

`src/verify/runner.ts` 第 9 行 `id: 'rust' | 'ruby';` 改为:

```ts
  id: 'rust' | 'ruby' | 'js';  // js = vitest runner,同时服务 js 与 vue 两种块
```

`src/verify/rspec.ts` 第 33 行 `function groupBySpecDir` 改为 `export function groupBySpecDir`(vitest runner 复用,同为"spec 文件按前两段目录分组")。

新建 `src/verify/vitest.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerifyRunner } from './runner.js';
import { realExec, type Exec } from './cargo.js';
import { expandCmd, groupBySpecDir } from './rspec.js';
import { parseVitestJson } from './vitest-parse.js';
import { pickVitestScope, type VitestScope } from './vitest-scope.js';

export interface JsRunnerConfig { cmd: string[]; scanLimit?: number; }

/** 读仓根 easyreview.runner.json 的 js 节。缺失/无效 → 可操作错误。 */
export function loadJsRunnerConfig(repo: string): JsRunnerConfig {
  const p = join(repo, 'easyreview.runner.json');
  if (!existsSync(p)) {
    throw new Error('verify JS/Vue 需要仓根 easyreview.runner.json——chatwoot 配方见 docs/recipes/chatwoot-vitest.md');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(p, 'utf8')); } catch {
    throw new Error('easyreview.runner.json 解析失败——检查 JSON 语法');
  }
  const js = (parsed as { js?: JsRunnerConfig }).js;
  if (!js || !Array.isArray(js.cmd) || js.cmd.length === 0) {
    throw new Error('easyreview.runner.json 缺少 js.cmd——chatwoot 配方见 docs/recipes/chatwoot-vitest.md');
  }
  return js;
}

/** vitest runner:一个实例同时服务 js 与 vue 块(圈定/执行/分组与语言无关,按 spec 文件走)。 */
export function makeVitestRunner(config: JsRunnerConfig): VerifyRunner {
  return {
    id: 'js',
    pickScope(_g, chunk, repo) {
      const scope = pickVitestScope(repo, chunk.file, config.scanLimit ?? 20);
      if (!scope) {
        throw new Error(`${chunk.file} 找不到可用的 spec 域(镜像 spec 不存在,或引用过广且无镜像)——换个有测试覆盖的块`);
      }
      return { scope, note: scope.scanNote };
    },
    async run(sandboxSrc, _sandboxTarget, scope, exec) {
      const { specFiles } = scope as VitestScope;
      const [cmd, ...args] = expandCmd(config.cmd, specFiles);
      const out = await ((exec ?? realExec) as Exec)(cmd, args, sandboxSrc);
      return parseVitestJson(out);
    },
    group: groupBySpecDir,
  };
}
```

- [ ] **Step 4: Run test + 全量回归 + typecheck**

Run: `npx vitest run test/vitest-runner.test.ts && npm test && npm run typecheck`
Expected: 全 PASS + 0 errors(id 联合加宽不影响现有 `=== 'rust'` 判断)

- [ ] **Step 5: Commit**

```bash
git add src/verify/vitest.ts src/verify/runner.ts src/verify/rspec.ts test/vitest-runner.test.ts
git commit -m "feat: vitest runner——js 节配置加载+{specFiles} 展开+JSON 解析,复用 rspec 分组"
```

---

### Task 4: pick-site 加 JS 目标 + carve 感知(vue)

**Files:**
- Modify: `src/verify/pick-site.ts`(重构 pickPreferredSite,原 87 行)
- Test: `test/pick-site-js.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { pickPreferredSite } from '../src/verify/pick-site.js';
import { JS, VUE } from '../src/extract/lang.js';

describe('pickPreferredSite (js)', () => {
  it('picks the first statement-position call/assignment', async () => {
    const src = [
      "import { x } from './x';",        // 1  import 不是表达式语句
      'export function f(a) {',           // 2
      '  const local = calc(a);',         // 3  声明不是目标
      '  doWork(a);',                      // 4  ← 首个好语句
      '  state.value = a + 1;',            // 5
      '  total += a;',                     // 6
      '}',
    ].join('\n');
    const site = (await pickPreferredSite(src, JS))!;
    expect(site.line).toBe(4);
    expect(site.original).toBe('  doWork(a);');
  });

  it('assignment and augmented assignment are targets too', async () => {
    const src = 'function g() {\n  state.value = 1;\n}\n';
    expect((await pickPreferredSite(src, JS))!.line).toBe(2);
    const src2 = 'function h() {\n  total += 1;\n}\n';
    expect((await pickPreferredSite(src2, JS))!.line).toBe(2);
  });

  it('await-wrapped call unwraps (existing WRAPPERS reused)', async () => {
    const src = 'async function f() {\n  await save();\n}\n';
    expect((await pickPreferredSite(src, JS))!.line).toBe(2);
  });

  it('multi-line template literal statement is excluded by single-line filter', async () => {
    const src = [
      'function f(a) {',
      '  notify(`multi',   // 2-3 跨行——不能选
      '  line ${a}`);',
      '}',
    ].join('\n');
    expect(await pickPreferredSite(src, JS)).toBeNull();
  });

  it('single-line template literal call is a safe target', async () => {
    const src = 'function f(a) {\n  notify(`one ${a}`);\n}\n';
    expect((await pickPreferredSite(src, JS))!.line).toBe(2);
  });
});

describe('pickPreferredSite (vue, carve 感知)', () => {
  it('site lands inside <script> region with real-file line numbers', async () => {
    const sfc = [
      '<template>',              // 1
      '  <div @click="go" />',   // 2  模板里的"调用"不可选
      '</template>',             // 3
      '<script setup>',          // 4
      'const go = () => {',      // 5
      '  emit("done");',         // 6  ← 目标,真实文件行 6
      '};',                      // 7
      '</script>',               // 8
    ].join('\n');
    const site = (await pickPreferredSite(sfc, VUE))!;
    expect(site.line).toBe(6);
    expect(site.original).toBe('  emit("done");');
  });

  it('statement on the opening-tag line is excluded (整行注释会连标签一起注释)', async () => {
    const sfc = '<script setup>doNow();\nrest();\n</script>\n';
    const site = (await pickPreferredSite(sfc, VUE))!;
    expect(site.line).toBe(2);
    expect(site.original).toBe('rest();');
  });

  it('template-only SFC → null', async () => {
    expect(await pickPreferredSite('<template><div /></template>\n', VUE)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pick-site-js.test.ts`
Expected: FAIL(js 走 RUST_TARGET 选不中 / vue 整文件 parse 噪音)

- [ ] **Step 3: Rewrite pickPreferredSite(保持导出签名,内部拆 pickInSource)**

对 `src/verify/pick-site.ts` 做如下改动(其余常量/函数原样保留):

顶部常量区追加:

```ts
// 实测(2026-07-13):JS 语句 = expression_statement,子节点为调用/赋值/复合赋值;
// await x() 为 await_expression 包装(WRAPPERS 可复用下钻)。多行模板串使节点跨行,
// 单行过滤天然排除——无 Ruby heredoc 式兄弟节点陷阱。
const JS_TARGET = new Set(['call_expression', 'assignment_expression', 'augmented_assignment_expression']);
```

`pickPreferredSite` 整体替换为:

```ts
/**
 * 挑一个"好语句"位点(注释后大概率某测试变红而非白改):
 * - Rust:单行 expression_statement,首个具名子节点是赋值/复合赋值/调用/宏调用。
 * - Ruby:单行 call/assignment/operator_assignment 且处于语句位。
 * - JS:单行 expression_statement,子节点是调用/赋值/复合赋值(await/括号下钻)。
 * - Vue:按 carve 区段逐段挑(JS 规则),行号还原到真实文件;区段 row 0(与 <script>
 *   开标签同行)排除——注释整行会连标签一起注释掉。
 * 找不到返回 null。返回 1-based 行号 + 该行完整原文。
 */
export async function pickPreferredSite(
  source: string,
  langSpec: LangSpec = RUST,
): Promise<{ line: number; original: string } | null> {
  if (langSpec.carve) {
    const fullLines = source.split('\n');
    for (const seg of langSpec.carve(source)) {
      const site = await pickInSource(seg.source, langSpec, 1);
      if (site) {
        const row = site.line - 1 + seg.lineOffset;
        return { line: row + 1, original: fullLines[row] };
      }
    }
    return null;
  }
  return pickInSource(source, langSpec, 0);
}

async function pickInSource(
  source: string,
  langSpec: LangSpec,
  minRow: number,
): Promise<{ line: number; original: string } | null> {
  const { parser } = await getParser(langSpec);
  const tree = parser.parse(source);
  const lines = source.split('\n');
  try {
    if (langSpec.id === 'ruby') {
      const candidates = collect(tree.rootNode, (n) =>
        RUBY_TARGET.has(n.type) &&
        n.startPosition.row === n.endPosition.row &&
        n.startPosition.row >= minRow &&
        !!n.parent && RUBY_STMT_PARENT.has(n.parent.type) &&
        !hasHeredoc(n));
      return firstSiteOf(candidates, lines);
    }
    const target = langSpec.id === 'js' || langSpec.id === 'vue' ? JS_TARGET : RUST_TARGET;
    const stmts = collect(tree.rootNode, (n) => n.type === 'expression_statement');
    const candidates = stmts.filter((n) => {
      if (n.startPosition.row !== n.endPosition.row) return false;
      if (n.startPosition.row < minRow) return false;
      const inner = unwrap(n.namedChild(0));
      return !!inner && target.has(inner.type);
    });
    return firstSiteOf(candidates, lines);
  } finally {
    tree.delete();
  }
}
```

(说明:碰 vue 时 `getParser(VUE)` 加载的就是 JS 语法——注册表里 VUE.wasm 即 JS wasm。
carve 区段 row>0 的行与真实文件行逐字节相同,original 取自 fullLines 与 withMutation 的行校验一致。)

- [ ] **Step 4: Run test + 既有位点测试回归**

Run: `npx vitest run test/pick-site-js.test.ts test/pick-site-ruby.test.ts test/choose-mutation.test.ts && npm test`
Expected: 全 PASS(rust/ruby 路径行为不变:minRow=0 是恒真过滤)

- [ ] **Step 5: Commit**

```bash
git add src/verify/pick-site.ts test/pick-site-js.test.ts
git commit -m "feat: pick-site 支持 JS 语句位点与 vue carve 区段(行号还原,开标签行排除)"
```

---

### Task 5: mutate 显式语言分派 + isCommentableJs(死码清理)

**Files:**
- Modify: `src/verify/mutate.ts`
- Test: `test/mutate-js.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { chooseMutation } from '../src/verify/mutate.js';
import type { Chunk, Leaf } from '../src/types.js';

const mk = (file: string): { chunk: Chunk; leaves: (s: number, e: number) => Leaf[] } => ({
  chunk: { id: file, name: 'x', file, crate: 'app', leafIds: [] },
  leaves: (s, e) => [{ id: 'l', kind: 'fn', name: 'x', file, startLine: s, endLine: e, loc: e - s + 1 }],
});

describe('chooseMutation (js)', () => {
  it('js chunk gets // prefix via tree-sitter site', async () => {
    const { chunk, leaves } = mk('app/javascript/helper/url.js');
    const src = 'export function f(a) {\n  doWork(a);\n  return a;\n}\n';
    const op = (await chooseMutation(chunk, leaves(1, 4), src))!;
    expect(op.line).toBe(2);
    expect(op.mutated).toBe('  // doWork(a);');
  });

  it('regex fallback: takes first ;-terminated line, skips backtick lines', async () => {
    const { chunk, leaves } = mk('app/javascript/helper/plain.js');
    // 无 tree-sitter 好语句(只有声明),回退 regex
    const src = [
      'export function f() {',        // 1  不以 ; 结尾
      '  const q = `has backtick`;',  // 2  含反引号——保守跳过
      '  const v = 1;',               // 3  ← 回退选这行
      '}',
    ].join('\n');
    const op = (await chooseMutation(chunk, leaves(1, 4), src))!;
    expect(op.line).toBe(3);
    expect(op.mutated).toBe('  // const v = 1;');
  });

  it('vue chunk mutates inside script region only', async () => {
    const { chunk } = mk('app/javascript/widget/App.vue');
    const sfc = [
      '<template>',
      '  <div @click="go" />',
      '</template>',
      '<script setup>',
      'const go = () => {',
      '  emit("done");',
      '};',
      '</script>',
    ].join('\n');
    const vueLeaves: Leaf[] = [{ id: 'l', kind: 'fn', name: 'go', file: chunk.file, startLine: 5, endLine: 7, loc: 3 }];
    const op = (await chooseMutation(chunk, vueLeaves, sfc))!;
    expect(op.line).toBe(6);
    expect(op.mutated).toBe('  // emit("done");');
  });

  it('unknown language → null (不再回退 RUST——PR #11 终审回访)', async () => {
    const chunk: Chunk = { id: 'notes.txt', name: 'notes', file: 'notes.txt', crate: 'root', leafIds: [] };
    const leaves: Leaf[] = [{ id: 'l', kind: 'fn', name: 'x', file: 'notes.txt', startLine: 1, endLine: 3, loc: 3 }];
    expect(await chooseMutation(chunk, leaves, 'do_thing();\n')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mutate-js.test.ts`
Expected: FAIL(js 走 isCommentableRust 分支行为不对 / 未知语言回退 RUST 不为 null)
(注:第 1、3 用例可能借 Task 4 的 pick-site 已绿——至少第 2、4 用例红即确认 TDD 有效。)

- [ ] **Step 3: Modify mutate.ts**

`isCommentableRuby` 之后追加:

```ts
/** JS/Vue regex 回退:只要完整单行语句(以 ; 结尾);含反引号的行保守跳过——
 *  regex 层判不了模板串上下文。已知局限:多行模板串的内部行若不含反引号且以 ; 结尾
 *  仍可能被选中(注释它只是改字符串内容,不破坏语法,最坏 uncovered 兜底)。 */
function isCommentableJs(line: string): boolean {
  const t = line.trim();
  if (t === '' || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return false;
  if (!t.endsWith(';')) return false;
  if (t.includes('`')) return false;
  return true;
}
```

`chooseMutation` 开头两行:

```ts
  const lang = langOf(chunk.file) ?? RUST;
  const pref = await pickPreferredSite(source, lang);
```

改为:

```ts
  // 显式分派:未知语言返回 null,不再回退 RUST(PR #11 终审回访——拆掉被 runnerFor 遮蔽的陷阱)
  const lang = langOf(chunk.file);
  if (!lang) return null;
  const pref = await pickPreferredSite(source, lang);
```

`const commentable = lang.id === 'ruby' ? isCommentableRuby : isCommentableRust;` 改为:

```ts
  const commentable =
    lang.id === 'ruby' ? isCommentableRuby :
    lang.id === 'rust' ? isCommentableRust : isCommentableJs;
```

顶部 import 行 `import { langOf, RUST } from '../extract/lang.js';` 改为 `import { langOf } from '../extract/lang.js';`(RUST 不再使用)。
`buildOp` 不动——`langOf(file)?.id === 'ruby' ? '# ' : '// '` 对 js/vue 已经给 `// `。

- [ ] **Step 4: Run test + 全量回归 + typecheck**

Run: `npx vitest run test/mutate-js.test.ts test/choose-mutation.test.ts test/pick-site-ruby.test.ts && npm test && npm run typecheck`
Expected: 全 PASS + 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/verify/mutate.ts test/mutate-js.test.ts
git commit -m "feat: mutate 显式语言分派(未知→null,拆 RUST 回退死码)+ isCommentableJs 回退"
```

---

### Task 6: cli-verify 接线 + verify-unsupported 改写 + js/vue happy path

**Files:**
- Modify: `src/cli-verify.ts`(runnerFor + 三处文案)
- Modify: `test/verify-unsupported.test.ts`(整文件改写——旧边界"vue/js 一律拒"失效)
- Test: `test/cli-verify-js.test.ts`(新)

- [ ] **Step 1: 改 cli-verify.ts(三处)**

(a) import 区追加:

```ts
import { loadJsRunnerConfig, makeVitestRunner } from './verify/vitest.js';
```

(b) `runnerFor` 改为:

```ts
function runnerFor(chunk: Chunk, repo: string): VerifyRunner {
  const lang = langOf(chunk.file)?.id;
  if (lang === 'rust') return cargoRunner;
  if (lang === 'ruby') return makeRspecRunner(loadRubyRunnerConfig(repo));
  if (lang === 'js' || lang === 'vue') return makeVitestRunner(loadJsRunnerConfig(repo));
  throw new Error(`verify（突变探针）暂只支持 Rust（cargo）、Ruby（rspec）与 JS/Vue（vitest）；\`${chunk.file}\` 不在支持范围。`);
}
```

(c) show 里冷启动提示三分支(原二分支 ternary 处):

```ts
  console.error(
    runner.id === 'rust'
      ? (firstRun
          ? `⏳ 沙箱首次全量编译 ${chunk.crate} 可能要 5-10 分钟（独立缓存,不碰真实仓的 target/），属正常、不是卡住。`
          : `⏳ 编译 ${chunk.crate}（沙箱增量）…`)
      : runner.id === 'ruby'
        ? `⏳ 运行 rspec（docker 冷启动/bundle 首次可能较慢）…`
        : `⏳ 运行 vitest（docker 冷启动/依赖首装后首跑较慢）…`,
  );
```

(d) show 里基线 `!baseline.compiled` 报错三分支:

```ts
  if (!baseline.compiled) {
    throw new Error(
      runner.id === 'rust'
        ? `${chunk.crate} 的基线 cargo test 无法编译——先修好编译错误再验证这个块。`
        : runner.id === 'ruby'
          ? '基线 rspec 无法加载或零 example——先确认测试环境可用（docs/recipes/chatwoot-rspec.md）。'
          : '基线 vitest 没跑起来或零结果——先确认测试环境可用（docs/recipes/chatwoot-vitest.md）。',
    );
  }
```

predict 的非 rust `brokeLine`/`noteLine` 文案**不动**——"spec 套件加载失败"对 vitest 的
compiled:false(套件级没跑起来)同样成立;vitest 逐文件隔离下加载失败通常表现为对应 spec 变红,
走正常 newly-failing 判定,不进 compileBroke 分支。verify.md 的非 rust 文案(`相关 spec 文件`/
spec 路径预测提示)对 js/vue 原样适用。

- [ ] **Step 2: 改写 test/verify-unsupported.test.ts(整文件替换)**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { runMap } from '../src/cli.js';
import { runVerifyShow, runVerifyPredict } from '../src/cli-verify.js';
import { sandboxFor } from '../src/verify/sandbox.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

/** 2026-07-13 改写:JS/Vue 已获支持(vitest 探针)——本文件从「vue/js 一律拒绝」改锁新边界:
 *  无 easyreview.runner.json 时 show/predict 都给可操作报错,且零 exec 调用、零沙箱副作用。 */
describe('verify js/vue without runner config', () => {
  async function setup() {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    const sb = sandboxFor(dir);
    cleanups.push(() => rmSync(sb.dir, { recursive: true, force: true }));
    writeRepoFile(dir, 'app/javascript/widget/App.vue',
      '<template><div /></template>\n<script setup>\nconst go = () => 1;\n</script>\n');
    writeRepoFile(dir, 'app/javascript/helper/url.js', 'export const make = () => 2;\n');
    commitAll(dir, 'init');
    await runMap({ repo: dir, outDir: dir });
    return dir;
  }

  it('vue chunk show: actionable config error, exec untouched, no sandbox', async () => {
    const dir = await setup();
    let execCalled = false;
    await expect(
      runVerifyShow({ repo: dir, outDir: dir, chunkId: 'app/javascript/widget/App.vue',
        exec: async () => { execCalled = true; return ''; } }),
    ).rejects.toThrow(/easyreview\.runner\.json/);
    expect(execCalled).toBe(false);
    expect(existsSync(sandboxFor(dir).dir)).toBe(false);
  });

  it('js chunk predict: same config error, zero side effects', async () => {
    const dir = await setup();
    let execCalled = false;
    await expect(
      runVerifyPredict({ repo: dir, outDir: dir, chunkId: 'app/javascript/helper/url.js',
        predicted: ['whatever'], exec: async () => { execCalled = true; return ''; } }),
    ).rejects.toThrow(/easyreview\.runner\.json/);
    expect(execCalled).toBe(false);
    expect(existsSync(sandboxFor(dir).dir)).toBe(false);
  });
});
```

- [ ] **Step 3: 新建 test/cli-verify-js.test.ts(happy path,全 fake exec)**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { runMap } from '../src/cli.js';
import { runVerifyShow, runVerifyPredict } from '../src/cli-verify.js';
import { sandboxFor } from '../src/verify/sandbox.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

const vitestJson = (entries: Array<[string, boolean]>) =>
  JSON.stringify({ testResults: entries.map(([name, ok]) => ({ name: `/app/${name}`, status: ok ? 'passed' : 'failed', assertionResults: [] })) });

async function setup() {
  const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
  const sb = sandboxFor(dir);
  cleanups.push(() => rmSync(sb.dir, { recursive: true, force: true }));
  writeRepoFile(dir, 'app/javascript/helper/url.js',
    'export function make(a) {\n  doWork(a);\n  return a;\n}\n');
  writeRepoFile(dir, 'app/javascript/helper/specs/url.spec.js',
    "import { make } from '../url';\ndescribe('make', () => {});\n");
  writeRepoFile(dir, 'easyreview.runner.json',
    JSON.stringify({ version: 1, js: { cmd: ['fakedocker', 'vitest', '{specFiles}'], scanLimit: 20 } }));
  commitAll(dir, 'init');
  await runMap({ repo: dir, outDir: dir });
  return dir;
}

describe('verify js chunk end-to-end (fake exec)', () => {
  it('show: scopes mirror spec, writes baseline + spec-file predict prompt', async () => {
    const dir = await setup();
    const exec = async () => vitestJson([['app/javascript/helper/specs/url.spec.js', true]]);
    await runVerifyShow({ repo: dir, outDir: dir, chunkId: 'app/javascript/helper/url.js', exec });
    const baseline = JSON.parse(readFileSync(join(dir, 'easyreview.verify-baseline.json'), 'utf8'));
    expect(baseline.green).toEqual(['app/javascript/helper/specs/url.spec.js']);
    expect((baseline.scope as { specFiles: string[] }).specFiles).toEqual(['app/javascript/helper/specs/url.spec.js']);
    expect(baseline.op.mutated).toContain('// ');
    const md = readFileSync(join(dir, 'easyreview.verify.md'), 'utf8');
    expect(md).toContain('相关 spec 文件');
    expect(md).toContain('```javascript');
  });

  it('predict: mutation turns mirror spec red, hit → verified', async () => {
    const dir = await setup();
    const sb = sandboxFor(dir);
    const spec = 'app/javascript/helper/specs/url.spec.js';
    const green = async () => vitestJson([[spec, true]]);
    await runVerifyShow({ repo: dir, outDir: dir, chunkId: 'app/javascript/helper/url.js', exec: green });
    // 突变后:沙箱里的源文件包含被注释的行 → 返回红
    const after = async () => {
      const mutatedNow = readFileSync(join(sb.srcDir, 'app/javascript/helper/url.js'), 'utf8').includes('// doWork');
      return vitestJson([[spec, !mutatedNow]]);
    };
    await runVerifyPredict({ repo: dir, outDir: dir, chunkId: 'app/javascript/helper/url.js', predicted: [spec], exec: after });
    const progress = JSON.parse(readFileSync(join(dir, 'easyreview.progress.json'), 'utf8'));
    expect(progress.verified).toContain('app/javascript/helper/url.js');
    const md = readFileSync(join(dir, 'easyreview.verify.md'), 'utf8');
    expect(md).toContain('✅');
  });

  it('vue chunk routes to vitest runner (mirror spec of App.vue)', async () => {
    const dir = await setup();
    writeRepoFile(dir, 'app/javascript/widget/App.vue',
      '<template>\n  <div @click="go" />\n</template>\n<script setup>\nconst go = () => {\n  emit("done");\n};\n</script>\n');
    writeRepoFile(dir, 'app/javascript/widget/specs/App.spec.js', "import App from '../App.vue';\n");
    commitAll(dir, 'vue');
    await runMap({ repo: dir, outDir: dir });
    const exec = async () => vitestJson([['app/javascript/widget/specs/App.spec.js', true]]);
    await runVerifyShow({ repo: dir, outDir: dir, chunkId: 'app/javascript/widget/App.vue', exec });
    const baseline = JSON.parse(readFileSync(join(dir, 'easyreview.verify-baseline.json'), 'utf8'));
    expect(baseline.op.line).toBe(6); // emit("done") 在 script 区域内的真实文件行
    expect(baseline.op.mutated).toContain('// emit');
    const md = readFileSync(join(dir, 'easyreview.verify.md'), 'utf8');
    expect(md).toContain('```vue');
  });
});
```

- [ ] **Step 4: Run 全部相关测试 + 全量 + typecheck**

Run: `npx vitest run test/cli-verify-js.test.ts test/verify-unsupported.test.ts test/cli-verify.test.ts && npm test && npm run typecheck`
Expected: 全 PASS + 0 errors(rust/ruby 路径零变化)

- [ ] **Step 5: Commit**

```bash
git add src/cli-verify.ts test/verify-unsupported.test.ts test/cli-verify-js.test.ts
git commit -m "feat: verify 接通 js/vue——runnerFor 分发 vitest,无配置可操作报错,happy path 锁定"
```

---

### Task 7: chatwoot 配方文档 + HANDOFF + 全量门

**Files:**
- Create: `docs/recipes/chatwoot-vitest.md`
- Modify: `docs/HANDOFF.md`

- [ ] **Step 1: 写 docs/recipes/chatwoot-vitest.md**

```markdown
# chatwoot vitest 环境配方(easyreview verify 用)

verify JS/Vue 需要能跑 vitest 的环境。本配方给既有 `docker-compose.easyreview.yaml`
(见 [chatwoot-rspec.md](./chatwoot-rspec.md),项目名已钉 `chatwoot-easyreview`)加一个 node 服务。
chatwoot 前端:vitest 3.0.5 + jsdom;node 24.x(.nvmrc)/ pnpm 10.2.0(packageManager)/ husky ^7。

**状态:待真仓验收(验收后更新本行)。**

## 一次性安装

1. 在 chatwoot 仓根的 `docker-compose.easyreview.yaml` 里加 `vitest` 服务与两个命名卷(模板见下)。
2. `easyreview.runner.json` 加 `js` 节(模板见下,与 `ruby` 节并列)。
3. 安装依赖(首次 10-30 分钟;装进命名卷,与沙箱/真仓路径无关):

​```powershell
cd <chatwoot 仓根>
docker compose -f docker-compose.easyreview.yaml run --rm -T vitest sh -c "corepack enable && pnpm install"
​```

已知雷:
- **`HUSKY: 0` 必须有**(已进模板)——挂载目录无 `.git`,prepare 脚本(`husky install`)会炸 pnpm install。
- **node_modules 放命名卷 `frontend_modules`**——与 rspec 的 bundle 卷同一心智:一次安装,
  verify 从沙箱跑时靠钉死的项目名复用;沙箱同步永远看不见它。宿主机(Windows)不装前端依赖。
- **`TZ: UTC`**(已进模板)——chatwoot 的 test script 前缀要求,时区敏感 spec 会红。
- `cmd` 用 `node node_modules/vitest/vitest.mjs` 而非 `npx`——easyreview 用 execFile 不经 shell。
- pnpm 版本由 `packageManager` 字段钉死,`corepack enable` 后自动匹配。

## docker-compose.easyreview.yaml 增补(模板)

​```yaml
  vitest:
    image: node:24
    working_dir: /app
    volumes:
      - .:/app
      - frontend_modules:/app/node_modules
      - pnpm_store:/root/.local/share/pnpm/store
    environment:
      TZ: UTC
      HUSKY: 0
​```

volumes 顶层追加:

​```yaml
volumes:
  bundle:
  frontend_modules:
  pnpm_store:
​```

## easyreview.runner.json 的 js 节(模板)

​```json
"js": {
  "cmd": ["docker", "compose", "-f", "docker-compose.easyreview.yaml", "run", "--rm", "-T", "vitest", "node", "node_modules/vitest/vitest.mjs", "run", "--reporter=json", "{specFiles}"],
  "scanLimit": 20
}
​```

## 工作原理

verify 的 cwd 是沙箱 `src/`;compose 文件是仓内普通文件、随同步进沙箱,`.:/app` 挂载的就是沙箱——
突变对容器可见,真实仓零接触。`{specFiles}` 展开为镜像 spec + 引用扫描命中(超上限回退只跑镜像)。
vitest 逐文件隔离:突变致模块加载失败只红 import 它的 spec 文件,就是正常爆炸半径。

## 已知局限

- 镜像匹配按 basename(specs/ 在哪层都认),撞名取目录公共前缀最长——极端同名同层会选错,接受。
- 引用扫描按源文件 basename 词边界 grep:注释/字符串里的名字也算命中,确定性启发,接受。
- .vue 组件大多无行为 spec——圈不到域时按提示换块。
- regex 回退可能选中多行模板串的内部行(不含反引号且以 ; 结尾)——注释它只改字符串内容,
  不破坏语法,最坏 uncovered 兜底。
​```

(注意:上面代码围栏里的 ​``` 写入真实文件时用正常三反引号——此处为嵌套围栏的转义表示。)

- [ ] **Step 2: 更新 docs/HANDOFF.md(四处)**

1. ③ 执行验证段落,`# 2026-07-12 起支持 Ruby/rspec：…` 行后追加一行:
   `# 2026-07-13 起支持 JS/Vue/vitest：同一 easyreview.runner.json 加 js 节（chatwoot 配方 docs/recipes/chatwoot-vitest.md），`
   `#   范围=basename 镜像 spec+引用扫描（超上限回退），预测粒度=spec 文件级;.vue 突变只落在 <script> 区域。`
2. 代码地图表,`verify/rspec-parse.ts` 行后追加三行:
   `| \`verify/vitest.ts\` | js 节配置加载 + VitestRunner（一个 runner 服务 js/vue 两种块）|`
   `| \`verify/vitest-scope.ts\` | basename 索引镜像 spec（最长公共前缀消歧）+ 引用扫描 + 上限回退 |`
   `| \`verify/vitest-parse.ts\` | vitest --reporter=json 解析（噪音容忍、路径归一、文件级聚合）|`
   同表 `verify/pick-site.ts` 行职责末尾追加:`;JS 语句位点 + vue 按 carve 区段(2026-07-13)`;
   `verify/mutate.ts` 行职责末尾追加:`;未知语言显式 null(不再回退 RUST)`。
3. "下一步"清单末尾追加:
   `8. ~~**vitest 突变探针**~~ ✅ 已完成（分支 feat/vitest-probe，见 \`docs/superpowers/plans/2026-07-13-vitest-probe.md\`）。verify 全语言闭环:runnerFor 分发 vitest（js/vue 共用）;圈定=basename 索引镜像+引用扫描;位点=JS 语句+vue carve 区段(开标签行排除);死码清理(未知语言→null);vitest 逐文件隔离使加载失败=正常爆炸半径,judge 零改动。`
   (真仓验收结果验收后由主会话补进这一条。)
4. 顶部测试计数按 Step 3 实测更新。

- [ ] **Step 3: 全量门**

Run: `npm test && npm run typecheck`
Expected: 全 PASS + 0 errors;记录文件数/用例数回填 HANDOFF。

- [ ] **Step 4: Commit**

```bash
git add docs/recipes/chatwoot-vitest.md docs/HANDOFF.md
git commit -m "docs: chatwoot vitest 配方 + HANDOFF——verify 全语言闭环"
```

---

### Task 8(主会话自跑,不派 subagent): chatwoot 真仓验收

- [ ] 配方落地:chatwoot 仓根 compose 加 vitest 服务与命名卷、runner.json 加 js 节(均为未跟踪本地文件);
  `docker compose -f docker-compose.easyreview.yaml run --rm -T vitest sh -c "corepack enable && pnpm install"`(首次 10-30 分钟)。
- [ ] `URLHelper.js` 端到端:show 圈定(镜像 `dashboard/helper/specs/URLHelper.spec.js` + 引用扫描)→
  基线绿 → 真实突变 → 镜像 spec 红 → 预测命中 → verified。
- [ ] 第二发:找一个有镜像 spec 的 .vue 块(`git ls-files 'app/javascript/**/specs/*.spec.js'` 里挑
  basename 对应 .vue 的),验证位点落在 script 区域、行号正确。
- [ ] chatwoot 真仓零接触(`git -C <chatwoot> status` 除三个配方文件外 0 改动)、沙箱字节还原。
- [ ] 踩到的雷回写 `docs/recipes/chatwoot-vitest.md`(状态行 + 已知雷),真仓验收结果补进 HANDOFF 第 8 条。

---

## Self-Review(已做)

- **Spec 覆盖**:§2 配方(T7/T8)、§3 runner(T3)、§4 圈定(T2)、§5 位点/突变/死码(T4/T5)、§6 接线与改写(T6)、§7 解析(T1)、§8 单测分布于各任务+验收(T8)。无缺口。
- **占位符**:无 TBD;全部代码逐字给出;配方文档嵌套围栏已注明转义。
- **类型一致性**:`VitestScope{specFiles,scanNote?}` T2 定义、T3 消费、T6 baseline 断言一致;`JsRunnerConfig` 命名前后一致;`pickInSource(source, langSpec, minRow)` 仅 T4 内部;`TestRun` 从 runner.js 引入(T1)。
- **既有测试依赖**:已全局搜过——`choose-mutation.test.ts` 全 .rs 不受显式分派影响;`verify-unsupported.test.ts` 是唯一锁旧边界者(T6 计划内改写);`pick-site-ruby.test.ts` 走 ruby 分支(minRow=0 恒真)。
