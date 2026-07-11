# verify 沙箱化 · 设计(子项目 C)

2026-07-11。设计转向 A→B→C 的第三个子项目(见 2026-07-05 总设计与其修订)。

## 问题

`verify predict` 的 `withMutation`(`src/verify/mutate.ts`)把突变行**直接写进真实仓文件**,跑完 cargo test 在 `finally` 还原。正常路径没事,但进程被杀/断电时窗口期内真实仓被留在突变态;编辑器/文件监听也可能读到脏文件。`verify show` 的基线 cargo test 也以真实仓为 cwd(往真实仓写 `target/`)。

**目标:突变与所有 verify 相关的 cargo 构建都发生在沙箱里,真实仓零接触(源码和 target/ 都不写一个字节)。**

## 已定决策

| 决策点 | 选择 | 被拒选项 |
|---|---|---|
| 零接触边界 | 源码零接触,target 也不碰:沙箱自带独立持久 `CARGO_TARGET_DIR` | 共享真实仓 target(污染增量缓存);只做崩溃恢复不做副本(不算真沙箱) |
| 同步基准 | 当前工作区原样(含未提交改动,非 git 仓也能用) | git worktree = HEAD(未提交改动不可见,位点易 mismatch,且写真实仓 `.git/worktrees/`) |
| 沙箱位置 | 系统临时目录持久复用:`os.tmpdir()/easyreview-sandbox/<hash>/`,提供 `verify --clean` | outDir 里(几十 GB target 窝心);用完即删(每次全量编译 = 减速带) |
| 同步机制 | 自研内容比对增量同步(方案 1) | git worktree + diff 叠加(方案 2,git-only 且繁琐);robocopy/rsync(方案 3,平台分叉) |

**关键技术前提**:cargo 增量编译靠文件 mtime/内容判断重编。全量重拷会刷新所有 mtime → 全量重编 → 持久缓存作废。所以「只碰真正变了的文件」的增量同步是刚需,不是优化。

## §1 沙箱布局与同步器(`src/verify/sandbox.ts`,新文件)

布局:`os.tmpdir()/easyreview-sandbox/<hash>/`,hash = 真实仓绝对路径(resolve 后)的 sha256 前 12 位。

- `src/` —— 真实仓源码副本(cargo 的 cwd)
- `target/` —— 独立编译缓存(经 `CARGO_TARGET_DIR` 注入,跨运行持久复用)

接口(两个导出):

- `sandboxFor(repo: string): { dir: string; srcDir: string; targetDir: string }` —— 纯路径计算,不碰磁盘
- `syncSandbox(repo: string, srcDir: string): { copied: number; deleted: number }` —— 增量同步

同步规则:

1. 遍历真实仓,排除:`.git`、`node_modules`、任何名为 `target` 的目录、`easyreview.*` 产物文件
2. 逐文件比对:先 size,不等直接判变;相等再比内容字节。只覆写有差异的文件,未变文件的 mtime 一个不动
3. 反向遍历沙箱 `src/`,删掉真实仓已不存在的文件/目录(防幽灵文件参与编译)
4. 真实仓全程只读;二进制文件按 Buffer 原样拷

## §2 cargo 接入(`src/verify/cargo.ts` 改造)

- `Exec` 签名扩为 `(cmd, args, cwd, env?) => Promise<string>`;`realExec` 把 `env` 合进 `process.env` 传给 `execFile`。测试 fake exec 参数少写也兼容
- `runCargoTests(cwd, crate, exec?, targetDir?)`:有 `targetDir` 时以 `env = { ...process.env, CARGO_TARGET_DIR: targetDir }` 调 exec;`cwd` 由调用方传沙箱 `src/`
- `parse.ts`、`judge.ts`、`pick-site.ts` 不动

## §3 `cli-verify.ts` 接线

`runVerifyShow`:

1. 读 tree、找 chunk、断言 Rust、从真实仓读源码选突变位点——不变
2. 新增 `sandboxFor` + `syncSandbox`,打一行 `⏳ 同步沙箱…(<n> 个文件更新)`;首次(沙箱 target 尚不存在时)另提示「首次全量编译可能 5-10 分钟(独立缓存,不碰你的 target/),缓存位置 <dir>」
3. 基线 `runCargoTests(sandbox.srcDir, crate, exec, sandbox.targetDir)`——基线也进沙箱,真实仓零写入
4. baseline JSON、verify.md 生成不变

`runVerifyPredict`:

1. 读 baseline 不变
2. 再同步一次沙箱(show/predict 之间源码可能变;`withMutation` 位点校验兜底)
3. `probe` 的 `absFile` 改传 `join(sandbox.srcDir, chunk.file)`;`runAfter` 同样带 `targetDir`
4. `withMutation` 的 finally 还原保留(沙箱与真实仓保持一致、编译缓存不脏);进程死在窗口期只脏沙箱,下次 sync 自动修复
5. 判定、progress 落盘、verify.md 不变

`probe.ts`、`mutate.ts` 一行不改——操作路径由调用方决定。

## §4 `--clean` 与错误处理

- `easyreview verify --clean [--repo <p>]`(repo 缺省同现有约定):删除该仓整个沙箱目录,打印路径;沙箱不存在也正常退出(幂等)。`cli.ts` verify 分支先判 `--clean`,此时不需要 chunkId
- 同步失败(权限/磁盘满):抛出,带沙箱路径 +「可 `verify --clean` 后重试」提示
- 位点校验失败:现有 mismatch 报错保留,追加「源码已变,先重跑 `easyreview verify <chunkId>` 刷新基线」
- 沙箱残留突变:无需特殊处理,下次 sync 内容比对自动修回
- 磁盘占用:不做自动回收(系统临时目录由 OS 管),`--clean` 是唯一手动出口

## §5 测试

新增 `test/verify-sandbox.test.ts`(纯单元,不跑 cargo):

1. 首次 sync 全量拷贝;`.git`/`target`/`node_modules`/`easyreview.*` 被排除
2. 改一个文件再 sync → 只有它被覆写,未变文件 mtime 不动(断言 mtime 相等——增量编译前提的回归锁)
3. 真实仓删文件再 sync → 沙箱同名文件被删
4. `sandboxFor` 同一 repo 路径稳定、不同 repo 不同 hash

改造 `test/cli-verify.test.ts`(仍全用 fake exec):

5. fake exec 记录 cwd 和 env → 断言 cwd 是沙箱 `src/`、`CARGO_TARGET_DIR` 指向沙箱 `target/`
6. 零接触锁:predict 全程前后对真实仓目标文件 byte 级快照比对不变;沙箱文件在 probe 结束后已还原
7. 现有 3 个用例继续绿;测试临时仓的沙箱目录进 cleanup

验收(真仓,手动):umwelt-bevy 上 `verify show` → 真实仓 `git status` 干净、无 target 写入;首次编译落沙箱;二次 verify 增量快。
