# 纵向切割打样:rspec trace 一条真流程 · 设计

日期:2026-07-15
背景:现有地图是横向切割(风险×贡献度,静态排序),回答「哪块重要」;本方向加纵向切割(端到端业务流程),回答「这些块怎么连成线」——对应研究报告(deep-research-report.md)的程序模型优先原则:执行路径、状态更新点、跨文件边界。refsIn/refsOut 引用图(PR #15-#17)是其数据地基。

## 1. 已定决策(用户逐项确认)

- 切片语义:**端到端业务流程**(否掉领域聚合、数据生命周期——记为将来形态)。
- 范围:**先 web 栈(chatwoot)**,架构留多语言接口(否掉一步通用:Bevy 的流程语义是 system 调度,与请求链难同构)。
- 产出边界:**打样优先**——一条真流程走通识别→落盘→viewer 展示,验证阅读体验再铺开。
- 链的来源:**运行时 trace**(rspec+TracePoint,链是真跑出来的)——与突变探针同哲学「理解靠撞真实运行验证」;否掉纯静态链生长(引用图噪音每跳累乘,链的真假无保证)与打样期混合+LLM(范围失控)。

## 2. 打样流程选择标准(实现期勘察定具体流程)

① 穿至少三层(controller → model → job/listener);② 有现成 rspec request/integration spec 覆盖;③ 中心度榜首 conversation.rb 在链上。候选方向:「发消息」POST → message 建库 → 分发 job。

## 3. trace 机制

- Ruby `TracePoint(:call)`,过滤仓内 `app/` 路径,采 `(file, method, line)` 序列,输出 JSON。
- tracer 脚本经 `RUBYOPT=-r<tracer>` 注入现有 Docker rspec 环境(chatwoot-easyreview 项目,配方 `docs/recipes/chatwoot-rspec.md` 复用)。
- **真实仓零污染是验收硬条件**:注入不许在真实仓留任何文件(挂载/临时路径方案实现期勘察定,用后即删),`git status` 零改动。
- trace 跑一次落盘缓存,读者零成本。

## 4. 链折叠规则(确定性)

原始调用序列 → 文件级链:

- 只保仓内 `app/` 文件,映射到块 id(文件即块);
- **相邻重复合并**;**步序 = 首次出现顺序**;
- 跨步回访(A→B→A)不重复成步,每步记 `hits`(原始序列命中次数);
- 原始方法级序列一并留档(将来下钻用),打样 UI 只消费文件级。

## 5. 数据 schema —— 独立 `easyreview.flows.json`

**不进 tree.json**:流程是另一维度产物,重跑 map 不动它、tree 不膨胀。

```json
{
  "version": 1,
  "flows": [{
    "id": "flow-<slug>",
    "name": "<CLI 参数人工给,打样期不上 LLM>",
    "source": { "kind": "rspec-trace", "spec": "spec/...", "tracedAt": "<ISO>" },
    "steps": [{ "chunkId": "app/...", "methods": ["<top-N 方法名>"], "hits": 3 }],
    "rawTrace": [{ "file": "...", "method": "...", "line": 1 }]
  }]
}
```

`source.kind` 即多来源/多语言预留接口(将来 `static-anchor`/`vue-router` 等);steps 只含语言无关的 chunkId。

## 6. CLI

新子命令 `flow`:`npm run flow -- trace <specFile> --name "<流程名>" --repo <p> --out <d>`。与 verify 平级(verify 验证理解,flow 生产流程数据),复用 runner 配置加载(easyreview.runner.json)与 Docker 执行模板。非 Ruby spec / 无 runner 配置 → 友好拒绝(镜像 verify 的先例)。

## 7. viewer 呈现(打样级)

- 第三个 Tab「流程」:流程列表(打样期一条)→ 纵向步骤列表:第 N 步、块名、文件、方法名 chips、hits,每步可点(复用 selectedId/openDrawer 跳转)。
- serve:读 `easyreview.flows.json` 进 `ViewerState.flows` + `hasFlows` 旗标;文件不存在(全部既有产物)→ Tab 不渲染,零回归。
- 走读步进模式(当前步高亮/上一步下一步)留二期。

## 8. 测试计划(计划定稿 +19 条,300→319;初估 10~12,cli-flow 编排的集成测试与 tracer 常量断言是增量)

- 链折叠纯函数:相邻合并、首现序、回访 hits、app 外过滤、映射块 id(fixture 序列驱动,不进 Docker)。
- flows.json 读写 schema 与损坏容错(读不出 → 视同不存在)。
- `ViewerState.flows`/`hasFlows` 三态(无文件/空 flows/有流程)。
- page Tab 结构与「流程」文案字符串断言。
- CLI 层非 Ruby / 无配置友好拒绝。

## 9. 真仓验收

- trace 一条真流程,链上每步与 spec 实际行为人工对照(物证级:如「发消息」链含 conversation.rb、message.rb、某分发 job);
- 真实仓零接触(git status 干净、容器内无残留文件);
- viewer:流程 Tab 可见、步骤点击跳抽屉、无 flows.json 的产物 Tab 不出现;
- umwelt 回归零变化(本期完全不碰非 web 栈)。

## 10. 不做什么(= 二期候选清单,已记忆归档)

- 自动流程发现(全量入口扫描 + 链自动生长);
- 前端 Vue 段(trace 不到,将来静态锚点补:vue-router/API 调用点);
- LLM 流程命名与每步一句话叙述(interpret 模式,确定性骨架先行);
- 走读步进模式(UI 二期);
- 四语言通用(Bevy=system 调度语义,另行设计);
- **流程级突变探针**(沿链突变验证读者对流程的理解——横向 verify 的纵向版,记档待议)。
