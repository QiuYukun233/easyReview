import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flowIdFor } from './flow-id.js';
import type { FlowCandidate, FlowCandidatesFile } from '../types.js';

const FILE = 'easyreview.flow-candidates.json';

/** 读不出/损坏 → null(视同没跑过 discover,serve 与 CLI 共用此容错口径,同 flows.ts)。 */
export function loadCandidates(outDir: string): FlowCandidatesFile | null {
  const p = join(outDir, FILE);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as FlowCandidatesFile;
    return Array.isArray(parsed.candidates) ? parsed : null;
  } catch {
    console.warn('⚠ easyreview.flow-candidates.json 解析失败,忽略(候选段将不显示)');
    return null;
  }
}

export function saveCandidates(outDir: string, file: FlowCandidatesFile): void {
  writeFileSync(join(outDir, FILE), JSON.stringify(file, null, 2));
}

interface DryRunExample { full_description?: string; file_path?: string; line_number?: number }

/** rspec --dry-run --format json 的 examples[] → 候选。从底向上找可解析的 { 行,
 *  容忍容器/bundler 提示语粘污染(同 rspec-parse.ts 口径)。缺 file_path/line_number 的跳过。 */
export function parseDryRun(output: string): FlowCandidate[] {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t.startsWith('{')) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(t); } catch { continue; }
    const examples = (parsed as { examples?: DryRunExample[] }).examples;
    if (!Array.isArray(examples)) continue;
    const out: FlowCandidate[] = [];
    for (const ex of examples) {
      const raw = ex.file_path ?? '';
      const file = raw.startsWith('./') ? raw.slice(2) : raw;
      if (!file || ex.line_number == null) continue;
      const spec = file + ':' + ex.line_number;
      out.push({ id: flowIdFor(file, ex.line_number), name: ex.full_description ?? spec, spec });
    }
    return out;
  }
  return [];
}

/** 0 候选时区分成因:dry-run 输出含 rspec 加载错误标记 → 'load-error'(环境没起好,如 test 库未建),
 *  否则 'empty'(该目录确实没有可枚举的 example)。给 discover 挑更贴切的警示用。 */
export function emptyDryRunReason(output: string): 'load-error' | 'empty' {
  return output.includes('An error occurred while loading') ? 'load-error' : 'empty';
}
