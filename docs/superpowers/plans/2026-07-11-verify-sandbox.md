# verify 沙箱化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** verify 的突变与所有 cargo 构建都发生在沙箱(系统临时目录里的增量同步副本 + 独立 CARGO_TARGET_DIR),真实仓源码和 target/ 零写入。

**Architecture:** 新增 `src/verify/sandbox.ts`(路径计算 + 内容比对增量同步);`cargo.ts` 的 Exec 扩 env 参数、`runCargoTests` 扩 targetDir;`cli-verify.ts` 的 show/predict 全部改为在沙箱 `src/` 跑 cargo、在沙箱文件上突变;`cli.ts` 加 `verify --clean`。`probe.ts`/`mutate.ts`/`parse.ts`/`judge.ts`/`pick-site.ts` 一行不改。

**Tech Stack:** Node 内置 fs/crypto/os,vitest(全 fake exec,不跑真 cargo)。

**Spec:** `docs/superpowers/specs/2026-07-11-verify-sandbox-design.md`

**关键不变量(实现时不得违背):**
1. 同步只覆写内容有差异的文件——未变文件的 mtime 一个不动(cargo 增量编译的前提)。
2. 真实仓全程只读(源码、target/、.git 都不写)。
3. 测试全部用 fake exec 注入,绝不调真 cargo。
4. `probe.ts`、`mutate.ts` 不改——沙箱化只是换调用方传入的路径。

---

### Task 1: `src/verify/sandbox.ts`(路径计算 + 增量同步器)

**Files:**
- Create: `src/verify/sandbox.ts`
- Test: `test/verify-sandbox.test.ts`

- [ ] **Step 1: Write the failing tests**

创建 `test/verify-sandbox.test.ts`,内容如下(完整文件):

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { sandboxFor, syncSandbox } from '../src/verify/sandbox.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ez-sbx-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function trackSandbox(repo: string) {
  const sb = sandboxFor(repo);
  cleanups.push(() => rmSync(sb.dir, { recursive: true, force: true }));
  return sb;
}

function write(repo: string, rel: string, content: string): void {
  const p = join(repo, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

describe('sandboxFor', () => {
  it('is stable for the same repo and distinct across repos; srcDir/targetDir live under dir', () => {
    const a = makeRepo(); const b = makeRepo();
    const s1 = sandboxFor(a); const s2 = sandboxFor(a); const s3 = sandboxFor(b);
    expect(s1.dir).toBe(s2.dir);
    expect(s1.dir).not.toBe(s3.dir);
    expect(s1.srcDir).toBe(join(s1.dir, 'src'));
    expect(s1.targetDir).toBe(join(s1.dir, 'target'));
    expect(s1.dir.startsWith(join(tmpdir(), 'easyreview-sandbox'))).toBe(true);
  });
});

describe('syncSandbox', () => {
  it('first sync copies source files and excludes .git/target/node_modules/easyreview.*', () => {
    const repo = makeRepo();
    write(repo, 'Cargo.toml', '[workspace]');
    write(repo, 'crates/a/src/lib.rs', 'pub fn f() {}');
    write(repo, '.git/HEAD', 'ref: refs/heads/main');
    write(repo, 'target/debug.bin', 'junk');
    write(repo, 'node_modules/m/index.js', 'x');
    write(repo, 'easyreview.tree.json', '{}');
    const sb = trackSandbox(repo);
    const stats = syncSandbox(repo, sb.srcDir);
    expect(stats.copied).toBe(2);
    expect(readFileSync(join(sb.srcDir, 'Cargo.toml'), 'utf8')).toBe('[workspace]');
    expect(readFileSync(join(sb.srcDir, 'crates/a/src/lib.rs'), 'utf8')).toBe('pub fn f() {}');
    expect(existsSync(join(sb.srcDir, '.git'))).toBe(false);
    expect(existsSync(join(sb.srcDir, 'target'))).toBe(false);
    expect(existsSync(join(sb.srcDir, 'node_modules'))).toBe(false);
    expect(existsSync(join(sb.srcDir, 'easyreview.tree.json'))).toBe(false);
  });

  it('incremental sync only rewrites changed files — untouched files keep their mtime', () => {
    const repo = makeRepo();
    write(repo, 'Cargo.toml', '[workspace]');
    write(repo, 'crates/a/src/lib.rs', 'pub fn f() {}');
    const sb = trackSandbox(repo);
    syncSandbox(repo, sb.srcDir);
    const untouched = join(sb.srcDir, 'crates/a/src/lib.rs');
    const mtimeBefore = statSync(untouched).mtimeMs;

    write(repo, 'Cargo.toml', '[workspace]\nmembers = []');
    const stats = syncSandbox(repo, sb.srcDir);
    expect(stats.copied).toBe(1);
    expect(readFileSync(join(sb.srcDir, 'Cargo.toml'), 'utf8')).toBe('[workspace]\nmembers = []');
    expect(statSync(untouched).mtimeMs).toBe(mtimeBefore);
  });

  it('deletes sandbox files and dirs that no longer exist in the repo', () => {
    const repo = makeRepo();
    write(repo, 'keep.rs', 'k');
    write(repo, 'gone.rs', 'g');
    write(repo, 'olddir/x.rs', 'x');
    const sb = trackSandbox(repo);
    syncSandbox(repo, sb.srcDir);
    rmSync(join(repo, 'gone.rs'));
    rmSync(join(repo, 'olddir'), { recursive: true });
    const stats = syncSandbox(repo, sb.srcDir);
    expect(stats.deleted).toBe(2);
    expect(existsSync(join(sb.srcDir, 'keep.rs'))).toBe(true);
    expect(existsSync(join(sb.srcDir, 'gone.rs'))).toBe(false);
    expect(existsSync(join(sb.srcDir, 'olddir'))).toBe(false);
  });

  it('copies binary files byte-for-byte', () => {
    const repo = makeRepo();
    const bytes = Buffer.from([0, 255, 1, 254, 10, 13, 0]);
    mkdirSync(join(repo, 'assets'), { recursive: true });
    writeFileSync(join(repo, 'assets/blob.bin'), bytes);
    const sb = trackSandbox(repo);
    syncSandbox(repo, sb.srcDir);
    expect(readFileSync(join(sb.srcDir, 'assets/blob.bin')).equals(bytes)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/verify-sandbox.test.ts`
Expected: FAIL —— 找不到模块 `../src/verify/sandbox.js`

- [ ] **Step 3: Write the implementation**

创建 `src/verify/sandbox.ts`,内容如下(完整文件):

```ts
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** 同步排除:版本库、依赖、构建产物、easyreview 自身产物。 */
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'target']);
const isArtifact = (name: string) => name.startsWith('easyreview.');

export interface Sandbox { dir: string; srcDir: string; targetDir: string; }

/** 纯路径计算,不碰磁盘。hash = 真实仓绝对路径的 sha256 前 12 位。 */
export function sandboxFor(repo: string): Sandbox {
  const hash = createHash('sha256').update(resolve(repo)).digest('hex').slice(0, 12);
  const dir = join(tmpdir(), 'easyreview-sandbox', hash);
  return { dir, srcDir: join(dir, 'src'), targetDir: join(dir, 'target') };
}

export interface SyncStats { copied: number; deleted: number; }

/**
 * 真实仓 → 沙箱 src/ 增量同步。只覆写内容有差异的文件(未变文件 mtime 不动——
 * cargo 增量编译的前提),删掉真实仓已不存在的条目。真实仓全程只读。
 */
export function syncSandbox(repo: string, srcDir: string): SyncStats {
  const stats: SyncStats = { copied: 0, deleted: 0 };
  try {
    mkdirSync(srcDir, { recursive: true });
    syncDir(repo, srcDir, stats);
  } catch (e) {
    throw new Error(
      `沙箱同步失败(${srcDir}):${e instanceof Error ? e.message : String(e)}——可 \`easyreview verify --clean\` 后重试`,
    );
  }
  return stats;
}

function syncDir(from: string, to: string, stats: SyncStats): void {
  const dirs: string[] = [];
  const files: string[] = [];
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!EXCLUDED_DIRS.has(e.name)) dirs.push(e.name); }
    else if (e.isFile()) { if (!isArtifact(e.name)) files.push(e.name); }
    // symlink 等其它类型跳过
  }

  for (const name of files) {
    const srcBuf = readFileSync(join(from, name));
    const destPath = join(to, name);
    const st = statSync(destPath, { throwIfNoEntry: false });
    const same = st?.isFile() === true && st.size === srcBuf.length && srcBuf.equals(readFileSync(destPath));
    if (!same) { writeFileSync(destPath, srcBuf); stats.copied++; }
  }
  for (const name of dirs) {
    const destPath = join(to, name);
    mkdirSync(destPath, { recursive: true });
    syncDir(join(from, name), destPath, stats);
  }

  const keepDirs = new Set(dirs);
  const keepFiles = new Set(files);
  for (const e of readdirSync(to, { withFileTypes: true })) {
    const keep = e.isDirectory() ? keepDirs.has(e.name) : keepFiles.has(e.name);
    if (!keep) { rmSync(join(to, e.name), { recursive: true, force: true }); stats.deleted++; }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/verify-sandbox.test.ts`
Expected: 5 passed

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`(必须干净)

```bash
git add src/verify/sandbox.ts test/verify-sandbox.test.ts
git commit -m "feat: verify 沙箱——路径计算 + 内容比对增量同步器"
```

---

### Task 2: `cargo.ts` 扩 env / targetDir

**Files:**
- Modify: `src/verify/cargo.ts`(全文替换,现文件仅 19 行)
- Test: `test/verify-cargo.test.ts`(新建)

- [ ] **Step 1: Write the failing tests**

创建 `test/verify-cargo.test.ts`,内容如下(完整文件):

```ts
import { describe, it, expect } from 'vitest';
import { runCargoTests, type Exec } from '../src/verify/cargo.js';

describe('runCargoTests', () => {
  it('passes cwd and CARGO_TARGET_DIR through to exec when targetDir is given', async () => {
    let seenCwd = '';
    let seenEnv: NodeJS.ProcessEnv | undefined;
    let seenArgs: string[] = [];
    const fake: Exec = async (_cmd, args, cwd, env) => {
      seenCwd = cwd; seenEnv = env; seenArgs = args;
      return 'test a::t1 ... ok';
    };
    const run = await runCargoTests('/sb/src', 'my_crate', fake, '/sb/target');
    expect(run.compiled).toBe(true);
    expect(seenCwd).toBe('/sb/src');
    expect(seenEnv?.CARGO_TARGET_DIR).toBe('/sb/target');
    expect(seenArgs).toEqual(['test', '-p', 'my_crate', '--', '--test-threads=1']);
  });

  it('passes no env override when targetDir is omitted', async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined = { sentinel: 'x' };
    const fake: Exec = async (_cmd, _args, _cwd, env) => { seenEnv = env; return 'test a::t1 ... ok'; };
    await runCargoTests('/repo', 'c', fake);
    expect(seenEnv).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/verify-cargo.test.ts`
Expected: FAIL —— runCargoTests 不接受第 4 个参数 / env 未透传(TS 报参数数量或断言失败)

- [ ] **Step 3: Rewrite `src/verify/cargo.ts`**

全文替换为:

```ts
import { execFile } from 'node:child_process';
import type { CargoTestRun } from '../types.js';
import { parseCargoTest } from './parse.js';

/** (cmd, args, cwd, env?) → 合并的 stdout+stderr。不因非零退出码抛出。env 缺省=继承进程环境。 */
export type Exec = (cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<string>;

const realExec: Exec = (cmd, args, cwd, env) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, env: env ?? process.env }, (_err, stdout, stderr) => {
      resolve(`${stdout ?? ''}\n${stderr ?? ''}`);
    });
  });

/** cwd 由调用方决定(沙箱化后传沙箱 src/);targetDir 提供时经 CARGO_TARGET_DIR 注入。 */
export async function runCargoTests(cwd: string, crate: string, exec: Exec = realExec, targetDir?: string): Promise<CargoTestRun> {
  const env = targetDir ? { ...process.env, CARGO_TARGET_DIR: targetDir } : undefined;
  const out = await exec('cargo', ['test', '-p', crate, '--', '--test-threads=1'], cwd, env);
  return parseCargoTest(out);
}
```

(第一个参数从 `repo` 改名为 `cwd`——语义变了:沙箱化后调用方传的是沙箱 `src/`,不再是真实仓。现有 fake exec 都是 `(cmd, args)` 或 `(cmd, args, cwd)` 形参,少写尾参在 TS 里天然兼容,不用改。)

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run test/verify-cargo.test.ts && npm run typecheck`
(PowerShell 下分两条跑:`npx vitest run test/verify-cargo.test.ts` 然后 `npm run typecheck`)
Expected: 2 passed;typecheck 干净

- [ ] **Step 5: Commit**

```bash
git add src/verify/cargo.ts test/verify-cargo.test.ts
git commit -m "feat: cargo Exec 扩 env,runCargoTests 支持 CARGO_TARGET_DIR 注入"
```

---

### Task 3: `cli-verify.ts` 接线(show/predict 进沙箱)+ 零接触测试锁

**Files:**
- Modify: `src/cli-verify.ts`
- Test: `test/cli-verify.test.ts`(改 3 个现有用例的清理 + 新增 1 个用例)

- [ ] **Step 1: Write the failing test**

在 `test/cli-verify.test.ts` 做如下修改。

(a) 顶部 import 改为:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTempRepo, writeRepoFile, commitAll } from './helpers.js';
import { runMap } from '../src/cli.js';
import { runVerifyShow, runVerifyPredict } from '../src/cli-verify.js';
import { sandboxFor } from '../src/verify/sandbox.js';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
```

(b) `describe` 内、第一个 `it` 之前加辅助函数:

```ts
  function trackSandbox(repo: string) {
    const sb = sandboxFor(repo);
    cleanups.push(() => rmSync(sb.dir, { recursive: true, force: true }));
    return sb;
  }
```

(c) 3 个现有用例:在 `const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);` 之后各加一行 `trackSandbox(dir);`(show 会创建沙箱,测试要清掉)。

(d) 文件末尾(`describe` 内)新增用例:

```ts
  it('mutates only the sandbox; the real repo stays byte-identical throughout', async () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    const sb = trackSandbox(dir);
    writeRepoFile(dir, 'crates/chem_field/Cargo.toml', '[package]\nname="chem_field"');
    writeRepoFile(dir, 'crates/chem_field/src/core/field.rs',
      'pub fn step(v: f32) -> f32 {\n    let dt = 0.1;\n    v + dt\n}\n');
    commitAll(dir, 'init');
    await runMap({ repo: dir, outDir: dir });

    const chunkId = 'crates/chem_field/src/core/field.rs';
    const realFile = join(dir, chunkId);
    const realBefore = readFileSync(realFile);

    let phase = 'baseline';
    let seenCwd = '';
    let seenTarget: string | undefined;
    let mutationSeenInSandbox = false;
    let realCleanDuringMutation = true;
    const fakeExec = async (_cmd: string, _args: string[], cwd: string, env?: NodeJS.ProcessEnv) => {
      seenCwd = cwd;
      seenTarget = env?.CARGO_TARGET_DIR;
      if (phase === 'mutated') {
        const sbNow = readFileSync(join(sb.srcDir, chunkId), 'utf8');
        if (sbNow !== realBefore.toString('utf8')) mutationSeenInSandbox = true;
        if (!readFileSync(realFile).equals(realBefore)) realCleanDuringMutation = false;
        return 'test core::field::t1 ... ok\ntest core::field::t2 ... FAILED';
      }
      return 'test core::field::t1 ... ok\ntest core::field::t2 ... ok';
    };

    await runVerifyShow({ repo: dir, outDir: dir, chunkId, exec: fakeExec });
    expect(seenCwd).toBe(sb.srcDir);
    expect(seenTarget).toBe(sb.targetDir);
    expect(readFileSync(realFile).equals(realBefore)).toBe(true);

    phase = 'mutated';
    await runVerifyPredict({ repo: dir, outDir: dir, chunkId, predicted: ['core::field::t2'], exec: fakeExec });
    expect(seenCwd).toBe(sb.srcDir);
    expect(seenTarget).toBe(sb.targetDir);
    expect(mutationSeenInSandbox).toBe(true);
    expect(realCleanDuringMutation).toBe(true);
    expect(readFileSync(realFile).equals(realBefore)).toBe(true);
    expect(readFileSync(join(sb.srcDir, chunkId), 'utf8')).toBe(realBefore.toString('utf8'));
  });
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `npx vitest run test/cli-verify.test.ts`
Expected: 新用例 FAIL(seenCwd 仍是真实仓、seenTarget 为 undefined);现有 3 个仍 PASS

- [ ] **Step 3: Modify `src/cli-verify.ts`**

(a) 顶部 import 增改:

```ts
import { sandboxFor, syncSandbox } from './verify/sandbox.js';
```

(`existsSync` 已在第 1 行的 fs import 里。)

(b) `runVerifyShow` 中,把

```ts
  console.error(`⏳ 首次编译 ${crate} 可能要几分钟（bevy/egui 链接很重），属正常、不是卡住。`);
  const baseline = await runCargoTests(o.repo, crate, o.exec);
```

替换为:

```ts
  const sb = sandboxFor(o.repo);
  const firstRun = !existsSync(sb.targetDir);
  const stats = syncSandbox(o.repo, sb.srcDir);
  console.error(`⏳ 沙箱已同步(${stats.copied} 个文件更新,位置 ${sb.dir})`);
  console.error(
    firstRun
      ? `⏳ 沙箱首次全量编译 ${crate} 可能要 5-10 分钟（独立缓存,不碰真实仓的 target/），属正常、不是卡住。`
      : `⏳ 编译 ${crate}（沙箱增量）…`,
  );
  const baseline = await runCargoTests(sb.srcDir, crate, o.exec, sb.targetDir);
```

(c) `runVerifyPredict` 中,把

```ts
  const blast = await probe({
    chunkId: chunk.id,
    absFile: join(o.repo, chunk.file),
    op: cached.op,
    baselineGreen: cached.green,
    runAfter: () => runCargoTests(o.repo, crate, o.exec),
  });
```

替换为:

```ts
  const sb = sandboxFor(o.repo);
  syncSandbox(o.repo, sb.srcDir);
  let blast: import('./types.js').BlastRadius;
  try {
    blast = await probe({
      chunkId: chunk.id,
      absFile: join(sb.srcDir, chunk.file),
      op: cached.op,
      baselineGreen: cached.green,
      runAfter: () => runCargoTests(sb.srcDir, crate, o.exec, sb.targetDir),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('mutation site mismatch')) {
      throw new Error(`${msg}\n源码已变——先重跑 \`easyreview verify ${chunk.id}\` 刷新基线`);
    }
    throw e;
  }
```

其余(判定、progress、verify.md)一律不动。`probe.ts`、`mutate.ts` 不改。

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run test/cli-verify.test.ts` 然后 `npm run typecheck`
Expected: 4 passed;typecheck 干净

- [ ] **Step 5: Commit**

```bash
git add src/cli-verify.ts test/cli-verify.test.ts
git commit -m "feat: verify show/predict 进沙箱——真实仓零接触,含零接触测试锁"
```

---

### Task 4: `verify --clean`

**Files:**
- Modify: `src/cli-verify.ts`(加 `runVerifyClean`)
- Modify: `src/cli.ts:110-124`(verify 分支先判 `--clean`)
- Test: `test/cli-verify.test.ts`(新增 1 个用例)

- [ ] **Step 1: Write the failing test**

`test/cli-verify.test.ts` 的 import 里给 `runVerifyClean` 补上:

```ts
import { runVerifyShow, runVerifyPredict, runVerifyClean } from '../src/cli-verify.js';
```

并在顶部 fs import 里补 `mkdirSync`、`writeFileSync`:

```ts
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
```

`describe` 内新增用例:

```ts
  it('verify --clean removes the whole sandbox and is idempotent', () => {
    const { dir, cleanup } = makeTempRepo(); cleanups.push(cleanup);
    const sb = trackSandbox(dir);
    mkdirSync(sb.srcDir, { recursive: true });
    mkdirSync(sb.targetDir, { recursive: true });
    writeFileSync(join(sb.srcDir, 'x.rs'), 'x');
    expect(existsSync(sb.dir)).toBe(true);

    runVerifyClean(dir);
    expect(existsSync(sb.dir)).toBe(false);

    runVerifyClean(dir); // 沙箱已不存在——幂等,不抛
  });
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `npx vitest run test/cli-verify.test.ts`
Expected: FAIL —— `runVerifyClean` 未导出

- [ ] **Step 3: Implement**

(a) `src/cli-verify.ts`:fs import 补 `rmSync`(现第 1 行改为):

```ts
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
```

文件末尾追加:

```ts
/** 删除该仓对应的整个沙箱(源码副本 + 编译缓存)。沙箱不存在也正常返回(幂等)。 */
export function runVerifyClean(repo: string): void {
  const sb = sandboxFor(repo);
  if (existsSync(sb.dir)) {
    rmSync(sb.dir, { recursive: true, force: true });
    console.log(`✓ 已删除沙箱 ${sb.dir}`);
  } else {
    console.log(`沙箱不存在（${sb.dir}）——无需清理`);
  }
}
```

(b) `src/cli.ts` 的 verify 分支(现 110-124 行)整体替换为:

```ts
if (cmd === 'verify') {
  const rest = process.argv.slice(3);
  if (rest.includes('--clean')) {
    const { repo } = parseArgs(rest);
    import('./cli-verify.js').then(({ runVerifyClean }) => runVerifyClean(repo));
  } else {
    const chunkId = rest.find((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
    if (!chunkId) { console.error('用法: easyreview verify <chunkId> [--predict a,b] [--repo <p>] [--out <d>] | verify --clean [--repo <p>]'); process.exit(1); }
    const { repo, outDir } = parseArgs(rest);
    const pi = rest.indexOf('--predict');
    const predicted = pi >= 0 && rest[pi + 1] ? rest[pi + 1].split(',').map((s) => s.trim()).filter(Boolean) : null;
    import('./cli-verify.js').then(({ runVerifyShow, runVerifyPredict }) =>
      (predicted
        ? runVerifyPredict({ repo, outDir, chunkId, predicted })
        : runVerifyShow({ repo, outDir, chunkId }))
        .then(() => console.log('✓ wrote easyreview.verify.md'))
        .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); }),
    );
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run test/cli-verify.test.ts` 然后 `npm run typecheck`
Expected: 5 passed;typecheck 干净

- [ ] **Step 5: Commit**

```bash
git add src/cli-verify.ts src/cli.ts test/cli-verify.test.ts
git commit -m "feat: easyreview verify --clean 删除沙箱(幂等)"
```

---

### Task 5: HANDOFF 更新 + 全量验证

**Files:**
- Modify: `docs/HANDOFF.md`

- [ ] **Step 1: Update HANDOFF.md**

(a) 找到 verify 的介绍段(③ verify 相关小节),在其描述后补一句:

> 2026-07-11 起 verify 沙箱化:突变与全部 cargo 构建发生在 `os.tmpdir()/easyreview-sandbox/<仓路径hash>/`(`src/` 增量同步副本 + 独立 `CARGO_TARGET_DIR`),真实仓源码和 target/ 零写入;`easyreview verify --clean` 删沙箱。首次全量编译较慢,之后增量。

(b) 代码地图表格加一行(与现有 verify 行同格式):

```
| `src/verify/sandbox.ts` | 沙箱路径计算 + 内容比对增量同步(未变文件 mtime 不动——cargo 增量前提) |
```

(c) `src/verify/cargo.ts` 行的描述改为提及 `Exec (cmd,args,cwd,env?)` 与 `CARGO_TARGET_DIR` 注入。

(d) 测试计数句改为:`47 文件 / 149 个测试`(新增 verify-sandbox 5 + verify-cargo 2 + cli-verify 新增 2 = 141+9... **执行时以实际 `npm test` 输出为准**,数字必须来自真实运行结果,不得照抄本句)。

- [ ] **Step 2: Full verification**

Run: `npm test` 然后 `npm run typecheck`
Expected: 全绿(预计 47 files / 150 tests——以实际输出为准);typecheck 干净

- [ ] **Step 3: Commit**

```bash
git add docs/HANDOFF.md
git commit -m "docs: HANDOFF 同步 verify 沙箱化(sandbox.ts/--clean/测试计数)"
```

---

## 验收(计划外、合并前手动)

umwelt-bevy 真仓:

1. `git -C D:/dev/umwelt-bevy status` 记录初始状态
2. `npm run verify`(经 CLI)对某个 Rust chunk 跑 `verify show` → 确认:输出提示沙箱位置;真实仓 `git status` 无新变化、`target/` mtime 无更新;沙箱目录出现且在编译
3. 二次 show → 沙箱增量(同步 0-少量文件,编译快)
4. `easyreview verify --clean --repo D:/dev/umwelt-bevy` → 沙箱目录消失
