# chatwoot vitest 环境配方(easyreview verify 用)

verify JS/Vue 需要能跑 vitest 的环境。本配方给既有 `docker-compose.easyreview.yaml`（见 chatwoot-rspec.md，项目名已钉 `chatwoot-easyreview`）加一个 node 服务。chatwoot 前端：vitest 3.0.5 + jsdom；node 24.x（.nvmrc 24.13.0）/ pnpm 10.2.0（packageManager 字段）/ husky ^7。

**状态：2026-07-13 真仓验收通过（chatwoot：js 块 `URLHelper.js` 突变 L17 → 镜像 spec 红/hotkeys spec 绿、预测命中→verified；vue 块 `InboxFacebookForm.vue` 突变 `onMounted(preloadSdk);` → 祖先层镜像 spec 红、预测命中→verified；另有三个 .vue 块得到诚实的 uncovered/无位点判定。真实仓零接触、沙箱字节还原。下述模板即验收版本。**

## 一次性安装

1. chatwoot 仓根的 `docker-compose.easyreview.yaml` 加 `vitest` 服务与两个命名卷（模板见下）。
2. `easyreview.runner.json` 加 `js` 节（模板见下，与 `ruby` 节并列）。
3. 安装依赖（首次 10-30 分钟；装进命名卷，与沙箱/真仓路径无关）：

```powershell
cd <chatwoot 仓根>
docker compose -f docker-compose.easyreview.yaml run --rm -T vitest sh -c "corepack enable && pnpm install"
```

已知雷（chatwoot 前端规范 + 实现审查 + 2026-07-13 实测）：

- **`HUSKY: 0` 必须有**（已进模板）——挂载目录无 `.git`，prepare 脚本（`husky install`）会炸 pnpm install（husky ^7 支持该开关）。
- **node_modules 放命名卷 `frontend_modules`**——与 rspec 的 bundle 卷同一心智：一次安装，verify 从沙箱跑时靠钉死的项目名复用；沙箱同步永远看不见它；宿主机（Windows）不装前端依赖。
- **`TZ: UTC`**（已进模板）——chatwoot 的 test script 前缀要求，时区敏感 spec 会红。
- `cmd` 用 `node node_modules/vitest/vitest.mjs` 而非 `npx`——easyreview 用 execFile 不经 shell，cmd[0] 必须真实可执行文件。
- pnpm 版本由 `packageManager` 字段钉死，`corepack enable` 后自动匹配。
- **`--outputFile=/dev/stdout` 必须有**（已进模板，验收实踩）——chatwoot 的 vitest.config 配了 `outputFile`（sonar 报告），不覆写的话 `--reporter=json` 的 JSON 会写进文件而非 stdout。覆写后 vitest 会在**同一行** JSON 后粘一句 `JSON report written to /dev/stdout.`——easyreview 的解析已做平衡截断容忍。
- pnpm 10 默认拦下 core-js/esbuild/vue-demi 的构建脚本（安装时会提示 `Ignored build scripts`）——实测不影响跑测试（esbuild 走平台包、vue-demi 默认 Vue3），无需 `pnpm approve-builds`。
- 安装在仓根跑时（有 `.git`）husky prepare 会真装 hooks，无害；`HUSKY: 0` 是给沙箱/无 .git 场景兜底的。

## docker-compose.easyreview.yaml 增补（模板）

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

volumes 顶层追加：

```yaml
volumes:
  bundle:
  frontend_modules:
  pnpm_store:
```

## easyreview.runner.json 的 js 节（模板）

```json
"js": {
  "cmd": ["docker", "compose", "-f", "docker-compose.easyreview.yaml", "run", "--rm", "-T", "vitest", "node", "node_modules/vitest/vitest.mjs", "run", "--reporter=json", "--outputFile=/dev/stdout", "{specFiles}"],
  "scanLimit": 20
}
```

## 工作原理

verify 的 cwd 是沙箱 `src/`（仓的增量同步副本）；compose 文件是仓内普通文件、会同步进沙箱，
`volumes: .:/app` 挂载的就是沙箱——突变对容器可见，真实仓零接触。
`{specFiles}` 由 easyreview 展开为镜像 spec + 引用扫描命中的文件列表（超上限回退只跑镜像 spec）。
vitest 逐文件隔离：突变致模块加载失败只红 import 它的 spec 文件，就是正常爆炸半径。

## 已知局限（实现审查记录）

- 镜像匹配按 basename（specs/ 在哪层都认），撞名取目录公共前缀最长——极端同名同层会选错，接受。
- 引用扫描按源文件 basename 词边界 grep：注释/字符串里的名字也算命中，确定性启发，接受。
- .vue 组件大多无行为 spec——圈不到域时按提示换块。
- 纯声明式 `<script setup>`（函数全藏在 `computed(() => …)` 参数里）提不出具名叶子 → "找不到可突变的语句行"（验收实测:ChannelLeaf/SidebarUnreadBadge 均如此）——这是叶子五形态的已知边界,换块即可。
- 挂载型 spec 大多只断言渲染,事件处理器里的位点常得 uncovered(验收实测三例)——挂载路径上的顶层语句(如 `onMounted(preloadSdk);`)才是好探针目标。
- 泛用 basename(如 `Message`)的引用扫描噪音大;镜像匹配大小写敏感(`Message` ≠ `message.spec.js`)。
- regex 回退的两条已知噪音（tree-sitter 是首选路径的原因）：多行模板串内部行（无害改字符串，最坏 uncovered）；尾随运算符续行（`a +` 换行后的 `b;`）注释即语法破坏→假红，前缀守卫原理上挡不住。
