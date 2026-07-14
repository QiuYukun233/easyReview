# 中心度泛用名截断 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 中心度加泛用名硬截断——df > max(⌈5%×N⌉, 20) 的叶子名视为词汇噪音,贡献归零,止住撞关键字/大众词的灾难级虚高。

**Architecture:** 只动 `src/grade/centrality.ts` 一个文件:先按唯一名字建 df 表(词名查既有词频表、非词名在既有正则回退里顺手统计),主循环加一句超限跳过。函数签名、返回形状、归一化全部不变,调用方零感知。设计 spec:`docs/superpowers/specs/2026-07-14-centrality-generic-cutoff-design.md`(实测定稿数据在里面)。

**Tech Stack:** TypeScript (tsx 运行,无 build)、vitest。

**背景(给零上下文的实现者):**
- easyReview 把仓库文件当「块」打分;中心度 = 一个块的所有函数名(叶子名)在其它文件文本里作为完整词出现的次数加总,归一化 0..1。
- 灾难案例:chatwoot 有个 Vuex action 叫 `import`,匹配了全库每条 import 语句(9611 次),把所在文件顶到贡献度 #2。
- 修法:一个名字若出现在超过 `max(⌈5%×文件数⌉, 20)` 个文件里,它就是大众词(`import`/`get`/`new`),数它毫无意义 → 贡献归零。20 文件下限保护小仓库(68 文件的 umwelt 若按 5% 阈值=4,会误杀真领域函数)。
- 现有测试 `test/centrality.test.ts` 里有个 naiveReference 对拍契约(锁分词化重写与旧正则实现等价)——**原样保留,一个字不改**:它的夹具都 <20 文件,截断永不触发,契约继续成立。

---

### Task 1: 泛用名截断(TDD)

**Files:**
- Modify: `src/grade/centrality.ts`(全文件替换,见 Step 3)
- Test: `test/centrality.test.ts`(只追加,不动已有内容)

- [ ] **Step 1: 写失败测试**

在 `test/centrality.test.ts` 顶部,把既有 import 行:

```ts
import { nameFanInCentrality } from '../src/grade/centrality.js';
```

改为:

```ts
import { nameFanInCentrality, genericDfCutoff } from '../src/grade/centrality.js';
```

然后在文件**末尾**追加(已有内容一律不动):

```ts
// —— 以下为 2026-07-14 泛用名截断新增(spec:2026-07-14-centrality-generic-cutoff-design.md)——
// 注意:上面的 naiveReference 对拍夹具都 <20 文件,截断永不触发,契约原样成立。

describe('genericDfCutoff', () => {
  it('小仓库走 20 文件下限(umwelt N=68 时 5% 阈值=4 会误杀真领域名)', () => {
    expect(genericDfCutoff(68)).toBe(20);
  });

  it('N=400 恰为 5% 与下限的交界', () => {
    expect(genericDfCutoff(400)).toBe(20);
  });

  it('大仓库走 ceil(5%)(chatwoot N=2425 → 122)', () => {
    expect(genericDfCutoff(2425)).toBe(122);
  });
});

describe('nameFanInCentrality 泛用名截断', () => {
  it('df == cutoff 计入、df == cutoff+1 截断(下限档,22 个合成文件)', () => {
    const leaves = [leaf('a.js', 'cut21'), leaf('b.js', 'keep20')];
    const sources: Record<string, string> = { 'a.js': 'cut21();', 'b.js': 'keep20();' };
    // cut21 出现在 a.js + o1..o20 → df=21 > cutoff(20) → 截断
    // keep20 出现在 b.js + o1..o19 → df=20 == cutoff → 计入,他文件出现 19 次
    for (let i = 1; i <= 20; i++) sources[`o${i}.js`] = 'cut21();';
    for (let i = 1; i <= 19; i++) sources[`o${i}.js`] += ' keep20();';
    const cen = nameFanInCentrality(leaves, sources);
    expect(cen['b.js']).toBe(1); // keep20 的 19 次是全场唯一非零 → max → 1
    expect(cen['a.js'] ?? 0).toBe(0); // cut21 被截断 → raw 0
  });

  it('撞关键字的叶子名(import)不再霸榜——chatwoot 灾难合成用例', () => {
    const leaves = [leaf('actions.js', 'import'), leaf('api.js', 'fetchThing')];
    const sources: Record<string, string> = {
      'actions.js': 'export const doImport = () => {}; // import action',
      'api.js': 'export function fetchThing() {}',
    };
    // 每个消费者文件都有 import 语句;只有 c1..c5 真调 fetchThing
    for (let i = 1; i <= 21; i++) {
      sources[`c${i}.js`] = `import x from 'y';` + (i <= 5 ? ' fetchThing();' : '');
    }
    // 23 文件,cutoff=20;import df=22(actions.js 注释 + c1..c21)→ 截断;fetchThing df=6 → 计 5 次
    const cen = nameFanInCentrality(leaves, sources);
    expect(cen['api.js']).toBe(1);
    expect(cen['actions.js'] ?? 0).toBe(0);
  });

  it('非词名(valid?)走正则回退同样受截断', () => {
    const leaves = [leaf('m.rb', 'valid?'), leaf('n.rb', 'compute_thing')];
    const sources: Record<string, string> = { 'm.rb': 'def valid?; end', 'n.rb': 'def compute_thing; end' };
    for (let i = 1; i <= 20; i++) {
      sources[`r${i}.rb`] = 'valid? && go' + (i <= 3 ? '; compute_thing' : '');
    }
    // 22 文件,cutoff=20;valid? df=21 → 截断;compute_thing df=4 → 计 3 次
    const cen = nameFanInCentrality(leaves, sources);
    expect(cen['n.rb']).toBe(1);
    expect(cen['m.rb'] ?? 0).toBe(0);
  });

  it('同文件混合:超限名字归零、其余名字照常累计', () => {
    const leaves = [leaf('mix.js', 'ubiquitous'), leaf('mix.js', 'special'), leaf('z.js', 'anchor')];
    const sources: Record<string, string> = {
      'mix.js': 'ubiquitous(); special(); anchor();',
      'z.js': 'anchor(); special(); special();',
    };
    for (let i = 1; i <= 21; i++) sources[`u${i}.js`] = 'ubiquitous();';
    // 23 文件,cutoff=20;ubiquitous df=22 → 截断;special df=2 → mix 计 2;anchor df=2 → z 计 1
    const cen = nameFanInCentrality(leaves, sources);
    expect(cen['mix.js']).toBe(1); // 2/2;若 ubiquitous 未被截,raw=2+21=23
    expect(cen['z.js']).toBe(0.5); // 1/2;若 ubiquitous 未被截,z≈1/23≈0.043 —— 此断言使截断不可少
  });

  it('文件全部名字被截断且无其它信号 → 空表(沿用 max=0 行为)', () => {
    const leaves = [leaf('a.js', 'everywhere')];
    const sources: Record<string, string> = { 'a.js': 'everywhere();' };
    for (let i = 1; i <= 21; i++) sources[`e${i}.js`] = 'everywhere();';
    // 22 文件,cutoff=20;everywhere df=22 → 截断 → raw 全 0 → {}
    expect(nameFanInCentrality(leaves, sources)).toEqual({});
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/centrality.test.ts`
Expected: FAIL——`genericDfCutoff` 未导出(SyntaxError/undefined),新 describe 全红;既有 5 条(1 条旧行为 + 4 条对拍)仍绿。

- [ ] **Step 3: 实现**

`src/grade/centrality.ts` 全文件替换为:

```ts
import type { Leaf } from '../types.js';

/**
 * v1 近似中心度:chunk(文件)的所有函数名在其他文件源码中作为完整词出现的次数,
 * 归一化到 0..1。近似——同名/宏/方法分派会有噪音,将来由引用图/调用图替换。
 *
 * 2026-07-13 分词化:每文件单遍分词建词频表([A-Za-z0-9_]+,与 \b 词边界定义严格一致)。
 * 建表 O(总字符数);查表主循环仍是 O(名字×文件),但单次代价从「正则扫全文」降到 Map.get,
 * 实测 2800 文件×1.2 万名字约几秒。含非词字符的名字(ruby 的 valid?/save!,chatwoot 后端约 13%)
 * 走逐名字正则回退,将来可做词干+后缀专用分词。
 *
 * 2026-07-14 泛用名截断:df(名字出现过的文件数,含定义文件)超过 max(⌈5%×N⌉, 20) 的名字
 * 视为词汇噪音,贡献归零。撞语言关键字的叶子名(chatwoot 的 import action 匹配全库 import
 * 语句 9611 次)和大众词(get/new/default)由此消音;5% 阈值实测天然吸收语言关键字停用表
 * (开关结果一字不差),故不维护关键字清单;20 文件下限保护小仓库(umwelt N=68 时 5%=4
 * 会误杀 place_neuron 等真领域名)。实测定稿见 spec:2026-07-14-centrality-generic-cutoff-design.md。
 */
const WORD = /[A-Za-z0-9_]+/g;
const isWordName = (s: string) => /^[A-Za-z0-9_]+$/.test(s);

export const GENERIC_DF_RATIO = 0.05;
export const GENERIC_DF_FLOOR = 20;

export function genericDfCutoff(fileCount: number): number {
  return Math.max(Math.ceil(fileCount * GENERIC_DF_RATIO), GENERIC_DF_FLOOR);
}

export function nameFanInCentrality(
  leaves: Leaf[],
  sources: Record<string, string>,
): Record<string, number> {
  const filesByLeafFile = new Map<string, Set<string>>();
  for (const l of leaves) {
    if (!filesByLeafFile.has(l.file)) filesByLeafFile.set(l.file, new Set());
    filesByLeafFile.get(l.file)!.add(l.name);
  }

  const tokenCounts = new Map<string, Map<string, number>>();
  for (const [file, src] of Object.entries(sources)) {
    const counts = new Map<string, number>();
    for (const m of src.matchAll(WORD)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
    tokenCounts.set(file, counts);
  }

  // 逐唯一名字统计 df;非词名在同一趟正则扫描里顺手记逐文件出现次数
  // (旧实现按 (文件,名字) 对全库扫,同名多处定义会重复扫——此处按唯一名字扫一趟,行为不变)。
  const allNames = new Set<string>();
  for (const names of filesByLeafFile.values()) for (const n of names) allNames.add(n);

  const df = new Map<string, number>();
  const nonWordOcc = new Map<string, Map<string, number>>();
  for (const name of allNames) {
    if (isWordName(name)) {
      let d = 0;
      for (const counts of tokenCounts.values()) if (counts.has(name)) d++;
      df.set(name, d);
    } else {
      const re = new RegExp(`\\b${escapeRe(name)}\\b`, 'g');
      const occ = new Map<string, number>();
      let d = 0;
      for (const [file, src] of Object.entries(sources)) {
        const c = (src.match(re) ?? []).length;
        if (c > 0) { occ.set(file, c); d++; }
      }
      df.set(name, d);
      nonWordOcc.set(name, occ);
    }
  }

  const cutoff = genericDfCutoff(Object.keys(sources).length);

  const raw: Record<string, number> = {};
  for (const [file, names] of filesByLeafFile) {
    let count = 0;
    for (const name of names) {
      if (df.get(name)! > cutoff) continue; // 泛用名:词汇噪音,不计入扇入
      if (isWordName(name)) {
        for (const [otherFile, counts] of tokenCounts) {
          if (otherFile === file) continue;
          count += counts.get(name) ?? 0;
        }
      } else {
        for (const [otherFile, c] of nonWordOcc.get(name)!) {
          if (otherFile === file) continue;
          count += c;
        }
      }
    }
    raw[file] = count;
  }
  const max = Math.max(0, ...Object.values(raw));
  if (max === 0) return {};
  const out: Record<string, number> = {};
  for (const [f, n] of Object.entries(raw)) out[f] = n / max;
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

逐字照抄,不增不减。

- [ ] **Step 4: 跑测试确认全绿**

Run: `npx vitest run test/centrality.test.ts`
Expected: PASS,13 条(既有 5 + 新增 8:cutoff 3 条 + 行为 5 条)。

- [ ] **Step 5: 全量测试 + 类型检查**

Run: `npm test`
Expected: 全绿(62 文件 / 280 测试;此前 272 + 新增 8)。

Run: `npm run typecheck`
Expected: 零错误。

- [ ] **Step 6: 提交**

```bash
git add src/grade/centrality.ts test/centrality.test.ts
git commit -m "feat: 中心度泛用名截断——df 超 max(5%N, 20 文件) 的名字贡献归零"
```

---

## 真仓验收(主会话做,不属于实现任务)

1. chatwoot 重跑:`npm run map -- --repo E:/learning/agent-research/repos/chatwoot --include app --out E:/dev/easyReview/out/chatwoot`(带 DEEPSEEK_API_KEY,换桶块会自动重打标签)
   - actions.js 与 tiktok/message_service 跌出贡献度前 100;conversations_controller 保持前 10;耗时仍秒级。
2. umwelt 重跑:`npm run map -- --repo D:/dev/umwelt-bevy --out E:/dev/easyReview`
   - top-10 基本保序(grid.rs 仍 #1);被截名字 ≈ 8 个。
3. 两真仓 `git status` 干净(零接触)。
4. HANDOFF、记忆更新;「中心度 v2:引用图+PageRank,verify 突变探针抽查验收」记入候选方向。
