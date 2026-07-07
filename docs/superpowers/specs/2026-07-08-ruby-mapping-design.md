# 设计：Ruby 映射（多语言子项目①——学 chatwoot）

> 日期：2026-07-08 · 主题：easyReview 的地图/旅程/标签/viewer 支持 Ruby 仓库（目标：`E:\learning\agent-research\repos\chatwoot`），通过"语言注册表"泛化提取层，加 `--include` 目录过滤器。verify（突变探针）本轮**不**支持 Ruby——rspec 探针是子项目②（需先立 Docker 测试环境，独立 spec）。

## 背景与勘察事实

- chatwoot = Ruby on Rails + Vue.js：git tracked 8367 文件，`.rb` 2239（`app/` 下 738）、`.vue` 1092、`.js` 1022。
- 本轮范围（用户已确认）：**只做 Ruby**，加通用 `--include <前缀>` 过滤器控制规模（学 chatwoot 先限 `app/`，738 块是可用量级）。Vue/JS 留到以后（注册表就是为此铺路）。
- 浅克隆已补全：`git fetch --unshallow` 后 6365 commits，churn/耦合/所有权信号有效。
- `tree-sitter-wasms` 包内已有 `tree-sitter-ruby.wasm`（以及 vue/js/ts，将来可用）。
- 本机无 Ruby/Postgres/Redis（只有 Docker）——rspec 探针必须先立环境，故拆到子项目②。
- 现有 `.rs` 假设位置：`cli.ts:42`（sources 过滤）、`extract/tree.ts`（文件过滤/crateOf/baseName）、`extract/rust.ts`+`extract/parser.ts`（提取）、`label/prompt.ts`（```rust 围栏）、verify 系（cargo，本轮不动，只加拒绝）。

## 架构（方案 A：语言注册表）

### 新增 `src/extract/lang.ts` —— 唯一的语言知识源

```ts
export interface LangSpec {
  id: 'rust' | 'ruby';
  exts: string[];      // ['.rs'] / ['.rb']
  wasm: string;        // 'tree-sitter-rust.wasm' / 'tree-sitter-ruby.wasm'
  query: string;       // 叶子查询，捕获 @fn（整个函数节点）+ @name（名字节点）
  fence: string;       // 标签 prompt 代码围栏语言标签（'rust' / 'ruby'）
}
export const LANGS: LangSpec[];                        // rust + ruby
export function langOf(file: string): LangSpec | null; // 按扩展名；未注册 → null
```

- Rust query 沿用现有：`(function_item name: (identifier) @name) @fn`。
- Ruby 叶子 = `def foo`（`method`）+ `def self.foo`（`singleton_method`），一串 query 两个 pattern：`(method name: (identifier) @name) @fn (singleton_method name: (identifier) @name) @fn`。类/模块声明不算叶子（容器不是最小学习单元）。**节点/字段名以真实 wasm 语法为准，实现第一步用小样例实证**（计划③的教训：AST 名字必须实测）。

### `extract/parser.ts` 泛化

- `getParser(spec: LangSpec)`：按 `spec.id` 的单例缓存（`Map<id, Promise<{parser, lang}>>`），`Parser.init()` 只跑一次。
- 保留 `getRustParser()` 作薄包装（= `getParser(RUST)`）——`verify/pick-site.ts` 还在用，不动。

### `extract/rust.ts` → `extract/leaves.ts`

- 通用 `extractLeaves(file, source, spec): Promise<Leaf[]>`：逻辑与现在逐字相同（query 匹配 → Leaf{id,kind:'fn',name,file,startLine,endLine,loc}，`tree.delete()` 在读完节点后），parser/query 来自 spec；query 编译按语言缓存一次。
- `extract/rust.ts` 删除，`tree.ts` 改引 `leaves.js`。

### `extract/tree.ts`

- 文件筛选：`langOf(f) !== null`，再叠加可选 `include` 前缀（命中任一前缀才收）；`buildTree(repo, opts?: { include?: string[] })`。
- `crateOf`：`crates/<name>/` 命中照旧；否则顶层段；**无 `/` 的根文件 → `'root'`**（把 `.endsWith('.rs')` 判断换成 `top === file`，对旧行为等价）。chatwoot 自然成章：`app:models`、`app:controllers/api/v1`、`lib:...`。
- `baseName`：`\.rs$` → 通用 `\.[^.]+$`。
- 每文件提取时按 `langOf(file)` 选 spec。

### `src/cli.ts`

- `MapOptions` 加 `include?: string[]`；`parseArgs` 加 `--include app,lib`（逗号分隔前缀，缺省不过滤）。
- 中心度 sources 收集与 buildTree 用同一套过滤（已注册语言 + include）。

### `label/prompt.ts`

- 围栏从写死 ```` ```rust ```` 改为 `langOf(i.file)?.fence ?? ''`。`ChunkLabelInput` 类型不动、内容 hash 输入不变（file 本来就是块身份）——已有 Rust 标签缓存不失效。

### verify 拒绝（`cli-verify.ts`）

- 拿到 chunk 后若 `langOf(chunk.file)?.id !== 'rust'` → 明确报错："verify（突变探针）暂只支持 Rust（cargo）；该块是 Ruby——rspec 探针在下一轮（子项目②）"。不会默默跑 cargo。

## 错误处理

- Ruby 语法错误文件：tree-sitter 容错，能提取多少提多少（与 Rust 现状一致）。
- 未注册扩展名：不进树（等价现在非 .rs）。
- `--include` 全部未命中 → 0 块空地图照常落盘，不报错（与空仓行为一致）。

## 测试（TDD）

- `test/lang.test.ts` — langOf 按扩展名、未知 → null、fence 值。
- `test/ruby-extract.test.ts` — `def foo` / `def self.bar` / class·module 嵌套内方法 / 无方法文件→空；行号与 loc 正确。
- `test/tree.test.ts`（扩展现有）— 混合仓（.rs+.rb）两种块都进树；`include:['app']` 过滤；`app/models/user.rb` → 章 `app:models`；根级 `foo.rb` → crate `root`。
- `test/cli.test.ts`（扩展）— `--include` 解析（逗号分隔、缺省 undefined）。
- 现有 99 测试全绿不动（Rust 路径行为不变）。
- **真实冒烟（observe）**：chatwoot `map --include app --out <独立outDir>`（738 块、6365 commits 风险信号）→ `learn` → `serve --port 4872` 浏览器看地图/卡片/章切分；有 DEEPSEEK_API_KEY 则顺带打标签评质量；verify 对 Ruby 块的拒绝信息实测一条。

## 用法（学 chatwoot 的工作流；两项目 outDir 隔离互不干扰）

```bash
npm run map   -- --repo E:/learning/agent-research/repos/chatwoot --include app --out <chatwoot-out>
npm run learn -- --out <chatwoot-out>
npm run serve -- --out <chatwoot-out> --port 4872   # umwelt-bevy 继续用 4870
```

## 非目标（YAGNI / 子项目②）

- Vue/JS 提取（注册表留了位，本轮不做）。
- Ruby 的 verify/突变探针（rspec + Docker 环境 = 子项目②，独立勘察+spec）。
- 多仓库切换 UI（outDir 隔离已够用）。
- 块粒度细化（块=文件不变；Rails 单文件类与此天然契合）。

## 依赖/产物

- 零新依赖（tree-sitter-ruby.wasm 已在 tree-sitter-wasms 内）。
- 依赖注意：真实冒烟里的 viewer 体验需要 PR #5（web viewer）已合入 main；若届时未合，冒烟退化为看 journey.md/map.md。
