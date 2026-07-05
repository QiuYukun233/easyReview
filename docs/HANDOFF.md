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
- **41 测试全绿**，纯 TDD 完成，三份计划各自评审通过并 ff-merge 到 main。

### 完整闭环（在真实 umwelt-bevy 上可跑）

```bash
cd E:/dev/easyReview
npm install                                               # 首次

# ① 地图：产出 easyreview.tree.json + easyreview.map.md（68 块的风险×贡献度网格）
npm run map   -- --repo D:/dev/umwelt-bevy --out .

# ② 学习旅程：产出 easyreview.journey.md（进度条 + 下一步卡片，从 filler 小文件起步）+ progress.json
npm run learn -- --out .
npm run done  -- <chunkId> --out .                        # 标记某块已理解，进度前进、章级点亮 ✓

# ③ 执行验证（护城河）：仅 chem_field
npm run verify -- crates/chem_field/src/core/field.rs --repo D:/dev/umwelt-bevy --out .
#   → 跑基线 cargo、显示突变位点 + 21 个测试名 + "预测哪些会崩"
npm run verify -- crates/chem_field/src/core/field.rs --predict <逗号分隔测试名> --repo D:/dev/umwelt-bevy --out .
#   → 注释一行、跑 cargo、算真实爆炸半径、比对你的预测、通过则标 verified（还原原文件）
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
| `render/journey-md.ts` | 进度条 + 下一步卡片 |
| `verify/parse.ts` | 解析 cargo test 输出（test…ok/FAILED + 编译崩）|
| `verify/cargo.ts` | runCargoTests（可注入 exec，测试用 fake）|
| `verify/mutate.ts` | withMutation（**finally 保证还原 + 行校验**，绝不损坏 umwelt-bevy）+ chooseMutation |
| `verify/probe.ts` | 爆炸半径探针（基线→突变→跑→diff→还原）|
| `verify/judge.ts` | 判定预测 vs 真实爆炸半径 |
| `cli.ts` / `cli-learn.ts` / `cli-verify.ts` | CLI 命令 map / learn / done / verify |

## 明天可选的下一步（按价值排序，记忆里也有）

1. **计划②-LLM（章/块贴标签）**：目前卡片里的"为什么现在学它"是静态文案；换成 LLM 生成的块标签/职责/学习钩子。
   - 技术：`@anthropic-ai/sdk` 的 `client.messages.parse()` + `zodOutputFormat`（`@anthropic-ai/sdk/helpers/zod`），默认模型 `claude-opus-4-8`（可配置成 haiku 做廉价批量），`output_config.effort:'low'`，认证 `new Anthropic()`（读 ANTHROPIC_API_KEY / `ant auth login` profile）。
   - **测试要点**：把 Labeler 抽成接口，测试注入 fake labeler（不打真实 API）；真实 Claude 只在 observe 冒烟。
   - claude-api 参考已在会话里加载过；铁律仍是"LLM 只贴标签、不发明结构"。
2. **verify 扩到 grid_workshop**（编译更重，需处理 UI/render 测试）。
3. **更聪明的突变位点**：`chooseMutation` 现在挑第一个 loc≥3 函数的第一条语句，对 `field.rs` 挑到了 `Field::new` 的构造体返回 → 注释后是**编译崩**（承重信号，但教学不如"某个具体测试变红"丰富）。改进：跳过纯构造体/单一 tail 表达式，偏好逻辑函数体中间的语句 → 得到具体测试失败。
4. **web viewer**：会点亮的地图 + 进度条的可视化版（当前只有 Markdown）。

## 一些工作方式上值得记住的经验

- 全程 subagent 驱动 TDD：每任务派全新 subagent 实现 → 两阶段评审（spec 合规 → 代码质量）→ 修 → 再审。评审 subagent 抓出了多个我计划里的真实 bug（分位公式、`'50%'.includes('0%')` 子串碰撞、done arg 顺序、`blast.actual` 笔误、verified 跨块持久化丢失）——**评审是真在拦 bug，不是走过场**。
- 每个渲染/验证模块都拿**真实 umwelt-bevy** 观察验证过（不止玩具单测）。
- **umwelt-bevy 绝不被损坏**：`withMutation` finally 无条件还原 + 施突变前校验目标行，sha256 验证过字节级还原。

## 遗留小事

- `E:\dev\easyReview\easyReview` 是当初为取远程地址建的空 clone 目录，多余，可删（一直是 untracked）。

## 设计/研究文档（都在仓库里）

- `docs/superpowers/specs/2026-07-05-easyreview-design.md` — 总设计（含铁律、三层树、两轴、验证）。
- `docs/superpowers/plans/2026-07-05-engine-foundation-and-grounded-map.md`（①）
- `docs/superpowers/plans/2026-07-06-deterministic-learning-journey.md`（②）
- `docs/superpowers/plans/2026-07-06-mutation-probe-verification.md`（③）
- `material/deep-research-report.md`（资深程序员如何理解程序）
- `material/research-02-training-and-tooling-landscape.md`（训练理解力的工具版图与空白，含引用）
