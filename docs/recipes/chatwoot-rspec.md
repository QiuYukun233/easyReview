# chatwoot rspec 环境配方(easyreview verify 用)

verify Ruby 需要一套能跑 rspec 的环境。本配方用 Docker Compose 立起 chatwoot 的最小测试环境
(按其 CI `run_foss_spec.yml` 裁剪:pg16 + redis + ruby 3.4.4)。

**状态:活文档——真仓验收踩到的坑直接修回这里,验收通过的版本才算定稿。**

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

已知雷(来自 chatwoot CI 与实现审查):
- CE spec 不含 enterprise——若加载报 enterprise 相关错误,rspec 只指定 spec 文件路径时通常不受影响;必要时在沙箱里临时排除。
- `NODE_OPTIONS=--openssl-legacy-provider` 已在 compose 里预置。
- 数据库连接环境变量名以 chatwoot `config/database.yml` 为准——若连接失败,对照该文件调整 compose 的 environment(验收时校准)。
- `easyreview.runner.json` 的 `cmd` 首词必须是真实可执行文件(如 `docker` = docker.exe)——easyreview 用 execFile 不经 shell,npm 式 `.cmd`/`.bat` shim 无法启动。

## docker-compose.easyreview.yaml(模板)

```yaml
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
