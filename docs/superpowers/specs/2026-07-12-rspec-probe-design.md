# rspec 突变探针 · 设计(路线图子项目②)

2026-07-12。让 verify(突变探针)支持 Ruby/rspec,目标仓 chatwoot(`E:/learning/agent-research/repos/chatwoot`,产物在 `out/chatwoot`)。复用 C 的沙箱机制(PR #9),真实仓零接触语义原样延续。

## 问题

verify 目前 Rust/cargo 专属(`assertRustChunk` 拦截)。Ruby 侧三个根本差异:①无 crate 概念——chatwoot 全部 738 块 crate 均为 'app',「按 crate 圈测试」失效,且全量 CE spec 在 CI 要 16 路并行,单机全量不可行;②本机无 Ruby,环境要靠 Docker(pg16+redis+schema);③rspec example 名是长句子,cargo 式「预测测试名」不可操作。

## 已定决策

| 决策点 | 选择 | 被拒选项 |
|---|---|---|
| 环境形态 | 仓级配置声明测试命令(`easyreview.runner.json`),环境用户自备,随附 chatwoot compose 配方 | 内置 Docker 编排(工程量数倍、强耦合难测);只支持本地已有 rspec 环境(本机无 Ruby=不可用) |
| 测试范围 | 镜像 spec + 引用扫描(确定性 grep 类名),上限回退 | 仅镜像 spec(爆炸半径囿于本文件,预测无意义);配置写死目录(粗、慢、每仓人工调) |
| 预测粒度 | spec 文件级(文件含≥1 失败 example 即红) | example 级(长句子名无法命令行输入);describe 块级(增量信息少、多一层映射) |
| 架构 | 方案 1:`VerifyRunner` 接口按语言注册,CargoRunner 纯搬运 + RspecRunner | 方案 2 cli-verify 内 if/else 分叉(不可维护);方案 3 全语言命令模板(Rust 零配置变有配置=减速带) |
| 验收深度 | 真仓立起来跑通(Docker 环境初始化 + chatwoot 真跑 show/predict) | 工程验收为主真仓后置(配方风险未踩实) |

## §1 Runner 接口与类型(`src/verify/runner.ts`,新文件)

```ts
export type TestRun = CargoTestRun;   // 结构通用:{compiled(=套件可加载), results:[{name,passed}]}

export interface VerifyRunner {
  id: 'rust' | 'ruby';
  /** 圈定测试域(只读真实仓)。返回可序列化 scope,原样存进 baseline JSON,predict 时原样传回。 */
  pickScope(g: GradedTree, chunk: Chunk, repo: string): { scope: unknown; note?: string };
  /** 在沙箱里跑该域测试,返回【预测粒度】的 TestRun(cargo=测试名;rspec=spec 文件路径)。 */
  run(sandboxSrc: string, sandboxTarget: string, scope: unknown, exec?: Exec): Promise<TestRun>;
  /** verify.md 测试清单分组展示。 */
  group(names: string[]): { module: string; tests: string[] }[];
}
```

- `CargoRunner`:`pickScope → {crate: chunk.crate}`;`run → runCargoTests(...)` 原样;`group → groupTestsByModule` 原样——纯搬运,行为零变化。
- `probe.ts` 的 `withMutation` 调用链、`judge.ts`(字符串集合比对,天然兼容文件级名字)、沙箱模块全部不动。

## §2 RspecRunner · 范围圈定(镜像 + 引用扫描)

- **镜像规则**:去掉头部 `app/` 前缀、挂到 `spec/`、`.rb` → `_spec.rb`(`app/actions/x.rb → spec/actions/x_spec.rb`;`lib/x.rb → spec/lib/x_spec.rb`)。文件存在才算。
- **引用扫描**:类名 = basename 的 camelize(`contact_identify_action → ContactIdentifyAction`,Rails 铁约定);在真实仓 `spec/**/*_spec.rb` 内容里词边界 grep,命中进候选。命名空间类只按 basename 类名扫(确定性启发,已知局限)。
- **上限护栏**:扫描命中数 > `scanLimit`(默认 20)→ 回退只跑镜像 spec,verify.md 显式说明「引用扫描命中 N 个超上限,本次只跑镜像」。不做静默截断、不做按路径取前 N 的有偏采样。
- **皆空**:镜像不存在且扫描零命中 → 报错「找不到相关 spec——换个有测试覆盖的块」。
- scope 序列化形态:`{ specFiles: string[], scanNote: string }`。

## §3 配置文件与命令执行

真实仓根 `easyreview.runner.json`(`easyreview.` 前缀天然被沙箱同步排除,它也不需要进沙箱):

```json
{
  "version": 1,
  "ruby": {
    "cmd": ["docker", "compose", "-f", "docker-compose.easyreview.yaml", "run", "--rm", "-T", "rspec", "{specFiles}"],
    "scanLimit": 20
  }
}
```

- `cmd` 数组;`{specFiles}` 占位符展开为多个参数(每个文件一个)。
- **cwd = 沙箱 `src/`**:compose 文件是仓内普通文件、会同步进沙箱;compose 里挂载 `.` 即挂载沙箱——突变对容器可见,零接触语义延续(沙箱在用户 Temp 下,Docker Desktop 默认共享范围内)。
- 输出合并 stdout+stderr(复用 `Exec`);rspec 不需要 targetDir,`run` 忽略之;退出码不作依据,以解析到的 rspec JSON 为准。
- 缺配置/缺 `ruby` 节 → 报错「verify Ruby 需要仓根 easyreview.runner.json——chatwoot 配方见 docs/recipes/chatwoot-rspec.md」。

## §4 rspec JSON 解析与判定语义(`src/verify/rspec-parse.ts`,新文件)

- **提取**:输出混着 compose/bundler 噪音——从后往前找能 `JSON.parse` 且带 `examples` 键的行(rspec `--format json` 汇总是单行)。
- **文件级聚合**:example 的 `file_path` 归一化(`./spec/…` → `spec/…`);文件 `passed` ⟺ 无 `failed` example(`pending` 不算失败)。`results = [{name: 文件路径, passed}]`。
- **「编译崩」等价物**:无可解析 JSON 或 0 个 example(加载期 NameError/SyntaxError)→ `compiled: false`。verify.md 文案按语言:Ruby 用「突变让 spec 套件加载失败——这行是承重的」(probe.ts 不动,措辞在 cli-verify 生成 verify.md 时按语言选;`<compile-error>` 哨兵保留)。
- **uncovered 规则原样复用**:没崩且零新红文件 = 未覆盖,不算通过。

## §5 Ruby 突变位点

- `pick-site.ts` 泛化为按语言分发 `pickPreferredSite(source, lang)`:Rust 路径原逻辑不动;Ruby 路径用 tree-sitter-ruby(经 `extract/parser.ts` 现有 wasm 加载机制)——候选 = 单行的 `call`/`assignment`/`operator_assignment` 节点且处于语句位(父节点为 `body_statement`/`do_block`/`block_body`/`begin`/`then`/`else`/`program`),取源码顺序第一个。
- `mutate.ts`:`buildOp` 注释前缀按 `langOf(file)` 选 `// ` 或 `# `;`chooseMutation` regex 回退的 `isCommentable` 按语言换规则(Ruby 版跳过空行、`#`、`def `、`end`、`class `/`module `、以 `do` 结尾的块头等)。**`withMutation` 一行不动。**
- 已知风险注明:Ruby 注释一行不产生编译错,坏果子在运行期(NameError/行为变化)——正合探针本意;`end` 配对破坏由「跳过块头/块尾」规避。

## §6 `cli-verify.ts` 接线与 UX

- `assertRustChunk` 删除 → `runnerFor(chunk, repo)`:rust=`CargoRunner`、ruby=`RspecRunner`(此时加载校验 runner 配置)、其它语言报错(沿用现有措辞格式)。
- **show**:读源码 → `chooseMutation`(语言感知)→ 沙箱同步 → `runner.pickScope` → `runner.run` 基线 → baseline JSON 新增 `scope` 字段 → verify.md。文案按语言:rspec 版编译提示为「首次运行 docker 冷启动+bundle 可能较慢」;清单按 `runner.group`(rspec 按 spec 顶层目录分组);预测指令改为 spec 文件路径逗号分隔;扫描上限回退时显式一行。
- **predict**:读 baseline(含 scope)→ 沙箱同步 → `probe`(absFile 沙箱路径、`runAfter = runner.run(scope)`)→ `judge` → uncovered/通过/progress 全沿用;`compileBroke` 措辞按语言。
- **baseline 兼容**:旧 baseline 无 `scope` 只可能来自 Rust,`CargoRunner` 从 chunk.crate 现算,不做迁移。

## §7 chatwoot 环境配方(交付物)

`docs/recipes/chatwoot-rspec.md` + 两个模板(放 `docs/recipes/`,使用时拷入 chatwoot 仓根,对该仓是未跟踪本地文件):

- **`docker-compose.easyreview.yaml`**(按 chatwoot CI 配方裁剪):`postgres`=pgvector/pgvector:pg16(trust、tmpfs 数据盘);`redis`=redis:alpine;`rspec` 服务=ruby:3.4.4 基础镜像、挂 `.`→`/app`、gems 缓存命名卷、env 指向 compose 内 pg/redis、`RAILS_ENV=test`。
- 一次性初始化(文档写明手动跑):`bundle install` + `rake db:create db:schema:load`。
- 已知雷预置注释:CE spec 需剔除 enterprise(CI 有 Strip enterprise code 步骤)、`NODE_OPTIONS=--openssl-legacy-provider`。
- **配方是活文档**:真仓验收踩坑修回配方,验收通过的版本才定稿。

## §8 测试与验收

单元(全 fake exec / 真 tree-sitter,不碰 docker):

1. CargoRunner 纯搬运回归(现有 cli-verify 测试全绿即锁)
2. 范围圈定:镜像映射(app/ 与非 app/)、camelize、扫描命中、超上限回退、皆空报错
3. `rspec-parse`:fixture——全过/有 failed/pending 不算失败/噪音包裹/加载崩→`compiled:false`
4. `RspecRunner.run`:fake exec 断言 `{specFiles}` 多参数展开、cwd=沙箱 src
5. Ruby 位点:真 tree-sitter-ruby 命中/跳过规则;`buildOp` 出 `# `;regex 回退 Ruby 版
6. cli-verify Ruby 全流程(fake exec):show(baseline 含 scope+verify.md 文件级清单)→ predict(文件级判定+progress);缺配置报错;零接触锁复用 C 模式
7. Rust 全量回归:现有 151 测试一个不红

真仓验收(定稿标准):启动 Docker Desktop → 配方拷入 chatwoot → 一次性初始化(首次 30-60 分钟)→ `verify show app/actions/contact_identify_action.rb` → `--predict` 真突变真 rspec → 零接触断言(chatwoot `git status` 0 改动、突变只在沙箱、事后字节还原)→ 踩坑修回配方。
