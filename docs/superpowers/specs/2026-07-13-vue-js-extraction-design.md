# Vue/JS 提取 · 设计(2026-07-13)

> 路线图多语言子项目③(HANDOFF"下一步"第 7 条)。前置:Ruby 映射(PR #6)、rspec 探针(PR #10)。
> 状态:设计已经用户逐节确认(2026-07-13)。

## 1. 目标与边界

给语言注册表加 **JavaScript(.js)** 和 **Vue SFC(.vue)** 两项,让 map / learn / viewer / 解读全链路覆盖
chatwoot 前端(`app/javascript/` 下 1092 个 .vue + 1011 个 .js)。

**边界(用户已确认):**
- verify 突变探针**不做**——对 vue/js 块保持现有友好拒绝(`runnerFor` else 分支),补测试锁死行为。
  将来若做 vitest 探针另立子项目。
- 测试文件**排除**在地图外(`*.spec.js` / `*.test.js` / `specs/` / `__tests__/` 目录)——与 Rails 侧
  spec/ 被 `--include app` 天然排除对称;chatwoot 前端有 371 个 spec 混在源码目录里。
- TypeScript **不做**(chatwoot 前端只有 1 个 .ts,无真仓可验收;注册表"加语言=加一项",将来碰到再加)。

## 2. 注册表扩展:两个新的可选字段

`LangSpec`(`src/extract/lang.ts`)加两个可选字段,"加语言=加一项"模型不破:

```ts
export interface LangSpec {
  id: 'rust' | 'ruby' | 'js' | 'vue';
  exts: string[];
  wasm: string;
  query: string;
  fence: string;
  /** parse 前的区段切取。缺省=整文件一个区段、offset 0。返回 [] = 无叶子(块照常进地图)。 */
  carve?: (source: string) => Array<{ source: string; lineOffset: number }>;
  /** 命中任一即不进 scope(inScope 在 langOf 命中后先查它)。 */
  exclude?: RegExp[];
}
```

- **carve 返回数组**:合法 SFC 允许 `<script>` 与 `<script setup>` 并存;空数组对应纯模板组件
  (chatwoot 有 6 个),文件仍是 chunk、只是没有函数叶。
- **exclude**:JS/Vue 项配 `[/\.spec\.js$/, /\.test\.js$/, /(^|\/)specs?\//, /(^|\/)__tests__\//]`;
  rust/ruby 不配,行为零变化。

新注册项:

- `JS = { id:'js', exts:['.js'], wasm:'tree-sitter-javascript.wasm', query:<JS查询>, fence:'javascript', exclude:[...] }`
- `VUE = { id:'vue', exts:['.vue'], wasm:同 JS, query:同 JS, fence:'vue', carve:carveVueScript, exclude:[...] }`

Vue 直接复用 JS 语法 wasm 与查询,唯一差别是先切 script。`extract/leaves.ts` 在 parse 前应用
carve,对每个区段独立 parse,叶子行号 += lineOffset。
(注意 `extract/parser.ts` 的 parser 缓存按 `spec.id` 键控、`leaves.ts` 的 query 缓存也按 `spec.id`——
js 与 vue 两项共用同一 wasm 会各建一份 parser/query,冗余但无害,不特殊处理。)

## 3. 什么算 JS 的"函数叶子"

四种形态,覆盖 chatwoot 实际代码(861 个 `<script setup>` + 225 个 options API + 纯 JS 模块):

1. `function foo() {}` — 函数声明(含 generator);
2. `const foo = () => {}` / `const foo = function () {}` — 变量声明绑定的箭头/函数表达式
   (script setup 的主要形态;helper 模块的 `export const foo = ...` 也是它);
3. `foo() {}` — 对象/类的 shorthand 方法(options API 的 `methods:` / `computed:` 成员、
   Vuex actions、class 方法);
4. `foo: () => {}` — 对象属性值为箭头/函数表达式。

**匿名回调不算叶子**(传参的裸箭头函数没有名字,不是学习单元)。

精确 tree-sitter S 表达式在 plan 阶段**实测定稿**(node 名如 `function_expression` vs `function`
有 grammar 版本差异)——沿用 Ruby 项"实测(2026-07-08)"的惯例,注册项注释里记实测日期。

## 4. Vue SFC 切取(carveVueScript)

确定性 regex:全局找 `<script\b[^>]*>` 开标签,区段 = 开标签之后到下一个 `</script>` 之前;
`lineOffset` = 开标签结尾所在行(0 基)。叶子行号 = 区段内 parse 行号 + lineOffset,
**直接指向真实 .vue 文件的真实行**——源码抽屉函数跳行、interpret 行号引用零特判。

已知边界(接受):`</script>` 出现在 script 内字符串里会切早——HTML 规范本身按首个
`</script>` 切,合法 SFC 不会出现。

不用 tree-sitter-vue(方案 2 已否):双 parse、语法是 Vue 2 时代的、要开"一个文件两种
parser"的特殊通道,为一个几乎不存在的边界付双倍复杂度。

## 5. 规模关:中心度分词化

现状 `grade/centrality.ts` 的 `nameFanInCentrality` 是每名字建正则 × 每文件扫一遍
(O(名字 × 文件 × 文件大小));前端加入后 ~1.2 万名字 × ~2800 文件 → 分钟级。

改成:**每文件单遍分词**(`[A-Za-z0-9_]+`,与 `\b` 词边界定义严格一致)建词频 Map,
每名字 O(1) 查表求和:

- 纯词字符名字下与旧正则**计数严格等价**——单测锁定:同一输入新旧实现结果一致。
- 含非词字符的名字(Ruby 的 `valid?` / `save!`)极少,对它们保留旧的逐名字正则回退,行为零变化。
- 复杂度降到 O(总字符数),秒级。

## 6. 其余触点盘点(不改或只补测试)

| 触点 | 处置 |
|---|---|
| verify(`cli-verify.ts` runnerFor) | else 分支已报"仅支持 Rust/Ruby",vue/js 自然落入;补测试锁文案 |
| interpret / label | 语言无关(整文件源码+确定性事实),fence 按注册项走;新增 ~2100 块标签是一次性 API 成本,增量缓存照旧 |
| highlight(serve/highlight.ts) | 行级通用 tokenizer,对 JS/Vue 效果可接受,不动 |
| pick-site / mutate | 不动(verify 不支持 vue/js,不会走到) |
| 章切分 | `app:javascript/...` 每目录一章,chatwoot 167 → ~700 章;journey.md 变长、树视图靠折叠——接受 |
| grade 分位 | 分桶是全仓分位,前端块加入后 Ruby 块相对档位会移动——**预期行为,验收时不当回归** |

## 7. 测试与真仓验收

**单测(TDD):**
- carve:单 script / `<script>`+`<script setup>` 双块 / 无 script(空数组)/ lineOffset 正确性
  (含开标签不在行首、多行属性的情况);
- JS query:四种形态各有捕获、匿名回调不捕获、名字与行号正确;
- exclude:`.spec.js`/`.test.js` 后缀、`specs/`/`__tests__/` 目录按目录边界命中(`myspecs/` 不误伤)、
  rust/ruby 行为不变;
- 中心度:新旧实现在同一输入上计数一致(含多文件、重名、词边界毗邻情形)、非词字符名字走回退;
- verify:vue/js 块拒绝文案。

**真仓验收:**
- chatwoot `--include app` 重跑 map:预期 ~2470 块(738 + ~1730 非测试前端文件),记录耗时(目标分钟内);
- viewer 抽查 .vue 块:源码抽屉整文件展示、函数跳行落在 script 真实行;
- `URLHelper.js` 这类高扇入 helper 的中心度应明显偏高(与领域常识对照);
- umwelt-bevy 回归:68 块原样、标签缓存不动。
