# chatwoot vitest 环境配方(easyreview verify 用)

verify JS/Vue 需要能跑 vitest 的环境。本配方给既有 `docker-compose.easyreview.yaml`（见 chatwoot-rspec.md，项目名已钉 `chatwoot-easyreview`）加一个 node 服务。chatwoot 前端：vitest 3.0.5 + jsdom；node 24.x（.nvmrc 24.13.0）/ pnpm 10.2.0（packageManager 字段）/ husky ^7。

**状态：待真仓验收（验收后更新本行）。**

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
  "cmd": ["docker", "compose", "-f", "docker-compose.easyreview.yaml", "run", "--rm", "-T", "vitest", "node", "node_modules/vitest/vitest.mjs", "run", "--reporter=json", "{specFiles}"],
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
- regex 回退的两条已知噪音（tree-sitter 是首选路径的原因）：多行模板串内部行（无害改字符串，最坏 uncovered）；尾随运算符续行（`a +` 换行后的 `b;`）注释即语法破坏→假红，前缀守卫原理上挡不住。
