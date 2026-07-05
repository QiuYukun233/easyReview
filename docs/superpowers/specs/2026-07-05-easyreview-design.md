# easyReview 设计文档（v1）

> 状态：设计定稿，待评审 → writing-plans
> 日期：2026-07-05
> 前置材料：`material/deep-research-report.md`（资深程序员如何理解程序）、`material/research-02-training-and-tooling-landscape.md`（训练理解力的工具版图与教学理念）

---

## 1. 使命与定位

**easyReview 是一个"陌生代码库上手引擎"。** 它把一个开发者从"读不懂这个项目"训练到"理解整个项目、并具备足以 review 代码的能力和经验"。

做法三步：
1. 把代码切成一张**接地的"风险 × 架构贡献度"二维地图**；
2. 排出一条**从简单/重复/低风险爬向高风险核心的学习路径**（进度条）；
3. 用**可执行 ground-truth 验证**（Gistify 式：生成可证伪断言 → 撞真实运行）确认使用者真的理解，**而非让 AI 叙述式解释代码**。

**定位**：个人工具优先。v1 目标代码库 = `D:\dev\umwelt-bevy`（Rust/Bevy ECS workspace，含 `chem_field` 与 `grid_workshop` 两个 crate）。

**独占空白**（研究结论）：现存工具分三族——导航覆盖层、风险量化器、AI 解释助手——**没有一族能可度量地把人从"读不懂"训练到"能 review"**。easyReview 占这个空白。

## 2. 核心赌注：为什么这不是"AI 解释代码"

一句话铁律：**所有结构性判断（两个轴、叶子如何聚成块）都由确定性 VCS/静态/执行信号算出；LLM 只贴标签、解释，绝不发明结构。理解靠撞运行时 ground truth 验证，不靠叙述。**

研究背书：
- AI"解释仓库"可靠退化成摘要，受限于模型固有能力而非上下文量（CoReQA 2025）。→ 不把叙述当产物。
- 代码库理解可设成运行时可判定任务，SOTA 恰在长/深轨迹（高风险核心）失败（Gistify 2025）。→ 验证是护城河，也是"AI 解释"没有的那一步。

## 3. 研究驱动的设计铁律

1. **风险轴**：主信号 = **相对（归一化）churn + change coupling**；静态复杂度次要；**按仓库标定的复合分**，不用 McCabe/Halstead 当普适（它们预测理解断裂只有 AUROC 0.63、不跨库迁移）。
2. **贡献度轴**：基于**提交的 DOA/所有权** + 调用图/ECS 中心度；**不用行级 git-blame**。
3. **验证**：许多**小的可证伪二元输入-输出检查**（Gistify 式运行时复现），难度集中在高风险核心。
4. **防盲区**（最重要的坑）：预设路径会压制探索、制造盲区（code tour 实证）。路径只"建议下一步 + 逼学习者在周围觅食 + 靠验收抓路径未覆盖的盲点"，**绝不是一条单轨**。
5. **教学法是待验证假设**：把学习路径当假设，个人验证；设计来源 = Code Reading Club /《The Programmer's Brain》/ cognitive apprenticeship；拿 getDX 的 27 项 reviewer 胜任力当"能 review 了"的验收锚点；**不过度宣称**科学性。

## 4. 核心数据结构：三层树

同一棵树，三个视图各取所需：

```
Chapter 章 = crate / mod / 目录        → 地图格子（宏观网格）
   └─ Chunk 块 = 一簇协作叶子=干一件事  → 进度条每一步（学习单位，单一概念）
        └─ Leaf 叶 = 函数 / 内聚代码区   → 打分 & 验收的原子单位
```

- **叶**：tree-sitter-rust 取函数/方法/impl 边界。风险、贡献度在叶上算、向上汇总。可被 Gistify 式验收的最小单位。
- **块**：v1 务实聚类 = 文件内 + 调用/mod 邻接粗聚；执行 trace 聚类延后。
- **章**：v1 = crate/mod/目录（作者自己的 chunking，免费且可靠）。umwelt-bevy 的章即两 crate 及其 mod 子树（如 `grid_workshop::routing`、`chem_field::core`）。

## 5. 两个视图

- **宏观地图**：章级"风险 × 贡献度"网格。终点视角，随进度**点亮**。
- **线性进度条**：块按学习序排。新手入口——"已理解 X% / 下一步：这个块"。
- **关系**：进度条 = 按序走过的地图；走完的块点亮所属章；**地图是被你一步步走出来、逐渐可读的**。新手看不懂地图，但看得懂进度条 + 一个具体下一步。

## 6. 引擎管线（六步）

```
Rust 适配器(tree-sitter) ─┐
                          ├─► ① Extract：建三层树（章=crate/mod/目录，块=文件+邻接，叶=函数）
git history ──────────────┘
     ► ② Grade：两轴复合分 = 相对churn + change coupling + DOA/所有权 + 中心度/size，按仓库归一化标定
     ► ③ Label：LLM 给章/块命名 + 一句职责（接地，不发明结构）
     ► ④ Sequence：学习路径，填充/低风险起步 → 核心，依赖+难度分级，留觅食缺口防盲区
     ► ⑤ Verify：每块生成可证伪断言 → 撞 ground truth（跑 umwelt-bevy 测试 / headless 步进）
     ► ⑥ Progress：持久化进度状态（哪些块已验证/理解、地图点亮）
     ► 渲染：Markdown 先（地图表 + 路径 + 每块卡片 + 进度条），薄 Vite/React viewer 后
```

## 7. 架构

**引擎 + 双输出**，表现与分析解耦：
- **引擎**（Node/TypeScript）：语言无关核心 + **可插拔 Rust 适配器**。产出一份规范数据 artifact（JSON：三层树 + 两轴分 + 标签 + 学习路径 + 每块验证项 + 进度）。将来换语言只换适配器。
- **渲染器**（薄）：Markdown 导出先行；Vite/React 本地 viewer（地图点亮 + 进度条 + 章→块下钻）后加。二者都只读同一份 JSON。

**关键外部依赖**：
- tree-sitter-rust（叶子提取）；`git log`/`git blame`（churn/coupling/DOA）；`cargo test` 与 headless Bevy 运行（验证 ground truth）；Claude API（Opus/Sonnet，仅用于标签与可证伪断言生成）。

## 8. 验证设计（Gistify 式，v1 护城河）

**原则**：复用 umwelt-bevy **已有测试**作 ground-truth harness，不从零造通用复现引擎。
- 每块生成 1+ 个**可证伪断言**：预测某测试的输出 / 预测哪个 Bevy system 会跑 / 预测某组件状态在 N 步后如何变。
- 断言 → 撞真实：跑对应 `cargo test` 或一个小 headless 步进 harness → **二元判对错**。
- 难度集中在高风险核心（正是 SOTA 会失败处），也正是学习者最需要被验收处。
- 验收结果驱动进度条点亮与"防盲区"提示（路径没覆盖但断言暴露的块）。

## 9. v1 范围与里程碑

覆盖**整个 umwelt-bevy workspace**（两 crate），验收用**完整 Gistify 式执行验证**。为可增量交付，v1 内分两里程碑：

- **v1a — 地图与路径**：三层树 + VCS 接地两轴复合分 + LLM 标签 + 分级学习路径（带觅食缺口）+ Markdown 渲染 + 进度持久化 + 轻量案例日志（学习日志，与 teach learning-records 合流）。
- **v1b — 执行验证闭环**：每块可证伪断言 → 复用 umwelt-bevy 测试/headless 步进撞 ground truth → 二元验收 → 驱动进度与防盲区。先从测试覆盖最好的 crate 起，扩到两 crate。

**延后**：Vite/React viewer 打磨、执行 trace 聚类、教练强制闸门（v1 验收信息化但轻触）、多语言、多仓。

**diff 模式**（v1.5，二级）：复用树，把 diff 打到格子上，显示受影响章/块及其两轴分——"理解一个变更 = 它在你已学过的项目模型里动了哪块"。

## 10. 验证计划（这个方向是否成立）

个人高密度验证：拿 easyReview 走 umwelt-bevy 的路径。度量（对齐前期报告 + getDX 胜任力）：
- 能否**解释**（而非只更放心）——150 字解释 + 8 问 rubric；
- 核心块的**可证伪断言验收是否通过**；
- 影响面预测 / reviewer 追问预测的事后命中；
- 某些输出结构（地图、路径、验证项）是否跨块稳定复现有用。
学习日志落 `cases/`。三信号出现两个即值得继续投入。

## 11. 已知风险与开放问题

- **教学法→可计算路径无实证背书**：sequencing 是假设，需个人验证，不过度宣称。
- **Rust/Bevy ECS 特异性**：控制流经 ECS 调度器分派而非显式调用图——churn/DOA（VCS 派生）仍有效，但"中心度"与执行验证需适配调度器语义（system 顺序、组件读写）。这也是机会：**Bevy schedule 本身就是执行顺序 = 现成 ground truth**。
- **完整 Gistify 验证 + 整 workspace 对 v1 偏重**：以里程碑 v1a/v1b 拆解、复用现成测试来控风险。
- **防盲区平衡未有定论**：揭示多少 vs 逼觅食，v1 取"建议 + 缺口 + 验收兜底"，留待个人验证调参。

## 12. 与 teach 系统的关系

复用 `junior-to-senior` 的 teach 教学法（learning-record / lesson / glossary 格式）作每块内容与验收的基座，开放参考更广教学法。进度与那套 mission 对齐。二者是同一学习系统的两臂。

## 13. 非目标（v1 明确不做）

- 不做"自动找 bug"的 review bot（那是旧 ReviewFlow 方向，已存档）。
- 不做叙述式"解释整个仓库"（注定退化成摘要）。
- 不做多用户/团队/账号/云端。
- 不做多语言（仅 Rust 适配器）。
- 不追求地图美学（静态复杂度指标不可当普适）。
