# 中心度 v2:引用图 + 加权入度 · 设计 spec

日期:2026-07-14
状态:已确认(用户批准方案甲 + 产出边界 B「信号 + 边落盘」;两步走的第 2 步,第 1 步泛用名截断已合 PR #14)

## 问题

「贡献度排序」被用户定位为本产品最重要机能之一。v1 名字扇入(即使经泛用名截断止血)有两个根本局限:

1. **「提到」≠「依赖」**:出现次数加总无法区分谁在依赖谁,单文件反复提及即可刷分;
2. **块身份不可见**:`ApiClient` 被全仓 `import ApiClient from …` 引用,但类名/文件名不是叶子(函数名),v1 完全看不见这类最强的依赖信号——截断后 ApiClient 仍只排 ~#300。

用户哲学(2026-07-14):「解析具体代码是复现阶段做的,不是读代码阶段做的」——map 侧必须零配置秒级、对装不起依赖的仓库免疫,语言服务器路线永久排除;本方案仍是纯文本 token 级。

## 方案选择(实测定稿,三轮探针)

chatwoot(2425 块)哨兵排名对比:

| 哨兵 | v1.5(截断后名字扇入) | A 叶子边·occ | B 身份边·fin | **C 合并·fin(选定)** | C 图上 PageRank |
|---|---|---|---|---|---|
| conversation.rb(核心模型) | 中游 | #22 | #8 | **#1** | #15 |
| URLHelper.js | #337 | #46 | #28 | **#12** | #50 |
| ApiClient.js(前端基类) | ~#300 | #284 | **#14** | #34 | #6 |
| ReplyBox.vue | #1 | #8 | #543 | **#9** | #36 |
| conversations_controller | #7 | #29 | #1917 | **#32** | #46 |
| contacts/actions.js(原噪音王) | #338 | #140 | #2305 | **#77** | #86 |

关键实测结论:

1. **身份名边是最大单项增益**(ApiClient #284→#14;conversation.rb 进前排)——模块被引用靠的是身份名(import 语句、Ruby 常量、模板组件名),不是函数名。
2. **身份边不能单独用**:controllers 靠 Rails 约定路由、从不被名字引用(#1917);Vue 组件引用稀少时同样沉底。叶子边是必要的另一半。
3. **fin(每引用文件记 1)优于 occ(按次数)**:occ 让单文件反复提及刷分(top 被 AddAttribute/EditAttribute 这类撞中频词的对话框霸占)。
4. **PageRank 双仓实测均差于加权入度**:chatwoot 榜首变 `bubbles/Base.vue`/`base_client.rb`(簇内自引环流被放大),umwelt 把 `constants/biology.rs` 抬到 #2——与「教学重要度」错位,且多一套迭代收敛复杂度。否掉,数据留档防将来重蹈。
5. umwelt(68 块)C-fin 入度 top-3 = path_tree/routes/grid,与代码结构常识吻合,小仓库健康。
6. **诚实局限**:身份名撞大众词的核心文件仍被低估——`message.rb` 的 `Message` df 超限被截,排 #184;controllers 靠叶子边撑到 #32 但天花板有限。固有于文本匹配,记录之,不救(将来可选语义增强)。

## 规则(锁死)

> **名字池** = 每块的叶子名 ∪ 身份名。身份名 = `chunk.name`(无扩展名 basename);`.rb` 块另加驼峰形式(`url_helper → UrlHelper`);非词形式的 basename(如 `foo-bar`)不产身份名。
> **df 过滤**:名字 df(出现过的文件数,含定义文件,与 CT 口径一致)> `genericDfCutoff(N)` → 该名字不建边(泛用文件名 `index`/`utils` 与泛用函数名同一条规则被截)。
> **建边**:文件 f(∉ 该名字的定义者集合)出现该名字(**≥1 次即可,不计次数**)→ 对每个定义者 d 产边 `f→d`,权重 `1/|定义者|`;同一 (f,d) 对上多个名字的权重累加,名字并入该边 `names`。
> **中心度** = 每块入边权重和,除以全场最大值归一化 0..1;全零 → `{}`(与 v1 契约一致)。
> **refsIn** = 每块入边按权重降序取 **top-10**;平权按 `from` 字典序;`names` 字典序——全确定性,重跑逐字节一致。

## 模块与 schema

`src/grade/centrality.ts` **原地重写**(职责不变:中心度信号;边是同一趟计算的顺产物,内聚):

- 导出 `referenceGraphCentrality(chunks: Chunk[], leaves: Leaf[], sources: Record<string,string>): { centrality: Record<NodeId, number>; refsIn: Record<NodeId, ChunkRefIn[]> }`
- 保留 `GENERIC_DF_RATIO` / `GENERIC_DF_FLOOR` / `genericDfCutoff`(CT 资产复用)
- **删除** `nameFanInCentrality`(v1 退役;naiveReference 对拍契约随算法一起退役)
- 非词名(ruby `valid?` 类)fin 只需 `re.test`(不数次数)——比 CT 的 `match` 更省;`\b` 怪癖(尾缀 ?/! 名字要求后跟词字符)原样继承,已记 PR #14 spec,v2 不救

`src/types.ts` 的 `Tree` 加**可选**字段(旧 tree.json 与全部既有测试夹具零改动):

```ts
export interface ChunkRefIn {
  from: NodeId;      // 引用方块 id
  weight: number;    // fin·多定义均分后的累计权重
  names: string[];   // 命中的名字,字典序
}
// Tree 内新增:
refsIn?: Record<NodeId, ChunkRefIn[]>;
```

## 集成(一处)

`cli.ts` runMap:

```ts
const ref = referenceGraphCentrality(tree.chunks, tree.leaves, sources);
const graded = gradeTree({ ...tree, refsIn: ref.refsIn }, {
  relChurn: …, coupling: …, ownership: …,
  centrality: ref.centrality,
});
```

map.md / labels / journey / serve 代码零改动。

## 波及面(全部零代码改动,既有机制自动生效)

- **labels 缓存**:换桶块自动重打一波(与 CT 合入时同规模,带 key 重跑 ~10 分钟一次性成本)。
- **interpret 缓存**:全量失效(键含 centrality 原始值),按需重生成。
- 既有 62 个测试文件的 Tree 夹具零改动(refsIn 可选);serve/verify/render 零波及。
- 性能:df 逻辑与 CT 同量级,非词名降为 `re.test`;chatwoot 确定性 map 预期仍 <15s。

## 测试计划(test/centrality.test.ts 重写,~12 条)

保留:`genericDfCutoff` 3 条。
删除:v1 行为 1 条 + naiveReference 对拍 4 条 + CT 截断行为 6 条(锚定 `nameFanInCentrality` 的全部退役)——截断语义由新用例在图规则下重锁。
新增(全对 `referenceGraphCentrality`):

1. 叶子名成边:f 引用 d 的叶子名 → d 得入度,refsIn 记 `{from: f, names: [叶子名]}`
2. 身份名成边:`import ApiClient` 场景——身份名命中,叶子名全被截时块仍有入度
3. rb 驼峰:`url_helper.rb` 被 `UrlHelper` token 引用成边
4. 非词 basename(`foo-bar.js`)不产身份名
5. df 截断作用于两类名字:泛用文件名(如 `index`)不建边
6. fin 计数:同文件出现 5 次,权重仍 1
7. 多定义均分:同名两定义者,引用文件对各贡献 0.5
8. 自引不成边(定义者出现自己的名字不计)
9. 同一 (f,d) 多名字:权重累加、names 并列字典序
10. 归一化 0..1 与全零 `{}` 契约
11. refsIn top-10 截断 + 权重降序 + 平权 from 字典序(11 个引用方构造)
12. 集成冒烟:runMap 级(或直接构造)确认 refsIn 落进 tree 输出(有既有 map 集成测试则挂靠,无则用最小夹具直接断言返回值形状)

## 真仓验收(主会话做)

- chatwoot 重跑:哨兵容差 ±20%——conversation.rb ~#1、URLHelper ~#12、ApiClient ~#34、ReplyBox ~#9、conversations_controller ~#32、actions.js ~#77;确定性 map(--no-label)仍秒级(<15s)。
- **refsIn 物证核对**:URLHelper 的入边 `names` 应含 `URLHelper`/`frontendURL`,`from` 打开真实源码肉眼核对 2-3 条真的在引用。
- **verify 突变探针抽查**(v2 独有的实证闭环):对新榜首 conversation.rb 跑 rspec 突变探针,镜像 spec 应真变红——「地图说它最重要」得到「动它真的炸」的物证。
- umwelt 回归:入度 top-3 = path_tree/routes/grid;refsIn 边肉眼核对 1-2 条。
- 两真仓零接触;HANDOFF、记忆(design-pivot-state)更新。

## 不做什么

- 不做 PageRank——双仓实测差于入度(榜首被簇内自引节点占据),数据表留档本 spec 防将来重蹈。
- 不做 UI「被谁依赖」面板——产出边界 B 只落盘数据,UI 另立项(数据现成,无需重跑 map)。
- 不做 import 语句/Ruby 常量的语义解析——文本 token 已达标;将来可选增强,且必须保持零配置秒级。
- 不救身份名撞大众词的核心文件(`message.rb` #184)——文本匹配固有局限,如实记录。
- 不动贡献度权重公式(0.6/0.25/0.15)、不动其它信号、不动叶子提取。
- 不修尾缀 ?/! 名字的 `\b` 怪癖(继承 PR #14 决定)。质量评审实测把它的严重度校准得更诚实:真实调用点(`obj.save!`、`obj.valid? &&`——`?`/`!` 后跟空格/括号/分号)**基本建不了边**,只有 `valid?x` 型后跟词字符的写法能命中——ruby bang/question 方法的扇入不是「被低估」而是「接近于零」。v2 不改,留给将来语义增强。
