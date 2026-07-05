# easyReview 计划① — 引擎地基 + 接地地图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 easyReview 引擎的地基，对 umwelt-bevy 产出一份"确定性接地"的三层树 + 风险×架构贡献度二维地图（Markdown），证明"接地不是叙述"。

**Architecture:** Node/TypeScript 引擎，纯确定性管线：tree-sitter 解析 Rust → 三层树（章=crate/mod/目录，块=文件，叶=函数）→ 从 git 历史算两轴复合分（相对churn/change coupling/所有权/中心度，按仓库分位标定）→ 渲染 Markdown 地图。本计划**不含 LLM**（标签/路径在计划②，验证在计划③）。

**Tech Stack:** Node 20+, TypeScript(ESM), vitest, web-tree-sitter(WASM), tree-sitter-wasms(预编译 rust 语法), git via node:child_process, tsx。

**Target repo（分析对象）:** `D:\dev\umwelt-bevy`（Rust/Bevy workspace，crate: chem_field, grid_workshop）。

---

## 文件结构

```
easyReview/
  package.json          # Task 1
  tsconfig.json         # Task 1
  vitest.config.ts      # Task 1
  src/
    types.ts            # Task 1  共享数据类型
    git.ts              # Task 2  git 命令封装 + 仓库文件/历史读取
    extract/
      rust.ts           # Task 3  tree-sitter Rust 叶子提取
      tree.ts           # Task 4  组装三层树
    grade/
      churn.ts          # Task 5  相对 churn 信号
      coupling.ts       # Task 6  change coupling 信号
      ownership.ts      # Task 7  基于提交的所有权信号
      centrality.ts     # Task 8  名字出现 fan-in 中心度信号（v1 近似）
      grade.ts          # Task 9  复合 + 分位标定 + 分桶 → GradedTree
    render/
      map-md.ts         # Task 10 Markdown 风险×贡献度地图
    cli.ts              # Task 11 CLI 入口 `easyreview map`
  test/
    helpers.ts          # Task 2  临时 git 仓库 + rust fixture 构造
    *.test.ts
```

设计原则：每个信号一个文件、单一职责、纯函数、可独立测试。`grade.ts` 只做组合，不重新算信号。

---

### Task 1: 项目脚手架 + 共享类型

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/types.ts`, `test/types.test.ts`

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "easyreview",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "easyreview": "./src/cli.ts" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "map": "tsx src/cli.ts map"
  },
  "dependencies": {
    "web-tree-sitter": "^0.22.6",
    "tree-sitter-wasms": "^0.1.11"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: 写 vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000, // tree-sitter wasm + git 子进程可能慢
  },
});
```

- [ ] **Step 4: 写共享类型 src/types.ts**

```ts
export type NodeId = string;

export interface Leaf {
  id: NodeId;          // `${file}::${name}::${startLine}`
  kind: 'fn';
  name: string;
  file: string;        // 相对 repo 根的 POSIX 路径
  startLine: number;   // 1-based
  endLine: number;
  loc: number;
}

export interface Chunk {
  id: NodeId;          // 相对文件路径
  name: string;        // v1: 文件名（无扩展名）
  file: string;
  crate: string;
  leafIds: NodeId[];
}

export interface Chapter {
  id: NodeId;          // `${crate}:${dir}`
  name: string;        // `${crate}::${dir}` 人读标签
  crate: string;
  dir: string;         // crate 内相对目录，'' = crate 根
  chunkIds: NodeId[];
}

export interface Tree {
  repo: string;
  chapters: Chapter[];
  chunks: Chunk[];
  leaves: Leaf[];
}

export type RiskBucket = 'none' | 'low' | 'med' | 'high';
export type ContribBucket = 'filler' | 'low' | 'med' | 'high';

export interface Signals {
  relChurn: number;    // 0..1
  coupling: number;    // 0..1
  ownership: number;   // 0..1（所有权集中度）
  centrality: number;  // 0..1
  sizeNorm: number;    // 0..1（LOC 分位）
}

export interface Grade {
  risk: number;            // 0..1 复合
  riskBucket: RiskBucket;
  contribution: number;    // 0..1 复合
  contribBucket: ContribBucket;
  signals: Signals;
}

/** 每个 chunk 一份 grade（v1 在 chunk=文件粒度打分）。 */
export interface GradedTree extends Tree {
  grades: Record<NodeId, Grade>; // key = chunk.id
}
```

- [ ] **Step 5: 写会失败的测试 test/types.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import type { Leaf } from '../src/types.js';

describe('types', () => {
  it('Leaf shape is usable', () => {
    const leaf: Leaf = {
      id: 'a.rs::foo::1', kind: 'fn', name: 'foo',
      file: 'a.rs', startLine: 1, endLine: 3, loc: 3,
    };
    expect(leaf.name).toBe('foo');
  });
});
```

- [ ] **Step 6: 安装依赖并运行测试**

Run: `npm install && npm test`
Expected: 通过（1 passed）。若 tree-sitter 相关包安装失败，先解决安装再继续——后续任务依赖它。

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts src/types.ts test/types.test.ts package-lock.json
git commit -m "feat(engine): scaffold + shared types"
```

---

### Task 2: git 封装 + 测试辅助（临时仓库/fixture 构造）

**Files:**
- Create: `src/git.ts`, `test/helpers.ts`, `test/git.test.ts`

- [ ] **Step 1: 写测试辅助 test/helpers.ts**

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

/** 在临时目录建一个 git 仓库；返回其绝对路径。调用方负责 cleanup()。 */
export function makeTempRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'easyrev-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 写文件（自动建目录）。path 相对 repo 根。 */
export function writeRepoFile(dir: string, path: string, content: string): void {
  const abs = join(dir, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** 提交当前工作区所有改动。 */
export function commitAll(dir: string, msg: string, author?: string): void {
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  const env = author
    ? { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${author}@t`,
        GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: `${author}@t` }
    : process.env;
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir, stdio: 'pipe', env });
}
```

- [ ] **Step 2: 写会失败的测试 test/git.test.ts**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { listTrackedFiles, logNameOnly } from '../src/git.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

describe('git', () => {
  it('lists tracked files (POSIX paths)', () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'src/a.rs', 'fn a() {}');
    writeRepoFile(dir, 'src/b.rs', 'fn b() {}');
    commitAll(dir, 'init');
    expect(listTrackedFiles(dir).sort()).toEqual(['src/a.rs', 'src/b.rs']);
  });

  it('logNameOnly returns one commit record per commit with its files', () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'a.rs', '1'); commitAll(dir, 'c1', 'alice');
    writeRepoFile(dir, 'a.rs', '2'); writeRepoFile(dir, 'b.rs', '1');
    commitAll(dir, 'c2', 'bob');
    const log = logNameOnly(dir);
    expect(log).toHaveLength(2);
    expect(log[0].files).toContain('a.rs'); // 最新在前
    expect(log[0].files).toContain('b.rs');
    expect(log[0].author).toBe('bob');
    expect(log[1].files).toEqual(['a.rs']);
    expect(log[1].author).toBe('alice');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test -- git`
Expected: FAIL（`listTrackedFiles` / `logNameOnly` 未定义）。

- [ ] **Step 4: 实现 src/git.ts**

```ts
import { execFileSync } from 'node:child_process';

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo, stdio: 'pipe', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

/** 被 git 跟踪的文件（相对 repo 根，POSIX 斜杠）。 */
export function listTrackedFiles(repo: string): string[] {
  return git(repo, ['ls-files'])
    .split('\n').map((s) => s.trim()).filter(Boolean);
}

export interface CommitRecord {
  hash: string;
  author: string;
  files: string[]; // 该提交触及的文件（相对 repo 根）
}

/**
 * 解析 `git log --name-only`，每个提交一条记录，最新在前。
 * 用 NUL 分隔的自定义格式稳健解析。
 */
export function logNameOnly(repo: string): CommitRecord[] {
  const SEP = '';
  const raw = git(repo, [
    'log', '--no-merges', `--format=${SEP}%H%x00%an`, '--name-only',
  ]);
  const records: CommitRecord[] = [];
  for (const block of raw.split(SEP)) {
    if (!block.trim()) continue;
    const [header, ...rest] = block.split('\n');
    const [hash, author] = header.split(' ');
    const files = rest.map((s) => s.trim()).filter(Boolean);
    records.push({ hash, author: author ?? '', files });
  }
  return records;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -- git`
Expected: PASS（2 passed）。

- [ ] **Step 6: Commit**

```bash
git add src/git.ts test/helpers.ts test/git.test.ts
git commit -m "feat(engine): git wrapper (tracked files + name-only log) and test helpers"
```

---

### Task 3: tree-sitter Rust 叶子提取（前置最大技术风险）

**Files:**
- Create: `src/extract/rust.ts`, `test/rust.test.ts`

- [ ] **Step 1: 写会失败的测试 test/rust.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { extractLeaves } from '../src/extract/rust.js';

const SRC = `
pub fn top() -> i32 { 1 }

struct S;
impl S {
    fn method(&self) {
        let x = 1;
    }
}
`;

describe('extractLeaves', () => {
  it('finds free functions and impl methods with line spans', async () => {
    const leaves = await extractLeaves('src/s.rs', SRC);
    const names = leaves.map((l) => l.name).sort();
    expect(names).toEqual(['method', 'top']);
    const top = leaves.find((l) => l.name === 'top')!;
    expect(top.file).toBe('src/s.rs');
    expect(top.kind).toBe('fn');
    expect(top.startLine).toBeGreaterThan(0);
    expect(top.endLine).toBeGreaterThanOrEqual(top.startLine);
    expect(top.loc).toBe(top.endLine - top.startLine + 1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- rust`
Expected: FAIL（`extractLeaves` 未定义）。

- [ ] **Step 3: 实现 src/extract/rust.ts**

说明：用 `web-tree-sitter`（WASM，免 native 构建）。rust 语法 wasm 来自 `tree-sitter-wasms` 包。Parser 单例懒加载。

```ts
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Parser, Language, Query } from 'web-tree-sitter';
import type { Leaf } from '../types.js';

const require = createRequire(import.meta.url);

let parserPromise: Promise<Parser> | null = null;
let langCache: Language | null = null;

async function getParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init();
      const wasmPath = require.resolve('tree-sitter-wasms/out/tree-sitter-rust.wasm');
      langCache = await Language.load(readFileSync(wasmPath));
      const p = new Parser();
      p.setLanguage(langCache);
      return p;
    })();
  }
  return parserPromise;
}

// Rust 中 free fn 与 impl 方法都是 function_item 节点。
const QUERY = '(function_item name: (identifier) @name) @fn';

export async function extractLeaves(file: string, source: string): Promise<Leaf[]> {
  const parser = await getParser();
  const tree = parser.parse(source);
  const query = new Query(langCache!, QUERY);
  const leaves: Leaf[] = [];
  for (const m of query.matches(tree.rootNode)) {
    const fnNode = m.captures.find((c) => c.name === 'fn')!.node;
    const nameNode = m.captures.find((c) => c.name === 'name')!.node;
    const startLine = fnNode.startPosition.row + 1;
    const endLine = fnNode.endPosition.row + 1;
    const name = nameNode.text;
    leaves.push({
      id: `${file}::${name}::${startLine}`,
      kind: 'fn', name, file, startLine, endLine,
      loc: endLine - startLine + 1,
    });
  }
  tree.delete();
  return leaves;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- rust`
Expected: PASS。若 `web-tree-sitter` API 因版本不同报错（如 `Parser.init` / `Language.load` / `Query` 导出位置），以已安装版本的 `node_modules/web-tree-sitter/*.d.ts` 为准调整导入，语义不变（init parser → load rust wasm → query function_item）。

- [ ] **Step 5: Commit**

```bash
git add src/extract/rust.ts test/rust.test.ts
git commit -m "feat(extract): tree-sitter rust leaf extraction"
```

---

### Task 4: 组装三层树

**Files:**
- Create: `src/extract/tree.ts`, `test/tree.test.ts`

- [ ] **Step 1: 写会失败的测试 test/tree.test.ts**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { buildTree } from '../src/extract/tree.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

describe('buildTree', () => {
  it('groups tracked .rs files into chapters(crate/dir) → chunks(file) → leaves', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'crates/foo/Cargo.toml', '[package]\nname="foo"');
    writeRepoFile(dir, 'crates/foo/src/lib.rs', 'pub fn a() {}');
    writeRepoFile(dir, 'crates/foo/src/core/mod.rs', 'fn b() {}\nfn c() {}');
    writeRepoFile(dir, 'README.md', 'x'); // 非 rs 忽略
    commitAll(dir, 'init');

    const tree = await buildTree(dir);

    expect(tree.chunks.map((c) => c.file).sort())
      .toEqual(['crates/foo/src/core/mod.rs', 'crates/foo/src/lib.rs']);
    // crate 名从路径 crates/<name> 推断
    expect(tree.chunks.every((c) => c.crate === 'foo')).toBe(true);
    // 章按 crate+dir 分组
    const chapterDirs = tree.chapters.map((ch) => ch.dir).sort();
    expect(chapterDirs).toEqual(['src', 'src/core']);
    // 叶子数 = 1 + 2
    expect(tree.leaves).toHaveLength(3);
    const libChunk = tree.chunks.find((c) => c.file.endsWith('lib.rs'))!;
    expect(libChunk.leafIds).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tree`
Expected: FAIL（`buildTree` 未定义）。

- [ ] **Step 3: 实现 src/extract/tree.ts**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listTrackedFiles } from '../git.js';
import { extractLeaves } from './rust.js';
import type { Tree, Chapter, Chunk, Leaf } from '../types.js';

/** 从 `crates/<name>/...` 推断 crate 名；否则用顶层目录或 'root'。 */
function crateOf(file: string): string {
  const m = file.match(/^crates\/([^/]+)\//);
  if (m) return m[1];
  const top = file.split('/')[0];
  return top.endsWith('.rs') ? 'root' : top;
}

/** crate 内相对目录（去掉 crates/<name>/ 前缀，去掉文件名）。 */
function dirOf(file: string, crate: string): string {
  const stripped = file.replace(new RegExp(`^crates/${crate}/`), '');
  const parts = stripped.split('/');
  parts.pop();
  return parts.join('/') || '';
}

function baseName(file: string): string {
  return file.split('/').pop()!.replace(/\.rs$/, '');
}

export async function buildTree(repo: string): Promise<Tree> {
  const files = listTrackedFiles(repo).filter((f) => f.endsWith('.rs'));
  const leaves: Leaf[] = [];
  const chunks: Chunk[] = [];
  const chapterMap = new Map<string, Chapter>();

  for (const file of files) {
    const crate = crateOf(file);
    const dir = dirOf(file, crate);
    const source = readFileSync(join(repo, file), 'utf8');
    const fileLeaves = await extractLeaves(file, source);
    leaves.push(...fileLeaves);

    const chunk: Chunk = {
      id: file, name: baseName(file), file, crate,
      leafIds: fileLeaves.map((l) => l.id),
    };
    chunks.push(chunk);

    const chId = `${crate}:${dir}`;
    let chapter = chapterMap.get(chId);
    if (!chapter) {
      chapter = { id: chId, name: `${crate}::${dir || '/'}`, crate, dir, chunkIds: [] };
      chapterMap.set(chId, chapter);
    }
    chapter.chunkIds.push(chunk.id);
  }

  return { repo, chapters: [...chapterMap.values()], chunks, leaves };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tree`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/extract/tree.ts test/tree.test.ts
git commit -m "feat(extract): assemble 3-layer tree (chapter/chunk/leaf)"
```

---

### Task 5: 相对 churn 信号

**Files:**
- Create: `src/grade/churn.ts`, `test/churn.test.ts`

说明：v1 相对 churn = 每文件被提交触及的次数，按仓库最大值归一化到 0..1（研究：绝对 churn 是噪音，须归一化）。

- [ ] **Step 1: 写会失败的测试 test/churn.test.ts**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { logNameOnly } from '../src/git.js';
import { relativeChurn } from '../src/grade/churn.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

describe('relativeChurn', () => {
  it('normalizes commit-touch counts to 0..1 (max file = 1)', () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'hot.rs', '1'); commitAll(dir, 'c1');
    writeRepoFile(dir, 'hot.rs', '2'); commitAll(dir, 'c2');
    writeRepoFile(dir, 'hot.rs', '3'); writeRepoFile(dir, 'cold.rs', '1');
    commitAll(dir, 'c3');

    const churn = relativeChurn(logNameOnly(dir));
    expect(churn['hot.rs']).toBe(1);      // 3 次触及 = 最大
    expect(churn['cold.rs']).toBeCloseTo(1 / 3); // 1 次
  });

  it('returns 0 map for empty log', () => {
    expect(relativeChurn([])).toEqual({});
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- churn`
Expected: FAIL（`relativeChurn` 未定义）。

- [ ] **Step 3: 实现 src/grade/churn.ts**

```ts
import type { CommitRecord } from '../git.js';

/** 每文件相对 churn（0..1）：提交触及次数 / 仓库最大触及次数。 */
export function relativeChurn(log: CommitRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of log) {
    for (const f of c.files) counts[f] = (counts[f] ?? 0) + 1;
  }
  const max = Math.max(0, ...Object.values(counts));
  if (max === 0) return {};
  const out: Record<string, number> = {};
  for (const [f, n] of Object.entries(counts)) out[f] = n / max;
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- churn`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/grade/churn.ts test/churn.test.ts
git commit -m "feat(grade): relative churn signal"
```

---

### Task 6: change coupling 信号

**Files:**
- Create: `src/grade/coupling.ts`, `test/coupling.test.ts`

说明：v1 coupling = 每文件与之在 ≥1 次提交中共同变更的**不同文件数**，按仓库最大值归一化。

- [ ] **Step 1: 写会失败的测试 test/coupling.test.ts**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { logNameOnly } from '../src/git.js';
import { changeCoupling } from '../src/grade/coupling.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

describe('changeCoupling', () => {
  it('counts distinct co-changed files, normalized to 0..1', () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    // hub 与 a、b 各共同变更过；solo 从不与人共变
    writeRepoFile(dir, 'hub.rs', '1'); writeRepoFile(dir, 'a.rs', '1');
    commitAll(dir, 'c1');
    writeRepoFile(dir, 'hub.rs', '2'); writeRepoFile(dir, 'b.rs', '1');
    commitAll(dir, 'c2');
    writeRepoFile(dir, 'solo.rs', '1'); commitAll(dir, 'c3');

    const cp = changeCoupling(logNameOnly(dir));
    expect(cp['hub.rs']).toBe(1);   // 与 a、b 共变 = 2 个 = 最大
    expect(cp['a.rs']).toBeCloseTo(0.5); // 仅与 hub
    expect(cp['solo.rs'] ?? 0).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- coupling`
Expected: FAIL。

- [ ] **Step 3: 实现 src/grade/coupling.ts**

```ts
import type { CommitRecord } from '../git.js';

/** 每文件的 change coupling（0..1）：曾共同变更的不同文件数 / 仓库最大值。 */
export function changeCoupling(log: CommitRecord[]): Record<string, number> {
  const partners = new Map<string, Set<string>>();
  for (const c of log) {
    for (const f of c.files) {
      if (!partners.has(f)) partners.set(f, new Set());
      for (const g of c.files) if (g !== f) partners.get(f)!.add(g);
    }
  }
  const counts: Record<string, number> = {};
  for (const [f, set] of partners) counts[f] = set.size;
  const max = Math.max(0, ...Object.values(counts));
  if (max === 0) return {};
  const out: Record<string, number> = {};
  for (const [f, n] of Object.entries(counts)) out[f] = n / max;
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- coupling`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/grade/coupling.ts test/coupling.test.ts
git commit -m "feat(grade): change coupling signal"
```

---

### Task 7: 基于提交的所有权信号

**Files:**
- Create: `src/grade/ownership.ts`, `test/ownership.test.ts`

说明：研究：基于提交的所有权优于行级 blame。v1 所有权集中度 = 每文件最大单作者提交占比（0..1）。高集中 = 知识孤岛/重要（喂贡献度轴的次要信号）。

- [ ] **Step 1: 写会失败的测试 test/ownership.test.ts**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { logNameOnly } from '../src/git.js';
import { ownershipConcentration } from '../src/grade/ownership.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

describe('ownershipConcentration', () => {
  it('top-author commit share per file', () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'solo.rs', '1'); commitAll(dir, 'c1', 'alice');
    writeRepoFile(dir, 'solo.rs', '2'); commitAll(dir, 'c2', 'alice');
    writeRepoFile(dir, 'shared.rs', '1'); commitAll(dir, 'c3', 'alice');
    writeRepoFile(dir, 'shared.rs', '2'); commitAll(dir, 'c4', 'bob');

    const own = ownershipConcentration(logNameOnly(dir));
    expect(own['solo.rs']).toBe(1);        // alice 2/2
    expect(own['shared.rs']).toBeCloseTo(0.5); // 1/2
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- ownership`
Expected: FAIL。

- [ ] **Step 3: 实现 src/grade/ownership.ts**

```ts
import type { CommitRecord } from '../git.js';

/** 每文件所有权集中度（0..1）= 最大单作者提交数 / 该文件总提交数。 */
export function ownershipConcentration(log: CommitRecord[]): Record<string, number> {
  const perFile = new Map<string, Map<string, number>>();
  for (const c of log) {
    for (const f of c.files) {
      if (!perFile.has(f)) perFile.set(f, new Map());
      const m = perFile.get(f)!;
      m.set(c.author, (m.get(c.author) ?? 0) + 1);
    }
  }
  const out: Record<string, number> = {};
  for (const [f, authors] of perFile) {
    const total = [...authors.values()].reduce((a, b) => a + b, 0);
    const top = Math.max(...authors.values());
    out[f] = total === 0 ? 0 : top / total;
  }
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- ownership`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/grade/ownership.ts test/ownership.test.ts
git commit -m "feat(grade): commit-based ownership concentration signal"
```

---

### Task 8: 名字出现 fan-in 中心度信号（v1 近似）

**Files:**
- Create: `src/grade/centrality.ts`, `test/centrality.test.ts`

说明：v1 中心度近似（不接 rust-analyzer）：一个 chunk（文件）的中心度 = 它导出的函数名在**其他文件**中作为标识符出现的总次数，按仓库最大值归一化。明确标注为近似（同名冲突、宏、方法分派会有噪音）。

- [ ] **Step 1: 写会失败的测试 test/centrality.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { nameFanInCentrality } from '../src/grade/centrality.js';
import type { Leaf } from '../src/types.js';

const leaf = (file: string, name: string): Leaf => ({
  id: `${file}::${name}::1`, kind: 'fn', name, file, startLine: 1, endLine: 1, loc: 1,
});

describe('nameFanInCentrality', () => {
  it('counts cross-file identifier occurrences of a chunk\'s function names', () => {
    const leaves = [leaf('util.rs', 'helper'), leaf('main.rs', 'run')];
    const sources: Record<string, string> = {
      'util.rs': 'pub fn helper() {}',
      'main.rs': 'fn run() { helper(); helper(); }', // helper 被引用 2 次（跨文件）
    };
    const cen = nameFanInCentrality(leaves, sources);
    expect(cen['util.rs']).toBe(1);       // helper 跨文件出现 2 次 = 最大
    expect(cen['main.rs'] ?? 0).toBe(0);  // run 无人引用
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- centrality`
Expected: FAIL。

- [ ] **Step 3: 实现 src/grade/centrality.ts**

```ts
import type { Leaf } from '../types.js';

/**
 * v1 近似中心度：chunk(文件)的所有函数名在其他文件源码中作为完整词出现的次数，
 * 归一化到 0..1。近似——同名/宏/方法分派会有噪音，将来由调用图/rust-analyzer 替换。
 */
export function nameFanInCentrality(
  leaves: Leaf[],
  sources: Record<string, string>,
): Record<string, number> {
  const filesByLeafFile = new Map<string, Set<string>>(); // file -> its fn names
  for (const l of leaves) {
    if (!filesByLeafFile.has(l.file)) filesByLeafFile.set(l.file, new Set());
    filesByLeafFile.get(l.file)!.add(l.name);
  }

  const raw: Record<string, number> = {};
  for (const [file, names] of filesByLeafFile) {
    let count = 0;
    for (const name of names) {
      const re = new RegExp(`\\b${escapeRe(name)}\\b`, 'g');
      for (const [otherFile, src] of Object.entries(sources)) {
        if (otherFile === file) continue; // 只算跨文件 fan-in
        count += (src.match(re) ?? []).length;
      }
    }
    raw[file] = count;
  }
  const max = Math.max(0, ...Object.values(raw));
  if (max === 0) return {};
  const out: Record<string, number> = {};
  for (const [f, n] of Object.entries(raw)) out[f] = n / max;
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- centrality`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/grade/centrality.ts test/centrality.test.ts
git commit -m "feat(grade): v1 name-fan-in centrality signal (approximate)"
```

---

### Task 9: 复合打分 + 分位标定 + 分桶

**Files:**
- Create: `src/grade/grade.ts`, `test/grade.test.ts`

说明：把信号组合成两轴（0..1），按仓库**分位**分桶（per-repo 标定，不用固定阈值）。
- 风险 = 0.5·relChurn + 0.3·coupling + 0.2·sizeNorm（churn 优先）。桶：分位 <0.25 none / <0.5 low / <0.75 med / 否则 high。
- 贡献 = 0.6·centrality + 0.25·sizeNorm + 0.15·ownership。桶：分位 <0.25 filler / <0.5 low / <0.75 med / 否则 high。
- sizeNorm = chunk 的 LOC（其叶子 LOC 之和）按仓库最大归一化。

- [ ] **Step 1: 写会失败的测试 test/grade.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { gradeTree } from '../src/grade/grade.js';
import type { Tree } from '../src/types.js';

function fakeTree(): Tree {
  // 3 个 chunk，制造清晰的高/中/低
  return {
    repo: '/x',
    chapters: [{ id: 'root:', name: 'root::/', crate: 'root', dir: '', chunkIds: ['hot.rs', 'mid.rs', 'cold.rs'] }],
    chunks: [
      { id: 'hot.rs', name: 'hot', file: 'hot.rs', crate: 'root', leafIds: ['hot.rs::h::1'] },
      { id: 'mid.rs', name: 'mid', file: 'mid.rs', crate: 'root', leafIds: ['mid.rs::m::1'] },
      { id: 'cold.rs', name: 'cold', file: 'cold.rs', crate: 'root', leafIds: ['cold.rs::c::1'] },
    ],
    leaves: [
      { id: 'hot.rs::h::1', kind: 'fn', name: 'h', file: 'hot.rs', startLine: 1, endLine: 20, loc: 20 },
      { id: 'mid.rs::m::1', kind: 'fn', name: 'm', file: 'mid.rs', startLine: 1, endLine: 10, loc: 10 },
      { id: 'cold.rs::c::1', kind: 'fn', name: 'c', file: 'cold.rs', startLine: 1, endLine: 2, loc: 2 },
    ],
  };
}

describe('gradeTree', () => {
  it('produces a grade per chunk with buckets, churn-dominant risk', () => {
    const tree = fakeTree();
    const graded = gradeTree(tree, {
      relChurn: { 'hot.rs': 1, 'mid.rs': 0.5, 'cold.rs': 0 },
      coupling: { 'hot.rs': 1, 'mid.rs': 0.3, 'cold.rs': 0 },
      ownership: { 'hot.rs': 1, 'mid.rs': 1, 'cold.rs': 1 },
      centrality: { 'hot.rs': 1, 'mid.rs': 0.5, 'cold.rs': 0 },
    });
    expect(Object.keys(graded.grades)).toHaveLength(3);
    const hot = graded.grades['hot.rs'];
    const cold = graded.grades['cold.rs'];
    expect(hot.risk).toBeGreaterThan(cold.risk);
    expect(hot.riskBucket).toBe('high');
    expect(cold.contribBucket).toBe('filler');
    // churn 优先：hot 风险应显著高
    expect(hot.risk).toBeGreaterThan(0.7);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- grade`
Expected: FAIL（`gradeTree` 未定义）。

- [ ] **Step 3: 实现 src/grade/grade.ts**

```ts
import type {
  Tree, GradedTree, Grade, Signals, RiskBucket, ContribBucket, Leaf,
} from '../types.js';

export interface SignalMaps {
  relChurn: Record<string, number>;
  coupling: Record<string, number>;
  ownership: Record<string, number>;
  centrality: Record<string, number>;
}

function chunkLoc(chunkId: string, leaves: Leaf[]): number {
  return leaves.filter((l) => l.file === chunkId).reduce((s, l) => s + l.loc, 0);
}

/**
 * 按分位分桶：把 value 在 sorted 值集合里的位置百分位映射到 4 桶。
 * 用 (rank-1)/(n-1) 使 min→0、max→1，保证最小值进 labels[0]、最大值进 labels[3]，
 * 不受样本大小影响（朴素的 rank/n 在 n<4 时最小值分位>0.25，会漏掉第 0 桶）。
 */
function quantileBucket<T>(value: number, sorted: number[], labels: [T, T, T, T]): T {
  if (sorted.length <= 1) return labels[0];
  const rank = (sorted.filter((v) => v <= value).length - 1) / (sorted.length - 1);
  if (rank <= 0.25) return labels[0];
  if (rank <= 0.5) return labels[1];
  if (rank <= 0.75) return labels[2];
  return labels[3];
}

export function gradeTree(tree: Tree, sig: SignalMaps): GradedTree {
  const locs: Record<string, number> = {};
  for (const c of tree.chunks) locs[c.id] = chunkLoc(c.id, tree.leaves);
  const maxLoc = Math.max(1, ...Object.values(locs));

  // 先算每 chunk 的两轴复合分
  const risks: Record<string, number> = {};
  const contribs: Record<string, number> = {};
  const signalsById: Record<string, Signals> = {};

  for (const c of tree.chunks) {
    const relChurn = sig.relChurn[c.id] ?? 0;
    const coupling = sig.coupling[c.id] ?? 0;
    const ownership = sig.ownership[c.id] ?? 0;
    const centrality = sig.centrality[c.id] ?? 0;
    const sizeNorm = locs[c.id] / maxLoc;

    const risk = 0.5 * relChurn + 0.3 * coupling + 0.2 * sizeNorm;
    const contribution = 0.6 * centrality + 0.25 * sizeNorm + 0.15 * ownership;

    risks[c.id] = risk;
    contribs[c.id] = contribution;
    signalsById[c.id] = { relChurn, coupling, ownership, centrality, sizeNorm };
  }

  const riskSorted = Object.values(risks).sort((a, b) => a - b);
  const contribSorted = Object.values(contribs).sort((a, b) => a - b);

  const grades: Record<string, Grade> = {};
  for (const c of tree.chunks) {
    grades[c.id] = {
      risk: risks[c.id],
      riskBucket: quantileBucket<RiskBucket>(risks[c.id], riskSorted, ['none', 'low', 'med', 'high']),
      contribution: contribs[c.id],
      contribBucket: quantileBucket<ContribBucket>(contribs[c.id], contribSorted, ['filler', 'low', 'med', 'high']),
      signals: signalsById[c.id],
    };
  }

  return { ...tree, grades };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- grade`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/grade/grade.ts test/grade.test.ts
git commit -m "feat(grade): composite two-axis scoring with per-repo quantile buckets"
```

---

### Task 10: Markdown 风险×贡献度地图渲染

**Files:**
- Create: `src/render/map-md.ts`, `test/map-md.test.ts`

说明：渲染宏观地图——4×4 网格（风险行 × 贡献度列），每格列出落入的**章**（按其 chunk 的中位桶聚合）。v1 章级桶 = 该章下 chunk 的众数桶。

- [ ] **Step 1: 写会失败的测试 test/map-md.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { renderMapMarkdown } from '../src/render/map-md.js';
import type { GradedTree } from '../src/types.js';

const graded: GradedTree = {
  repo: '/x',
  chapters: [
    { id: 'foo:core', name: 'foo::core', crate: 'foo', dir: 'core', chunkIds: ['a.rs'] },
    { id: 'foo:util', name: 'foo::util', crate: 'foo', dir: 'util', chunkIds: ['b.rs'] },
  ],
  chunks: [
    { id: 'a.rs', name: 'a', file: 'a.rs', crate: 'foo', leafIds: [] },
    { id: 'b.rs', name: 'b', file: 'b.rs', crate: 'foo', leafIds: [] },
  ],
  leaves: [],
  grades: {
    'a.rs': { risk: 0.9, riskBucket: 'high', contribution: 0.9, contribBucket: 'high', signals: {} as any },
    'b.rs': { risk: 0.1, riskBucket: 'none', contribution: 0.1, contribBucket: 'filler', signals: {} as any },
  },
};

describe('renderMapMarkdown', () => {
  it('places chapters into the risk×contribution grid', () => {
    const md = renderMapMarkdown(graded);
    expect(md).toContain('# easyReview 地图');
    expect(md).toContain('foo::core'); // high/high 格
    expect(md).toContain('foo::util'); // none/filler 格
    // 表头含四个贡献度桶
    expect(md).toContain('填充');
    expect(md).toContain('风险 高');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- map-md`
Expected: FAIL。

- [ ] **Step 3: 实现 src/render/map-md.ts**

```ts
import type { GradedTree, Chapter, RiskBucket, ContribBucket } from '../types.js';

const RISK_ROWS: RiskBucket[] = ['high', 'med', 'low', 'none'];
const CONTRIB_COLS: ContribBucket[] = ['filler', 'low', 'med', 'high'];
const RISK_LABEL: Record<RiskBucket, string> = { high: '风险 高', med: '风险 中', low: '风险 低', none: '风险 无' };
const CONTRIB_LABEL: Record<ContribBucket, string> = { filler: '填充', low: '低', med: '中', high: '高' };

function mode<T>(xs: T[]): T {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** 章级桶 = 其 chunk 桶的众数。 */
function chapterBuckets(ch: Chapter, g: GradedTree): { risk: RiskBucket; contrib: ContribBucket } {
  const rs = ch.chunkIds.map((id) => g.grades[id].riskBucket);
  const cs = ch.chunkIds.map((id) => g.grades[id].contribBucket);
  return { risk: mode(rs), contrib: mode(cs) };
}

export function renderMapMarkdown(g: GradedTree): string {
  // grid[risk][contrib] = chapter 名列表
  const grid = new Map<string, string[]>();
  for (const ch of g.chapters) {
    const { risk, contrib } = chapterBuckets(ch, g);
    const key = `${risk}|${contrib}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push(ch.name);
  }

  const lines: string[] = [];
  lines.push('# easyReview 地图');
  lines.push('');
  lines.push('> 接地地图：章按 git 历史算出的风险 × 架构贡献度落位。从左下（填充/低风险）起步，爬向右上核心。');
  lines.push('');
  lines.push(`| | ${CONTRIB_COLS.map((c) => CONTRIB_LABEL[c]).join(' | ')} |`);
  lines.push(`|---|${CONTRIB_COLS.map(() => '---').join('|')}|`);
  for (const risk of RISK_ROWS) {
    const cells = CONTRIB_COLS.map((contrib) => {
      const names = grid.get(`${risk}|${contrib}`) ?? [];
      return names.join('<br>') || '·';
    });
    lines.push(`| **${RISK_LABEL[risk]}** | ${cells.join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- map-md`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/render/map-md.ts test/map-md.test.ts
git commit -m "feat(render): markdown risk×contribution map"
```

---

### Task 11: CLI 入口 + 对 umwelt-bevy 冒烟运行

**Files:**
- Create: `src/cli.ts`, `test/cli.test.ts`

- [ ] **Step 1: 写会失败的测试 test/cli.test.ts**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { runMap } from '../src/cli.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

describe('runMap', () => {
  it('produces graded-tree JSON + map markdown for a repo', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'crates/foo/src/lib.rs', 'pub fn a() { b(); }\nfn b() {}');
    writeRepoFile(dir, 'crates/foo/src/util.rs', 'pub fn util() {}');
    commitAll(dir, 'init');

    const outDir = dir; // 就近输出
    await runMap({ repo: dir, outDir });

    const tree = JSON.parse(readFileSync(join(outDir, 'easyreview.tree.json'), 'utf8'));
    expect(tree.chunks.length).toBe(2);
    expect(tree.grades).toBeDefined();
    const md = readFileSync(join(outDir, 'easyreview.map.md'), 'utf8');
    expect(md).toContain('# easyReview 地图');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- cli`
Expected: FAIL（`runMap` 未定义）。

- [ ] **Step 3: 实现 src/cli.ts**

```ts
#!/usr/bin/env tsx
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTree } from './extract/tree.js';
import { logNameOnly, listTrackedFiles } from './git.js';
import { relativeChurn } from './grade/churn.js';
import { changeCoupling } from './grade/coupling.js';
import { ownershipConcentration } from './grade/ownership.js';
import { nameFanInCentrality } from './grade/centrality.js';
import { gradeTree } from './grade/grade.js';
import { renderMapMarkdown } from './render/map-md.js';

export interface MapOptions { repo: string; outDir: string; }

export async function runMap(opts: MapOptions): Promise<void> {
  const { repo, outDir } = opts;
  const tree = await buildTree(repo);
  const log = logNameOnly(repo);

  // centrality 需要各 .rs 源码
  const sources: Record<string, string> = {};
  for (const f of listTrackedFiles(repo).filter((x) => x.endsWith('.rs'))) {
    sources[f] = readFileSync(join(repo, f), 'utf8');
  }

  const graded = gradeTree(tree, {
    relChurn: relativeChurn(log),
    coupling: changeCoupling(log),
    ownership: ownershipConcentration(log),
    centrality: nameFanInCentrality(tree.leaves, sources),
  });

  writeFileSync(join(outDir, 'easyreview.tree.json'), JSON.stringify(graded, null, 2));
  writeFileSync(join(outDir, 'easyreview.map.md'), renderMapMarkdown(graded));
}

function parseArgs(argv: string[]): MapOptions {
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  return { repo: get('--repo', process.cwd()), outDir: get('--out', process.cwd()) };
}

// CLI 执行入口
const cmd = process.argv[2];
if (cmd === 'map') {
  runMap(parseArgs(process.argv.slice(3)))
    .then(() => console.log('✓ wrote easyreview.tree.json + easyreview.map.md'))
    .catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- cli`
Expected: PASS。

- [ ] **Step 5: 全量测试**

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 6: 对真实 umwelt-bevy 冒烟运行（观察验证，非单测）**

Run: `npm run map -- --repo D:/dev/umwelt-bevy --out .`
Expected: 打印 `✓ wrote ...`；生成 `easyreview.tree.json`（含 chem_field/grid_workshop 的 chunk 与 grades）与 `easyreview.map.md`。
人工核对：打开 `easyreview.map.md`，确认高 churn 的 grid_workshop 模块（如 routing、build_ui/viewer）落在较高风险行，而 constants/小工具落在填充/低风险。若明显反直觉，回看信号权重（不是改测试）。

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat(cli): easyreview map — graded tree JSON + markdown map"
```

- [ ] **Step 8: 忽略生成物**

把 `easyreview.tree.json` 与 `easyreview.map.md` 加入 `.gitignore`（生成物不入库），提交。

```bash
printf 'easyreview.tree.json\neasyreview.map.md\n' >> .gitignore
git add .gitignore
git commit -m "chore: ignore generated map artifacts"
```

---

## 自查（Self-Review）

**Spec 覆盖**（对 `2026-07-05-easyreview-design.md`）：
- §4 三层树 → Task 3/4 ✓
- §6 ① Extract → Task 3/4 ✓；② Grade（相对churn/coupling/DOA/中心度，按仓库标定）→ Task 5/6/7/8/9 ✓
- §3 铁律①风险 churn 优先归一化 → Task 5 + Task 9 权重 ✓；②贡献 DOA+中心度非行级 blame → Task 7/8 ✓；铁律"静态指标不当普适、按仓库标定" → Task 9 分位分桶 ✓
- §7 引擎产出规范 JSON artifact → Task 11 ✓
- 计划①**明确不含**：LLM 标签、学习路径、进度、Gistify 验证（→ 计划②③）。与 spec §9 里程碑 v1a/v1b 一致。

**占位符扫描**：无 TBD/TODO；每个代码步含完整代码。

**类型一致性**：`Leaf/Chunk/Chapter/Tree/GradedTree/Grade/Signals` 全部源自 Task 1 `types.ts`；`CommitRecord` 源自 Task 2；信号函数签名 `(log|leaves,sources) → Record<string,number>` 一致；`gradeTree(tree, SignalMaps)` 的 `SignalMaps` 键（relChurn/coupling/ownership/centrality）与 Task 5-8 输出、Task 11 组装一致；chunk.id = 文件相对路径，贯穿 grading/render/cli 一致。

**已知 v1 近似（诚实标注，非缺陷）**：churn=提交计数（非 churn/LOC）、centrality=名字出现（非真实调用图）、章级桶=众数。均在 spec §11 风险清单内，计划②③与后续里程碑替换。
