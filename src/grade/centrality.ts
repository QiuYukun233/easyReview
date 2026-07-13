import type { Leaf } from '../types.js';

/**
 * v1 近似中心度：chunk(文件)的所有函数名在其他文件源码中作为完整词出现的次数，
 * 归一化到 0..1。近似——同名/宏/方法分派会有噪音，将来由调用图/rust-analyzer 替换。
 *
 * 2026-07-13 分词化：每文件单遍分词建词频表（[A-Za-z0-9_]+，与 \b 词边界定义严格一致）。
 * 建表 O(总字符数)；查表主循环仍是 O(名字×文件)，但单次代价从「正则扫全文」降到 Map.get，
 * 实测 2800 文件×1.2 万名字约几秒。含非词字符的名字（ruby 的 valid?/save!，chatwoot 后端约 13%）
 * 走旧的逐名字正则回退，行为零变化——这是仅存的慢路径，将来可做词干+后缀专用分词。
 */
const WORD = /[A-Za-z0-9_]+/g;
const isWordName = (s: string) => /^[A-Za-z0-9_]+$/.test(s);

export function nameFanInCentrality(
  leaves: Leaf[],
  sources: Record<string, string>,
): Record<string, number> {
  const filesByLeafFile = new Map<string, Set<string>>();
  for (const l of leaves) {
    if (!filesByLeafFile.has(l.file)) filesByLeafFile.set(l.file, new Set());
    filesByLeafFile.get(l.file)!.add(l.name);
  }

  const tokenCounts = new Map<string, Map<string, number>>();
  for (const [file, src] of Object.entries(sources)) {
    const counts = new Map<string, number>();
    for (const m of src.matchAll(WORD)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
    tokenCounts.set(file, counts);
  }

  const raw: Record<string, number> = {};
  for (const [file, names] of filesByLeafFile) {
    let count = 0;
    for (const name of names) {
      if (isWordName(name)) {
        for (const [otherFile, counts] of tokenCounts) {
          if (otherFile === file) continue;
          count += counts.get(name) ?? 0;
        }
      } else {
        const re = new RegExp(`\\b${escapeRe(name)}\\b`, 'g');
        for (const [otherFile, src] of Object.entries(sources)) {
          if (otherFile === file) continue;
          count += (src.match(re) ?? []).length;
        }
      }
    }
    raw[file] = count;
  }
  const max = Math.max(0, ...Object.values(raw));
  if (max === 0) return {};
  const out: Record<string, number> = {};
  for (const [f, n] of Object.entries(raw)) out[f] = n / max;
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
