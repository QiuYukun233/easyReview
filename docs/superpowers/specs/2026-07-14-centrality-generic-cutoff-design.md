# 中心度泛用名截断 · 设计 spec

日期:2026-07-14
状态:已确认(用户批准方案 1;两步走的第一步,第二步「引用图+PageRank 中心度 v2」另行立项)

## 问题

中心度(`src/grade/centrality.ts`)是名字扇入的文本近似:数一个块的所有叶子名在其它文件里作为完整词出现的次数。它对名字一视同仁,撞语言关键字/大众词的叶子名产生灾难级噪音。chatwoot 实测(2425 块 / 13834 叶):

- `contacts/actions.js` 有个 Vuex action 叫 `import`——单这一个名字匹配了全仓库每条 import 语句,occ=9611,把该文件顶到贡献度 **#2**;
- 叶子名 `end`(1 个,Pagination.vue 的 computed)匹配所有 ruby 块结尾(df=922 文件),把 Pagination.vue 抬进 top-15;
- `setup`(89 个叶子)匹配所有 `<script setup>`(df=967);`default`(308 个叶子,props 的 `default: () => …`)匹配所有 `export default`(df=1129);
- 结果:V1 榜单前排大量虚高(#1 tiktok/message_service.rb 亦属噪音),真核心被挤下去,学习地图误导新人。

「贡献度排序」被用户定位为本产品最重要机能之一,此项目先止血,不解决文本匹配的根本歧义(那是 v2 的事)。

## 方案选择(实测定稿)

在 chatwoot(2425 文件)与 umwelt-bevy(68 文件)两真仓上跑变体矩阵(探针脚本:截断阈值 5%/10% × 计数 occ/fin × 语言关键字停用表开/关):

| 变体 | actions.js(应降) | tiktok(应降) | conversations_controller(应保持) | URLHelper |
|---|---|---|---|---|
| V1 现状 | **#2** | **#1** | #9 | #1079 |
| 平滑 IDF(occ×log(N/df)) | #5 | #6 | #1 | #1064 |
| occ·截断10% | #21 | #318 | #6 | #519 |
| occ·截断10%+停用表 | #38 | #275 | #5 | #464 |
| **occ·截断5%(选定)** | **#338** | **#147** | **#7** | #337 |
| fin·截断5% | #213 | #394 | #3 | #563 |

关键实测结论:

1. **平滑 IDF 无效**——log 降权压不住上千次出现的泛用名,否掉。
2. **5% 阈值天然吸收关键字停用表**——停用表开关结果一字不差(所有语言关键字 df 均远超 5%),因此不引入按语言维护的关键字清单,一条 df 规则搞定。
3. **10% 有漏网**——`search`(df=238)/`delete`(239)/`active`(166)恰好卡在 10%×2425=243 之下继续污染。
4. **纯 5% 对小仓库是灾难**——umwelt N=68 时 cutoff=4,`place_neuron`(df=20)、`occupied_cells`(df=7)等真领域函数被误杀,top-10 全毁。加下限 `max(⌈5%N⌉, 20)` 后只截 8 个真泛用名(`new`/`default`/`len`/`c`/`coord`/`from`/`place_edge`/`from_path`),top-10 与 V1 基本保序(grid.rs 仍 #1),V1∩新 top-20 交集 12/20。
5. **fin(按文件数计)不如 occ**——URLHelper 反而更沉,否掉。
6. **诚实注记**:URLHelper「该排高」的原预期不成立——其真实扇入中等(`frontendURL` df=51,其余个位数),截断后 #337 是应得位置。本项目修的是「噪音虚高挤压真信号」,不是抬举特定文件。

## 规则(锁死)

> 名字的 **df** = `sources` 里有多少个文件出现过该名字(完整词匹配,含定义它的文件自己);
> **cutoff** = `max(ceil(fileCount × 0.05), 20)`;
> df > cutoff 的名字视为词汇噪音,**贡献归零**;其余名字照旧按「在其它文件的出现次数」加总,归一化不变。

- 常数具名导出:`GENERIC_DF_RATIO = 0.05`、`GENERIC_DF_FLOOR = 20`;不做 CLI 参数(实测定的值,要改改代码)。
- cutoff 计算抽成导出的纯函数 `genericDfCutoff(fileCount)`——5% 分支(N>400 才生效)直接对纯函数做单测,行为测试只需下限档(25 个合成文件)即可触发截断,不用造 400+ 文件夹具。
- df 含自己:与「其它文件出现次数」的计数口径差 1 个文件,在下限 20 面前无实质影响,换取 df 全局算一次的简单性。
- 非词名(ruby `valid?`/`save!`,~13%)走既有正则回退,df 在同一趟扫描里顺手统计,同受截断。

## 实现落点

只动 `src/grade/centrality.ts`:

1. 先建 df 表:词名从既有 tokenCounts 查 `counts.has(name)` 数文件(零新增遍历);非词名按**唯一名字**做一趟正则扫描同时得 df 与逐文件 occ(顺带修掉现状「同名字多定义文件重复全库扫描」的小浪费,行为不变)。
2. 主循环加一句:`if (df.get(name)! > cutoff) continue;`。
3. 函数签名、返回形状(`Record<string, number>` 归一化 0..1)、`max=0 → {}` 行为全部不变,调用方零感知。

`test/centrality.test.ts` 的 naiveReference 对拍契约**原样保留**:夹具均 <20 文件,截断永不触发,契约继续锁分词化等价;截断行为用独立用例锁。

## 波及面(全部零代码改动,既有机制自动生效)

- **labels 缓存**(键=桶位+邻居+函数源码):贡献桶挪动的块自动重打——少量 DeepSeek 调用,2026-07-14 刚打齐的 2425 块大部分不动。
- **interpret 缓存**(键含 `signals.centrality` 原始值,input.ts:21):重归一化后人人都变 → **全量失效**。按需重生成(点开哪块调哪块),无批量成本,不 bump PROMPT_VERSION(键变化本身就使旧条目不再命中)。
- **journey/map.md**:顺序重排,每次 map 本来就重新生成。
- serve / verify / extract:零波及。

## 测试计划(~7 条,全在 test/centrality.test.ts 追加)

1. `genericDfCutoff`:N=68→20(下限)、N=400→20(边界)、N=2425→122(5% 分支)。
2. 阈值边界:df 恰好 = cutoff 计入、cutoff+1 截断(25 个合成文件,下限档)。
3. 撞关键字场景:名字 `import` df 超限 → 贡献 0(chatwoot 灾难合成用例)。
4. 非词名(`valid?`)df 超限同样被截断(回退路径)。
5. 文件全部名字被截断 → raw=0;全体 0 → `{}`。
6. 截断只影响超限名字:同文件其余名字照常计数。
7. 既有 4 条对拍/行为测试不动、继续绿。

## 真仓验收(主会话做)

- chatwoot 重跑 map:actions.js 与 tiktok/message_service 跌出前 100;conversations_controller 保持前 10;耗时仍秒级。
- umwelt 重跑:top-10 基本保序(grid.rs 仍 #1);被截名字 ≈ 8 个。
- 两真仓零接触(git status 干净)。
- HANDOFF、记忆(design-pivot-state)更新;「中心度 v2:引用图+PageRank,verify 突变探针抽查验收」记入候选方向。

## 不做什么

- 不建引用图、不做 PageRank——中心度 v2 另立项。
- 不动贡献度权重公式(0.6 centrality / 0.25 sizeNorm / 0.15 ownership)。
- 不动叶子提取(`default:` props 的 308 个叶子留着,靠截断在中心度层面消音)。
- 不加配置项/CLI 开关;不做语言关键字停用表(被 df 规则吸收,维护成本零)。
- 不追求语言服务器级精度——「解析具体代码是复现阶段做的,不是读代码阶段做的」(用户 2026-07-14):map 侧必须零配置秒级、对装不起依赖的仓库免疫;调用点级精度属于 verify 侧。
