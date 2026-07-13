# 叶子形态扩展(JS 第六形态:标识符调用含函数实参)设计

日期:2026-07-13
状态:设计定稿(方案 2 通用规则,用户确认)
前置:PR #11(Vue/JS 提取)、PR #12(vitest 突变探针)已合并

## 问题

纯声明式 `<script setup>` 组件(chatwoot 验收实测:ChannelLeaf、SidebarUnreadBadge)的函数全藏在
`computed(() => …)` / `watch(src, () => …)` / `debounce(() => …, ms)` 的**实参**里,现有 JS 五形态
查询提不出叶子:

- map 上这些组件是零方法的空块;
- verify 的 regex 回退按叶子圈扫描范围(`loc≥3`),无叶 → 无范围 → "找不到可突变的语句行"。

chatwoot 体量:`= computed(` 2139 处 / 559 文件,`= debounce(` 22 处,`= watch(` 赋值形 0 处
(watch 全在语句位,已是 pick-site 目标)。

## 方案选择

- 方案 1(白名单谓词):`#match? @wrapper "^(computed|watch|watchEffect|debounce|throttle)$"`,
  实测谓词有效(probe-predicate.mjs,含 randomWrapper 阴性用例)。语义干净但白名单要维护。
- **方案 2(通用规则,用户选定)**:任何**标识符调用**含**函数实参**、经 `variable_declarator`
  绑定名字的,都算具名叶子。捕获更广、零维护;代价是 `const id = setTimeout(() => …)` 这类
  "值不是函数"的绑定也成叶——**接受**,不加特例。

## 查询改动(实测定稿,probe-generic.mjs 2026-07-13)

`src/extract/lang.ts` 的 `JS_QUERY` 追加第六形态(js/vue 共用,自动双语言生效):

```
(variable_declarator
  name: (identifier) @name
  value: (call_expression
    function: (identifier)
    arguments: (arguments [(arrow_function) (function_expression)]))) @fn
```

实测确认的行为:

| 输入 | 结果 |
|---|---|
| `const label = computed(() => makeLabel(props));` | 捕获,名 `label` |
| `const both = pipe(() => 1, () => 2);` | **只产 1 条匹配**,无需去重 |
| `const fe = wrap(function () { … });` | 捕获(function_expression 实参,与形态 3/5 对称) |
| 嵌套:`computed(() => { const inner = watch(x, () => …) })` | 内外各一叶,行号不同 id 不撞 |
| `const id = setTimeout(() => tick(), 100);` | 捕获(方案 2 接受的代价) |
| `const member = _.debounce(() => save(), 300);` | 不捕获(function 是 member_expression) |
| `const plain = foo(1, 2);` | 不捕获(无函数实参) |
| `const chained = api.get(() => 1);` | 不捕获(member_expression) |

`extractLeaves` 零改动:新形态只捕获 `@name`/`@fn`,现有循环直接吃。

## 波及面盘点

- **map**:vue/js 叶子预计 1687 → ~3900+(全仓 11694 → ~14000);纯声明组件从零叶变有叶。
- **grade**:块方法数上涨 → 分位重排,前端块 contribBucket 可能整体上移。如实反映,不修正。
- **centrality**:新叶名(`label`/`isActive` 类变量名)进词频扇入,泛用名噪音再放大一点。
  v1 近似固有,记已知局限,不修(候选方向"调用图"的活)。
- **interpret**:缓存键 `computeInterpretHash` 已含 `functions` 名单 → 新叶子自动失效受影响块
  缓存,**不 bump PROMPT_VERSION**,零改动。
- **verify**:pick-site 主路径零改动(声明位 call_expression 仍不是位点)。涨的是 regex 回退:
  多行 computed 体(`loc≥3`)成为新扫描域;单行 computed(loc=1)被现有过滤天然挡住。
- **serve/抽屉**:函数跳行多出新叶,行号由 carve lineOffset 保证,零改动。

## 测试计划

extract 侧新增一组查询捕获用例:

1. 单行 computed 捕获,名字/行号正确;
2. 多行 computed 体,endLine 覆盖全体(regex 回退域的前提);
3. 多箭头实参只产一叶(锁死 probe 结论,防 wasm 升级回归);
4. 嵌套 declarator 内外各一叶;
5. `randomWrapper(() => 1)` 被捕获——方案 2 与方案 1 的分水岭,显式锁住通用性;
6. `setTimeout` 捕获——把接受的代价写成测试,防将来被"好心"白名单挡掉;
7. member_expression 调用不捕获;无函数实参的普通调用不捕获;
8. .vue 里新形态行号经 lineOffset 还原正确;
9. 现有五形态与全量测试回归(263 测试应全绿)。

## 真仓验收(主会话)

- chatwoot 全量重跑 map(`--no-label`):叶子数增量与 559 个 computed 文件覆盖;抽查
  SidebarUnreadBadge/ChannelLeaf 从无叶变有叶、跳行精确;
- verify 挑一个此前"无位点"的纯声明组件,确认 regex 回退选到 computed 体内语句,跑通一轮探针
  (红/绿都算通,要的是不再空手而归);
- umwelt-bevy(rust)与 chatwoot ruby 侧回归:叶子数不变。

## 不做什么

- 不动 pick-site 主路径(声明位是否成为位点,另立项再说);
- 不做成员表达式调用、`new Promise(…)`、TypeScript;
- 不修泛用名中心度噪音。
