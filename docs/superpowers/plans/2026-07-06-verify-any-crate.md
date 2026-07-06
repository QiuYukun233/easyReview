# verify 扩到任意 crate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让突变探针 verify 不再硬编码只支持 chem_field，改为对任意 workspace crate 通用（crate 从 `chunk.crate` 推导）；并把测试名列表按模块分组、给重 crate 加一行冷编译警告。

**Architecture:** verify 的突变机器（cargo/mutate/probe/judge/withMutation）本就 crate-无关，`runCargoTests(repo, crate, exec)` 已参数化。改动集中在 `src/cli-verify.ts`（去掉 `CRATE` 常量与 crate 守卫、用 `chunk.crate`、加警告、用分组渲染）+ 一个新纯函数 `src/verify/testlist.ts`。`withMutation` 的还原逻辑零改动，umwelt-bevy 安全性不受影响。

**Tech Stack:** Node 20+ / TypeScript(ESM) / vitest。无新依赖。

> **实现决策（重要）**：`groupTestsByModule` 的每组 `tests` 保留**完整测试名**（如 `core::field::t1`），`module` 只作分组标题键。理由：学习者的 `--predict` 必须匹配 cargo 的完整测试名，保留全名才能直接复制粘贴；也让现有断言 `toContain('core::field::t1')` 不破。spec 示例里只显示叶名是示意，本计划以"保留全名"为准。

---

## 文件结构

| 路径 | 职责 | 动作 |
|---|---|---|
| `src/verify/testlist.ts` | `groupTestsByModule(names)` — 按 `::` 模块前缀分组，组内保序、组按模块名排序，全名保留 | Create |
| `src/cli-verify.ts` | 去掉 `CRATE` 常量 + 守卫；`crate = chunk.crate`；baseline 前警告；测试段用分组渲染 | Modify |
| `test/testlist.test.ts` | `groupTestsByModule` 纯函数单测 | Create |
| `test/cli-verify.test.ts` | 加一个非 chem_field crate 的端到端用例（注入 fake exec）；保留现有 chem_field 用例 | Modify |

---

## Task 1: 测试名按模块分组（纯函数）

**Files:**
- Create: `src/verify/testlist.ts`
- Test: `test/testlist.test.ts`

- [ ] **Step 1: 写失败测试**

Create `test/testlist.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { groupTestsByModule } from '../src/verify/testlist.js';

describe('groupTestsByModule', () => {
  it('groups by module prefix, keeps full names, preserves in-group order', () => {
    const out = groupTestsByModule([
      'build_ui::routing_fsm::b_test',
      'build_ui::routing_fsm::a_test',
      'constants::eval::curve',
    ]);
    expect(out).toEqual([
      { module: 'build_ui::routing_fsm', tests: ['build_ui::routing_fsm::b_test', 'build_ui::routing_fsm::a_test'] },
      { module: 'constants::eval', tests: ['constants::eval::curve'] },
    ]);
  });

  it('puts names without :: under the crate-root group', () => {
    const out = groupTestsByModule(['smoke', 'core::field::t1']);
    expect(out).toEqual([
      { module: '(crate 根)', tests: ['smoke'] },
      { module: 'core::field', tests: ['core::field::t1'] },
    ]);
  });

  it('sorts groups by module name but keeps original order within a group', () => {
    const out = groupTestsByModule(['z_mod::t1', 'a_mod::t2', 'a_mod::t1']);
    expect(out.map((g) => g.module)).toEqual(['a_mod', 'z_mod']);
    expect(out[0].tests).toEqual(['a_mod::t2', 'a_mod::t1']); // 组内保原序，不排序
  });

  it('returns [] for empty input', () => {
    expect(groupTestsByModule([])).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/testlist.test.ts`
Expected: FAIL — `src/verify/testlist.js` 不存在。

- [ ] **Step 3: 实现 `src/verify/testlist.ts`**

```ts
export interface TestGroup {
  module: string;
  tests: string[]; // 完整测试名（如 core::field::t1），非叶名
}

/** 按 `::` 模块前缀把测试名分组：最后一段是测试函数名，前面是模块路径；
 *  无 `::` 的归到 "(crate 根)"。组内保持原始顺序；组按模块名字典序排序（确定性输出）。 */
export function groupTestsByModule(names: string[]): TestGroup[] {
  const byModule = new Map<string, string[]>();
  for (const name of names) {
    const idx = name.lastIndexOf('::');
    const module = idx >= 0 ? name.slice(0, idx) : '(crate 根)';
    const arr = byModule.get(module);
    if (arr) arr.push(name);
    else byModule.set(module, [name]);
  }
  return [...byModule.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((module) => ({ module, tests: byModule.get(module)! }));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/testlist.test.ts`
Expected: PASS（4 tests）。也跑 `npm run typecheck`，确认干净。

- [ ] **Step 5: 提交**

```bash
git add src/verify/testlist.ts test/testlist.test.ts
git commit -m "feat(verify): groupTestsByModule（按模块前缀分组测试名，保留全名）"
```

---

## Task 2: cli-verify 去硬编码 crate + 分组渲染 + 冷编译警告

**Files:**
- Modify: `src/cli-verify.ts`
- Test: `test/cli-verify.test.ts`

先读 `src/cli-verify.ts` 对齐当前形态。关键现状：顶部 `const CRATE = 'chem_field'`；`findChunk` 有 `if (c.crate !== CRATE) throw`；`runVerifyShow` 用 `runCargoTests(o.repo, CRATE, o.exec)` 且测试段是 `` `## ${CRATE} 的测试（${all.length}）`, ...all.map((n) => `- \`${n}\``) ``；`runVerifyPredict` 里 probe 的 `runAfter: () => runCargoTests(o.repo, CRATE, o.exec)`。

- [ ] **Step 1: 扩展 `test/cli-verify.test.ts`（先写、确认失败）**

在现有 `describe('verify show/predict', ...)` 块内**新增**这个用例（保留原 chem_field 用例不动）。文件顶部已 import 的 `makeTempRepo/writeRepoFile/commitAll/runMap/runVerifyShow/runVerifyPredict/readFileSync/existsSync/join` 复用：

```ts
  it('works for a non-chem_field crate and groups tests by module', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    writeRepoFile(dir, 'crates/grid_workshop/Cargo.toml', '[package]\nname="grid_workshop"');
    writeRepoFile(dir, 'crates/grid_workshop/src/build_ui/routing_fsm.rs',
      'pub fn route(x: i32) -> i32 {\n    let step = 1;\n    x + step\n}\n');
    commitAll(dir, 'init');
    await runMap({ repo: dir, outDir: dir });

    const chunkId = 'crates/grid_workshop/src/build_ui/routing_fsm.rs';
    let phase = 'baseline';
    let seenCrate = '';
    const fakeExec = async (_cmd: string, args: string[]) => {
      const pi = args.indexOf('-p');
      if (pi >= 0) seenCrate = args[pi + 1];
      return phase === 'baseline'
        ? 'test build_ui::routing_fsm::t1 ... ok\ntest build_ui::routing_fsm::t2 ... ok'
        : 'test build_ui::routing_fsm::t1 ... ok\ntest build_ui::routing_fsm::t2 ... FAILED';
    };

    // (a) 非 chem_field 不再被拒
    await runVerifyShow({ repo: dir, outDir: dir, chunkId, exec: fakeExec });
    // (d) fake exec 收到的 crate 是块自己的 crate
    expect(seenCrate).toBe('grid_workshop');
    const show = readFileSync(join(dir, 'easyreview.verify.md'), 'utf8');
    // (b) 测试名按模块分组出现
    expect(show).toContain('### build_ui::routing_fsm');
    expect(show).toContain('build_ui::routing_fsm::t1'); // 全名保留
    // 标题用块自己的 crate
    expect(show).toContain('`grid_workshop` 的测试');

    // (c) 判定/verified 流程照旧
    phase = 'mutated';
    await runVerifyPredict({ repo: dir, outDir: dir, chunkId, predicted: ['build_ui::routing_fsm::t2'], exec: fakeExec });
    const verdict = readFileSync(join(dir, 'easyreview.verify.md'), 'utf8');
    expect(verdict).toContain('通过');
    const progress = JSON.parse(readFileSync(join(dir, 'easyreview.progress.json'), 'utf8'));
    expect(progress.verified).toContain(chunkId);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/cli-verify.test.ts`
Expected: FAIL — 新用例在 `runVerifyShow` 抛 `v1 突变探针仅支持 chem_field 的块`（旧守卫），且 `seenCrate` 断言/分组标题断言不满足。原 chem_field 用例仍通过。

- [ ] **Step 3: 改 `src/cli-verify.ts`**

(a) 顶部 import 追加：

```ts
import { groupTestsByModule } from './verify/testlist.js';
```

(b) 删除 `const CRATE = 'chem_field';` 这一行。

(c) 把 `findChunk` 改成（去掉 crate 守卫）：

```ts
function findChunk(g: GradedTree, chunkId: string): Chunk {
  const c = g.chunks.find((x) => x.id === chunkId);
  if (!c) throw new Error(`未知 chunk: ${chunkId}`);
  return c;
}
```

(d) `runVerifyShow`：在 `const chunk = findChunk(...)` 之后加 `const crate = chunk.crate;`。把 baseline 相关三处改掉——先加警告、用 `crate` 跑、测试段用分组渲染。即把现有：

```ts
  const baseline = await runCargoTests(o.repo, CRATE, o.exec);
```
改为：
```ts
  console.error(`⏳ 首次编译 ${crate} 可能要几分钟（bevy/egui 链接很重），属正常、不是卡住。`);
  const baseline = await runCargoTests(o.repo, crate, o.exec);
```

并把 `lines` 数组里这两行：
```ts
    `## ${CRATE} 的测试（${all.length}）`,
    ...all.map((n) => `- \`${n}\``),
```
替换为：
```ts
    `## \`${crate}\` 的测试（${all.length}）`,
    ...groupTestsByModule(all).flatMap((grp) => [
      `### ${grp.module}`,
      ...grp.tests.map((n) => `- \`${n}\``),
    ]),
```

(e) `runVerifyPredict`：在 `const chunk = findChunk(...)` 之后加 `const crate = chunk.crate;`，并把 probe 里的：
```ts
    runAfter: () => runCargoTests(o.repo, CRATE, o.exec),
```
改为：
```ts
    runAfter: () => runCargoTests(o.repo, crate, o.exec),
```

（`runVerifyPredict` 的其余渲染不引用 CRATE，无需再改。确认全文件已无 `CRATE` 残留。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/cli-verify.test.ts`
Expected: PASS（原 chem_field 用例 + 新 grid_workshop 用例）。原用例的 `toContain('core::field::t1')` 仍成立（全名保留）。

- [ ] **Step 5: 全量测试 + typecheck**

Run: `npx vitest run` — 全绿。
Run: `npm run typecheck` — 干净。

- [ ] **Step 6: 提交**

```bash
git add src/cli-verify.ts test/cli-verify.test.ts
git commit -m "feat(verify): 支持任意 crate（crate 从块推导）+ 测试名按模块分组 + 冷编译警告"
```

---

## Task 3（可选，手动）：真实 grid_workshop cargo 冒烟

**Files:** 无代码改动——人工验证，需真实 cargo 且愿意等冷编译（可能数分钟）。

- [ ] **Step 1: 确认 map 产物存在**

Run: `npm run map -- --repo D:/dev/umwelt-bevy --out .`（若已跑过可跳过）。

- [ ] **Step 2: 选一个 grid_workshop 被测试覆盖的块跑 show**

挑一个 `crates/grid_workshop/src/...` 下有函数、且被 `#[test]` 覆盖的块（如 `build_ui/routing_fsm.rs`）：

Run: `npm run verify -- crates/grid_workshop/src/build_ui/routing_fsm.rs --repo D:/dev/umwelt-bevy --out .`
Expected: 先打出 `⏳ 首次编译 grid_workshop 可能要几分钟…` 警告；冷编译后写出 `easyreview.verify.md`，测试段按 `### <module>` 分组、约 201 个测试名。若卡在编译，耐心等——不是死。若该机器缺 bevy 链接所需系统库导致编译失败，记录到交接（不阻塞 Task 1/2）。

- [ ] **Step 3: 预测并揭晓**

Run: `npm run verify -- crates/grid_workshop/src/build_ui/routing_fsm.rs --predict <逗号分隔测试名> --repo D:/dev/umwelt-bevy --out .`
Expected: 第二次 cargo 增量编译较快；算出真实爆炸半径、判定、通过则标 verified（原文件字节级还原——`git status` 应显示 umwelt-bevy 干净）。

---

## 收尾

- [ ] 全量 `npx vitest run` 全绿、`npm run typecheck` 干净。
- [ ] 更新 `docs/HANDOFF.md`：把"下一步 2（verify 扩 grid_workshop）"标记完成；`verify` 用法说明改为"任意 crate（crate 从块推导）"，并注明测试名分组 + 首次冷编译警告。单独提交。
