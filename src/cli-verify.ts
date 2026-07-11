import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { GradedTree, Chunk } from './types.js';
import { type Exec } from './verify/cargo.js';
import { sandboxFor, syncSandbox } from './verify/sandbox.js';
import { chooseMutation } from './verify/mutate.js';
import { probe } from './verify/probe.js';
import { judge } from './verify/judge.js';
import { loadProgress, saveProgress, markUnderstood } from './progress/progress.js';
import { cargoRunner, type VerifyRunner } from './verify/runner.js';
import { loadRubyRunnerConfig, makeRspecRunner } from './verify/rspec.js';
import { langOf } from './extract/lang.js';

function loadTree(outDir: string): GradedTree {
  try { return JSON.parse(readFileSync(join(outDir, 'easyreview.tree.json'), 'utf8')) as GradedTree; }
  catch { throw new Error(`找不到 easyreview.tree.json——先运行 \`easyreview map --repo <path> --out ${outDir}\``); }
}
function findChunk(g: GradedTree, chunkId: string): Chunk {
  const c = g.chunks.find((x) => x.id === chunkId);
  if (!c) throw new Error(`未知 chunk: ${chunkId}`);
  return c;
}
function runnerFor(chunk: Chunk, repo: string): VerifyRunner {
  const lang = langOf(chunk.file)?.id;
  if (lang === 'rust') return cargoRunner;
  if (lang === 'ruby') return makeRspecRunner(loadRubyRunnerConfig(repo));
  throw new Error(`verify（突变探针）暂只支持 Rust（cargo）与 Ruby（rspec）；\`${chunk.file}\` 不在支持范围。`);
}
const baselinePath = (o: string) => join(o, 'easyreview.verify-baseline.json');
const verifyMd = (o: string) => join(o, 'easyreview.verify.md');
const progressPath = (o: string) => join(o, 'easyreview.progress.json');

export interface ShowOpts { repo: string; outDir: string; chunkId: string; exec?: Exec; }
export async function runVerifyShow(o: ShowOpts): Promise<void> {
  const g = loadTree(o.outDir);
  const chunk = findChunk(g, o.chunkId);
  const runner = runnerFor(chunk, o.repo);
  const source = readFileSync(join(o.repo, chunk.file), 'utf8');
  const leaves = g.leaves.filter((l) => l.file === chunk.file);
  const op = await chooseMutation(chunk, leaves, source);
  if (!op) throw new Error(`${chunk.file} 找不到可突变的语句行——换个块试试`);

  const picked = runner.pickScope(g, chunk, o.repo);

  const sb = sandboxFor(o.repo);
  const firstRun = !existsSync(sb.targetDir);
  const stats = syncSandbox(o.repo, sb.srcDir);
  console.error(`⏳ 沙箱已同步(${stats.copied} 个文件更新,位置 ${sb.dir})`);
  console.error(
    runner.id === 'rust'
      ? (firstRun
          ? `⏳ 沙箱首次全量编译 ${chunk.crate} 可能要 5-10 分钟（独立缓存,不碰真实仓的 target/），属正常、不是卡住。`
          : `⏳ 编译 ${chunk.crate}（沙箱增量）…`)
      : `⏳ 运行 rspec（docker 冷启动/bundle 首次可能较慢）…`,
  );
  const baseline = await runner.run(sb.srcDir, sb.targetDir, picked.scope, o.exec);
  if (!baseline.compiled) {
    throw new Error(
      runner.id === 'rust'
        ? `${chunk.crate} 的基线 cargo test 无法编译——先修好编译错误再验证这个块。`
        : '基线 rspec 无法加载或零 example——先确认测试环境可用（docs/recipes/chatwoot-rspec.md）。',
    );
  }
  const green = baseline.results.filter((r) => r.passed).map((r) => r.name);
  const all = baseline.results.map((r) => r.name);
  writeFileSync(baselinePath(o.outDir), JSON.stringify({ green, all, op, scope: picked.scope }, null, 2));

  const isRust = runner.id === 'rust';
  const lines = [
    '# 突变探针 · 预测',
    '',
    `目标块：\`${chunk.name}\`  (\`${chunk.file}\`)`,
    '',
    `我们会注释掉这一行（然后重跑测试）：`,
    '',
    `> ${chunk.file}:${op.line}`,
    '```' + (langOf(chunk.file)?.fence ?? ''),
    op.original,
    '```',
    '',
    isRust ? `## \`${chunk.crate}\` 的测试（${all.length}）` : `## 相关 spec 文件（${all.length}）`,
    ...(picked.note ? ['', `> ${picked.note}`] : []),
    ...runner.group(all).flatMap((grp) => [
      `### ${grp.module}`,
      ...grp.tests.map((n) => `- \`${n}\``),
    ]),
    '',
    '## 你的任务',
    isRust
      ? '读懂这个块后，**预测注释掉那行会让上面哪些测试变红**（爆炸半径）。'
      : '读懂这个块后，**预测注释掉那行会让上面哪些 spec 文件变红**（爆炸半径，文件级）。',
    '答完运行：',
    '',
    isRust
      ? `\`easyreview verify ${chunk.id} --predict <逗号分隔的测试名>\``
      : `\`easyreview verify ${chunk.id} --predict <逗号分隔的 spec 文件路径>\``,
    '',
    '（预测越准，说明你越懂"谁依赖它"。）',
  ];
  writeFileSync(verifyMd(o.outDir), lines.join('\n'));
}

export interface PredictOpts { repo: string; outDir: string; chunkId: string; predicted: string[]; exec?: Exec; }
export async function runVerifyPredict(o: PredictOpts): Promise<void> {
  const g = loadTree(o.outDir);
  const chunk = findChunk(g, o.chunkId);
  const runner = runnerFor(chunk, o.repo);
  if (!existsSync(baselinePath(o.outDir))) {
    throw new Error(`没有基线——先运行 \`easyreview verify ${chunk.id}\``);
  }
  const cached = JSON.parse(readFileSync(baselinePath(o.outDir), 'utf8')) as {
    green: string[]; all: string[]; op: import('./types.js').MutationOp; scope?: unknown;
  };
  // 旧 baseline 无 scope 只可能来自 Rust 流程——现算(行为等价);Ruby baseline 一定带 scope
  const scope = cached.scope ?? runner.pickScope(g, chunk, o.repo).scope;

  const sb = sandboxFor(o.repo);
  syncSandbox(o.repo, sb.srcDir);
  let blast: import('./types.js').BlastRadius;
  try {
    blast = await probe({
      chunkId: chunk.id,
      absFile: join(sb.srcDir, chunk.file),
      op: cached.op,
      baselineGreen: cached.green,
      runAfter: () => runner.run(sb.srcDir, sb.targetDir, scope, o.exec),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('mutation site mismatch')) {
      throw new Error(`${msg}\n源码已变——先重跑 \`easyreview verify ${chunk.id}\` 刷新基线`);
    }
    throw e;
  }

  // 空爆炸半径（非编译崩）= 该块没被测试覆盖 → 无法用突变探针验证，不能算通过
  const uncovered = !blast.compileBroke && blast.newlyFailing.length === 0;
  const verdict = judge(blast, o.predicted);
  const passed = verdict.passed && !uncovered;

  if (passed) {
    const file = progressPath(o.outDir);
    let p = loadProgress(file);
    p = markUnderstood(p, chunk.id);
    p = { ...p, verified: [...new Set([...(p.verified ?? []), chunk.id])] };
    saveProgress(file, p);
  }

  const isRust = runner.id === 'rust';
  const brokeLine = isRust
    ? '突变让 crate **无法编译**——这行是承重的。'
    : '突变让 spec 套件**加载失败**——这行是承重的。';
  const noteLine = blast.note
    ? (blast.compileBroke && !isRust ? '\n> 突变让 spec 套件加载失败——这行是承重的。' : `\n> ${blast.note}`)
    : '';
  const lines = uncovered
    ? [
        '# 突变探针 · 无法验证',
        '',
        `目标块：\`${chunk.name}\`  (\`${chunk.file}\`)`,
        `⚠️ 注释掉突变位点后没有任何测试变红——**这块没被测试覆盖**，突变探针无法验证它。`,
        '换一个被测试覆盖的块试，或先给它补个测试。',
        noteLine,
      ]
    : [
        '# 突变探针 · 判定',
        '',
        `目标块：\`${chunk.name}\`  (\`${chunk.file}\`)`,
        blast.compileBroke ? brokeLine : '',
        '',
        `- 你的预测：${o.predicted.map((t) => `\`${t}\``).join(', ') || '（无）'}`,
        `- 真实爆炸半径：${verdict.actual.map((t) => `\`${t}\``).join(', ') || '（无）'}`,
        `- 命中：${verdict.hits.join(', ') || '—'}`,
        `- 漏掉（真崩没预测到）：${verdict.misses.join(', ') || '—'}`,
        `- 误报（预测崩了没崩）：${verdict.falseAlarms.join(', ') || '—'}`,
        '',
        passed ? '✅ **通过**——已标记该块为 verified。' : '❌ 未通过——回去重读，尤其漏掉的那几个测试对应的行为。',
        noteLine,
      ];
  writeFileSync(verifyMd(o.outDir), lines.filter((l) => l !== '').join('\n'));
}

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
