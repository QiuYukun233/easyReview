# 设计：web viewer（会点亮的地图 + 进度条）

> 日期：2026-07-07 · 主题：给 easyReview 加一个本地 web viewer——风险×贡献度网格会随学习进度点亮，右侧固定"下一步"卡片，页面上可直接"标记已理解"。当前这些只有 Markdown 形态（map.md / journey.md）。

## 定位与铁律

- **本地服务器 + 轻交互**：`npm run serve -- --out . [--port 4870]` 起一个 `node:http` 服务；页面能"看"（地图/进度/卡片）+ 一个写操作（标记已理解）。verify 仍走 CLI（长任务不进 v1）。
- **铁律不动**：viewer 只消费 outDir 里 CLI 生成的 JSON（tree/labels/progress），不算任何信号、不发明结构。数据由 map/learn 生成；viewer 是消费端。
- **单一状态源**：页面"标记已理解"与 CLI `done` 写**同一份 progress.json、走同一个 progress 模块**——不存在两套状态。
- **零新依赖、零构建**：`node:http` 内置；前端是内嵌 CSS/JS 的单文件原生页。

## 布局（已定稿：A 地图为主 + B 的固定"下一步"卡片）

```
┌──────────────────────────────────────────────────┐
│ easyReview · 进度 ████████░░░ 24/68 · 已验证 3      │  顶栏进度条
├───────────────────────────────┬──────────────────┤
│  风险×贡献度网格（主角）         │  卡片面板（固定）   │
│  行=risk high→none            │  默认显示"下一步"   │
│  列=contrib filler→high       │  名字/章/桶        │
│  块=小方块：                   │  职责/whyNow       │
│   灰=未学 绿=已理解             │  函数/邻居         │
│   绿+边框=已验证 黄=下一步       │  自测三问          │
│  hover=名字 tooltip           │  [✓ 标记已理解]    │
│  click=右侧切该块卡片           │  [← 回到下一步]    │
└───────────────────────────────┴──────────────────┘
```

## 文件结构

| 路径 | 职责 | 动作 |
|---|---|---|
| `src/serve/state.ts` | `buildViewerState(tree, labels, progress): ViewerState` 纯函数（分桶网格、卡片数据、path 顺序、nextId） | Create |
| `src/serve/done.ts` | 校验 chunkId 存在 → 复用 `progress/progress.ts` 写 understood | Create |
| `src/serve/page.ts` | 返回内嵌 CSS/JS 的 index.html 字符串 | Create |
| `src/serve/server.ts` | 创建 http server：路由分发；outDir 注入（可测） | Create |
| `src/cli-serve.ts` | `runServe({outDir, port})`：读文件 + 组装 + 监听 + 打印 URL | Create |
| `src/cli.ts` | 加 `serve` 命令分发（照 learn/verify 的动态 import 模式） | Modify |

文件读取只在组装层（cli-serve/server 每请求现读）；`state.ts`/`done.ts` 核心逻辑纯函数，单测不碰磁盘。

## API 契约

**`GET /`** → `text/html`，index.html。

**`GET /api/state`** → `application/json`（每次现读磁盘，不缓存——另一终端重跑 map 后 F5 即最新）：

```ts
interface ViewerState {
  generatedAt: string;              // 响应时刻 ISO
  progress: { understood: number; verified: number; total: number };
  grid: {
    riskBuckets: RiskBucket[];      // ['high','med','low','none'] 行序
    contribBuckets: ContribBucket[]; // ['filler','low','med','high'] 列序
    cells: Record<string, NodeId[]>; // key = `${risk}:${contrib}`
  };
  chunks: Record<NodeId, {
    name: string; file: string; crate: string; chapterName: string;
    riskBucket: RiskBucket; contribBucket: ContribBucket;
    understood: boolean; verified: boolean;
    responsibility: string | null;  // labels.json；无标签为 null
    whyNow: string;                 // LLM 的，或静态回退文案（复用 journey-md 的回退逻辑）
    functions: string[];            // 叶子函数名
    neighbors: NodeId[];            // 同章觅食邻居
  }>;
  path: NodeId[];                   // path/sequence 的完整学习顺序
  nextId: NodeId | null;            // path 中第一个未理解的块；全学完为 null
}
```

数据来源：`easyreview.tree.json`（结构+grades）、`easyreview.labels.json`（可缺）、`easyreview.progress.json`（可缺）、`path/sequence.ts`（与 journey.md 同一排序算法）。

**`POST /api/done`**，body `{"chunkId": "..."}`：
- 成功 → 200 `{ok:true}`，写 progress.json（复用现有 progress 模块读改写）
- chunkId 不在 tree → 400 `{ok:false, error:"未知块 …"}`
- body 非法 JSON / 缺字段 → 400
- 写盘失败 → 500 `{ok:false, error}`

## 前端交互

- 载入 → fetch `/api/state` → 渲染网格 + 右侧"下一步"卡片。
- 点块 = 本地切卡片（无请求）；卡片顶部出现"← 回到下一步"。
- 块方块**统一色、只按状态**着色（灰/绿/绿框=verified/黄=下一步），不按章分色；方块内无字，hover tooltip（名字+章），click 高亮描边。
- "标记已理解"按钮**每张卡都有**（地图允许跳着学，对齐 CLI `done <任意id>`）；已理解的块显示"已理解 ✓"禁用态。
- done 成功 → 重新 fetch state 整页重渲染；若标记的是"下一步"，面板自动跳到新的下一步；若跳着标，停留在该块。
- 卡片里邻居名可点 → 切到那块卡片（觅食动线）。
- 空态：无标签 → 职责行不显示、whyNow 静态回退；全学完 → "下一步"卡变完成祝贺 + 指引 verify。

**不做（YAGNI）**：暗色主题切换（跟系统 `prefers-color-scheme`）、动画、移动端、多仓库切换、SSE 实时推送、页面触发 verify。

## 错误处理

- `tree.json` 缺失/损坏 → **启动即报错退出**，提示"先跑 npm run map"。
- `labels.json` / `progress.json` 缺失 → 按空处理照常起；损坏 → console.warn + 按空处理（同 loadLabelCache 策略）。
- 端口被占 → 明确报错，提示换 `--port`。
- 前端 fetch 失败 → 页面顶部红条"服务器没响应"。
- 并发写（CLI done 与页面 done 同时）：单人本地工具、窗口极小，复用现有读改写、不加锁（与现状一致）。

## 测试（TDD）

- `test/viewer-state.test.ts` — `buildViewerState` 纯函数：网格分桶、understood/verified 标记、nextId=path 首个未理解、labels 缺失→null+回退文案、全完成→nextId null。
- `test/serve-done.test.ts` — done 逻辑：合法 id 写入（注入临时目录）、未知 id 400、坏 body 400。
- `test/serve-http.test.ts` — 真 server 随机端口 + 临时 outDir：GET / 返 HTML、GET /api/state 返合法 JSON、POST done 全链路、tree 缺失启动抛错。
- 页面 JS 不做单测（原生 DOM 无测试基建、性价比低）→ 用真实 umwelt-bevy 数据 observe 冒烟：起 serve，浏览器过一遍"点块 → 标记 → 回下一步"动线。

## 产物/依赖

- 无新依赖、无新 gitignore（progress.json 等已忽略）。
- `package.json` 加 `"serve": "tsx src/cli.ts serve"` script。
