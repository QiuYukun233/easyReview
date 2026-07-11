import type { TestRun } from './runner.js';

interface RspecExample { file_path?: string; status?: string; }

/**
 * 从混着 compose/bundler 噪音的输出里提取 rspec --format json 的汇总行(单行 JSON,带 examples 键),
 * 聚合到 spec 文件级:文件 passed ⟺ 无 failed example(pending 不算失败)。
 * 无可解析 JSON 或 0 个 example → compiled:false(加载期崩,Ruby 的"编译崩"等价物)。
 */
export function parseRspecJson(output: string): TestRun {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t.startsWith('{')) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(t); } catch { continue; }
    const examples = (parsed as { examples?: RspecExample[] }).examples;
    if (!Array.isArray(examples)) continue;
    if (examples.length === 0) return { compiled: false, results: [] };
    const byFile = new Map<string, boolean>();
    for (const ex of examples) {
      const raw = ex.file_path ?? '';
      const file = raw.startsWith('./') ? raw.slice(2) : raw;
      if (!file) continue;
      byFile.set(file, (byFile.get(file) ?? true) && ex.status !== 'failed');
    }
    return { compiled: true, results: [...byFile.entries()].map(([name, passed]) => ({ name, passed })) };
  }
  return { compiled: false, results: [] };
}
