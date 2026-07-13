# Vue/JS 提取 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 语言注册表加 JavaScript(.js)与 Vue SFC(.vue)两项,map/learn/viewer/解读全链路覆盖 chatwoot 前端;中心度分词化过规模关;verify 对 vue/js 保持友好拒绝。

**Architecture:** `LangSpec` 加两个可选字段——`carve`(parse 前区段切取,Vue 用它切 `<script>` 块)与 `exclude`(测试文件排除);JS/VUE 两注册项共用 tree-sitter-javascript.wasm 与同一套函数查询(2026-07-13 已对真实 wasm 实测定稿);`nameFanInCentrality` 从"每名字×每文件正则扫"改为"每文件单遍分词建词频表"。

**Tech Stack:** Node 20+/TypeScript(ESM)/vitest/web-tree-sitter + tree-sitter-wasms。

**Spec:** `docs/superpowers/specs/2026-07-13-vue-js-extraction-design.md`

**约定(全任务适用):**
- 分支:`feat/vue-js-extraction`(已存在,spec 已在其上)。
- 跑测试:`npx vitest run test/<file>.test.ts`;全量 `npm test`;类型门 `npm run typecheck`(vitest 不查类型,改了类型必须跑它)。
- 测试绝不调真实 cargo/docker/API——一律注入 fake exec。
- 温测试仓用 `test/helpers.ts` 的 `makeTempRepo/writeRepoFile/commitAll`。

**JS 查询实测记录(2026-07-13,tree-sitter-javascript.wasm @ tree-sitter-wasms 当前版本):**
`function foo(){}` → `function_declaration`;`function* g(){}` → `generator_function_declaration`;`const f = () => {}` / `const f = function(){}` → `variable_declarator` + value `arrow_function`/`function_expression`(外层 `export_statement` 不挡匹配);对象 shorthand 方法与 class 方法(含 getter)→ `method_definition`(名字是 `property_identifier`);`foo: () => {}` → `pair`。匿名回调、解构声明不被下述查询捕获(已验证)。

---

### Task 1: carveVueScript(Vue SFC script 区段切取)

**Files:**
- Create: `src/extract/carve-vue.ts`
- Test: `test/carve-vue.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { carveVueScript } from '../src/extract/carve-vue.js';

describe('carveVueScript', () => {
  it('single <script setup>: body content and lineOffset point back into the real file', () => {
    const sfc = '<template>\n  <div />\n</template>\n<script setup>\nconst f = () => 1;\n</script>\n';
    const segs = carveVueScript(sfc);
    expect(segs).toHaveLength(1);
    // 区段从开标签的 > 之后开始(含该行剩余部分),lineOffset = 开标签结尾所在 0 基行号
    expect(segs[0].source).toBe('\nconst f = () => 1;\n');
    expect(segs[0].lineOffset).toBe(3);
    // 验证行号还原:区段内 row 1(const f 行)+ 1 + lineOffset = 文件真实第 5 行
  });

  it('plain <script> with attributes', () => {
    const sfc = '<script lang="js">\nexport default {};\n</script>\n<template><div /></template>\n';
    const segs = carveVueScript(sfc);
    expect(segs).toHaveLength(1);
    expect(segs[0].source).toBe('\nexport default {};\n');
    expect(segs[0].lineOffset).toBe(0);
  });

  it('<script> and <script setup> coexisting: two segments in order', () => {
    const sfc = '<script>\nconst a = 1;\n</script>\n<script setup>\nconst b = 2;\n</script>\n';
    const segs = carveVueScript(sfc);
    expect(segs).toHaveLength(2);
    expect(segs[0].source).toContain('const a');
    expect(segs[0].lineOffset).toBe(0);
    expect(segs[1].source).toContain('const b');
    expect(segs[1].lineOffset).toBe(3);
  });

  it('no script block: empty array (纯模板组件)', () => {
    expect(carveVueScript('<template>\n  <div />\n</template>\n')).toEqual([]);
  });

  it('opening tag not at line start: offset still correct', () => {
    const sfc = '<template><div /></template><script setup>\nconst g = () => 2;\n</script>\n';
    const segs = carveVueScript(sfc);
    expect(segs).toHaveLength(1);
    expect(segs[0].lineOffset).toBe(0); // 开标签结尾仍在第 0 行
    expect(segs[0].source).toBe('\nconst g = () => 2;\n');
  });

  it('unclosed <script>: lenient, carve to EOF', () => {
    const segs = carveVueScript('<script setup>\nconst h = 3;\n');
    expect(segs).toHaveLength(1);
    expect(segs[0].source).toBe('\nconst h = 3;\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/carve-vue.test.ts`
Expected: FAIL —— 找不到模块 `../src/extract/carve-vue.js`

- [ ] **Step 3: Write minimal implementation**

```ts
/** Vue SFC 的 <script> 区段切取:regex 定位开标签,首个 </script> 收尾(HTML 规范同款切法)。
 *  lineOffset = 开标签结尾所在 0 基行号;区段从 > 之后开始(区段 row 0 = 开标签行剩余部分),
 *  故叶子真实行号 = 区段内 row + 1 + lineOffset。 */
export interface CarvedSegment { source: string; lineOffset: number }

const OPEN_TAG = /<script\b[^>]*>/g;

export function carveVueScript(source: string): CarvedSegment[] {
  const segments: CarvedSegment[] = [];
  OPEN_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OPEN_TAG.exec(source))) {
    const start = m.index + m[0].length;
    const end = source.indexOf('</script>', start);
    const stop = end === -1 ? source.length : end;
    let lineOffset = 0;
    for (let i = 0; i < start; i++) if (source.charCodeAt(i) === 10) lineOffset++;
    segments.push({ source: source.slice(start, stop), lineOffset });
    OPEN_TAG.lastIndex = stop;
  }
  return segments;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/carve-vue.test.ts`
Expected: PASS(6 个测试)

- [ ] **Step 5: Commit**

```bash
git add src/extract/carve-vue.ts test/carve-vue.test.ts
git commit -m "feat: carveVueScript——Vue SFC script 区段切取(多块/offset/无 script)"
```

---

### Task 2: LangSpec 加 carve/exclude 字段 + JS/VUE 注册项

**Files:**
- Modify: `src/extract/lang.ts`(全文件重写,原 40 行)
- Modify: `test/lang.test.ts:9`(过渡性断言更新,见 Step 4)
- Test: `test/lang-js-vue.test.ts`
- Modify: `src/serve/highlight.ts` / `src/serve/source.ts`(**修订 2026-07-13**,见下)

> **修订(2026-07-13,执行中发现):** 计划自审只查了 `=== 'rust'` 型比较,漏了
> `serve/highlight.ts` 的 `KEYWORDS`/`TOKEN_RE` 是 `Record<LangSpec['id'], …>` 穷举映射——
> id 联合加宽后 typecheck 必红。处置:highlight 补 js/vue 两个 key(共享 `JS_KEYWORDS`/
> `JS_TOKEN_RE` 常量,真实 ES 关键字集;vue 的 template 部分按 JS 规则染色,spec §6
> "效果可接受"仍成立);`source.ts` 的 `SourceBody.lang` 改为引用 `LangSpec['id']`,
> 将来加语言不再改它。spec §6 "highlight 不动"字面上失效、精神(不为 JS 单做高亮工程)保留。

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { langOf, inScope, JS, VUE } from '../src/extract/lang.js';

describe('JS/Vue registry entries', () => {
  it('langOf maps extensions', () => {
    expect(langOf('app/javascript/dashboard/helper/URLHelper.js')?.id).toBe('js');
    expect(langOf('app/javascript/widget/App.vue')?.id).toBe('vue');
    expect(langOf('app/models/user.rb')?.id).toBe('ruby');
    expect(langOf('src/main.rs')?.id).toBe('rust');
  });

  it('vue reuses the JS grammar and query, but carves', () => {
    expect(VUE.wasm).toBe(JS.wasm);
    expect(VUE.query).toBe(JS.query);
    expect(typeof VUE.carve).toBe('function');
    expect(JS.carve).toBeUndefined();
  });

  it('test files are excluded from scope', () => {
    expect(inScope('app/javascript/dashboard/store/foo.spec.js')).toBe(false);
    expect(inScope('app/javascript/dashboard/store/foo.test.js')).toBe(false);
    expect(inScope('app/javascript/dashboard/specs/helper.js')).toBe(false);
    expect(inScope('app/javascript/widget/spec/thing.js')).toBe(false);
    expect(inScope('app/javascript/dashboard/__tests__/thing.vue')).toBe(false);
  });

  it('exclusion respects directory boundaries and does not over-match', () => {
    expect(inScope('app/javascript/myspecs/helper.js')).toBe(true);   // myspecs/ 不是 specs/
    expect(inScope('app/javascript/dashboard/inspector.js')).toBe(true); // 文件名含 spec 不误伤
    expect(inScope('spec/models/user_spec.rb')).toBe(true);           // ruby 无 exclude,行为零变化
  });

  it('--include still filters by dir prefix on top of language', () => {
    expect(inScope('app/javascript/widget/App.vue', ['app'])).toBe(true);
    expect(inScope('config/webpack.js', ['app'])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lang-js-vue.test.ts`
Expected: FAIL —— `JS`/`VUE` 未导出

- [ ] **Step 3: Write implementation(lang.ts 全文)**

```ts
import { carveVueScript, type CarvedSegment } from './carve-vue.js';

/** 语言注册表：加一门语言 = 在这里加一项（wasm 名以 tree-sitter-wasms/out/ 下真实文件为准）。 */
export interface LangSpec {
  id: 'rust' | 'ruby' | 'js' | 'vue';
  exts: string[];      // 命中任一扩展名即属于该语言
  wasm: string;        // tree-sitter-wasms/out/ 下的文件名
  query: string;       // 叶子查询：必须捕获 @fn（整个函数节点）与 @name（名字节点）
  fence: string;       // 标签 prompt 代码围栏语言标签
  carve?: (source: string) => CarvedSegment[]; // parse 前区段切取；缺省=整文件、offset 0；[] = 无叶子
  exclude?: RegExp[];  // 命中任一即不进 scope（langOf 命中后 inScope 先查它）
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

// 测试文件不进学习地图（与 Rails 侧 spec/ 被 --include app 天然排除对称）
const TEST_EXCLUDES = [/\.spec\.js$/, /\.test\.js$/, /(^|\/)specs?\//, /(^|\/)__tests__\//];

export const JS: LangSpec = {
  id: 'js',
  exts: ['.js'],
  wasm: 'tree-sitter-javascript.wasm',
  query: JS_QUERY,
  fence: 'javascript',
  exclude: TEST_EXCLUDES,
};

export const VUE: LangSpec = {
  id: 'vue',
  exts: ['.vue'],
  wasm: 'tree-sitter-javascript.wasm', // 复用 JS 语法：SFC 只切 <script> 区段来 parse
  query: JS_QUERY,
  fence: 'vue',
  carve: carveVueScript,
  exclude: TEST_EXCLUDES,
};

export const LANGS: LangSpec[] = [RUST, RUBY, JS, VUE];

export function langOf(file: string): LangSpec | null {
  for (const l of LANGS) if (l.exts.some((e) => file.endsWith(e))) return l;
  return null;
}

/** 已注册语言 + 排除规则 + 可选目录前缀过滤。前缀按目录边界匹配：'app' 只命中 app/ 下，不命中 apps/。 */
export function inScope(file: string, include?: string[]): boolean {
  const lang = langOf(file);
  if (!lang) return false;
  if (lang.exclude?.some((re) => re.test(file))) return false;
  if (!include || include.length === 0) return true;
  return include.some((p) => file.startsWith(p.endsWith('/') ? p : p + '/'));
}
```

- [ ] **Step 4: 更新过渡性断言 `test/lang.test.ts:9`**

原行(锁的是"vue 本轮未注册"的过渡行为,注释已预告本次解锁):

```ts
    expect(langOf('a.vue')).toBeNull();          // 本轮未注册
```

改为:

```ts
    expect(langOf('a.vue')?.id).toBe('vue');     // 2026-07-13 起已注册(Vue/JS 提取)
```

这是唯一一处依赖旧行为的既有测试(已全局搜过 `writeRepoFile.*\.js/\.vue` 与 `.vue'` 断言)。除此之外**不许改任何既有测试**——若别的测试红了,那是实现 bug,回头修实现。

- [ ] **Step 5: Run new test + 既有 lang 相关回归**

Run: `npx vitest run test/lang-js-vue.test.ts test/lang.test.ts && npm test`
Expected: 全 PASS(既有 rust/ruby 行为零变化)

- [ ] **Step 6: Typecheck(改了共享类型)**

Run: `npm run typecheck`
Expected: 0 errors(id 联合类型加宽不会破坏现有 `=== 'rust'`/`=== 'ruby'` 比较)

- [ ] **Step 7: Commit**

```bash
git add src/extract/lang.ts test/lang.test.ts test/lang-js-vue.test.ts
git commit -m "feat: 注册表加 js/vue 两项(carve/exclude 可选字段,JS 查询实测定稿)"
```

---

### Task 3: extractLeaves 应用 carve(区段化 parse + 行号还原)

**Files:**
- Modify: `src/extract/leaves.ts`(全文件重写,原 35 行)
- Test: `test/leaves-js.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { extractLeaves } from '../src/extract/leaves.js';
import { JS, VUE } from '../src/extract/lang.js';

describe('extractLeaves for JS', () => {
  it('captures all four named-function forms, skips anonymous callbacks', async () => {
    const src = [
      'export function decl(a) { return a; }',            // L1
      'export const arrow = (x) => x + 1;',               // L2
      'export default {',                                  // L3
      '  methods: {',                                      // L4
      '    shorthand() { return 1; },',                    // L5
      '    pairArrow: () => 2,',                           // L6
      '  },',
      '};',
      'arr.map(x => x * 2);',
    ].join('\n');
    const leaves = await extractLeaves('a/b.js', src, JS);
    const byName = Object.fromEntries(leaves.map((l) => [l.name, l]));
    expect(Object.keys(byName).sort()).toEqual(['arrow', 'decl', 'pairArrow', 'shorthand']);
    expect(byName['decl'].startLine).toBe(1);
    expect(byName['shorthand'].startLine).toBe(5);
    expect(byName['pairArrow'].startLine).toBe(6);
    // methods:(值是 object)与匿名 map 回调不成叶子
  });
});

describe('extractLeaves for Vue SFC', () => {
  it('leaf line numbers point into the real .vue file (template offset applied)', async () => {
    const sfc = [
      '<template>',            // L1
      '  <div @click="go" />', // L2
      '</template>',           // L3
      '<script setup>',        // L4
      'const go = () => 1;',   // L5
      'function helper() {',   // L6
      '  return 2;',           // L7
      '}',                     // L8
      '</script>',             // L9
      '',
    ].join('\n');
    const leaves = await extractLeaves('w/App.vue', sfc, VUE);
    const byName = Object.fromEntries(leaves.map((l) => [l.name, l]));
    expect(byName['go'].startLine).toBe(5);
    expect(byName['helper'].startLine).toBe(6);
    expect(byName['helper'].endLine).toBe(8);
    expect(byName['helper'].loc).toBe(3);
    expect(byName['go'].id).toBe('w/App.vue::go::5'); // id 用还原后的真实行号
  });

  it('template-only SFC yields zero leaves', async () => {
    const leaves = await extractLeaves('w/Pure.vue', '<template>\n  <div />\n</template>\n', VUE);
    expect(leaves).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/leaves-js.test.ts`
Expected: FAIL —— Vue 用例行号不带 offset(或 carve 未应用导致 0 叶子/解析噪音)

- [ ] **Step 3: Write implementation(leaves.ts 全文)**

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
  // carve：parse 前区段切取（Vue 切 <script> 块）；缺省 = 整文件一个区段
  const segments = spec.carve ? spec.carve(source) : [{ source, lineOffset: 0 }];
  const leaves: Leaf[] = [];
  for (const seg of segments) {
    const tree = parser.parse(seg.source);
    for (const m of query.matches(tree.rootNode)) {
      const fnNode = m.captures.find((c) => c.name === 'fn')!.node;
      const nameNode = m.captures.find((c) => c.name === 'name')!.node;
      const startLine = fnNode.startPosition.row + 1 + seg.lineOffset;
      const endLine = fnNode.endPosition.row + 1 + seg.lineOffset;
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
  }
  return leaves;
}
```

- [ ] **Step 4: Run test + 全量回归**

Run: `npx vitest run test/leaves-js.test.ts && npm test`
Expected: 全 PASS(rust/ruby 走缺省区段,字节级同旧行为)

- [ ] **Step 5: Commit**

```bash
git add src/extract/leaves.ts test/leaves-js.test.ts
git commit -m "feat: extractLeaves 支持 carve 区段化 parse,Vue 叶子行号指向真实文件"
```

---

### Task 4: 中心度分词化(规模关)

**Files:**
- Modify: `src/grade/centrality.ts`(全文件重写,原 39 行)
- Test: `test/centrality.test.ts`(追加用例,保留既有)

- [ ] **Step 1: Write the failing tests(追加到既有 describe 之后)**

```ts
// —— 以下为 2026-07-13 分词化新增:与旧正则实现的等价性由 naiveReference 锁定 ——

/** 旧实现原样搬来做参照(每名字建正则×每文件扫)。 */
function naiveReference(leaves: Leaf[], sources: Record<string, string>): Record<string, number> {
  const filesByLeafFile = new Map<string, Set<string>>();
  for (const l of leaves) {
    if (!filesByLeafFile.has(l.file)) filesByLeafFile.set(l.file, new Set());
    filesByLeafFile.get(l.file)!.add(l.name);
  }
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const raw: Record<string, number> = {};
  for (const [file, names] of filesByLeafFile) {
    let count = 0;
    for (const name of names) {
      const re = new RegExp(`\\b${esc(name)}\\b`, 'g');
      for (const [otherFile, src] of Object.entries(sources)) {
        if (otherFile === file) continue;
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

describe('nameFanInCentrality tokenized rewrite', () => {
  it('matches the old regex implementation on word-boundary edge cases', () => {
    const leaves = [
      leaf('a.js', 'foo'), leaf('a.js', 'bar'),
      leaf('b.js', 'foo_bar'),
      leaf('c.js', 'baz'),
    ];
    const sources: Record<string, string> = {
      'a.js': 'foo_bar(); foo(); bar();',
      'b.js': 'foo(); foo.bar(); "foo"; foo_bar_x(); x_foo_bar();',
      'c.js': 'foofoo(); foo(); { bar: 1 } foo_bar();',
    };
    expect(nameFanInCentrality(leaves, sources)).toEqual(naiveReference(leaves, sources));
  });

  it('non-word-char names (ruby valid?/save!) fall back to regex, same as old', () => {
    const leaves = [leaf('m.rb', 'valid?'), leaf('n.rb', 'plain')];
    const sources: Record<string, string> = {
      'm.rb': 'def valid?; end',
      'n.rb': 'valid?x; valid? ; plain(); if valid?y then plain end',
    };
    expect(nameFanInCentrality(leaves, sources)).toEqual(naiveReference(leaves, sources));
  });

  it('all-zero stays empty record', () => {
    const leaves = [leaf('a.js', 'nowhere')];
    const sources = { 'a.js': 'nowhere()', 'b.js': 'unrelated()' };
    expect(nameFanInCentrality(leaves, sources)).toEqual({});
  });
});
```

(文件头部 import 需补 `import type { Leaf } from '../src/types.js';` 已有;`leaf` helper 已有。)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/centrality.test.ts`
Expected: 新用例目前对旧实现应当 **PASS**(参照就是旧实现)——这一步是先固定行为快照。确认 PASS 后再改实现,改完必须仍 PASS。

- [ ] **Step 3: Rewrite implementation(centrality.ts 全文)**

```ts
import type { Leaf } from '../types.js';

/**
 * v1 近似中心度：chunk(文件)的所有函数名在其他文件源码中作为完整词出现的次数，
 * 归一化到 0..1。近似——同名/宏/方法分派会有噪音，将来由调用图/rust-analyzer 替换。
 *
 * 2026-07-13 分词化：每文件单遍分词建词频表（[A-Za-z0-9_]+，与 \b 词边界定义严格一致），
 * 名字 O(1) 查表——O(名字×文件) 降到 O(总字符数)，前端 2000+ 文件加入后仍是秒级。
 * 含非词字符的名字（ruby 的 valid?/save!）走旧的逐名字正则回退，行为零变化。
 */
const WORD = /[A-Za-z0-9_]+/g;
const isWordName = (s: string) => /^[A-Za-z0-9_]+$/.test(s);

export function nameFanInCentrality(
  leaves: Leaf[],
  sources: Record<string, string>,
): Record<string, number> {
  const filesByLeafFile = new Map<string, Set<string>>();
  for (const l of leaves) {
    if (!filesByLeafFile.has(l.file)) filesByLeafFile.set(l.file, new Set());
    filesByLeafFile.get(l.file)!.add(l.name);
  }

  const tokenCounts = new Map<string, Map<string, number>>();
  for (const [file, src] of Object.entries(sources)) {
    const counts = new Map<string, number>();
    for (const m of src.matchAll(WORD)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
    tokenCounts.set(file, counts);
  }

  const raw: Record<string, number> = {};
  for (const [file, names] of filesByLeafFile) {
    let count = 0;
    for (const name of names) {
      if (isWordName(name)) {
        for (const [otherFile, counts] of tokenCounts) {
          if (otherFile === file) continue;
          count += counts.get(name) ?? 0;
        }
      } else {
        const re = new RegExp(`\\b${escapeRe(name)}\\b`, 'g');
        for (const [otherFile, src] of Object.entries(sources)) {
          if (otherFile === file) continue;
          count += (src.match(re) ?? []).length;
        }
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

- [ ] **Step 4: Run test + 全量回归**

Run: `npx vitest run test/centrality.test.ts && npm test`
Expected: 全 PASS(等价性用例锁定新旧一致)

- [ ] **Step 5: Commit**

```bash
git add src/grade/centrality.ts test/centrality.test.ts
git commit -m "perf: 中心度分词化——每文件单遍建词频表,O(名字×文件)→O(总字符数)"
```

---

### Task 5: verify 对 vue/js 的友好拒绝(锁测试,零实现改动)

**Files:**
- Test: `test/verify-unsupported.test.ts`(新建;`cli-verify.ts` 的 `runnerFor` else 分支已有该行为,本任务只锁死)

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { runMap } from '../src/cli.js';
import { runVerifyShow, runVerifyPredict } from '../src/cli-verify.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

/** verify（突变探针）暂只支持 Rust/Ruby——vue/js 块必须在读源码、建沙箱、调 exec 之前
 *  就给出友好拒绝（runnerFor else 分支）。锁死文案与零副作用。 */
describe('verify rejects vue/js chunks up front', () => {
  async function setup() {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'app/javascript/widget/App.vue',
      '<template><div /></template>\n<script setup>\nconst go = () => 1;\n</script>\n');
    writeRepoFile(dir, 'app/javascript/helper/url.js', 'export const make = () => 2;\n');
    commitAll(dir, 'init');
    await runMap({ repo: dir, outDir: dir });
    return dir;
  }

  it('vue chunk: show rejected with friendly message, exec untouched', async () => {
    const dir = await setup();
    let execCalled = false;
    await expect(
      runVerifyShow({ repo: dir, outDir: dir, chunkId: 'app/javascript/widget/App.vue',
        exec: async () => { execCalled = true; return ''; } }),
    ).rejects.toThrow(/不在支持范围/);
    expect(execCalled).toBe(false);
  });

  it('js chunk: predict rejected the same way', async () => {
    const dir = await setup();
    let execCalled = false;
    await expect(
      runVerifyPredict({ repo: dir, outDir: dir, chunkId: 'app/javascript/helper/url.js',
        predicted: ['whatever'], exec: async () => { execCalled = true; return ''; } }),
    ).rejects.toThrow(/不在支持范围/);
    expect(execCalled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it passes(行为已存在)**

Run: `npx vitest run test/verify-unsupported.test.ts`
Expected: PASS。若 FAIL,说明注册 vue/js 后拒绝路径被破坏——那是真 bug,回头查 `runnerFor`,不许改测试将就。

- [ ] **Step 3: Commit**

```bash
git add test/verify-unsupported.test.ts
git commit -m "test: 锁死 verify 对 vue/js 块的前置友好拒绝(零副作用)"
```

---

### Task 6: HANDOFF 更新 + 全量门

**Files:**
- Modify: `docs/HANDOFF.md`

- [ ] **Step 1: 更新 HANDOFF**

1. 代码地图表:`extract/lang.ts` 行的职责改为
   `语言注册表（rust+ruby+js+vue：扩展名/wasm/叶子query/围栏 + 可选 carve 区段切取/exclude 排除）+ langOf/inScope（加语言=加一项）`;
   其下新增一行
   `| \`extract/carve-vue.ts\` | Vue SFC <script> 区段切取（regex 定位、lineOffset 还原真实行号）|`;
   `grade/{churn,coupling,ownership,centrality}.ts` 行职责末尾追加 `（中心度已分词化,2026-07-13）`。
2. "下一步"第 7 条打勾划线(样式照第 5/6 条):
   `7. ~~**Vue/JS 提取**~~ ✅ 已完成（分支 feat/vue-js-extraction，见 docs/superpowers/plans/2026-07-13-vue-js-extraction.md）。注册表加 js/vue 两项（carve/exclude 可选字段,JS 查询实测定稿）;Vue SFC 切 <script> 区段、叶子行号指向真实文件;测试文件（*.spec.js 等）不进地图;中心度分词化过规模关;verify 对 vue/js 前置友好拒绝。`
3. 顶部"52 文件 / 188 个测试"按实际全量结果更新(下一步测得)。
4. ⑤ Ruby 仓库段落中 `--include app` 示例后补一句:`（2026-07-13 起同一命令连前端一起进地图:app/javascript 的 .vue/.js,测试文件除外）`。

- [ ] **Step 2: 全量门**

Run: `npm test && npm run typecheck`
Expected: 全 PASS + 0 type errors。记录测试文件数/用例数,回填 HANDOFF 顶部。

- [ ] **Step 3: Commit**

```bash
git add docs/HANDOFF.md
git commit -m "docs: HANDOFF 更新——Vue/JS 提取完成,路线图第 7 条闭环"
```

---

### Task 7(主会话自跑,不派 subagent): chatwoot 真仓验收 + umwelt 回归

- [ ] chatwoot 重跑 map(**用 --no-label**,避免对 ~1700 个新块烧 API;标签由用户之后自行决定):
  `npm run map -- --repo E:/learning/agent-research/repos/chatwoot --include app --no-label --out E:/dev/easyReview/out/chatwoot`
  记录耗时(目标分钟内);预期块数 ~2470(738 + 2103 − 371 测试文件 − 若干 exclude 命中)。
- [ ] 抽查 grade:`app/javascript/dashboard/helper/URLHelper.js` 这类高扇入 helper 中心度应明显偏高;.vue 组件风险档分布不应全挤一桶。
- [ ] `npm run serve -- --out E:/dev/easyReview/out/chatwoot --port 4872`:抽查 .vue 块源码抽屉(整 SFC 展示、函数跳行落在 script 真实行)、树视图 app:javascript 章可折叠。
- [ ] umwelt-bevy 回归:`npm run map -- --repo D:/dev/umwelt-bevy --out E:/dev/easyReview` → 仍 68 块,labels 缓存不动。
- [ ] 已知预期变化(不当回归):chatwoot Ruby 块的分位档因前端块加入会重排;章数 167 → ~700。

---

## Self-Review(已做)

- **Spec 覆盖**:§2 注册表(Task 2)、§3 叶子形态(Task 2 查询+Task 3 测试)、§4 carve(Task 1/3)、§5 中心度(Task 4)、§6 verify 拒绝(Task 5)/其余触点零改动、§7 验收(Task 6/7)。无缺口。
- **占位符**:无 TBD/"适当处理";全部代码逐字给出。
- **类型一致性**:`CarvedSegment` 在 Task 1 定义、Task 2 类型引用、Task 3 消费;`JS/VUE` 导出名前后一致;`inScope` 签名未变(调用方 `extract/tree.ts` 零改动)。
- **既有测试影响**:全局搜过,现有测试无依赖 "langOf('.js') === null" 的用例;`verify-ruby-reject` 不受影响(ruby 无 exclude)。
