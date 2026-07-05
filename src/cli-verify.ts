import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GradedTree, Chunk } from './types.js';
import { runCargoTests, type Exec } from './verify/cargo.js';
import { chooseMutation } from './verify/mutate.js';
import { probe } from './verify/probe.js';
import { judge } from './verify/judge.js';
import { loadProgress, saveProgress, markUnderstood } from './progress/progress.js';

const CRATE = 'chem_field';

function loadTree(outDir: string): GradedTree {
  try { return JSON.parse(readFileSync(join(outDir, 'easyreview.tree.json'), 'utf8')) as GradedTree; }
  catch { throw new Error(`找不到 easyreview.tree.json——先运行 \`easyreview map --repo <path> --out ${outDir}\``); }
}
function findChunk(g: GradedTree, chunkId: string): Chunk {
  const c = g.chunks.find((x) => x.id === chunkId);
  if (!c) throw new Error(`未知 chunk: ${chunkId}`);
  if (c.crate !== CRATE) throw new Error(`v1 突变探针仅支持 ${CRATE} 的块（该块属于 ${c.crate}）`);
  return c;
}
const baselinePath = (o: string) => join(o, 'easyreview.verify-baseline.json');
const verifyMd = (o: string) => join(o, 'easyreview.verify.md');
const progressPath = (o: string) => join(o, 'easyreview.progress.json');

export interface ShowOpts { repo: string; outDir: string; chunkId: string; exec?: Exec; }
export async function runVerifyShow(o: ShowOpts): Promise<void> {
  const g = loadTree(o.outDir);
  const chunk = findChunk(g, o.chunkId);
  const source = readFileSync(join(o.repo, chunk.file), 'utf8');
  const leaves = g.leaves.filter((l) => l.file === chunk.file);
  const op = chooseMutation(chunk, leaves, source);
  if (!op) throw new Error(`${chunk.file} 找不到可突变的语句行——换个块试试`);

  const baseline = await runCargoTests(o.repo, CRATE, o.exec);
  const green = baseline.results.filter((r) => r.passed).map((r) => r.name);
  const all = baseline.results.map((r) => r.name);
  writeFileSync(baselinePath(o.outDir), JSON.stringify({ green, all, op }, null, 2));

  const lines = [
    '# 突变探针 · 预测',
    '',
    `目标块：\`${chunk.name}\`  (\`${chunk.file}\`)`,
    '',
    `我们会注释掉这一行（然后重跑测试）：`,
    '',
    `> ${chunk.file}:${op.line}`,
    '```rust',
    op.original,
    '```',
    '',
    `## ${CRATE} 的测试（${all.length}）`,
    ...all.map((n) => `- \`${n}\``),
    '',
    '## 你的任务',
    '读懂这个块后，**预测注释掉那行会让上面哪些测试变红**（爆炸半径）。',
    '答完运行：',
    '',
    `\`easyreview verify ${chunk.id} --predict <逗号分隔的测试名>\``,
    '',
    '（预测越准，说明你越懂"谁依赖它"。）',
  ];
  writeFileSync(verifyMd(o.outDir), lines.join('\n'));
}

export interface PredictOpts { repo: string; outDir: string; chunkId: string; predicted: string[]; exec?: Exec; }
export async function runVerifyPredict(o: PredictOpts): Promise<void> {
  const g = loadTree(o.outDir);
  const chunk = findChunk(g, o.chunkId);
  if (!existsSync(baselinePath(o.outDir))) {
    throw new Error(`没有基线——先运行 \`easyreview verify ${chunk.id}\``);
  }
  const cached = JSON.parse(readFileSync(baselinePath(o.outDir), 'utf8')) as {
    green: string[]; all: string[]; op: import('./types.js').MutationOp;
  };

  const blast = await probe({
    chunkId: chunk.id,
    absFile: join(o.repo, chunk.file),
    op: cached.op,
    baselineGreen: cached.green,
    runAfter: () => runCargoTests(o.repo, CRATE, o.exec),
  });

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

  const lines = uncovered
    ? [
        '# 突变探针 · 无法验证',
        '',
        `目标块：\`${chunk.name}\`  (\`${chunk.file}\`)`,
        `⚠️ 注释掉突变位点后没有任何测试变红——**这块没被测试覆盖**，突变探针无法验证它。`,
        '换一个被测试覆盖的块试（如 field/scene/phase 的核心函数），或先给它补个测试。',
        blast.note ? `\n> ${blast.note}` : '',
      ]
    : [
        '# 突变探针 · 判定',
        '',
        `目标块：\`${chunk.name}\`  (\`${chunk.file}\`)`,
        blast.compileBroke ? '突变让 crate **无法编译**——这行是承重的。' : '',
        '',
        `- 你的预测：${o.predicted.map((t) => `\`${t}\``).join(', ') || '（无）'}`,
        `- 真实爆炸半径：${verdict.actual.map((t) => `\`${t}\``).join(', ') || '（无）'}`,
        `- 命中：${verdict.hits.join(', ') || '—'}`,
        `- 漏掉（真崩没预测到）：${verdict.misses.join(', ') || '—'}`,
        `- 误报（预测崩了没崩）：${verdict.falseAlarms.join(', ') || '—'}`,
        '',
        passed ? '✅ **通过**——已标记该块为 verified。' : '❌ 未通过——回去重读，尤其漏掉的那几个测试对应的行为。',
        blast.note ? `\n> ${blast.note}` : '',
      ];
  writeFileSync(verifyMd(o.outDir), lines.filter((l) => l !== '').join('\n'));
}
