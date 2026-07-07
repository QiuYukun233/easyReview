#!/usr/bin/env tsx
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTree } from './extract/tree.js';
import { logNameOnly, listTrackedFiles } from './git.js';
import { relativeChurn } from './grade/churn.js';
import { changeCoupling } from './grade/coupling.js';
import { ownershipConcentration } from './grade/ownership.js';
import { nameFanInCentrality } from './grade/centrality.js';
import { gradeTree } from './grade/grade.js';
import { renderMapMarkdown } from './render/map-md.js';
import type { Labeler } from './types.js';
import { collectLabelInputs, labelChunks } from './label/label.js';
import { loadLabelCache, saveLabelCache } from './label/cache.js';
import { makeClaudeLabelerFromEnv } from './label/claude.js';
import { makeDeepSeekLabelerFromEnv } from './label/deepseek.js';

export interface MapOptions {
  repo: string;
  outDir: string;
  labeler?: Labeler | null; // 测试注入 fake；显式 null = 不打标签；缺省 = 按 provider+env 决定
  noLabel?: boolean;        // --no-label：即使有 key 也跳过
  model?: string;           // --model：覆盖默认模型（deepseek-v4-flash / claude-haiku-4-5）
  provider?: 'deepseek' | 'claude'; // --provider：默认 deepseek
}

export function resolveLabeler(opts: MapOptions): Labeler | null {
  if (opts.noLabel) return null;
  if (opts.labeler !== undefined) return opts.labeler; // 显式注入（含 null）优先
  const provider = opts.provider ?? 'deepseek';
  return provider === 'claude'
    ? makeClaudeLabelerFromEnv(opts.model)
    : makeDeepSeekLabelerFromEnv(opts.model);
}

export async function runMap(opts: MapOptions): Promise<void> {
  const { repo, outDir } = opts;
  const tree = await buildTree(repo);
  const log = logNameOnly(repo);

  const sources: Record<string, string> = {};
  for (const f of listTrackedFiles(repo).filter((x) => x.endsWith('.rs'))) {
    sources[f] = readFileSync(join(repo, f), 'utf8');
  }

  const graded = gradeTree(tree, {
    relChurn: relativeChurn(log),
    coupling: changeCoupling(log),
    ownership: ownershipConcentration(log),
    centrality: nameFanInCentrality(tree.leaves, sources),
  });

  writeFileSync(join(outDir, 'easyreview.tree.json'), JSON.stringify(graded, null, 2));
  writeFileSync(join(outDir, 'easyreview.map.md'), renderMapMarkdown(graded));

  // ── LLM 块标签（纯增强；无论如何 tree/map 已经落盘）──
  const labelPath = join(outDir, 'easyreview.labels.json');
  const cache = loadLabelCache(labelPath);
  const inputs = collectLabelInputs(graded, sources);
  const labeler = resolveLabeler(opts);
  const updated = await labelChunks(inputs, cache, labeler);
  saveLabelCache(labelPath, updated);
}

function parseArgs(argv: string[]): MapOptions {
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  return {
    repo: get('--repo', process.cwd()),
    outDir: get('--out', process.cwd()),
    noLabel: argv.includes('--no-label'),
    model: get('--model', '') || undefined,
    provider: get('--provider', 'deepseek') === 'claude' ? 'claude' : 'deepseek',
  };
}

const cmd = process.argv[2];
if (cmd === 'map') {
  runMap(parseArgs(process.argv.slice(3)))
    .then(() => console.log('✓ wrote easyreview.tree.json + easyreview.map.md + labels.json'))
    .catch((e) => { console.error(e); process.exit(1); });
}

if (cmd === 'learn') {
  import('./cli-learn.js').then(({ runLearn }) =>
    runLearn({ outDir: parseArgs(process.argv.slice(3)).outDir })
      .then(() => console.log('✓ wrote easyreview.journey.md + progress + lit map'))
      .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); }),
  );
}

if (cmd === 'done') {
  const rest = process.argv.slice(3);
  // 取第一个位置参数：跳过 --flag 本身及紧跟其后的取值（兼容 `done --out . <id>` 与 `done <id> --out .`）
  const chunkId = rest.find((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
  if (!chunkId) { console.error('用法: easyreview done <chunkId> [--out <dir>]'); process.exit(1); }
  import('./cli-learn.js').then(({ runDone }) =>
    runDone({ outDir: parseArgs(rest).outDir, chunkId })
      .then(() => console.log(`✓ marked ${chunkId} understood`))
      .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); }),
  );
}

if (cmd === 'verify') {
  const rest = process.argv.slice(3);
  const chunkId = rest.find((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
  if (!chunkId) { console.error('用法: easyreview verify <chunkId> [--predict a,b] [--repo <p>] [--out <d>]'); process.exit(1); }
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

if (cmd === 'serve') {
  const rest = process.argv.slice(3);
  const { outDir } = parseArgs(rest);
  const pi = rest.indexOf('--port');
  const port = pi >= 0 && rest[pi + 1] ? Number(rest[pi + 1]) : 4870;
  import('./cli-serve.js').then(({ runServe }) =>
    runServe({ outDir, port })
      .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); }),
  );
}
