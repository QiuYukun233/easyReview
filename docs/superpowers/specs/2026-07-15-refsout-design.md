# refsOut「它依赖谁」· 设计

日期:2026-07-15
前置:中心度 v2(PR #15)建了引用图并落盘入边 refsIn;「被谁依赖」UI(PR #16)把它呈现到 viewer。本项补出边方向,并让推荐位吃上真实依赖。

## 1. 目标与范围

引用图出边(refsOut)随 map 落盘 tree.json,viewer 镜像展示「它依赖谁」,「顺便看看」推荐位前置真实依赖。

已定决策:

- 范围:镜像展示 + **顺手增强推荐位**(用户选定,否掉只做镜像)。
- 增强层:**方案甲,sequence.ts 同源增强**(否掉 viewer 层合成)——journey.md 与网页同一口径;学习路径**顺序不动**,只动邻居列表。

## 2. 数据层(centrality.ts / types.ts / cli.ts)

- `ChunkRefOut { to: NodeId; weight: number; names: string[] }`;`Tree.refsOut?: Record<NodeId, ChunkRefOut[]>`(可选字段,老产物与全部夹具零改动)。
- `referenceGraphCentrality` 返回值加 `refsOut`:**同一张边表**(`weights`/`edgeNames`)按 from 重新分组,**仅 from 是块时**才进 refsOut(镜像 refsIn 的「to 恒为块」约定;cli 下 sources 与块同源,此为防御);排序同款——权重降序、平权 to 字典序、names 字典序;`REFS_OUT_TOP_K = 10`(独立常量,与入边同值)。
- cli.ts:`gradeTree({ ...tree, refsIn: ref.refsIn, refsOut: ref.refsOut }, …)`。

## 3. 推荐位增强(sequence.ts)

`neighborsOf(id)` 从「章内全部其它块」变为三段拼接、按序去重:

1. **它依赖的块**:`g.refsOut?.[id]` 的 to(已按权重降序);
2. **依赖它的块**:`g.refsIn?.[id]` 的 from,**过滤只留块**(from 可为非块文件);
3. 章内其余(既有逻辑)。

`buildPath(g)` 签名不变(refsIn/refsOut 就在 GradedTree 上);无 refsOut/refsIn 的老产物自动退化为纯章内邻居,零回归。面板照旧切前 6,journey-md 消费同一 neighbors 数组自动受益,渲染格式不改。

## 4. serve 层(state.ts)

- `ViewerChunk.refsOut: { to: NodeId; names: string[] }[]`(去 weight,同 refsIn 理由:内部量纲对读者无意义,落盘序即展示序)。
- `ViewerState.hasRefsOut: boolean`(独立旗标——存在「有 refsIn 没 refsOut」的 #15/#16 期产物,三态各自诚实)。
- neighbors 已由 buildPath 同源增强,serve 零额外逻辑。

## 5. UI 呈现(page.ts)

- **抽屉**:新增独立第二折叠区 `#drawer-refs-out`,紧跟 `#drawer-refs` 之后;交互完全镜像(默认折叠、localStorage 键 `easyreview-refs-out-collapsed`——连字符惯例,质量评审修正)——不动已验收的 refsIn 区。
- **面板卡片**:「被谁依赖」段之后加「它依赖谁(N)」段;N=10 标「前 10」不谎报总数。
- 列表复用:现有 `refsHtml` 泛化为接受 `{ id, names }[]` 的通用列表函数(refsIn 传 from、refsOut 传 to);出边 to 恒为块,全部可点跳转(data-ref 机制沿用)。
- 空态措辞(出边语义与入边不同):「未检出(名字级静态扫描;只统计仓内块之间的引用)」。
- 全部动态文本过 `esc()`。

## 6. 缓存与重跑影响

refsOut 不改 centrality 数值 → labels 缓存键、interpret 缓存键(含 signals.centrality 原始值)**全部不变**。重跑 map 拿 refsOut 是纯确定性秒级操作,零 LLM 调用——此点进真仓验收硬性核对(labels.json 字节不变)。

## 7. 边界与错误处理

三态产物:

| 产物 | refsIn | refsOut | 行为 |
|---|---|---|---|
| 旧(≤#14) | 无 | 无 | 两段都不渲染;邻居纯章内 |
| #15/#16 期 | 有 | 无 | 只渲染「被谁依赖」;邻居 = 被依赖 + 章内 |
| 新 | 有 | 有 | 全量 |

refsIn 的 from 非块 → 进推荐位前被过滤(UI 里维持 muted 不可点展示,不变)。

## 8. 测试计划(预计 +13~14 条,287→约 300)

- `centrality.test.ts`(约 5):① 小夹具无截断时 refsOut 与 refsIn 边集互为转置(from/to 互换、weight/names 一致);② from 非块不进 refsOut;③ top-10 截断与排序(权重降/平权 to 字典序);④ 同边多名字聚合 names 字典序;⑤ `expect(REFS_OUT_TOP_K).toBe(10)`。
- `sequence.test.ts`(约 4):⑥ 真实依赖(refsOut to)前置;⑦ 被依赖(refsIn from,滤非块)次之;⑧ 章内其余殿后且全程去重不含自己;⑨ 无 refsOut/refsIn → 纯章内(既有行为回归)。
- `viewer-state.test.ts`(约 3):⑩ refsOut 映射进 ViewerChunk 去 weight;⑪ 仅 refsIn 的树 → hasRefsOut=false 且各块 refsOut=[];⑫ 都有 → 双旗标 true。
- `serve-page.test.ts`(约 2):⑬ `drawer-refs-out` 容器与折叠键;⑭「它依赖谁」文案。

## 9. 真仓验收

- chatwoot 重跑 map:确定性秒级;**labels.json / interpret.json 字节不变**(缓存零失效实证)。
- refsOut 物证:conversation.rb 出边应含它 `include` 的 concerns;URLHelper 出边对真实 import 核实;HTTP 层 `/api/state` 的 refsOut 与 tree.json 逐条一致。
- 推荐位同源:journey.md 与网页「顺便看看」前几位是真实依赖,两出口一致。
- 现产物(仅 refsIn)回归:hasRefsOut=false、只渲染被谁依赖、页面正常。
- umwelt 回归:中心度榜不变(refsOut 不动数值)。

## 10. 不做什么

- 学习路径**顺序**不动(难度排序照旧,只动邻居列表)。
- weight 不进前端;依赖图可视化不做。
- refsIn 已验收行为不改(独立折叠区,不合区)。
- journey-md 渲染格式不改(消费 neighbors 数组自动受益)。
- 出边的「引用了但被 df 截断的泛用名」不补录——refsOut 与 refsIn 严格同一张边表,口径一致。
