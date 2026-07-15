# 「被谁依赖」UI 面板 · 设计

日期:2026-07-15
前置:中心度 v2(PR #15)已把 refsIn(每块入边 top-10:`{ from, weight, names }`,权重降序、全确定性)落盘 tree.json。本项把它呈现到 viewer,数据零重跑。

## 1. 目标与范围

viewer 回答「这块被谁依赖」:右侧面板卡片和源码抽屉各展示一份该块的 refsIn 列表,来源是块的可点跳转(点击=选中+开那块的抽屉)。纯 serve 层 + 前端(page.ts),map/grade 零改动。

已定决策:

- 交互深度:**可点击跳转**(否掉只读展示)——复用现有 selectedId/openDrawer 机制,顺便打通「顺着依赖读代码」。
- 展示位置:**方案甲,面板+抽屉双落点**(否掉只放一处)——学习决策("要不要细读")发生在面板卡片,"谁在用它"的疑问发生在读源码时;渲染共用一个函数,增量小。

## 2. 数据流(serve 层)

- `ViewerChunk` 加字段 `refsIn: { from: NodeId; names: string[] }[]`。**weight 不进 payload**:内部权重数字(1/|定义者| 累加)对读者无意义;落盘已按权重降序,展示保序即可。
- `ViewerState` 加 `hasRefs: boolean` = `tree.refsIn !== undefined`。语义:区分「老产物没这份数据」(整段不渲染)和「有数据但此块没检出入边」(渲染诚实空态)。
- `buildViewerState`:每块 `refsIn: (g.refsIn?.[c.id] ?? []).map(r => ({ from: r.from, names: r.names }))`。
- from 是否为块由前端查 `state.chunks[from]` 判断,serve 不加 flag(refsIn 的 from 可为范围内非块文件,to 恒为块——中心度 v2 的既有约定)。
- /api/state 体积:chatwoot 2108 键 × ≤10 边,粗估 +300~500KB。本地工具一次拉全量是既有约定,不做懒加载 API。

## 3. UI 呈现(page.ts)

共用渲染函数 `refsHtml(id)`(返回 HTML 字符串,内嵌 JS 约定:单引号拼接、禁反引号与 `\${`),两处调用:

- **hasRefs=false**(老产物)→ 两处整段不渲染,零回归。
- **有数据但列表空** → muted 一行:「被谁依赖:未检出(名字级静态扫描,入口文件/动态调用检不到)」。诚实标注盲区,防止"没人引用"被误读成"死代码"。
- **有列表** → 标题「被谁依赖(N)」;N=10 时写「被谁依赖(前 10)」——落盘截断后总数未知,不谎报。
- 每项:from 的 **basename**(`title` 悬停出完整路径);是块 → `.nb` 蓝色可点,`data-id`=from;非块 → muted 纯文本。后缀 muted 证据名字,最多 3 个、超出加「…」:`conversation_api.js (ApiClient)`。
- 点击行为:`selectedId = from; openDrawer(from); render();`——与「顺便看看」邻居一致;在抽屉里点则抽屉内容直接切到那个块。
- **面板卡片**:段落插在「顺便看看」之前(依赖证据比邻居觅食更贴近"要不要学它"的决策)。
- **抽屉**:新 `#drawer-refs` div,位置在 `#drawer-fns` 与 `#interp` 之间;可折叠、**默认折叠**(不挤源码空间),折叠态记 localStorage(`easyreview-refs-collapsed`),交互与 AI 解读段折叠头同款(「▸/▾ 被谁依赖(N)」)。

## 4. 边界与错误处理

- 全部动态文本过 `esc()` 再进 DOM(与全页约定一致)。
- 跳转后 srcCache/interp 本页缓存照常复用,无需新缓存。
- names 为空数组(理论不出现)→ 不渲染括号。
- 老 tree.json(无 refsIn 键)→ `hasRefs=false`,两处不渲染,零回归;旧夹具零改动(`Tree.refsIn?` 本就可选)。

## 5. 测试计划(预计 +5 条,282→287)

`test/viewer-state.test.ts`(viewer-fixture 加 refsIn 段):

1. refsIn 映射进 ViewerChunk:from/names 保序进 payload,weight 不出现;`hasRefs === true`。
2. tree 无 refsIn → `hasRefs === false` 且各块 `refsIn` 为 `[]`。
3. tree 有 refsIn 但某块无键 → 该块 `refsIn` 为 `[]` 且 `hasRefs === true`。

`test/serve-page.test.ts`(字符串包含断言,现有风格):

4. `renderPage()` 含 `drawer-refs` 容器 id。
5. `renderPage()` 含「被谁依赖」文案与 `refsHtml` 函数名。

## 6. 真仓验收

- serve out/chatwoot,HTTP 层核对:`/api/state` 中 URLHelper 块的 refsIn 10 条与 tree.json 逐条一致(顺序、from、names),`hasRefs === true`。
- 浏览器可视走一遍(Chrome 扩展不稳则请用户自点):点 conversation.rb → 面板见引用列表 → 点一条跳到那个块的抽屉。
- 老产物回归:拷一份删掉 refsIn 键的 tree.json 起 serve → 页面正常且两处无该段。

## 7. 不做什么

- 反向「它依赖谁」(refsOut 没落盘,要做得动 map,另立项)。
- 权重数字展示(内部量纲,读者无从解读)。
- 完整入边列表(落盘只有 top-10,REFS_IN_TOP_K 是中心度 v2 锁死的约定)。
- 依赖图可视化(节点连线图)——超出本项"证据列表"的定位。
