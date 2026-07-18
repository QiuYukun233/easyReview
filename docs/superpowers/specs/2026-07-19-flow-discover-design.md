# 流程自动发现(flow discover)· 设计

日期:2026-07-19
背景:纵向四部曲(trace #19 → 分相 #20 → 单例切窗 #21 → 流程探针 #23)让流程可看、可考,但流程是**手工采样**的——读者得先知道 `messages_controller_spec.rb:25` 这种 spec 路径才能 trace。目标用户恰是「不认识这个库的人」,面对的「流程」Tab 默认是空的。本项让流程**可发现**:确定性枚举业务流程 spec 的每个 example,列成命名候选,读者挑一条、复制现成命令去 trace。

## 1. 已定决策(用户逐项确认)

- 枚举机制:**方案甲——rspec `--dry-run`**(否掉乙 tree-sitter 静态扫:看不见共享示例、无描述 example、动态 example)。dry-run 复用现有 docker runner,只加载不执行,吐出权威的 `full_description`+`file_path`+`line_number`。
- trace 触发:**方案甲——viewer 列候选 + 可复制命令**(否掉乙一键浏览器触发:要把只读服务器扩成异步作业系统,另一期)。发现只枚举、不执行;trace 仍懒加载、仍 CLI 触发;服务器保持只读。

## 2. 目标与边界

`flow discover [--repo <p>] [--out <d>] [--specs <dir,dir>]`:dry-run 业务流程 spec、枚举每个 example、产出 `easyreview.flow-candidates.json`。viewer「流程」Tab 新增「可追踪的流程」段呈现候选。**不碰 flows.json**(发现与追踪是两份产物,职责分离)。

## 3. CLI 与枚举

- 复用现有 ruby runner 的 `cmd`(`loadRubyRunnerConfig`,已含 `--format json`),参数展开为 `['--dry-run', <存在的 spec 目录…>]`——rspec 接受 flag 与路径混排。
- `--specs` 缺省 = `spec/requests,spec/system,spec/controllers`;**过滤掉仓里不存在的目录**(chatwoot 自动只剩 requests+controllers,system=0)。全部不存在 → 友好拒绝。
- dry-run 只加载不跑,但仍需 Rails 环境加载 spec 文件(它们 require rails_helper),故沿用同一 docker runner。
- **不走沙箱**:discover 往仓里写零个文件(不像 trace 要写 tracer 进沙箱),dry-run 纯只读,故 cwd 直接是 repo(runner 本就 docker 隔离)。省掉沙箱同步,更快。发现是每仓一次性操作,几秒~分钟级,结果缓存落盘。

## 4. 解析(纯函数 `parseDryRun`)

rspec dry-run 的 JSON `examples[]` → 候选[],每条:
- `name` = `full_description`(`describe`+`context`+`it` 天然拼接,零 LLM 命名)。
- `spec` = `file_path` 归一到仓相对(rspec 输出形如 `./spec/...`,去前导 `./`)+ `:line_number`。
- `id` = `flowIdFor(spec, line)`(见 §5)。
- 解析容错沿用 `rspec-parse` 的「整段兜底」口径:dry-run 输出同样可能被容器提示语粘污染,提取平衡的 JSON 段。

## 5. 数据与 id 统一(一处小改)

候选与已追踪流程必须共享 id 才能去重对号。现有 `flow trace` 的 id 是 `flow-<basename>-L<line>`——在 1525 条候选规模下 basename 跨目录会撞(多个 `base_controller_spec` / v1·v2 · enterprise 镜像)。

- 改为**路径 slug**:去 `spec/` 前缀与 `_spec.rb` 后缀、`/`→`-`,前缀 `flow-`,带行号则尾 `-L<line>`。例:`spec/controllers/api/v1/accounts/conversations/messages_controller_spec.rb:25` → `flow-controllers-api-v1-accounts-conversations-messages_controller-L25`(只去 `_spec.rb`,`_controller` 保留)。
- 抽 `flowIdFor(spec: string, line: number | null): string`,**`flow trace` 与 discover 同用此一处**。
- 全谱流程(无行号)id 无 `-L` 尾缀,与单例候选(必带行号)天然不撞。
- flows.json 是 gitignore 的可重生成产物,老流程重 trace 即得新 id,无迁移负担;文档记一句「本项改了 id 方案,已 trace 的流程需重 trace」。

## 6. 数据类型

```ts
interface FlowCandidate { id: string; name: string; spec: string } // spec = "file:line"
interface FlowCandidatesFile { version: 1; candidates: FlowCandidate[] }
```

`loadCandidates`/`saveCandidates` 镜像 flows.ts 的容错口径(读不出/损坏 → null,serve 与 CLI 共用)。discover 每次**全量覆盖**候选文件(不增量)。

## 7. viewer 呈现

- serve 层加载 candidates,**滤掉已在 flows.json 里(同 id)的**——已追踪的走原有流程列表,候选段只显示还没 trace 的。
- `ViewerState` 加 `candidates: {id,name,spec}[]` + `hasCandidates: boolean`(区分「老产物没跑过 discover」与「跑了但零候选」)。
- 「流程」Tab 在已追踪流程下方新增「可追踪的流程(N 条)」段,**按 spec 文件分组折叠**(默认折叠,localStorage 持久化,复用现有折叠惯例与键连字符约定),展开见该文件的 examples;每条一行 `name` + 一个可复制的 `flow trace <spec> --name "<name>"` 命令文本。
- `hasCandidates=false`(老产物)整段不渲染,与 `hasFlows` 一个路数;`hasFlows=false && hasCandidates=true` 时 Tab 仍要出现(现有 renderTabs 回退按 hasFlows 判断,需一并看 hasCandidates,避免"有候选却无 Tab")。
- 空发现(跑了但零候选)诚实标注。

## 8. 测试计划(预计 +10~12 条)

- `flowIdFor`:slug 化(去前后缀、`/`→`-`)、有无行号、`spec/` 前缀剥离。
- `parseDryRun`:full_description 取名、`./` 前缀归一、slug id、污染兜底(粘提示语)、空 examples。
- discover 编排(fake exec):写候选文件、空发现诚实、`--specs` 目录不存在过滤、全部不存在友好拒绝。
- serve 层:候选滤已追踪(同 id)、按文件分组、`hasCandidates` 三态。
- page.ts:候选段渲染、分组折叠、命令文案含 `--name`、空态、`hasFlows=false && hasCandidates=true` 时 Tab 出现。

## 9. 真仓验收

- chatwoot 跑 `flow discover` → `easyreview.flow-candidates.json` 含 controllers 的约 1525 条;`messages_controller_spec` 的「creates a new outgoing message」在列,spec:line 正确对应真实 example 位置。
- viewer「流程」Tab 候选段按文件折叠;复制某条命令能直接 trace 出对应流程。
- 已 trace 的 messages 流程从候选段消失(同 id 去重生效)。
- 真实仓零接触:discover cwd=repo 直跑,dry-run 只读不写仓内跟踪文件,发现后 `git status` 干净(断言);老产物(无 candidates 文件)Tab 回归 `hasCandidates=false` 不渲染候选段。

## 10. 不做什么

- 一键浏览器触发 trace(二期,与探针 UI 集成同级 UI 工程)。
- 候选的「重要度」排序/过滤(违铁律「不靠 AI 叙述」;只按文件分组、名字自陈,读者自选)。
- 非 Ruby 栈发现(流程数据目前只有 rspec 来源)。
- 发现结果增量/时效性(每次 discover 全量覆盖)。
- 候选历史/收藏。
