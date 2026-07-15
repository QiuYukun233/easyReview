import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Flow, FlowsFile } from '../types.js';

const FILE = 'easyreview.flows.json';

/** 读不出/损坏 → null(视同不存在,serve 与 CLI 共用此容错口径)。 */
export function loadFlows(outDir: string): FlowsFile | null {
  const p = join(outDir, FILE);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as FlowsFile;
    return Array.isArray(parsed.flows) ? parsed : null;
  } catch { return null; }
}

export function saveFlows(outDir: string, flows: FlowsFile): void {
  writeFileSync(join(outDir, FILE), JSON.stringify(flows, null, 2));
}

/** 同 id 替换(保位),新 id 追加;null 起新文件。 */
export function upsertFlow(file: FlowsFile | null, flow: Flow): FlowsFile {
  const flows = file ? [...file.flows] : [];
  const i = flows.findIndex((f) => f.id === flow.id);
  if (i >= 0) flows[i] = flow; else flows.push(flow);
  return { version: 1, flows };
}
