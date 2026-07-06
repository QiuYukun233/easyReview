# 设计：更聪明的突变位点（tree-sitter 语句选择）

> 日期：2026-07-07 · 主题：让 `chooseMutation` 更倾向选到"注释后某测试变红"的位点，而非"编译崩"——用 tree-sitter 按 AST 节点类型挑语句，挑不到再回退现有 regex。

## 背景

突变探针 verify 的教学价值在于：注释掉一行 → **某个具体测试变红** → 学习者预测过 → 学到"谁依赖这行"。当前 `src/verify/mutate.ts` 的 `chooseMutation` 用纯 regex 挑位点：过滤 loc≥3 的函数，逐行找第一条 `isCommentable` 的语句就注释。对 `crates/chem_field/src/core/field.rs`，第一个 loc≥3 函数是构造器 `Field::new`，它的第一条 commentable 语句在**结构体字面量里**，注释后结构体不完整 → **编译崩**。编译崩是"承重"信号（真实、有用），但教学上不如"具体测试变红"丰富。

改进：用 tree-sitter（项目已用）按 AST 挑一个"好语句"——赋值 / 复合赋值 / 裸副作用调用——这些注释后保留绑定、只改行为，大概率让某测试变红而非编译崩。挑不到就回退现有 regex 扫描，保证**绝不退步**。

## 铁律不变

`withMutation` 的 "finally 无条件还原 + 施突变前校验目标行 + sha256 字节级还原" **一行不动**。本计划只改"挑哪一行"，不改"怎么施/还原突变"。umwelt-bevy 安全性不受影响。

## 架构

- 新增 `src/verify/pick-site.ts`：`pickPreferredSite(source: string): Promise<{ line: number; original: string } | null>`——用 tree-sitter 在源码里挑一个"好语句"行（1-based 行号 + 原行文本）；挑不到返回 null。
- `src/verify/mutate.ts` 的 `chooseMutation` 变成 **async 编排器**：先问 `pickPreferredSite`，命中就用它造 `MutationOp`；否则走**现有 regex 扫描**造 `MutationOp`；都没有返回 null。
- 唯一生产调用点 `src/cli-verify.ts` `runVerifyShow` 里 `const op = chooseMutation(...)` 改为 `const op = await chooseMutation(...)`。async 涟漪只此一处；`probe.ts` 用的是 `withMutation`，不受影响。
- 解析器复用：把 `extract/rust.ts` 里私有的 parser 单例初始化抽成极小共享模块 `src/extract/parser.ts`（`getRustParser(): Promise<Parser>`），`rust.ts` 与 `pick-site.ts` 都用它。这是顺手的、有界的小重构——只挪 parser init，不改 `extractLeaves` 行为。

## pick-site 选法

`pickPreferredSite(source)`：
1. `getRustParser()` 解析 source。
2. 在**函数体（`function_item` 的 body block）内**、**单行**（节点 `startPosition.row === endPosition.row`，配合"注释一行"机制）的 `expression_statement` 里挑，其内层表达式是以下之一：
   - `assignment_expression`（`self.x = …` / `x = …`）——保留 lvalue、只改值
   - `compound_assignment_expr`（`x += …`）
   - 裸 `call_expression` / `macro_invocation`（`foo.bar(…);`、`v.push(x);`）——副作用被去掉
3. **避开**：`let_declaration`（注释→缺绑定→编译崩）、结构体字面量字段（`struct_expression` 内）、tail 返回表达式（block 里最后一个不带 `;` 的表达式）、控制流头 / 块起始。
4. 多候选取**源码顺序第一个**（`startPosition` 最靠前）。
5. 返回 `{ line: node.startPosition.row + 1, original: <该行完整文本> }`，或 null。

> 这天然跳过纯构造器：`Field::new` 的 body 只有结构体字面量、没有上述语句 → 该函数无候选，picker 自动看源码后面的函数；找到第一个逻辑函数里的赋值/调用。

实现注意：把节点类型判断建立在 tree-sitter-rust 的实际语法节点名上——实现时先对样例源码打印 AST 节点类型确认（如 `compound_assignment_expr` vs `compound_assignment_expression` 的确切拼写），以真实语法为准，不臆测。

## chooseMutation 编排（`mutate.ts`）

```
async chooseMutation(chunk, leaves, source):
  1. pref = await pickPreferredSite(source)
     若 pref 非 null：用 pref.line / pref.original 造 MutationOp 返回（升级路径）
  2. 否则：现有 regex 扫描（loc≥3 函数 + isCommentable 逐行）找第一条可注释语句造 MutationOp（回退路径）
  3. 都没有：返回 null
```

- `MutationOp` 构造（`indent = original.match(/^\s*/)`；`mutated = \`${indent}// ${original.trim()}\``；`description`）由一个小 helper 共用，两条路都调，避免重复。
- **绝不退步**：现有 regex 能找到位点的块，新版至少同样能找到；仅在有"好语句"时升级。
- 签名保留 `chooseMutation(chunk, leaves, source)`（`leaves` 仍用于回退路径），只是返回 `Promise<MutationOp | null>`。

## 测试（TDD，沿用项目纪律）

- `test/pick-site.test.ts`（真实 tree-sitter，参照现有 `tree.test.ts` 用真实 parser）：
  - 构造器 + 逻辑函数：`fn new() -> Self { Self { x, y } }` 后跟 `fn step(&mut self) { self.x = f(); }` → 挑到 `self.x = f();` 那行，**不**挑构造体字段。
  - 只有 `let a = 1;` 的函数 → 返回 null（交给回退）。
  - `x += 1;`、裸调用 `v.push(a);` 能被选中；跨多行的语句不被选中。
- `test/mutate.test.ts`（扩展；现有用例因 `chooseMutation` 变 async 需改 `await`）：
  - 有好语句 → 选到赋值/调用行（升级）。
  - 只有 let/构造体字面量、无好语句 → 回退到 regex 仍返回非 null（不退步），断言位点落在旧逻辑会选的行。
- `test/cli-verify.test.ts`：把 `chooseMutation(...)` 调用点改 `await`（现有用例继续绿；`runVerifyShow` 已是 async）。
- `test/rust.test.ts` / `test/tree.test.ts`：抽共享 parser 后继续绿 = 回归保障。

## 非目标（YAGNI）

- 不做"实测挑红"（不为选位点额外跑 cargo）。
- 不动 `withMutation` / `probe.ts` / `judge.ts`。
- 不做"偏好非首条语句"的更精细排序（源码序第一个够用）。
- 不改突变机制（仍单行注释）。
- 无新依赖（tree-sitter 已在）、无新增 gitignore。
