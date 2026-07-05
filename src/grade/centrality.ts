import type { Leaf } from '../types.js';

/**
 * v1 近似中心度：chunk(文件)的所有函数名在其他文件源码中作为完整词出现的次数，
 * 归一化到 0..1。近似——同名/宏/方法分派会有噪音，将来由调用图/rust-analyzer 替换。
 */
export function nameFanInCentrality(
  leaves: Leaf[],
  sources: Record<string, string>,
): Record<string, number> {
  const filesByLeafFile = new Map<string, Set<string>>();
  for (const l of leaves) {
    if (!filesByLeafFile.has(l.file)) filesByLeafFile.set(l.file, new Set());
    filesByLeafFile.get(l.file)!.add(l.name);
  }

  const raw: Record<string, number> = {};
  for (const [file, names] of filesByLeafFile) {
    let count = 0;
    for (const name of names) {
      const re = new RegExp(`\\b${escapeRe(name)}\\b`, 'g');
      for (const [otherFile, src] of Object.entries(sources)) {
        if (otherFile === file) continue;
        count += (src.match(re) ?? []).length;
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
