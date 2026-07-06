# 更聪明的突变位点 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `chooseMutation` 优先用 tree-sitter 挑一个"注释后大概率某测试变红"的语句（赋值/复合赋值/裸调用），挑不到再回退现有 regex 扫描——绝不退步。

**Architecture:** 新增 `src/verify/pick-site.ts`（tree-sitter 挑"好语句"）；`src/verify/mutate.ts` 的 `chooseMutation` 变 async 编排器（prefer → regex 回退）；把 `extract/rust.ts` 的私有 parser 单例抽成共享 `src/extract/parser.ts`。`withMutation` 还原逻辑一行不动，umwelt-bevy 安全性不变。

**Tech Stack:** Node 20+ / TypeScript(ESM) / vitest / `web-tree-sitter` + `tree-sitter-wasms`。无新依赖。

> **AST 节点名已实证确认**（对 tree-sitter-rust wasm 打印 AST 得到，不要臆测）：
> - 目标语句：`expression_statement` 的首个具名子节点类型 ∈ `{ assignment_expression, compound_assignment_expr, call_expression, macro_invocation }`。注意复合赋值是 `compound_assignment_expr`（**不是** `_expression`）。
> - 构造器 `fn new() -> Self { Self { .. } }` 的 body block 直接含 `struct_expression`、**没有** `expression_statement` → picker 天然跳过。
> - `let a = 1;` 是 `let_declaration`（block 的直接子节点，非 expression_statement）→ 天然不被选。
> - tail 返回表达式 `a + b`（无 `;`）是 block 里的裸 `binary_expression`（非 expression_statement）→ 天然不被选。

---

## 文件结构

| 路径 | 职责 | 动作 |
|---|---|---|
| `src/extract/parser.ts` | 共享 Rust tree-sitter parser 单例：`getRustParser(): Promise<{ parser, lang }>` | Create |
| `src/extract/rust.ts` | 改用 `getRustParser()`（行为不变） | Modify |
| `src/verify/pick-site.ts` | `pickPreferredSite(source)` — tree-sitter 挑"好语句"行 | Create |
| `src/verify/mutate.ts` | `chooseMutation` 变 async 编排器（prefer → regex 回退）；`buildOp` helper | Modify |
| `src/cli-verify.ts` | `runVerifyShow` 里 `chooseMutation(...)` 改 `await` | Modify |
| `test/parser.test.ts` | 无需——由 rust/tree 现有测试回归保障（见 Task 1） | — |
| `test/pick-site.test.ts` | `pickPreferredSite` 单测（真实 tree-sitter） | Create |
| `test/choose-mutation.test.ts` | **已存在**——重写为 async + 升级断言（chooseMutation 测试统一在此）；`test/mutate.test.ts` 只测 withMutation、不动 | Modify |

---

## Task 1: 抽共享 tree-sitter parser（行为保持的小重构）

**Files:**
- Create: `src/extract/parser.ts`
- Modify: `src/extract/rust.ts`

先读 `src/extract/rust.ts` 对齐现状（它有私有 `getParser()` + 模块级 `lang`/`query`，`QUERY = '(function_item name: (identifier) @name) @fn'`）。

- [ ] **Step 1: 创建 `src/extract/parser.ts`**

```ts
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import Parser from 'web-tree-sitter';

const require = createRequire(import.meta.url);

let initPromise: Promise<{ parser: Parser; lang: Parser.Language }> | null = null;

/** 共享的 Rust tree-sitter parser 单例（parser + language）。多处复用，避免重复 init。 */
export async function getRustParser(): Promise<{ parser: Parser; lang: Parser.Language }> {
  if (!initPromise) {
    initPromise = (async () => {
      await Parser.init();
      const wasmPath = require.resolve('tree-sitter-wasms/out/tree-sitter-rust.wasm');
      const lang = await Parser.Language.load(readFileSync(wasmPath));
      const parser = new Parser();
      parser.setLanguage(lang);
      return { parser, lang };
    })();
  }
  return initPromise;
}
```

- [ ] **Step 2: 改 `src/extract/rust.ts` 用共享 parser**

把整个文件改为（保留 QUERY 与 extractLeaves 逻辑，只换 parser 来源、query 懒建一次）：

```ts
import Parser from 'web-tree-sitter';
import { getRustParser } from './parser.js';
import type { Leaf } from '../types.js';

const QUERY = '(function_item name: (identifier) @name) @fn';
let query: Parser.Query | null = null;

export async function extractLeaves(file: string, source: string): Promise<Leaf[]> {
  const { parser, lang } = await getRustParser();
  if (!query) query = lang.query(QUERY);
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

- [ ] **Step 3: 跑现有测试回归确认（这是行为保持重构，靠现有测试守）**

Run: `npx vitest run test/rust.test.ts test/tree.test.ts`
Expected: PASS（extractLeaves/buildTree 行为不变）。再跑 `npx tsc --noEmit`，确认干净。

> 注意：本分支从 main 开，无 `npm run typecheck` 脚本——用 `npx tsc --noEmit`。

- [ ] **Step 4: 提交**

```bash
git add src/extract/parser.ts src/extract/rust.ts
git commit -m "refactor(extract): 抽共享 getRustParser（rust.ts 复用，为 pick-site 铺路）"
```

---

## Task 2: pickPreferredSite（tree-sitter 挑"好语句"）

**Files:**
- Create: `src/verify/pick-site.ts`
- Test: `test/pick-site.test.ts`

- [ ] **Step 1: 写失败测试**

Create `test/pick-site.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pickPreferredSite } from '../src/verify/pick-site.js';

describe('pickPreferredSite', () => {
  it('skips a constructor struct literal and picks the assignment in a logic fn', async () => {
    const src = [
      'fn new() -> Self {',
      '    Self { x: 1, y: 2 }',
      '}',
      'fn step(&mut self) {',
      '    let a = 1;',
      '    self.x = compute();',
      '    a + 1',
      '}',
    ].join('\n');
    const site = await pickPreferredSite(src);
    expect(site).toEqual({ line: 6, original: '    self.x = compute();' });
  });

  it('picks a compound assignment', async () => {
    const src = 'fn f(&mut self) {\n    self.n += 1;\n}\n';
    expect(await pickPreferredSite(src)).toEqual({ line: 2, original: '    self.n += 1;' });
  });

  it('picks a bare side-effecting call', async () => {
    const src = 'fn f(&mut self) {\n    self.items.push(3);\n}\n';
    expect(await pickPreferredSite(src)).toEqual({ line: 2, original: '    self.items.push(3);' });
  });

  it('returns null when only let bindings / tail exprs exist (no good statement)', async () => {
    const src = 'fn f() -> i32 {\n    let a = 1;\n    a + 1\n}\n';
    expect(await pickPreferredSite(src)).toBeNull();
  });

  it('does not pick a multi-line statement', async () => {
    // 唯一的候选调用跨两行 → 不选 → null
    const src = 'fn f(&mut self) {\n    self.do_it(\n        1,\n    );\n}\n';
    expect(await pickPreferredSite(src)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/pick-site.test.ts`
Expected: FAIL — `src/verify/pick-site.js` 不存在。

- [ ] **Step 3: 实现 `src/verify/pick-site.ts`**

```ts
import Parser from 'web-tree-sitter';
import { getRustParser } from '../extract/parser.js';

const TARGET = new Set([
  'assignment_expression',
  'compound_assignment_expr',
  'call_expression',
  'macro_invocation',
]);

/**
 * 用 tree-sitter 挑一个"好语句"位点：单行的 expression_statement，其首个具名子节点
 * 是赋值/复合赋值/裸调用/宏调用——注释后大概率某测试变红（而非编译崩）。
 * 天然跳过 let 绑定、结构体字面量字段、tail 返回表达式。找不到返回 null。
 * 返回该行 1-based 行号 + 该行完整原文。
 */
export async function pickPreferredSite(
  source: string,
): Promise<{ line: number; original: string } | null> {
  const { parser } = await getRustParser();
  const tree = parser.parse(source);
  const lines = source.split('\n');

  // 递归收集所有 expression_statement 节点
  const stmts: Parser.SyntaxNode[] = [];
  const stack: Parser.SyntaxNode[] = [tree.rootNode];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'expression_statement') stmts.push(n);
    for (let i = 0; i < n.childCount; i++) stack.push(n.child(i)!);
  }

  const candidates = stmts.filter((n) => {
    if (n.startPosition.row !== n.endPosition.row) return false; // 仅单行
    const inner = n.namedChild(0);
    return !!inner && TARGET.has(inner.type);
  });
  tree.delete();

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.startIndex - b.startIndex); // 源码顺序
  const row = candidates[0].startPosition.row;
  return { line: row + 1, original: lines[row] };
}
```

> 实现者注意：先确认 `lang.query`/节点 API 与本仓库 web-tree-sitter 0.22 一致（`extract/rust.ts` 已示范 `matches`/`captures`/`startPosition`）。本实现用手写栈遍历而非 query，规避 query 语法风险；`namedChild(0)` 取内层表达式。若 `SyntaxNode` 类型导入名不符，以真实类型为准调整（功能不变）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/pick-site.test.ts`
Expected: PASS（5 tests）。跑 `npx tsc --noEmit` 干净。

- [ ] **Step 5: 提交**

```bash
git add src/verify/pick-site.ts test/pick-site.test.ts
git commit -m "feat(verify): pickPreferredSite（tree-sitter 挑赋值/调用语句作突变位点）"
```

---

## Task 3: chooseMutation 变 async 编排器（prefer → regex 回退）

**Files:**
- Modify: `src/verify/mutate.ts`
- Modify: `src/cli-verify.ts`
- Test: `test/choose-mutation.test.ts`（**已存在**，重写为 async + 升级断言）

先读 `src/verify/mutate.ts`（有 `withMutation`、`isCommentable`、同步 `chooseMutation`）**和** `test/choose-mutation.test.ts`（已存在，测同步 chooseMutation，其 test-1 断言挑第 6 行 `let dt = 0.1;` = 旧行为）对齐现状。

> **关键**：`test/choose-mutation.test.ts` 已存在并测**同步** chooseMutation。async 化会打破它——这是**预期的**：它编码的是旧的"挑第一条可注释行"行为，而新行为应升级到"挑复合赋值 `self.value += dt;`"。本任务**重写**这个文件（不是往 mutate.test.ts 另加）。`test/mutate.test.ts` 只测 withMutation，保持不动。

- [ ] **Step 1: 重写 `test/choose-mutation.test.ts`（先写、确认失败）**

用以下内容**整体替换** `test/choose-mutation.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { chooseMutation } from '../src/verify/mutate.js';
import type { Chunk, Leaf } from '../src/types.js';

const chunk: Chunk = { id: 'crates/chem_field/src/core/field.rs', name: 'field', file: 'crates/chem_field/src/core/field.rs', crate: 'chem_field', leafIds: ['f::step::5'] };
const leaves: Leaf[] = [
  { id: 'f::step::5', kind: 'fn', name: 'step', file: chunk.file, startLine: 5, endLine: 9, loc: 5 },
];

describe('chooseMutation', () => {
  it('upgrades: prefers the compound-assignment statement over the earlier let binding', async () => {
    const source = [
      'line1', 'line2', 'line3', 'line4',
      'pub fn step(&mut self) {',   // 5
      '    let dt = 0.1;',          // 6  (旧行为会挑这行)
      '    self.value += dt;',      // 7  (新行为：复合赋值=好语句，优先)
      '}',                          // 8
    ].join('\n');
    const op = (await chooseMutation(chunk, leaves, source))!;
    expect(op).not.toBeNull();
    expect(op.file).toBe(chunk.file);
    expect(op.line).toBe(7);
    expect(op.original).toBe('    self.value += dt;');
    expect(op.mutated).toBe('    // self.value += dt;');
  });

  it('falls back to regex when no preferred statement exists (never regresses)', async () => {
    const source = [
      'line1', 'line2', 'line3', 'line4',
      'pub fn calc() -> f32 {',   // 5
      '    let dt = 0.1;',        // 6  (只有 let + tail，无好语句)
      '    dt + 1.0',             // 7  (tail 表达式，不选)
      '}',                        // 8
    ].join('\n');
    const op = (await chooseMutation(chunk, leaves, source))!;
    expect(op).not.toBeNull();
    expect(op.line).toBe(6); // 回退 regex：第一条 commentable 是 let dt = 0.1;
    expect(op.original).toBe('    let dt = 0.1;');
    expect(op.mutated).toBe('    // let dt = 0.1;');
  });

  it('returns null when no commentable line exists', async () => {
    const emptyLeaf: Leaf[] = [{ id: 'x', kind: 'fn', name: 'x', file: chunk.file, startLine: 1, endLine: 2, loc: 2 }];
    expect(await chooseMutation(chunk, emptyLeaf, 'pub fn x() {}\n')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/choose-mutation.test.ts`
Expected: FAIL — 现同步 `chooseMutation` 返回的不是 Promise，`await` 后 `.line` 断言不符（尤其升级用例期望第 7 行，旧同步实现给第 6 行）。async 化 + prefer 逻辑后才通过。

- [ ] **Step 3: 改 `src/verify/mutate.ts`**

顶部追加 import：

```ts
import { pickPreferredSite } from './pick-site.js';
```

保留 `withMutation`、`isCommentable` 不动。把现有同步 `chooseMutation` 整个替换为一个 `buildOp` helper + async 编排器：

```ts
function buildOp(file: string, line: number, original: string): MutationOp {
  const indent = original.match(/^\s*/)?.[0] ?? '';
  return {
    file,
    line,
    original,
    mutated: `${indent}// ${original.trim()}`,
    description: `注释掉 ${file}:${line} 的一行语句`,
  };
}

/** 为一个 chunk 选突变位点：优先 tree-sitter 挑"好语句"（赋值/调用→大概率红测试），
 *  挑不到回退现有 regex 扫描（loc≥3 函数逐行找第一条可注释语句）。都没有返回 null。 */
export async function chooseMutation(chunk: Chunk, leaves: Leaf[], source: string): Promise<MutationOp | null> {
  const pref = await pickPreferredSite(source);
  if (pref) return buildOp(chunk.file, pref.line, pref.original);

  // 回退：现有 regex 逻辑（绝不退步）
  const lines = source.split('\n');
  const fns = leaves.filter((l) => l.file === chunk.file && l.loc >= 3).sort((a, b) => a.startLine - b.startLine);
  for (const fn of fns) {
    for (let ln = fn.startLine; ln <= fn.endLine; ln++) {
      const original = lines[ln - 1];
      if (original !== undefined && isCommentable(original)) {
        return buildOp(chunk.file, ln, original);
      }
    }
  }
  return null;
}
```

（`isCommentable` 原样保留；`MutationOp`/`Chunk`/`Leaf` 已在现有 import 里——若缺 `Chunk`/`Leaf` 则补进 `import type` 行。）

- [ ] **Step 4: 改 `src/cli-verify.ts` 调用点为 await**

在 `runVerifyShow` 里找到：
```ts
  const op = chooseMutation(chunk, leaves, source);
```
改为：
```ts
  const op = await chooseMutation(chunk, leaves, source);
```
（`runVerifyShow` 已是 async，其余不动。）

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/choose-mutation.test.ts`
Expected: PASS（3 tests：升级 / 回退 / null）。`test/mutate.test.ts`（withMutation）未动、仍绿。

- [ ] **Step 6: 全量 + typecheck**

Run: `npx vitest run` — 全绿（尤其 `test/cli-verify.test.ts`：现有 chem_field 用例的 source 只有 let+tail → pickPreferredSite 返回 null → 走 regex 回退 → 突变位点与改动前一致 → 用例继续通过）。
Run: `npx tsc --noEmit` — 干净。

- [ ] **Step 7: 提交**

```bash
git add src/verify/mutate.ts src/cli-verify.ts test/choose-mutation.test.ts
git commit -m "feat(verify): chooseMutation 优先挑好语句（tree-sitter），regex 兜底；调用点 await"
```

---

## Task 4（可选，手动）：真实 field.rs 冒烟

**Files:** 无代码改动——人工验证，需真实 cargo（chem_field 热编译 ~35s/次）。

- [ ] **Step 1: 确认 map 产物存在**（若已有可跳过）

Run: `npm run map -- --repo D:/dev/umwelt-bevy --out .`

- [ ] **Step 2: 对 field.rs 跑 show，看突变位点是否变成"好语句"**

Run: `npm run verify -- crates/chem_field/src/core/field.rs --repo D:/dev/umwelt-bevy --out .`
Expected: `easyreview.verify.md` 里的突变位点应落在一条赋值/调用语句上（而非之前 `Field::new` 的构造体字段行）。若 field.rs 恰好没有独立的赋值/调用语句，会回退到 regex——记录实际选到哪行到交接。

- [ ] **Step 3: 预测揭晓，确认爆炸半径更可能是"具体测试变红"**

Run: `npm run verify -- crates/chem_field/src/core/field.rs --predict <逗号分隔测试名> --repo D:/dev/umwelt-bevy --out .`
Expected: 相比改动前（编译崩），现在更可能是某几个具体测试变红。原文件字节级还原（`git -C D:/dev/umwelt-bevy status` 干净）。

---

## 收尾

- [ ] 全量 `npx vitest run` 全绿、`npx tsc --noEmit` 干净。
- [ ] 更新 `docs/HANDOFF.md`：把"下一步 3（更聪明的突变位点）"标记完成；`verify/mutate.ts` 一行说明改为"chooseMutation 优先 tree-sitter 挑好语句、regex 兜底"，代码地图加 `extract/parser.ts` + `verify/pick-site.ts` 两行。单独提交。
