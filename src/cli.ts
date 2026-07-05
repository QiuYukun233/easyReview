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

export interface MapOptions { repo: string; outDir: string; }

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
}

function parseArgs(argv: string[]): MapOptions {
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  return { repo: get('--repo', process.cwd()), outDir: get('--out', process.cwd()) };
}

const cmd = process.argv[2];
if (cmd === 'map') {
  runMap(parseArgs(process.argv.slice(3)))
    .then(() => console.log('✓ wrote easyreview.tree.json + easyreview.map.md'))
    .catch((e) => { console.error(e); process.exit(1); });
}
