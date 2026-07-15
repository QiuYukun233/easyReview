# chatwoot rspec 环境配方(easyreview verify 用)

verify Ruby 需要一套能跑 rspec 的环境。本配方用 Docker Compose 立起 chatwoot 的最小测试环境
(按其 CI `run_foss_spec.yml` 裁剪:pg16 + redis + ruby 3.4.4)。

**状态:2026-07-12 真仓验收通过(chatwoot @ 11deffdd5:show 圈定镜像+扫描 2 个 spec、基线 2 绿;突变 `include UrlHelper` 后镜像 spec 变红、预测命中→通过;真实仓零接触、沙箱字节还原)。下述模板即验收版本。**

## 一次性安装

1. 把下面两个文件拷到 chatwoot 仓根(对该仓是未跟踪的本地文件,不要提交):
   `docker-compose.easyreview.yaml` 与 `easyreview.runner.json`(模板见下)。
2. 启动 Docker Desktop。
3. 初始化(首次 30-60 分钟:拉镜像 + bundle install + 建库):

```powershell
cd <chatwoot 仓根>
docker compose -f docker-compose.easyreview.yaml run --rm -T rspec bundle install
docker compose -f docker-compose.easyreview.yaml run --rm -T rspec bundle exec rake db:create db:schema:load
```

已知雷(chatwoot CI + 实现审查 + 2026-07-12 真仓验收实测):
- **`EXECJS_RUNTIME: Disabled` 必须有**(已进模板)——ruby:3.4.4 容器无 JS runtime,缺它 uglifier 一加载就 `ExecJS::RuntimeUnavailable`(验收实踩)。
- **compose 顶层 `name:` 必须钉死**(已进模板)——verify 的 cwd 是沙箱 `src/`,不钉名的话项目名随目录名分叉,沙箱侧会另起一套空 pg/空 bundle 卷(验收实踩)。
- **pg 数据在 tmpfs**:`docker compose down`/Docker 重启后 schema 蒸发——若 spec 突然全红报 `relation ... does not exist`,重跑 `rake db:schema:load` 即可。容器组会一直挂着,不想要时 `docker compose -f docker-compose.easyreview.yaml down`(记得之后重载 schema)。
- CE spec 不含 enterprise——rspec 只指定 spec 文件路径时通常不受影响;必要时在沙箱里临时排除。
- `NODE_OPTIONS=--openssl-legacy-provider` 已在 compose 里预置。
- 数据库连接环境变量(`POSTGRES_HOST`/`POSTGRES_USERNAME` 等)已按 chatwoot `config/database.yml` 校准(验收验证)。
- `easyreview.runner.json` 的 `cmd` 首词必须是真实可执行文件(如 `docker` = docker.exe)——easyreview 用 execFile 不经 shell,npm 式 `.cmd`/`.bat` shim 无法启动。

## docker-compose.easyreview.yaml(模板)

```yaml
name: chatwoot-easyreview
services:
  postgres:
    image: pgvector/pgvector:pg16
    tmpfs:
      - /var/lib/postgresql/data
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ''
      POSTGRES_HOST_AUTH_METHOD: trust
  redis:
    image: redis:alpine
  rspec:
    image: ruby:3.4.4
    working_dir: /app
    volumes:
      - .:/app
      - bundle:/usr/local/bundle
    environment:
      RAILS_ENV: test
      EXECJS_RUNTIME: Disabled
      POSTGRES_HOST: postgres
      POSTGRES_USERNAME: postgres
      POSTGRES_PASSWORD: ''
      REDIS_URL: redis://redis:6379
      NODE_OPTIONS: --openssl-legacy-provider
    depends_on:
      - postgres
      - redis
volumes:
  bundle:
```

## easyreview.runner.json(模板)

```json
{
  "version": 1,
  "ruby": {
    "cmd": ["docker", "compose", "-f", "docker-compose.easyreview.yaml", "run", "--rm", "-T", "rspec", "bundle", "exec", "rspec", "--format", "json", "{specFiles}"],
    "scanLimit": 20
  }
}
```

## 工作原理

verify 的 cwd 是沙箱 `src/`(仓的增量同步副本);compose 文件是仓内普通文件、会同步进沙箱,
`volumes: .:/app` 挂载的就是沙箱——突变对容器可见,真实仓零接触。
`{specFiles}` 由 easyreview 展开为镜像 spec + 引用扫描命中的文件列表。

## 已知局限(实现审查记录)

- 引用扫描按 basename 类名词边界 grep:命名空间同名类会混同;字符串/注释里的类名也算命中——确定性启发,接受。
- chatwoot 的高中心度类(Account/User/Conversation 等)扫描命中普遍超上限 → 自动回退只跑镜像 spec(verify.md 会显式说明)。
- Ruby 位点:`private`/`attr_reader` 行可能被 regex 回退选中,注释后常无观测失败——浪费一次探针,uncovered 结果兜底。
- rspec 套件级 hook 错误(errors_outside_of_examples_count>0 且有 example)不被感知——突变目标是 app/ 源码行,不碰 spec_helper,风险极低。
- **flow trace 与 verify 别并发跑同一个仓**(2026-07-15,终审评估 LOW):两者共用同一沙箱目录且无锁,交错会互相干扰结果(verify 可能拿到假绿、trace 可能采到突变行为);真实仓零污染不受影响,重跑即可。单人顺序使用无此问题。
