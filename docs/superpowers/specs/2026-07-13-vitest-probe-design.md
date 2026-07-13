# vitest 突变探针 · 设计(2026-07-13)

> 路线图外新立项(Vue/JS 提取 PR #11 合并后的自然延伸)。前置:VerifyRunner 接口(PR #10)、
> js/vue 注册项与 carve(PR #11)、verify 沙箱化(PR #9)。
> 状态:设计已经用户确认(2026-07-13,澄清:Docker 环境/真仓验收/js+vue 全支持;方案 1)。

## 1. 目标与边界

verify(突变探针)支持 **js/vue 块**:`runnerFor` 对 js/vue 分发到新的 vitest runner。
无 `easyreview.runner.json` js 节 → 可操作报错(指 `docs/recipes/chatwoot-vitest.md`);
圈不到 spec 域 → "换个有测试覆盖的块"。真仓验收 = chatwoot 前端端到端。

**不做**:TypeScript;覆盖率法圈定;通用仓形态穷举(配方即活文档)。

**事实基础(2026-07-13 勘察 chatwoot)**:vitest 3.0.5 + jsdom + @vue/test-utils;
node 24.x(.nvmrc 24.13.0)/ pnpm 10.2.0(packageManager)/ husky ^7;
371 个 spec 文件在 `specs/`(164 直接子目录 + 173 祖先层深嵌套)与 `spec/`(34)目录;
.vue 组件大多无行为 spec,.js(helper/store/api)是 spec 密集区。

## 2. 环境形态(chatwoot 配方扩展)

给既有 `docker-compose.easyreview.yaml`(项目名已钉 `chatwoot-easyreview`)加 `vitest` 服务:

```yaml
  vitest:
    image: node:24
    working_dir: /app
    volumes:
      - .:/app
      - frontend_modules:/app/node_modules
      - pnpm_store:/root/.local/share/pnpm/store
    environment:
      TZ: UTC
      HUSKY: 0
```

(volumes 顶层加 `frontend_modules:` 与 `pnpm_store:`。)

- **node_modules 放命名卷**——与 rspec 的 bundle 卷同一心智:一次安装
  (仓根 `docker compose -f docker-compose.easyreview.yaml run --rm -T vitest sh -c "corepack enable && pnpm install"`),
  verify 从沙箱跑时靠钉死的项目名复用同一卷;沙箱同步永远看不见它。
- **`HUSKY: 0`**:绕开挂载目录无 `.git` 时 prepare 脚本(`husky install`)炸 pnpm install 的雷(husky ^7 支持)。
- **`TZ: UTC`**:chatwoot 的 test script 前缀要求。

`easyreview.runner.json` 加 `js` 节(与 ruby 节并列):

```json
"js": {
  "cmd": ["docker", "compose", "-f", "docker-compose.easyreview.yaml", "run", "--rm", "-T", "vitest", "node", "node_modules/vitest/vitest.mjs", "run", "--reporter=json", "{specFiles}"],
  "scanLimit": 20
}
```

`node node_modules/vitest/vitest.mjs` 而非 `npx`——easyreview 用 execFile 不经 shell,cmd[0] 必须真实可执行文件。

## 3. vitest runner(src/verify/vitest.ts)

- `VerifyRunner.id` 联合加宽为 `'rust' | 'ruby' | 'js'`——**一个 vitest runner 同时服务 js 和 vue 块**。
- `loadJsRunnerConfig(repo)`:与 `loadRubyRunnerConfig` 同构(同一 runner.json 的 `js` 节;
  缺文件/坏 JSON/缺 js.cmd → 可操作错误,指 `docs/recipes/chatwoot-vitest.md`)。
- `makeVitestRunner(config)`:
  - `pickScope` → `pickVitestScope(repo, chunk.file, scanLimit ?? 20)`,null → 抛
    `找不到可用的 spec 域(镜像 spec 不存在,或引用过广且无镜像)——换个有测试覆盖的块`;
  - `run` → `expandCmd`(从 rspec.ts 导出共享)展开 `{specFiles}`,exec cwd=沙箱 src,输出交 `parseVitestJson`;
  - `group` → 复用 `groupBySpecDir`(rspec.ts 导出)。
- 预测粒度 = **spec 文件相对路径**(与 rspec 一致)。

## 4. spec 圈定(src/verify/vitest-scope.ts)——方案 1:basename 索引

一次 walk 仓内 `*.spec.js` / `*.test.js`(排除 node_modules/.git),建 spec 文件索引(仓相对、forward-slash)。

- **镜像 = basename 匹配**:源 basename(去扩展名)+ `.spec.js` / `.test.js` 在索引中的命中
  (`URLHelper.js` → `URLHelper.spec.js`;`AccordionItem.vue` → `AccordionItem.spec.js`)。
  多候选(chatwoot 各 Vuex 模块都有 `actions.spec.js`)→ 取与源文件**目录公共前缀最长**者,
  平手取字典序第一(确定性)。
- **引用扫描**:按词边界 grep 源 basename(去扩展名)于全部 spec 文件内容(JS 的 import 语句天然含它),
  命中并入;命中数超 `scanLimit` → 回退只跑镜像 + 显式 note(不静默截断)。
- 镜像与扫描皆空 → null(runner 抛可操作拒绝);超上限且无镜像 → null。

与 rspec-scope 完全同构,差异仅在"镜像靠索引而非路径数学"(chatwoot 前端 specs/ 层级不定)。

## 5. 位点选择与突变(pick-site/mutate 回访)

- **JS tree-sitter 位点**:语句位的 `expression_statement`(子节点 ∈ `call_expression` /
  `assignment_expression` / `augmented_assignment_expression`),父节点 ∈ {`statement_block`, `program`},单行。
  精确节点名计划阶段对真实 wasm **实测定稿**(惯例)。
- **模板字符串不需要 heredoc 式特判**:它是表达式节点的一部分,多行模板串使语句节点跨行、
  被单行检查天然排除(计划阶段用测试钉死)。
- **Vue carve 感知**:vue 块位点选择按 carve 区段逐段 parse、行号加 offset——突变永远落在 script 区域内。
- **regex 回退**(`isCommentableJs`):非空、非 `//` 起始、以 `;` 结尾、整行不含反引号
  (regex 层无法判断模板串上下文,保守跳过);vue 回退只扫 carve 区段行号范围。
- **注释前缀**:js/vue → `// `(`buildOp` 按 langOf 分派)。`withMutation` 一字不动(字节级还原铁律)。
- **死码清理(PR #11 终审回访项)**:`chooseMutation`/`pickPreferredSite` 的"未知语言回退 RUST"
  改为显式按 id 分派(rust/ruby/js/vue),未知语言返回 null。

## 6. 判定语义

vitest **逐文件隔离**:突变致模块加载失败只红 import 它的 spec 文件——正常 newly-failing 语义,
**不需要 rspec 的 compileBroke 特殊化**。`compiled: false` 仅留给"JSON 解析不出 / testResults 空"
(= 套件没跑起来),报错指配方文档。judge.ts 零改动。

- verify.md:js/vue 用 `## 相关 spec 文件(n)` 与 spec 路径预测提示(同 ruby),fence 走 langOf。
- `runnerFor` else 文案更新:`暂只支持 Rust（cargo）、Ruby（rspec）与 JS/Vue（vitest）`。
- **`test/verify-unsupported.test.ts` 锁的旧边界(vue/js 一律拒)失效 → 改写为锁新边界**
  (无 js 配置时可操作报错 + 零 exec 调用 + 零沙箱副作用),先例同 rspec 轮改写 verify-ruby-reject。

## 7. 解析(src/verify/vitest-parse.ts)

`parseVitestJson(output): TestRun`:vitest `--reporter=json` 输出 jest 兼容 JSON
(`testResults[]` 每项 `name` = spec **绝对路径**、`status` = passed/failed),转仓相对路径、
聚合到文件级 `{name, passed}`(文件 passed ⟺ status === 'passed')。
输出可能混杂 docker/vitest 噪音甚至多行 JSON——解析策略(整段 parse → 自底向上行扫 → 含
`testResults` 键判别)计划阶段对真实 vitest 3 **实测定稿**(先在 easyReview 本仓实测格式,
验收时对 chatwoot 的 3.0.5 校准)。解析不出 / `testResults` 空 → `compiled: false`。
绝对→相对转换:去掉容器内 `/app/` 前缀(配方约定 working_dir=/app);去不掉时按
`app/javascript/` 锚点截取,再不行原样保留(确定性降级,不抛)。

## 8. 测试与真仓验收

**单测(全部 fake exec,绝不真调 docker/vitest):**
- config:js 节缺文件/坏 JSON/缺 cmd 三态错误、ruby 节不受影响;
- parseVitestJson:纯 JSON/带噪音/多行、通过与失败聚合、testResults 空 → compiled:false、/app/ 前缀剥离;
- vitest-scope:镜像 basename 命中、撞名最长公共前缀消歧+平手字典序、引用扫描并入、
  超 cap 回退镜像+note、双空 null、.vue 源镜像;
- pick-site:JS 三形态语句命中、多行模板串排除、非语句位不选、vue 区段 offset 还原;
- mutate:js `// ` 前缀、regex 回退反引号守卫、未知语言 null(死码清理);
- cli-verify:js happy path(show 基线→predict 命中)、vue 块走 vitest、无 js 配置可操作报错;
- verify-unsupported 改写(锁无配置边界)。

**真仓验收(chatwoot,Docker Desktop 需在跑):**
1. 配方落地:compose 加 vitest 服务,命名卷 pnpm install(首次 10-30 分钟);
2. `URLHelper.js`:show 圈定(镜像 `helper/specs/URLHelper.spec.js` + 引用扫描),基线绿;
   突变一行 → 镜像 spec 红;预测命中 → verified;
3. 第二发:找一个**有镜像 spec 的 .vue 块**端到端(位点落在 script 区域、行号正确);
4. chatwoot 真仓零接触(git 0 改动)、沙箱字节还原;
5. 踩到的雷回写 `docs/recipes/chatwoot-vitest.md`(活文档)。
