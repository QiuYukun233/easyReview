# trace 切窗/请求段标记(flow phase)· 设计

日期:2026-07-16
背景:纵向切割打样(PR #19)真仓验收发现,首现序把 Rails 引导+测试工厂 setup 排在链条前 44 步(共 81 步),真实请求叙事段(45-51)连续正确但藏在中段。本项把 setup 噪音与请求叙事分离——纵向二期首弹。

## 1. 目标与范围

流程链每步标 `phase: 'setup' | 'request'`,UI 把 setup 段折成默认收起的一行,请求叙事直接可读。**纯折叠侧改动**(trace.ts 的 foldTrace 扩展),tracer 一字不动;旧 flows.json 零回归(无 phase 视同全 request 不分段),重跑 `flow trace` 即获分段。

已定决策(用户逐项确认):

- 产品语义:setup 段**默认折叠、可展开**(诚实保留全链——想看 Rails 启动碰了什么也是合法阅读需求;否掉完全不显示与两段平铺)。
- 分相方案:**甲′,分界点+双相判定**(否掉纯首现分界——会把 conversation.rb 这类"首现于工厂但属于请求叙事"的主角折进噪音,打样数据实证;否掉 tracer 侧 RSpec 打标——那解决的是多 example 分组,剥不掉 example 内工厂噪音,留档二期)。

## 2. 分相算法(确定性,rawTrace 驱动)

- **分界点** = 原始调用序列(rawTrace 同源的 calls)里第一次进 `app/controllers/` 的 index;**含该次调用本身**(controller 归 request)。
- **每文件的相** = 从分界点(含)起是否还被命中:≥1 次 → `request`;零次 → `setup`。
  - conversation.rb(首现于工厂、请求持续命中)→ request ✓
  - 工厂/引导专属文件(分界后零命中)→ setup ✓
- **步序**:落盘 steps 重排为 setup 段在前(段内首现序)、request 段在后(段内按**分界后首次命中**序——叙事从 controller 开场);全局步号连续(与落盘序一致,诚实不跳号)。
- **无 controller 的链**(model spec 等):无分界点 → 全部 request、不分段,行为同现状。
- hits/methods 语义不变(仍是全链统计)。

## 3. schema 与兼容

- `FlowStep.phase?: 'setup' | 'request'`(可选字段;FlowsFile version 仍 1——加可选字段的先例同 Tree.refsIn)。
- serve 层 steps 原样透传,**零代码改动**(仅类型字段生效)。
- 前端:步缺 phase(旧数据)→ 不分段渲染,零回归。

## 4. UI(page.ts renderFlows)

- 存在 setup 步 → 折叠头「▸ 引导与测试数据准备(第 1-N 步)」,默认折叠、点击展开;折叠态记 localStorage `easyreview-flow-setup-collapsed`(多流程共享,打样期一条流程够用)。
- 请求段步直接列出,样式与可点跳转照旧。
- FLOWS_LEGEND 补一句 setup/request 释义。

## 5. 测试计划(预计 +8 条)

- foldTrace 分相(5):① controller 分界且自身归 request;② 跨相文件(分界前首现+分界后命中)归 request;③ 工厂专属(分界后零命中)归 setup;④ 无 controller → 全 request 无 setup 步;⑤ request 段按分界后首次命中排序、setup 段首现序、全局连续。
- viewer-state 透传(1):steps 带 phase 原样到前端。
- page(2):折叠头文案与 localStorage 键;renderFlows 分段函数标记(字符串断言)。

## 6. 真仓验收

- 重跑 chatwoot 发消息 flow trace:conversation.rb / message.rb / messages_controller 在请求段,工厂/引导文件在 setup 段,折叠头步数与总步数自洽,请求段以 controller 开场。
- 旧 flows.json(不重跑)serve 起来不分段、零回归;真实仓零接触;umwelt 零接触。

## 7. 不做什么

- tracer 不动;RSpec example 打标/多请求分组(乙案)留档二期。
- setup 段内部不再细分(引导 vs 工厂)——单层折叠够用。
- per-flow 独立折叠态持久化(多流程时代再议)。
- 非 controller 锚点的分界启发(jobs 入口、mailer 入口等)——等真仓出现该形态的流程再议。

## 8. 已知局限(质量评审记档,2026-07-16)

**eager_load 可能提前分界点(中低概率,静默降级)**:tracer 的 `-r` 注入先于 Rails boot,TracePoint 全程激活;若目标仓在测试环境开 `config.eager_load` 且某 controller 文件在 boot 期发生**定义在该文件内的方法调用**(TracePoint 的 path 取方法定义处,宏调用指向 gem 定义不算),分界点会落进 boot 段,setup 段坍缩、分相失真——不崩溃、不产生非法数据,但本功能的动机被静默瓦解。chatwoot 配方(RAILS_ENV=test、未设 CI)大概率不触发。若将来真仓踩中:考虑「boundary 距序列起点过近时告警」的轻量启发。
