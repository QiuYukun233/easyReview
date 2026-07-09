# AI 解读层(设计)

日期:2026-07-09
状态:已与用户逐节确认
背景:设计转向子项目 **B**(A=viewer v2 已合并 PR #7,C=verify 沙箱化在后)。核心诉求:比标签深一层的代码解读(函数职责/数据流/调用关系),默认开、可关,长在源码抽屉里。铁律修订(允许解读)随本篇写进总设计 `2026-07-05-easyreview-design.md`。

## 范围

做:`easyreview.interpret.json` 缓存、`src/interpret/` 生成端、`GET /api/interpret`、抽屉解读面板 + 顶栏开关、总设计铁律修订。
不做(留给 C 及以后):verify 改动、批量预热命令、跨文件邻居源码喂料、函数级缓存粒度。

## §1 数据与缓存

新产物 `easyreview.interpret.json`(outDir 下,与 labels/progress 并列),结构仿 `LabelCache`:

```
{ version: 1, entries: { <chunkId>: {
    overview: string,        // 职责展开(比 responsibility 深,3-5 句)
    dataFlow: string,        // 数据怎么进、怎么变、怎么出
    calls: string,           // 调用关系:文件内可见的 + 事实里给的(邻居/耦合),跨文件不臆测
    functions: { name: string, gist: string }[],  // 逐函数一句话,按 startLine 排序
    contentHash: string
} } }
```

缓存键 `contentHash` = sha256(整文件源码(实时读盘)+ 两轴桶位 + 同章邻居名 + signals 四项数值(relChurn/coupling/ownership/centrality)+ 函数名单 + `PROMPT_VERSION` 常量):

- 源码与 `/api/source` 同一份实时读盘——文件一改,下次打开抽屉自动失效重生成,增量天然成立;
- 失效粒度 = 整块:改一个函数重生成整篇,不做函数级 diff(喂料是整文件,篇内互相引用,拆开缓存会出现函数解读与块综述版本错位);
- `PROMPT_VERSION` 进 hash:改 prompt 后老缓存全部自然失效;
- 缓存文件解析失败 → 忽略重建,同 `loadLabelCache` 容错纪律。

## §2 生成端:`src/interpret/`

三个文件,纪律照抄 `src/label/`:

- **`input.ts`** — 纯函数 `collectInterpretInput(tree, chunk, source)`:整文件源码 + 确定性事实(两轴桶、章名、同章邻居、signals 四项数值转成档位人话——如「共变耦合:高(0.8)」、函数名单带行号)拼成 `InterpretInput` 并算 contentHash。事实全部来自 `easyreview.tree.json` 已有字段,不新增分析——注意 tree 里**没有** coupling 伙伴名单(map 时只落数值),所以跨文件关系的事实上限就是「邻居名单 + 档位」。
- **`prompt.ts`** — zod `InterpretSchema`(overview/dataFlow/calls/functions)+ system prompt。铁律进 prompt:只描述整文件内可见结构(use/mod/调用点)+ 事实清单里给的关系;跨文件关系只能转述事实(同章邻居名单、共变耦合/中心度档位),不得点名事实与源码中未出现的文件,严禁臆测;函数 gist 每条一句话。DeepSeek json 输出指令同 label 做法追加。
- **`deepseek.ts`** — `Interpreter` 接口(`interpret(input) → ChunkInterpretation | null`)+ 复用 `ChatCompletionsClient`(fake 可注入)+ `makeInterpreterFromEnv()`(无 `DEEPSEEK_API_KEY` → null;模型默认 `DEEPSEEK_MODEL` ?? `deepseek-v4-flash`)。单块生成,无并发池;任何错误返回 null 不抛,由 API 层降级。

`max_tokens` 4096;源码超 80000 字符截前 80000 并在 prompt 注明「文件被截断」(纯兜底,目标仓库无此规模文件)。

## §3 API:`GET /api/interpret?chunk=<id>`

`src/serve/interpret.ts` 出结果函数,`server.ts` 只接线,形状同 `readSource`/`applyDone`(`{status, body}`):

1. **校验**:chunk 命中 `tree.chunks` 白名单否则 400(防穿越);文件不存在 404(同 `/api/source` 人话报错)。
2. **查缓存**:实时读盘源码 → 算 hash → 查 interpret.json。命中且一致 → `200 { ok: true, interpretation, cached: true }`,零 LLM 调用。
3. **未命中现生成**:无 key → `503 { ok: false, error: '未配置 DEEPSEEK_API_KEY——解读不可用' }`;有 key → 同步调 DeepSeek(前端面板 loading,单块约 5~20 秒),成功落盘 → `200 { …, cached: false }`;LLM 失败 → `502`(前端给重试)。
4. **在途去重**:模块内 `Map<chunkId, Promise>`,同块并发请求共享同一在途生成,完成即清。

开关关掉时前端不发请求,服务端无感。写缓存 = 读-改-写整文件,同 progress 纪律。

## §4 前端:顶栏开关 + 抽屉解读面板

- **开关**:顶栏「解读」切换(样式同主题切换),默认开,`localStorage('easyreview-interpret')`。关 = 不渲染面板、不发请求;抽屉开着时切回 → 立即补拉。
- **面板**(Jupyter cell 风格):函数条与源码区之间,浅底色左边框可折叠区。头部「▾ AI 解读」折叠/展开,折叠态全局记 `localStorage('easyreview-interpret-collapsed')`。内容:职责/数据流/调用关系三小节 + 函数逐条(函数名可点,复用 `jumpTo` 跳行 + gist 一句话)。
- **加载**:`/api/source` 与 `/api/interpret` 并行,互不阻塞;在途显示「解读生成中…(首次约十几秒)」;竞态守卫 `if (drawerId !== id) return` 同款;503 → 灰字提示,502 → 错误行 + 重试;内存 `interpCache` 按 chunkId 记住已到解读,重开不闪 loading。
- **纪律**:解读文本全部过 `esc()`(服务端返回纯文本,不含 HTML);page.ts 继续无反引号、无 `${`。

## §5 铁律修订(打进总设计)

总设计头部加「修订 2026-07-09」记录,正文两处补丁:

1. §2 铁律句:LLM 可贴标签、也可生成解读层,前提四条——喂料=确定性事实+真实源码只描述给定内容;默认开一键可关;解读永不参与「已理解/已验证」判定(仍只认 ground truth);结构性判断 100% 确定性不动。
2. §13 非目标第 2 条收窄:不做的是「无接地的叙述式全仓摘要」;接地、按需的块级解读是做的(指向本 spec)。

修订理由:2026-07-08 实际使用反馈——看不到解释比"解释可能退化"更拖速度;退化风险用接地喂料+可关+不参与判定三条围栏对冲。

## §6 测试与验收

单测全走 fake,永不碰真 key(真 key 只进验收时的进程环境变量,不落任何文件):

- `test/interpret-input.test.ts`:事实拼装正确;contentHash 稳定——同输入同 hash;改源码一字符/改桶位/改 PROMPT_VERSION 各自翻 hash。
- `test/interpret-deepseek.test.ts`:好 JSON → 四字段齐;坏 JSON/空内容/抛错 → null 不炸;超长截断后 prompt 含「文件被截断」。
- `test/serve-interpret.test.ts`:400 批(缺参/未知块/`../../etc/passwd`);404 文件没了;缓存命中 fake 调用计数 0;miss → 落盘、二次 `cached: true`;无 interpreter → 503;失败 → 502;慢 fake 并发两请求只生成一次。
- serve-http 集成 +1(`createViewerServer` 加可选注入 interpreter);serve-page 补断言(开关、面板容器、`/api/interpret`、两个新 localStorage 键)。

验收(chatwoot + umwelt-bevy,浏览器动线用户过):首开生成十几秒 → 四段齐、函数跳行;重开秒出;改文件再开自动重生成;关开关 Network 零请求;无 key 起 serve 灰字降级;暗色主题正常。

## 已定决策记录

- 粒度:块级一篇 + 函数逐条(否决只做块级、只做函数)。
- 时机:抽屉打开按需生成(否决 map 全量预生成、按需+预热命令——预热留以后)。
- 开关:viewer 顶栏全局开关(否决 serve flag、双开关)。
- 喂料:整文件 + 确定性事实全家桶(否决函数切片、邻居文件摘要——token 与缓存键代价)。
- 形态:源码上方可折叠解读面板,Jupyter cell 风格(否决行间幽灵注释、抽屉内双栏;mockup 见 `.superpowers/brainstorm/370-1783579666/content/interpretation-layout.html`)。
- 接线:serve 进程内生成 + 新端点(否决 CLI 生成 serve 只读——减速带;前端直连——key 暴露)。
