# 叶子形态扩展(JS 第六形态)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** JS 叶子查询加第六形态——任何标识符调用含函数实参、经 `variable_declarator` 绑定名字的,都成为具名叶子(方案 2 通用规则,spec:`docs/superpowers/specs/2026-07-13-leaf-form-expansion-design.md`)。

**Architecture:** 只改 `src/extract/lang.ts` 的 `JS_QUERY`(追加一条实测定稿的查询模式);`extractLeaves` 及全部下游零改动(新形态只捕获 `@name`/`@fn`,interpret 缓存键已含 functions 名单会自动失效)。测试进现有 `test/leaves-js.test.ts` 加一个 describe。

**Tech Stack:** TypeScript + web-tree-sitter(tree-sitter-javascript.wasm)+ vitest。

**实测依据(2026-07-13,probe-generic.mjs,对真实 wasm):** 多箭头实参只产 1 条匹配(无需去重);嵌套 declarator 内外各一叶;`function_expression` 实参与箭头同收;member_expression 调用(`_.debounce`/`api.get`)不捕获;无函数实参调用不捕获。

**约定提醒(执行者必读):**
- 测试绝不调用真实 cargo/docker/API。本计划的测试只用 `extractLeaves` 纯内存解析,无此风险。
- `npm run typecheck` 是真正的类型闸门,`npm test` 是全量测试(当前 62 文件 263 测试全绿)。
- 提交信息末尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 遇到计划没覆盖的情况,停下来报 NEEDS_CONTEXT,不要自行扩大范围。

---

### Task 1: JS_QUERY 第六形态 + 捕获用例

**Files:**
- Modify: `src/extract/lang.ts:31-40`(JS_QUERY 常量与其上方注释)
- Test: `test/leaves-js.test.ts`(文件末尾追加一个 describe)

- [ ] **Step 1: 写失败测试**

在 `test/leaves-js.test.ts` 文件末尾(现有 `describe('extractLeaves for Vue SFC', …)` 块之后)追加:

```ts
describe('extractLeaves 第六形态:标识符调用含函数实参(通用规则)', () => {
  it('single-line computed binding becomes a named leaf', async () => {
    const src = 'const label = computed(() => makeLabel(props));\n';
    const leaves = await extractLeaves('a/c.js', src, JS);
    expect(leaves.map((l) => l.name)).toEqual(['label']);
    expect(leaves[0].startLine).toBe(1);
    expect(leaves[0].loc).toBe(1); // 单行:loc=1,verify 回退的 loc≥3 过滤会天然挡住
  });

  it('multi-line computed body: endLine covers the whole declarator (regex 回退域的前提)', async () => {
    const src = [
      'const heavy = computed(() => {', // L1
      '  const x = props.a;',           // L2
      '  return x + 1;',                // L3
      '});',                            // L4
    ].join('\n');
    const leaves = await extractLeaves('a/c.js', src, JS);
    expect(leaves.map((l) => l.name)).toEqual(['heavy']);
    expect(leaves[0].startLine).toBe(1);
    expect(leaves[0].endLine).toBe(4);
    expect(leaves[0].loc).toBe(4);
  });

  it('multiple function arguments yield exactly one leaf (no dedup needed)', async () => {
    const src = 'const both = pipe(() => 1, () => 2);\n';
    const leaves = await extractLeaves('a/c.js', src, JS);
    expect(leaves.map((l) => l.name)).toEqual(['both']);
  });

  it('nested declarators: outer and inner each become a leaf', async () => {
    const src = [
      'const outer = computed(() => {',          // L1
      '  const inner = watch(x, () => sync());', // L2
      '  return inner;',                          // L3
      '});',                                      // L4
    ].join('\n');
    const leaves = await extractLeaves('a/c.js', src, JS);
    const byName = Object.fromEntries(leaves.map((l) => [l.name, l]));
    expect(Object.keys(byName).sort()).toEqual(['inner', 'outer']);
    expect(byName['outer'].startLine).toBe(1);
    expect(byName['outer'].endLine).toBe(4);
    expect(byName['inner'].startLine).toBe(2);
  });

  it('generic rule captures unknown wrappers (方案 2 与白名单的分水岭)', async () => {
    const src = 'const nope = randomWrapper(() => 1);\n';
    const leaves = await extractLeaves('a/c.js', src, JS);
    expect(leaves.map((l) => l.name)).toEqual(['nope']);
  });

  it('setTimeout binding is captured (接受的代价——值不是函数也成叶,勿加白名单挡它)', async () => {
    const src = 'const id = setTimeout(() => tick(), 100);\n';
    const leaves = await extractLeaves('a/c.js', src, JS);
    expect(leaves.map((l) => l.name)).toEqual(['id']);
  });

  it('function_expression argument is captured (与形态 3/5 对称)', async () => {
    const src = 'const fe = wrap(function () { return 1; });\n';
    const leaves = await extractLeaves('a/c.js', src, JS);
    expect(leaves.map((l) => l.name)).toEqual(['fe']);
  });

  it('member-expression calls and plain calls are NOT captured', async () => {
    const src = [
      'const member = _.debounce(() => save(), 300);', // function 是 member_expression
      'const chained = api.get(() => 1);',             // 同上
      'const plain = foo(1, 2);',                      // 无函数实参
    ].join('\n');
    const leaves = await extractLeaves('a/c.js', src, JS);
    expect(leaves).toEqual([]);
  });

  it('vue SFC: 第六形态行号经 lineOffset 还原到真实文件坐标', async () => {
    const sfc = [
      '<template>',                                   // L1
      '  <div />',                                    // L2
      '</template>',                                  // L3
      '<script setup>',                               // L4
      'const count = computed(() => props.n + 1);',   // L5
      '</script>',                                    // L6
      '',
    ].join('\n');
    const leaves = await extractLeaves('w/Count.vue', sfc, VUE);
    expect(leaves.map((l) => l.name)).toEqual(['count']);
    expect(leaves[0].startLine).toBe(5);
    expect(leaves[0].id).toBe('w/Count.vue::count::5');
  });
});
```

导入无需改动:文件顶部已有 `import { extractLeaves } from '../src/extract/leaves.js';` 与 `import { JS, VUE } from '../src/extract/lang.js';`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/leaves-js.test.ts`
Expected: 新 describe 的 9 个用例中 8 个 FAIL(捕获类用例拿到空数组);`member-expression …NOT captured` 用例天然 PASS(现在什么都不捕获)。原有 4 个用例 PASS。

- [ ] **Step 3: 实现——JS_QUERY 追加第六形态**

`src/extract/lang.ts`,把:

```ts
// 实测（2026-07-13，对真实 tree-sitter-javascript.wasm）：五种形态覆盖 chatwoot 实际代码
// （function 声明含 generator / const 绑定箭头与函数表达式 / 对象与 class 的 shorthand 方法 /
//   pair 属性值为箭头或函数表达式）；export 外层包装不挡匹配；匿名回调与解构不被捕获。
const JS_QUERY = [
  '(function_declaration name: (identifier) @name) @fn',
  '(generator_function_declaration name: (identifier) @name) @fn',
  '(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @fn',
  '(method_definition name: (property_identifier) @name) @fn',
  '(pair key: (property_identifier) @name value: [(arrow_function) (function_expression)]) @fn',
].join('\n');
```

改为:

```ts
// 实测（2026-07-13，对真实 tree-sitter-javascript.wasm）：六种形态覆盖 chatwoot 实际代码
// （function 声明含 generator / const 绑定箭头与函数表达式 / 对象与 class 的 shorthand 方法 /
//   pair 属性值为箭头或函数表达式 / const 绑定"标识符调用含函数实参"——computed/watch/debounce
//   这类包装,通用规则不设白名单,setTimeout 型绑定也收,是接受的代价）；
//   export 外层包装不挡匹配；匿名回调、解构、成员表达式调用（_.debounce）不被捕获；
//   多函数实参只产一条匹配,嵌套 declarator 内外各成一叶。
const JS_QUERY = [
  '(function_declaration name: (identifier) @name) @fn',
  '(generator_function_declaration name: (identifier) @name) @fn',
  '(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @fn',
  '(method_definition name: (property_identifier) @name) @fn',
  '(pair key: (property_identifier) @name value: [(arrow_function) (function_expression)]) @fn',
  '(variable_declarator name: (identifier) @name value: (call_expression function: (identifier) arguments: (arguments [(arrow_function) (function_expression)]))) @fn',
].join('\n');
```

（只加最后一个数组元素并更新注释;前五条一字不动。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/leaves-js.test.ts`
Expected: 13 个用例全 PASS(原 4 + 新 9)。

- [ ] **Step 5: 全量回归 + 类型闸门**

Run: `npm test`
Expected: 62 文件全 PASS(总测试数 263 → 272)。特别关注 `lang-js-vue.test.ts`(断言 `VUE.query === JS.query`,同一常量,应 PASS)与 `centrality.test.ts`/`tree.test.ts` 等下游(不依赖形态数,应 PASS)。

Run: `npm run typecheck`
Expected: 零错误。

- [ ] **Step 6: 提交**

```bash
git add src/extract/lang.ts test/leaves-js.test.ts
git commit -m "feat: JS 叶子第六形态——标识符调用含函数实参的具名绑定(通用规则)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 配方文档的已知局限更新

**Files:**
- Modify: `docs/recipes/chatwoot-vitest.md:74`(「已知局限」列表中一条)

- [ ] **Step 1: 更新过时表述**

`docs/recipes/chatwoot-vitest.md` 的「已知局限」里这一条:

```markdown
- 纯声明式 `<script setup>`（函数全藏在 `computed(() => …)` 参数里）提不出具名叶子 → "找不到可突变的语句行"（验收实测:ChannelLeaf/SidebarUnreadBadge 均如此）——这是叶子五形态的已知边界,换块即可。
```

改为:

```markdown
- 纯声明式 `<script setup>`:叶子第六形态(2026-07-13)后 `const x = computed(() => …)` 已是具名叶子,多行 computed 体进 regex 回退扫描域;单行 computed(loc=1)仍被 loc≥3 过滤挡住,全单行的组件依旧"找不到可突变的语句行",换块即可。
```

- [ ] **Step 2: 提交**

```bash
git add docs/recipes/chatwoot-vitest.md
git commit -m "docs: chatwoot-vitest 配方——纯声明组件局限随叶子第六形态更新

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 真仓验收(主会话做,不派 subagent)

1. chatwoot 全量重跑 map:`node dist/cli.js map --repo E:/learning/agent-research/repos/chatwoot --include app --no-label --out E:/dev/easyReview/out/chatwoot`(命令以 HANDOFF 现行用法为准)——对比叶子数增量(预期 vue/js 1687 → ~3900+);抽查 SidebarUnreadBadge/ChannelLeaf 从无叶变有叶、抽屉跳行精确。
2. verify 挑一个此前"无位点"的纯声明组件(如 SidebarUnreadBadge),确认 regex 回退选到 computed 体内语句并跑通一轮探针(verified/uncovered 都算通,要的是不再空手而归)。
3. umwelt-bevy(rust)与 chatwoot ruby 侧回归:叶子数不变。
4. 验收通过后更新 `docs/HANDOFF.md`(测试数、形态描述)与记忆,push + PR。
