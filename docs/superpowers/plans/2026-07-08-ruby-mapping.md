# Ruby 映射（多语言子项目①）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** easyReview 的地图/旅程/标签/viewer 支持 Ruby 仓库（学 chatwoot），通过语言注册表泛化提取层 + `--include` 目录过滤器；verify 对非 Rust 块友好拒绝。

**Architecture:** 新增 `extract/lang.ts` 注册表（扩展名→wasm→叶子 query→围栏），`parser.ts` 泛化为按语言单例，`extract/rust.ts` 泛化为 `extract/leaves.ts`；`tree.ts`/`cli.ts` 用 `inScope(file, include)` 统一过滤；`label/prompt.ts` 围栏按语言。Rust 路径行为不变，现有 99 测试全绿是硬门。

**Tech Stack:** Node 20+ / TypeScript(ESM，import 带 `.js` 后缀) / vitest / `web-tree-sitter` + `tree-sitter-wasms`（`tree-sitter-ruby.wasm` 已在包内，零新依赖）。

> spec：`docs/superpowers/specs/2026-07-08-ruby-mapping-design.md`。
> **Ruby AST 已实证**（2026-07-08 probe 脚本，真 wasm）：节点 `method`（`def foo`）与 `singleton_method`（`def self.foo`），name 字段都是 `identifier`；query `(method name: (identifier) @name) @fn (singleton_method name: (identifier) @name) @fn` 实测正确提取名字与行号（含单行 `def helper; 1; end` → 12-12）；class/module/常量赋值不被捕获。
> vitest 不做类型检查——每任务收尾跑 `npm run typecheck`。Shell 是 PowerShell 5.1（无 `&&`，用 `;`）或 Bash 工具。

---

## 文件结构

| 路径 | 职责 | 动作 |
|---|---|---|
| `src/extract/lang.ts` | LangSpec 注册表（rust+ruby）+ `langOf` + `inScope` | Create |
| `src/extract/parser.ts` | `getParser(spec)` 按语言单例；`getRustParser` 保留为薄包装 | Modify |
| `src/extract/leaves.ts` | 通用 `extractLeaves(file, source, spec)`（query 按语言编译一次缓存） | Create |
| `src/extract/rust.ts` | 删除（逻辑并入 leaves.ts） | Delete |
| `src/extract/tree.ts` | `inScope` 过滤 + `crateOf` 根文件归 root + `baseName` 通用去扩展名 + 每文件按语言提取 | Modify |
| `src/cli.ts` | `MapOptions.include` + `--include` 解析（导出 `parseArgs` 可测）+ sources 同套过滤 | Modify |
| `src/label/prompt.ts` | 围栏按 `langOf(i.file).fence` | Modify |
| `src/cli-verify.ts` | show/predict 对非 Rust 块友好拒绝 | Modify |
| `test/lang.test.ts` / `test/ruby-extract.test.ts` / `test/prompt-fence.test.ts` / `test/verify-ruby-reject.test.ts` | 新测试 | Create |
| `test/tree.test.ts` / `test/cli.test.ts` | 扩展 | Modify |

---

## Task 1: 语言注册表 `lang.ts`

**Files:**
- Create: `src/extract/lang.ts`
- Test: `test/lang.test.ts`

- [ ] **Step 1: 写失败测试 `test/lang.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { langOf, inScope, RUST, RUBY } from '../src/extract/lang.js';

describe('langOf', () => {
  it('maps extensions to registered langs, unknown → null', () => {
    expect(langOf('crates/foo/src/lib.rs')).toBe(RUST);
    expect(langOf('app/models/user.rb')).toBe(RUBY);
    expect(langOf('README.md')).toBeNull();
    expect(langOf('a.vue')).toBeNull();          // 本轮未注册
  });

  it('carries fence tags for label prompts', () => {
    expect(RUST.fence).toBe('rust');
    expect(RUBY.fence).toBe('ruby');
  });
});

describe('inScope', () => {
  it('filters by registered language and optional dir-boundary prefixes', () => {
    expect(inScope('app/models/user.rb')).toBe(true);                      // 无 include = 全收
    expect(inScope('app/models/user.rb', ['app'])).toBe(true);
    expect(inScope('apps/other.rb', ['app'])).toBe(false);                 // 目录边界:app ≠ apps
    expect(inScope('lib/util.rb', ['app'])).toBe(false);
    expect(inScope('lib/util.rb', ['app', 'lib'])).toBe(true);
    expect(inScope('app/readme.md', ['app'])).toBe(false);                 // 未注册语言永远 false
    expect(inScope('app/models/user.rb', [])).toBe(true);                  // 空数组 = 不过滤
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/lang.test.ts`
Expected: FAIL — `src/extract/lang.js` 不存在。

- [ ] **Step 3: 实现 `src/extract/lang.ts`**

```ts
/** 语言注册表：加一门语言 = 在这里加一项（wasm 名以 tree-sitter-wasms/out/ 下真实文件为准）。 */
export interface LangSpec {
  id: 'rust' | 'ruby';
  exts: string[];      // 命中任一扩展名即属于该语言
  wasm: string;        // tree-sitter-wasms/out/ 下的文件名
  query: string;       // 叶子查询：必须捕获 @fn（整个函数节点）与 @name（名字节点）
  fence: string;       // 标签 prompt 代码围栏语言标签
}

export const RUST: LangSpec = {
  id: 'rust',
  exts: ['.rs'],
  wasm: 'tree-sitter-rust.wasm',
  query: '(function_item name: (identifier) @name) @fn',
  fence: 'rust',
};

export const RUBY: LangSpec = {
  id: 'ruby',
  exts: ['.rb'],
  wasm: 'tree-sitter-ruby.wasm',
  // 实测（2026-07-08）：def foo → method / def self.foo → singleton_method，name 字段均为 identifier
  query: '(method name: (identifier) @name) @fn (singleton_method name: (identifier) @name) @fn',
  fence: 'ruby',
};

export const LANGS: LangSpec[] = [RUST, RUBY];

export function langOf(file: string): LangSpec | null {
  for (const l of LANGS) if (l.exts.some((e) => file.endsWith(e))) return l;
  return null;
}

/** 已注册语言 + 可选目录前缀过滤。前缀按目录边界匹配：'app' 只命中 app/ 下，不命中 apps/。 */
export function inScope(file: string, include?: string[]): boolean {
  if (!langOf(file)) return false;
  if (!include || include.length === 0) return true;
  return include.some((p) => file.startsWith(p.endsWith('/') ? p : p + '/'));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/lang.test.ts`
Expected: PASS（3 tests）。`npm run typecheck` 干净。

- [ ] **Step 5: 提交**

```bash
git add src/extract/lang.ts test/lang.test.ts
git commit -m "feat(extract): 语言注册表（rust+ruby 的 wasm/query/fence + langOf/inScope）"
```

---

## Task 2: parser 泛化 + 通用 `leaves.ts`（删 rust.ts）

**Files:**
- Modify: `src/extract/parser.ts`（整体替换）
- Create: `src/extract/leaves.ts`
- Delete: `src/extract/rust.ts`
- Modify: `src/extract/tree.ts`（只改 import 与调用处，行为不变——过滤仍是 .rs，Task 3 才放开）
- Test: `test/ruby-extract.test.ts`

- [ ] **Step 1: 写失败测试 `test/ruby-extract.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { extractLeaves } from '../src/extract/leaves.js';
import { RUBY, RUST } from '../src/extract/lang.js';

const RUBY_SRC = `class User < ApplicationRecord
  def full_name
    "x"
  end

  def self.find_by_email(email)
    where(email: email).first
  end
end

module Util
  def helper; 1; end
end

CONST = 42
`;

describe('extractLeaves (ruby)', () => {
  it('extracts instance and singleton methods with correct lines/loc', async () => {
    const leaves = await extractLeaves('app/models/user.rb', RUBY_SRC, RUBY);
    expect(leaves.map((l) => l.name)).toEqual(['full_name', 'find_by_email', 'helper']);
    const full = leaves[0];
    expect(full.id).toBe('app/models/user.rb::full_name::2');
    expect(full.startLine).toBe(2);
    expect(full.endLine).toBe(4);
    expect(full.loc).toBe(3);
    const oneLiner = leaves[2];
    expect(oneLiner.startLine).toBe(12);
    expect(oneLiner.endLine).toBe(12);
    expect(oneLiner.loc).toBe(1);
  });

  it('returns empty for a ruby file without methods', async () => {
    const leaves = await extractLeaves('config/init.rb', 'CONST = 1\nOTHER = 2\n', RUBY);
    expect(leaves).toEqual([]);
  });

  it('still extracts rust functions through the same generic path', async () => {
    const leaves = await extractLeaves('crates/foo/src/lib.rs', 'pub fn a() {}\nfn b() {}\n', RUST);
    expect(leaves.map((l) => l.name)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/ruby-extract.test.ts`
Expected: FAIL — `src/extract/leaves.js` 不存在。

- [ ] **Step 3: 整体替换 `src/extract/parser.ts`**

```ts
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import Parser from 'web-tree-sitter';
import { RUST, type LangSpec } from './lang.js';

const require = createRequire(import.meta.url);

let parserInit: Promise<void> | null = null;
const cache = new Map<string, Promise<{ parser: Parser; lang: Parser.Language }>>();

/** 按语言的 tree-sitter parser 单例（parser + language）。Parser.init 全局只跑一次。 */
export async function getParser(spec: LangSpec): Promise<{ parser: Parser; lang: Parser.Language }> {
  let p = cache.get(spec.id);
  if (!p) {
    p = (async () => {
      if (!parserInit) parserInit = Parser.init();
      await parserInit;
      const wasmPath = require.resolve(`tree-sitter-wasms/out/${spec.wasm}`);
      const lang = await Parser.Language.load(readFileSync(wasmPath));
      const parser = new Parser();
      parser.setLanguage(lang);
      return { parser, lang };
    })();
    cache.set(spec.id, p);
  }
  return p;
}

/** 兼容旧调用（verify/pick-site.ts）：Rust parser 单例。 */
export function getRustParser(): Promise<{ parser: Parser; lang: Parser.Language }> {
  return getParser(RUST);
}
```

- [ ] **Step 4: 创建 `src/extract/leaves.ts`**（逻辑与旧 rust.ts 逐字相同，仅 parser/query 来自 spec）

```ts
import Parser from 'web-tree-sitter';
import { getParser } from './parser.js';
import type { LangSpec } from './lang.js';
import type { Leaf } from '../types.js';

const queries = new Map<string, Parser.Query>();

export async function extractLeaves(file: string, source: string, spec: LangSpec): Promise<Leaf[]> {
  const { parser, lang } = await getParser(spec);
  let query = queries.get(spec.id);
  if (!query) {
    query = lang.query(spec.query);
    queries.set(spec.id, query);
  }
  const tree = parser.parse(source);
  const leaves: Leaf[] = [];
  for (const m of query.matches(tree.rootNode)) {
    const fnNode = m.captures.find((c) => c.name === 'fn')!.node;
    const nameNode = m.captures.find((c) => c.name === 'name')!.node;
    const startLine = fnNode.startPosition.row + 1;
    const endLine = fnNode.endPosition.row + 1;
    const name = nameNode.text;
    leaves.push({
      id: `${file}::${name}::${startLine}`,
      kind: 'fn',
      name,
      file,
      startLine,
      endLine,
      loc: endLine - startLine + 1,
    });
  }
  tree.delete();
  return leaves;
}
```

- [ ] **Step 5: 删除 `src/extract/rust.ts`，更新 `src/extract/tree.ts` 的 import 与调用**

```bash
git rm src/extract/rust.ts
```

`tree.ts` 顶部 `import { extractLeaves } from './rust.js';` 改为：

```ts
import { extractLeaves } from './leaves.js';
import { RUST } from './lang.js';
```

第 35 行调用 `await extractLeaves(file, source)` 改为：

```ts
    const fileLeaves = await extractLeaves(file, source, RUST);
```

（本任务 tree.ts 仍只收 .rs——过滤放开是 Task 3。）

- [ ] **Step 6: 跑测试确认通过 + 全量回归**

Run: `npx vitest run test/ruby-extract.test.ts`
Expected: PASS（3 tests）。`npx vitest run` 全绿（现有 99 + 3 lang + 3 ruby = 105）、`npm run typecheck` 干净。

- [ ] **Step 7: 提交**

```bash
git add -A src/extract test/ruby-extract.test.ts
git commit -m "feat(extract): parser 按语言单例 + 通用 extractLeaves（rust.ts 并入 leaves.ts）"
```

---

## Task 3: `tree.ts` 泛化（inScope 过滤 + include + 章推导）

**Files:**
- Modify: `src/extract/tree.ts`（整体替换）
- Test: `test/tree.test.ts`（新增用例，现有用例不动）

- [ ] **Step 1: `test/tree.test.ts` 追加失败用例**（文件末尾、describe 内追加）

```ts
  it('includes ruby files with rails-style chapters; root file → crate root', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'app/models/user.rb', 'class User\n  def name; "n"; end\nend\n');
    writeRepoFile(dir, 'lib/util.rb', 'def helper; 1; end\n');
    writeRepoFile(dir, 'top.rb', 'def root_fn; 0; end\n');
    writeRepoFile(dir, 'README.md', 'x');
    commitAll(dir, 'init');

    const tree = await buildTree(dir);

    expect(tree.chunks.map((c) => c.file).sort()).toEqual(['app/models/user.rb', 'lib/util.rb', 'top.rb']);
    const user = tree.chunks.find((c) => c.file === 'app/models/user.rb')!;
    expect(user.crate).toBe('app');
    expect(user.name).toBe('user');
    const userChapter = tree.chapters.find((ch) => ch.chunkIds.includes(user.id))!;
    expect(userChapter.id).toBe('app:models');
    const top = tree.chunks.find((c) => c.file === 'top.rb')!;
    expect(top.crate).toBe('root');
    expect(tree.leaves.map((l) => l.name).sort()).toEqual(['helper', 'name', 'root_fn']);
  });

  it('mixes rust and ruby chunks in one repo', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'crates/foo/src/lib.rs', 'pub fn a() {}');
    writeRepoFile(dir, 'app/models/user.rb', 'def m; 1; end\n');
    commitAll(dir, 'init');

    const tree = await buildTree(dir);
    expect(tree.chunks).toHaveLength(2);
    expect(tree.leaves).toHaveLength(2);
  });

  it('applies include prefixes at directory boundaries', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'app/models/user.rb', 'def m; 1; end\n');
    writeRepoFile(dir, 'apps/other.rb', 'def o; 1; end\n');
    writeRepoFile(dir, 'lib/util.rb', 'def h; 1; end\n');
    commitAll(dir, 'init');

    const tree = await buildTree(dir, { include: ['app'] });
    expect(tree.chunks.map((c) => c.file)).toEqual(['app/models/user.rb']);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/tree.test.ts`
Expected: FAIL — ruby 文件没进树（现有过滤只收 .rs）/ buildTree 不认第二个参数。现有 .rs 用例仍 PASS。

- [ ] **Step 3: 整体替换 `src/extract/tree.ts`**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listTrackedFiles } from '../git.js';
import { extractLeaves } from './leaves.js';
import { langOf, inScope } from './lang.js';
import type { Tree, Chapter, Chunk, Leaf } from '../types.js';

function crateOf(file: string): string {
  const m = file.match(/^crates\/([^/]+)\//);
  if (m) return m[1];
  const top = file.split('/')[0];
  return top === file ? 'root' : top; // 无目录的根文件归 root
}

function dirOf(file: string, crate: string): string {
  let stripped = file.replace(new RegExp(`^crates/${crate}/`), '');
  // 非 crates/ 布局（如 Rails）：顶层目录即 crate，也要剥掉（app/models/user.rb → models/user.rb）
  if (stripped === file && file.startsWith(`${crate}/`)) stripped = file.slice(crate.length + 1);
  const parts = stripped.split('/');
  parts.pop();
  return parts.join('/') || '';
}

function baseName(file: string): string {
  return file.split('/').pop()!.replace(/\.[^.]+$/, '');
}

export interface BuildTreeOptions { include?: string[]; }

export async function buildTree(repo: string, opts: BuildTreeOptions = {}): Promise<Tree> {
  const files = listTrackedFiles(repo).filter((f) => inScope(f, opts.include));
  const leaves: Leaf[] = [];
  const chunks: Chunk[] = [];
  const chapterMap = new Map<string, Chapter>();

  for (const file of files) {
    const crate = crateOf(file);
    const dir = dirOf(file, crate);
    const source = readFileSync(join(repo, file), 'utf8');
    const fileLeaves = await extractLeaves(file, source, langOf(file)!);
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

（`dirOf` 行为核对：`crates/foo/src/lib.rs` → dir `src` 与现状一致；`app/models/user.rb`、crate=`app` → stripped `models/user.rb` → dir `models` → 章 `app:models`；根文件 `top.rb`、crate=`root` → 都不命中 → dir `''`。）

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run test/tree.test.ts`
Expected: PASS（1 现有 + 3 新）。`npx vitest run` 全绿（108）、`npm run typecheck` 干净。

- [ ] **Step 5: 提交**

```bash
git add src/extract/tree.ts test/tree.test.ts
git commit -m "feat(tree): 多语言文件收集 + --include 目录过滤 + Rails 风格章推导（root 文件归 root）"
```

---

## Task 4: `cli.ts` 接 `--include` + 标签围栏按语言

**Files:**
- Modify: `src/cli.ts`、`src/label/prompt.ts`
- Test: `test/cli.test.ts`（追加）、`test/prompt-fence.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

`test/prompt-fence.test.ts`（新建）：

```ts
import { describe, it, expect } from 'vitest';
import { userPrompt } from '../src/label/prompt.js';
import type { ChunkLabelInput } from '../src/types.js';

const mk = (file: string): ChunkLabelInput => ({
  chunkId: file, chunkName: 'x', file, chapterName: 'c',
  riskBucket: 'low', contribBucket: 'filler',
  functions: [{ name: 'f', source: 'BODY' }], neighbors: [], contentHash: 'h',
});

describe('userPrompt fence', () => {
  it('uses the language fence matching the chunk file', () => {
    expect(userPrompt(mk('crates/foo/src/lib.rs'))).toContain('```rust');
    expect(userPrompt(mk('app/models/user.rb'))).toContain('```ruby');
  });
});
```

`test/cli.test.ts` 追加（import 行合并 `parseArgs`：`import { runMap, resolveLabeler, parseArgs } from '../src/cli.js';`；文件末尾新增 describe）：

```ts
describe('parseArgs --include', () => {
  it('defaults to undefined, parses comma-separated prefixes', () => {
    expect(parseArgs(['--repo', 'r']).include).toBeUndefined();
    expect(parseArgs(['--include', 'app,lib']).include).toEqual(['app', 'lib']);
    expect(parseArgs(['--include', ' app , ,lib ']).include).toEqual(['app', 'lib']);
  });
});

describe('runMap with ruby + include', () => {
  it('maps only chunks under the included prefix', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'app/models/user.rb', 'def m; 1; end\n');
    writeRepoFile(dir, 'lib/util.rb', 'def h; 1; end\n');
    commitAll(dir, 'init');

    await runMap({ repo: dir, outDir: dir, labeler: null, include: ['app'] });

    const tree = JSON.parse(readFileSync(join(dir, 'easyreview.tree.json'), 'utf8'));
    expect(tree.chunks.map((c: { file: string }) => c.file)).toEqual(['app/models/user.rb']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/prompt-fence.test.ts test/cli.test.ts`
Expected: FAIL — prompt 里是 ```` ```rust ```` 写死（.rb 用例挂）；`parseArgs` 未导出、`MapOptions` 不认 include。现有 cli 用例仍 PASS。

- [ ] **Step 3: 改 `src/label/prompt.ts`**（只动 userPrompt 的围栏一处）

import 区加：

```ts
import { langOf } from '../extract/lang.js';
```

`userPrompt` 里：

```ts
export function userPrompt(i: ChunkLabelInput): string {
  const fence = langOf(i.file)?.fence ?? '';
  const fns = i.functions
    .map((f) => `### ${f.name}\n\`\`\`${fence}\n${f.source}\n\`\`\``)
    .join('\n\n');
  // ……其余原样不动
```

- [ ] **Step 4: 改 `src/cli.ts`**

(a) import 区加：

```ts
import { inScope } from './extract/lang.js';
```

(b) `MapOptions` 加字段：

```ts
  include?: string[];       // --include：目录前缀过滤（如 app,lib），缺省不过滤
```

(c) `runMap` 里两处：

```ts
  const tree = await buildTree(repo, { include: opts.include });
```

sources 收集（原 `.filter((x) => x.endsWith('.rs'))`）改为：

```ts
  for (const f of listTrackedFiles(repo).filter((x) => inScope(x, opts.include))) {
```

(d) `parseArgs` **导出**并加 include（其余字段原样）：

```ts
export function parseArgs(argv: string[]): MapOptions {
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const inc = get('--include', '');
  return {
    repo: get('--repo', process.cwd()),
    outDir: get('--out', process.cwd()),
    noLabel: argv.includes('--no-label'),
    model: get('--model', '') || undefined,
    provider: get('--provider', 'deepseek') === 'claude' ? 'claude' : 'deepseek',
    include: inc ? inc.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  };
}
```

- [ ] **Step 5: 跑测试确认通过 + 全量回归**

Run: `npx vitest run test/prompt-fence.test.ts test/cli.test.ts`
Expected: PASS。`npx vitest run` 全绿（111）、`npm run typecheck` 干净。

- [ ] **Step 6: 提交**

```bash
git add src/cli.ts src/label/prompt.ts test/cli.test.ts test/prompt-fence.test.ts
git commit -m "feat(cli): --include 目录过滤（map/中心度同一套 inScope）；标签围栏按语言"
```

---

## Task 5: verify 对非 Rust 块友好拒绝

**Files:**
- Modify: `src/cli-verify.ts`
- Test: `test/verify-ruby-reject.test.ts`（新建）

- [ ] **Step 1: 写失败测试 `test/verify-ruby-reject.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerifyShow, runVerifyPredict } from '../src/cli-verify.js';

let dirs: string[] = [];
afterEach(() => { dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); dirs = []; });

function outDirWithRubyChunk(): string {
  const dir = mkdtempSync(join(tmpdir(), 'easyrev-vrb-'));
  dirs.push(dir);
  const tree = {
    repo: '/fake',
    chapters: [{ id: 'app:models', name: 'app::models', crate: 'app', dir: 'models', chunkIds: ['app/models/user.rb'] }],
    chunks: [{ id: 'app/models/user.rb', name: 'user', file: 'app/models/user.rb', crate: 'app', leafIds: [] }],
    leaves: [],
    grades: {},
  };
  writeFileSync(join(dir, 'easyreview.tree.json'), JSON.stringify(tree));
  return dir;
}

describe('verify rejects non-rust chunks', () => {
  it('show: throws a friendly not-supported error before touching cargo', async () => {
    const dir = outDirWithRubyChunk();
    await expect(runVerifyShow({ repo: dir, outDir: dir, chunkId: 'app/models/user.rb' }))
      .rejects.toThrow(/暂只支持 Rust/);
  });

  it('predict: same rejection', async () => {
    const dir = outDirWithRubyChunk();
    await expect(runVerifyPredict({ repo: dir, outDir: dir, chunkId: 'app/models/user.rb', predicted: [] }))
      .rejects.toThrow(/暂只支持 Rust/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/verify-ruby-reject.test.ts`
Expected: FAIL — show 会往下走到读源文件/`chooseMutation`（报别的错，不是"暂只支持 Rust"）。

- [ ] **Step 3: 改 `src/cli-verify.ts`**

import 区加：

```ts
import { langOf } from './extract/lang.js';
```

新增私有校验（放在 `findChunk` 之后）：

```ts
function assertRustChunk(chunk: Chunk): void {
  if (langOf(chunk.file)?.id !== 'rust') {
    throw new Error(
      `verify（突变探针）暂只支持 Rust（cargo）；\`${chunk.file}\` 不是 Rust——rspec 探针在路线图子项目②。`,
    );
  }
}
```

`runVerifyShow` 与 `runVerifyPredict` 里 `const chunk = findChunk(g, o.chunkId);` 之后各加一行：

```ts
  assertRustChunk(chunk);
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run test/verify-ruby-reject.test.ts`
Expected: PASS（2 tests）。`npx vitest run` 全绿（113）、`npm run typecheck` 干净。

- [ ] **Step 5: 提交**

```bash
git add src/cli-verify.ts test/verify-ruby-reject.test.ts
git commit -m "feat(verify): 非 Rust 块友好拒绝（rspec 探针=子项目②）"
```

---

## Task 6（手动 observe）：真实 chatwoot 冒烟

**Files:** 无代码改动。chatwoot 已 unshallow（6365 commits）。

- [ ] **Step 1: map（738 块 + 6365 commits 信号；无 key 则自动跳过标签）**

```bash
mkdir -p <chatwoot-out>   # 独立 outDir，别和 umwelt-bevy 混
npm run map -- --repo E:/learning/agent-research/repos/chatwoot --include app --out <chatwoot-out>
```

Expected: tree.json ~738 chunks；章形如 `app:models`、`app:controllers/...`；风险轴有分布（不全平）。有 DEEPSEEK_API_KEY 时 labels.json 会打满（首次 ~738 次调用，增量缓存）。

- [ ] **Step 2: learn + serve + 浏览器过动线**

```bash
npm run learn -- --out <chatwoot-out>
npm run serve -- --out <chatwoot-out> --port 4872
```

浏览器检查：网格块数/分布合理、hover 名字、点块出卡片（Ruby 函数名列表）、下一步卡片、标记已理解联动。

- [ ] **Step 3: verify 拒绝实测**

```bash
npm run verify -- app/models/user.rb --repo E:/learning/agent-research/repos/chatwoot --out <chatwoot-out>
```

Expected: 明确报"verify（突变探针）暂只支持 Rust……子项目②"，不碰 cargo。

- [ ] **Step 4: Rust 回归冒烟（umwelt-bevy 不受影响）**

```bash
npm run map -- --repo D:/dev/umwelt-bevy --out .
```

Expected: 照常 68 块；已有 labels 缓存因 hash 未变几乎不再调 API。

---

## 收尾

- [ ] 全量 `npx vitest run` 全绿、`npm run typecheck` 干净。
- [ ] 更新 `docs/HANDOFF.md`（单独提交 `docs: HANDOFF 同步 Ruby 映射`）：
  - "现状"节：目标分析对象加一行 chatwoot（`E:\learning\agent-research\repos\chatwoot`，Ruby/Rails，学习地图限 `--include app`）。
  - "完整闭环"代码块加 Ruby 用法三行（map --include app / learn / serve --port 4872，注明 outDir 隔离）。
  - 代码地图：`extract/rust.ts` 行改为 `extract/lang.ts`（语言注册表）+ `extract/leaves.ts`（通用叶子提取）两行；`extract/parser.ts` 行措辞改"按语言单例 getParser（getRustParser 为薄包装）"。
  - "下一步"清单加两条：**子项目② rspec 突变探针**（需 Docker 立 chatwoot 测试环境——本机无 Ruby/Postgres/Redis；先勘察再 spec）、**Vue/JS 提取**（注册表加项即可，但要过规模关：.vue 1092 + .js 1022）。
