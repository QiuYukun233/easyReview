# easyReview 交接文档

> 最近更新：2026-07-06（v1 全套完成）。明天照这份就能继续。

## 这是什么

**easyReview 是一个"陌生代码库上手引擎"**：把一个开发者从"读不懂这个项目"训练到"理解整个项目、能 review 它"。

核心机制三层，**同一份数据的三个动作**：
1. **接地地图** — 把代码切成"风险 × 架构贡献度"二维网格（用 git 历史 + tree-sitter 算，不靠 AI 叙述）。
2. **学习路径** — 从简单/重复/低风险起步，爬向高风险核心；进度条 + 每步卡片；带"防盲区觅食"。
3. **执行验证（护城河）** — 突变探针：对某块注释一行 → 真跑 `cargo test` → 看真实"爆炸半径"（哪些测试变红）→ 学习者先预测再揭晓 → 判定 → 通过标 `verified`。

**铁律**：确定性信号（churn/coupling/所有权/中心度、tree-sitter、cargo）算结构与验证；理解靠**撞真实运行**验证，**不靠 AI 叙述解释代码**。

## 现状：v1 全套已完成并在 GitHub main 上

- 仓库：`E:\dev\easyReview`（本地）/ `https://github.com/QiuYukun233/easyReview`（main）。
- 目标分析对象：`D:\dev\umwelt-bevy`（Rust/Bevy workspace，crate: `chem_field`、`grid_workshop`）。
- 栈：Node 20+ / TypeScript(ESM) / vitest / `web-tree-sitter`+`tree-sitter-wasms` / git / cargo。
- **60 测试全绿**，纯 TDD 完成，四份计划各自评审通过并 ff-merge 到 main（第四份=计划②-LLM 块标签，见下）。
- `npm run typecheck`（`tsc --noEmit`）是类型的真实门——vitest 用 esbuild 抹类型、不做类型检查，改类型后务必跑它。

### 完整闭环（在真实 umwelt-bevy 上可跑）

```bash
cd E:/dev/easyReview
npm install                                               # 首次

# ① 地图：产出 easyreview.tree.json + easyreview.map.md（68 块的风险×贡献度网格）
npm run map   -- --repo D:/dev/umwelt-bevy --out .

# ①b LLM 块标签（可选增强）：默认 provider 是 DeepSeek——有 DEEPSEEK_API_KEY 时，map 会额外
#     为每块调 deepseek-v4-flash 生成"职责/为什么现在学它"两句，写 easyreview.labels.json
#     （按块 id+内容 hash 增量缓存）。--provider claude 可切回 Claude（读 ANTHROPIC_API_KEY，
#     默认 claude-haiku-4-5；haiku 不能传 effort）。
#     无对应 key / --no-label / 调用失败 → 静默跳过，map 照常产出 tree/map（纯确定性、可离线）。
#     模型可配：--model <id>，或 DEEPSEEK_MODEL / ANTHROPIC_MODEL 环境变量（按 provider 生效）。
#     注意：labels 缓存按"块 id+内容 hash"增量、不区分 provider/model——切换 provider 后想重打标签，
#     需先删 easyreview.labels.json（否则旧 provider 的标签会因 hash 未变而一直保留）。

# ② 学习旅程：产出 easyreview.journey.md（进度条 + 下一步卡片，有标签则叠加"职责"行+用 LLM 的 whyNow，无则回退静态）+ progress.json
npm run learn -- --out .
npm run done  -- <chunkId> --out .                        # 标记某块已理解，进度前进、章级点亮 ✓

# ③ 执行验证（护城河）：任意 crate（crate 从块自己的 chunk.crate 推导，不再只限 chem_field）
npm run verify -- crates/chem_field/src/core/field.rs --repo D:/dev/umwelt-bevy --out .
#   → 跑基线 cargo、显示突变位点 + 测试名（按 :: 模块分组）+ "预测哪些会崩"
#   → grid_workshop 也支持（201 测试、bevy/egui 链接重）；show 会先打一行"首次编译可能数分钟"警告
#   → 基线编译不过会明确报错（不再误报为"未覆盖"）
npm run verify -- crates/chem_field/src/core/field.rs --predict <逗号分隔测试名> --repo D:/dev/umwelt-bevy --out .
#   → 注释一行、跑 cargo、算真实爆炸半径、比对你的预测、通过则标 verified（还原原文件）

# ④ web viewer：npm run serve -- --out . [--port 4870] → http://localhost:4870
#   → 点亮地图（风险×贡献度网格,灰/绿/绿框=verified/黄=下一步）+ 右侧固定"下一步"卡片
#   → 页面可"标记已理解"（与 CLI done 写同一份 progress.json,同一代码路径）+ 亮暗主题
#   → 铁律不变:viewer 只消费 outDir 的 JSON,每次 F5 现读磁盘;无 tree.json 启动即报错指引先跑 map
```

> 注意：`verify` 会真跑 `cargo test -p chem_field`（热编译 ~35s/次，慢是正常的，不是卡住）。生成物（tree.json / *.md / progress.json / verify-*）都已 gitignore。

## 代码地图（src/）

| 路径 | 职责 |
|---|---|
| `types.ts` | 所有共享类型（三层树、Grade、JourneyPath、Progress、验证类型）|
| `git.ts` | git 封装（listTrackedFiles、logNameOnly）|
| `extract/rust.ts` | tree-sitter 提取函数叶子（web-tree-sitter 0.22.6，query 只编译一次、tree 每次释放）|
| `extract/tree.ts` | 组装三层树（章=crate/mod/目录，块=文件，叶=函数）|
| `grade/{churn,coupling,ownership,centrality}.ts` | 四个信号（0..1，归一化）|
| `grade/grade.ts` | 复合两轴 + 分位分桶（min→0/max→1 位置百分位）|
| `render/map-md.ts` | 风险×贡献度地图（可选 understood 点亮 ✓）|
| `path/sequence.ts` | 学习路径排序（难度=0.5贡献+0.3风险+0.2size；章内连续；觅食邻居）|
| `progress/progress.ts` | 进度持久化（understood + verified）|
| `render/journey-md.ts` | 进度条 + 下一步卡片（可选叠加 LLM 职责/whyNow，无标签回退静态）|
| `label/cache.ts` | 标签缓存：内容 hash（含函数源码+风险/贡献度档+邻居）、增量筛选、合并、读写 |
| `label/label.ts` | collectLabelInputs（GradedTree→输入）+ labelChunks（增量 + 无key/失败降级，绝不抛）|
| `label/prompt.ts` | 两 provider 共享：LabelSchema（zod）+ BASE_SYSTEM（铁律框架）+ userPrompt |
| `label/concurrency.ts` | 共享 mapWithConcurrency（并发池，按输入序返回）|
| `label/claude.ts` | ClaudeLabeler（messages.parse+zod，client 可注入、逐块弹性、并发5）+ makeClaudeLabelerFromEnv |
| `label/deepseek.ts` | DeepSeekLabeler（openai SDK 指向 DeepSeek，json_object+逐块弹性）+ makeDeepSeekLabelerFromEnv，**默认 provider** |
| `verify/parse.ts` | 解析 cargo test 输出（test…ok/FAILED + 编译崩）|
| `verify/cargo.ts` | runCargoTests（可注入 exec，测试用 fake）|
| `extract/parser.ts` | 共享 Rust tree-sitter parser 单例 getRustParser（rust.ts + pick-site.ts 复用）|
| `verify/mutate.ts` | withMutation（**finally 保证还原 + 行校验**，绝不损坏 umwelt-bevy）+ chooseMutation（async：优先 tree-sitter 好语句、regex 兜底）|
| `verify/pick-site.ts` | pickPreferredSite：tree-sitter 挑赋值/复合赋值/裸调用（下钻 ?/.await/paren）语句作突变位点，避开 let/构造体/tail |
| `verify/probe.ts` | 爆炸半径探针（基线→突变→跑→diff→还原）|
| `verify/judge.ts` | 判定预测 vs 真实爆炸半径 |
| `serve/state.ts` | buildViewerState 纯函数（网格分桶/卡片数据/path 顺序/nextId,复用 buildPath+whyNow）|
| `serve/done.ts` | 页面"标记已理解"（校验块存在,复用 progress 模块——与 CLI done 同一代码路径）|
| `serve/page.ts` | 自包含单页（原生 HTML/CSS/JS,零依赖零构建,亮暗主题跟系统+localStorage）|
| `serve/server.ts` | node:http 路由（GET / / /api/state / POST /api/done,每请求现读,错误兜底 500）|
| `cli.ts` / `cli-learn.ts` / `cli-verify.ts` / `cli-serve.ts` | CLI 命令 map / learn / done / verify / serve |

## 明天可选的下一步（按价值排序，记忆里也有）

1. ~~**计划②-LLM（块贴标签）**~~ ✅ 已完成（分支 feat/llm-chunk-labels，见 `docs/superpowers/plans/2026-07-06-llm-chunk-labels.md`）。
   - 设计/实现要点：Labeler 抽成接口、测试注入 FakeLabeler；ClaudeLabeler 用 `messages.parse()`+`zodOutputFormat`，默认 haiku（**注意 haiku 不接受 `effort`，会 400——所以不传 effort**）；铁律"LLM 只贴标签不发明结构"由 SYSTEM prompt + 只喂既有块数据保证。
   - **遗留**：真实 Claude 的 observe 冒烟未跑（本机无 ANTHROPIC_API_KEY / ant）。逻辑已由注入 fake client 的单测 + 对真实 SDK 类型定义的核对覆盖；等有 key 时跑一次 `npm run map -- --repo D:/dev/umwelt-bevy --out .` 肉眼评标签质量即可（会真调 68 块，第二次跑因 hash 缓存几乎不再调）。已在真实 umwelt-bevy 上验证过**无 key 降级**端到端可用（tree/map 照常、labels.json 空）。
   - **后续（2026-07-07）**：默认 provider 已改为 **DeepSeek**（便宜、OpenAI 兼容；分支 feat/deepseek-labeler，见 `docs/superpowers/plans/2026-07-07-deepseek-labeler.md`）。`--provider claude` 可切回。**真实 DeepSeek 冒烟已通过**（2026-07-07，deepseek-v4-flash 打满 umwelt-bevy 68/68 块、0 丢弃，标签贴合真实代码未发明结构；二跑因 hash 缓存 1.2s 不再调 API）。Claude 侧真实冒烟仍待有 ANTHROPIC_API_KEY 时补。
2. ~~**verify 扩到 grid_workshop**~~ ✅ 已完成（分支 feat/verify-any-crate，见 `docs/superpowers/plans/2026-07-06-verify-any-crate.md`）。verify 现支持任意 crate（crate 从块推导）；测试名按 `::` 模块分组；首次冷编译打警告；基线编译失败明确报错。勘察发现 grid_workshop 的 201 个测试基本是纯逻辑测试，无需 headless——障碍只是编译重 + 列表长。
3. ~~**更聪明的突变位点**~~ ✅ 已完成（分支 feat/smarter-mutation-site，见 `docs/superpowers/plans/2026-07-07-smarter-mutation-site.md`）。`chooseMutation` 改成 async 编排器：先用 tree-sitter 挑"好语句"（赋值/复合赋值/裸调用，含 `?`/`.await`/括号包装下钻），注释后大概率某测试变红而非编译崩；挑不到回退现有 regex 扫描（绝不退步）。顺手抽了共享 `getRustParser`。`withMutation` 还原逻辑一行未动。
4. ~~**web viewer**~~ ✅ 已完成（分支 feat/web-viewer，见 `docs/superpowers/plans/2026-07-07-web-viewer.md`）。`npm run serve` 起本地 viewer:点亮地图 + 固定"下一步"卡片 + 页面标记已理解（写同一份 progress.json）+ 亮暗主题。已在真实 umwelt-bevy 上浏览器冒烟通过（68 块渲染/点块切卡/标记联动/主题切换/错误路径,零控制台错误）。

## 一些工作方式上值得记住的经验

- 全程 subagent 驱动 TDD：每任务派全新 subagent 实现 → 两阶段评审（spec 合规 → 代码质量）→ 修 → 再审。评审 subagent 抓出了多个我计划里的真实 bug（分位公式、`'50%'.includes('0%')` 子串碰撞、done arg 顺序、`blast.actual` 笔误、verified 跨块持久化丢失）——**评审是真在拦 bug，不是走过场**。
- 每个渲染/验证模块都拿**真实 umwelt-bevy** 观察验证过（不止玩具单测）。
- **umwelt-bevy 绝不被损坏**：`withMutation` finally 无条件还原 + 施突变前校验目标行，sha256 验证过字节级还原。

## 设计/研究文档（都在仓库里）

- `docs/superpowers/specs/2026-07-05-easyreview-design.md` — 总设计（含铁律、三层树、两轴、验证）。
- `docs/superpowers/plans/2026-07-05-engine-foundation-and-grounded-map.md`（①）
- `docs/superpowers/plans/2026-07-06-deterministic-learning-journey.md`（②）
- `docs/superpowers/plans/2026-07-06-mutation-probe-verification.md`（③）
- `material/deep-research-report.md`（资深程序员如何理解程序）
- `material/research-02-training-and-tooling-landscape.md`（训练理解力的工具版图与空白，含引用）
