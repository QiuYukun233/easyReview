# viewer v2:源码显示 + 文件树视图(设计)

日期:2026-07-09
状态:已与用户逐节确认
背景:2026-07-08 设计转向(见 `2026-07-05-easyreview-design.md` 的铁律修订路线),拆为子项目 A→B→C。本篇是 **A**。核心诉求:①看不到源码十分不便;②网格切割后看不到原目录结构。

## 范围

做:Tab 双视图(网格|文件树)、源码抽屉(只读 + 轻量高亮 + 函数跳行)、网格折叠、`GET /api/source`。
不做(留给子项目 B/C):AI 解读内容、编辑器唤起、verify 入口改动。

## §1 页面结构:Tab 双视图

顶栏加「网格 | 文件树」两个 Tab(进度条、主题切换保留)。

- **网格视图**:现有风险×贡献网格 + 两处折叠——每一风险行行头可点击折叠整行;抽屉打开时「收起网格」按钮把左侧全收掉、源码占满全宽(再点恢复)。
- **文件树视图**:前端从 `state.chunks[].file` 拼目录树(不改后端;树只含被 map 进学习范围的文件)。文件行 = 风险色点 + 文件名 + ✓(已理解)/✓✓(已验证);目录行 = `(已理解数/总数)`,可折叠。
- 两个视图点文件/卡片行为一致:打开同一个源码抽屉。
- 持久化:当前 Tab、行折叠、目录折叠状态均存 `localStorage`。
- 右侧固定「下一步」卡在两个视图下都保留。

## §2 源码抽屉

点卡片(网格)或文件行(树)→ 抽屉从右滑出,占 55% 宽(上限约 900px)。

- **头部**:文件路径 + 风险/贡献徽章 + 职责一行(labels 的 responsibility,有则显示)+「标记已理解」按钮(复用 `POST /api/done`,成功后头部与背后视图即时更新)。
- **函数列表条**:头部下方横排 chunk 函数名(`state.chunks[].functions`,扩为含 `startLine`,见 §3),点击滚动到对应行并短暂高亮该行;函数多时可展开/收起。
- **源码区**:等宽 + 行号,只读。轻量自研高亮:按语言(扩展名 → Rust/Ruby)正则 tokenizer 着四类色——关键字/字符串/注释/数字;**先转义 HTML 再包 span**(与 `esc()` 同一条纪律);高亮失败降级为纯文本,绝不因高亮挂掉抽屉。
- **交互**:Esc 或点抽屉外关闭;「收起网格」钮在抽屉左缘;暗色主题跟随现有主题变量。
- 源码经 `GET /api/source?chunk=<id>` 按需拉取,打开时轻量 loading。

## §3 后端:`GET /api/source` + state 小改

新增只读端点;另有一处 state 扩展(自查发现):`ViewerState.chunks[].functions` 现为 `string[]`(只有名字),函数跳行需要行号——扩为 `{ name: string; startLine: number }[]`(数据源 `Leaf.startLine` 已有,`buildViewerState` 一行改动;前端函数列表渲染同步适配)。其余后端不动。

- `GET /api/source?chunk=<id>` → `{ ok: true, file, lang: 'rust'|'ruby'|null, source }`;按 `tree.repo + '/' + chunk.file` 实时读磁盘(UTF-8)。
- 纯函数 `readSource(tree, chunkId)` 放 `src/serve/source.ts`,形状同 `applyDone`(`{status, body}`),`server.ts` 只做路由接线。
- 错误:未知 chunk → 400;repo/文件不存在 → 404,报错含人话("仓库路径 `<repo>` 下找不到 `<file>`——repo 挪位置了?用 --repo 重新 map 或把仓库放回原处");读取异常 → 500(现有 handler catch)。
- 安全:chunk id 必须先在 `tree.chunks` 命中才读盘——白名单,杜绝 `?chunk=../../etc/passwd` 路径穿越。
- 大文件不截断;`lang` 由 `langOf(file)` 给,null 则不高亮。

## §4 测试与验收

- `readSource` 单测(`test/serve-source.test.ts`):正常读取带对 lang;未知 chunk → 400;文件被删 → 404 且报错含 repo 路径;`../` 类 id 走不到读盘(400)。
- HTTP 集成(扩展 serve-http 测试):`GET /api/source?chunk=<真实id>` 200 + JSON 形状;无参 → 400。
- 页面测试(serve-page 补断言):渲染产物含 Tab 结构、抽屉容器、高亮函数;高亮单测——Ruby/Rust 源码断言关键字/字符串/注释包 span、HTML 已转义(`<script>` 必须变实体)。
- 验收:umwelt-bevy(Rust)与 chatwoot(Ruby)各起一次 serve,过完整动线:切 Tab → 树上点文件 → 抽屉滑出带高亮 → 点函数跳行 → 收起网格全宽 → 标记已理解 → 树上 ✓ 点亮;暗色主题同样过一遍。

## 已定决策记录

- 源码位置:右滑抽屉(否决三栏 IDE 式、卡片原地展开)。
- 树与网格:顶部 Tab 平级视图(否决常驻侧栏、树抽屉)。
- 网格折叠:两种都要(行折叠 + 抽屉时全收)。
- 高亮:轻量自研(否决不高亮、vendor highlight.js——页面自包含、无 CDN)。
- 源码送达:按需 API 实时读盘(否决全量内嵌——几十 MB 爆炸;预生成快照——会过期且与"真实源码"诉求相悖)。
