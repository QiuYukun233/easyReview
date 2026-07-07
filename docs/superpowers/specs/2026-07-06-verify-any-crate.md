# 设计：verify 扩到任意 crate（去硬编码 chem_field）

> 日期：2026-07-06 · 主题：让突变探针验证不再只支持 chem_field，改为对任意 workspace crate 通用；并处理重 crate（grid_workshop：201 测试、bevy/egui 链接极重）的两个 UX 后果。

## 背景

当前 `easyreview verify` 只能验证 `chem_field` 的块——不是因为机器有 crate 依赖，而是 `src/cli-verify.ts` 顶部硬编码了 `const CRATE = 'chem_field'`，且 `findChunk` 里有 `if (c.crate !== CRATE) throw` 的守卫。底层已经是 crate-无关的：`runCargoTests(repo, crate, exec)` 早已按 crate 参数化，突变机器（`chooseMutation` / `probe` / `judge` / `withMutation`）不关心是哪个 crate。

真正的目标 crate `grid_workshop` 有 **201 个 `#[test]`**（chem_field 才 20），依赖全套 bevy（render/pbr/winit）+ egui + panorbit。经代码勘察，其测试基本是纯逻辑测试（proptest/approx），只有 1 个 src 文件（`build_ui/viewer/state.rs`）碰 egui/App——所以"UI/render 测试"不是障碍，无需窗口/headless。真正的后果只有两个：

1. **冷编译极重**：首次 `cargo test -p grid_workshop` 链接 bevy_render/winit/egui，可能数分钟；`execFile` 不流式，跑完前终端静默，易被误以为卡住。
2. **verify.md 要塞 201 个测试名**：chem_field 才 21 个还好，201 个平铺是一堵墙。

## 铁律不变

`withMutation` 的"finally 无条件还原 + 施突变前校验目标行 + sha256 字节级还原"完全不动。本计划只是**放宽 cargo 跑哪个 crate**，不碰突变/还原逻辑，umwelt-bevy 安全性不受任何影响。

## 变更

### 1. 去硬编码 crate（`src/cli-verify.ts`）

- 删除 `const CRATE = 'chem_field'`。
- 删除 `findChunk` 里的 crate 守卫（`if (c.crate !== CRATE) throw ...`）；`findChunk` 只保留"未知 chunk 报错"。
- 在 `runVerifyShow` 与 `runVerifyPredict` 内部，取 `const crate = chunk.crate`，传给 `runCargoTests(o.repo, crate, o.exec)`；所有渲染里出现的 `${CRATE}`（标题"## `<crate>` 的测试"等）改用 `${crate}`。
- 效果：任意 workspace crate 的块都能验证。零测试的 crate/块 → baseline `results` 为空 → 突变后仍空 → 走**现有** `uncovered` 分支（"这块没被测试覆盖，突变探针无法验证它"），优雅降级、不崩。

`src/verify/cargo.ts` 不改（已参数化）。

### 2. 测试名按模块分组（新 `src/verify/testlist.ts`）

纯函数：

```ts
export interface TestGroup { module: string; tests: string[]; }
export function groupTestsByModule(names: string[]): TestGroup[];
```

- 把每个测试名按 `::` 拆分：最后一段是测试函数名，前面拼成模块路径；不含 `::` 的测试名归到模块 `(crate 根)`。
- 按模块分组；**组内保持原始顺序**；**组按模块名字典序排序**（确定性输出，利于快照/缓存稳定）。
- 空输入返回 `[]`。

`runVerifyShow` 里"## `<crate>` 的测试（N）"那段改为：先给总数，再按分组渲染，例如：

```
## `grid_workshop` 的测试（201）

### build_ui::routing_fsm
- `test_dead_end_marks_unroutable`
- `test_backtrack_on_conflict`

### constants::eval
- `test_biomass_curve`
```

- **保留全部测试，不截断**——教学上学习者就该对"远处某个测试变红"感到意外，这正是爆炸半径的价值；分组只是让 201 个可扫。
- chem_field 的 20 个测试也顺带走同样的分组渲染（无害、更整齐）。

### 3. 重编译警告（`src/cli-verify.ts` `runVerifyShow`）

- 在跑 baseline cargo **之前**，`console.error` 一行警告：
  `⏳ 首次编译 <crate> 可能要几分钟（bevy/egui 链接很重），属正常、不是卡住。`
- 只在 `runVerifyShow`（第一次冷编译发生处）打；机制不动，靠 cargo 自身编译缓存使"慢"只发生一次。
- 用 `console.error`（stderr），不污染生成的 markdown。

## 测试（TDD，沿用项目纪律）

- `test/testlist.test.ts`：`groupTestsByModule` — 多模块分组正确、组内保序、组按模块名排序、无 `::` 归"(crate 根)"、空输入返回 `[]`。
- `test/cli-verify.test.ts`（扩展，保留现有 chem_field 用例）：注入 fake `exec`（不打真实 cargo），构造一个**非 chem_field crate 的块**（如合成一个 `grid_workshop` crate、带若干 `module::test` 名的假 cargo 输出），跑 show → predict，断言：
  - (a) 非 chem_field crate 的块**不再被拒**（旧守卫已删）；
  - (b) `easyreview.verify.md` 里测试名**按模块分组**出现（含 `### <module>` 标题）；
  - (c) baseline 缓存、判定、`verified` 标记流程照旧工作；
  - (d) fake exec 收到的 `cargo test` 参数里 crate 是**块自己的 crate**，不是写死的 chem_field。
- 现有 chem_field cli-verify 用例继续通过（分组渲染后测试名仍在，断言可能需从"平铺列表"放宽到"包含该测试名"）。

## 非目标（YAGNI）

- 不动 `--test-threads=1`（并行可能引入共享状态 flaky → 污染爆炸半径 = 假教学；且 201 个纯逻辑测试执行是秒级，瓶颈在编译）。
- 不改 `Exec` 抽象 / 不流式输出 cargo 进度（要动被测的注入接缝，收益边际）。
- 不动 `chooseMutation`（更聪明的突变位点是下一项独立计划）。
- 不做测试列表截断/折叠。
- 无新依赖、无新增 gitignore（verify-* 已忽略）。
