import type { Leaf } from '../types.js';

/**
 * v1 近似中心度:chunk(文件)的所有函数名在其他文件源码中作为完整词出现的次数,
 * 归一化到 0..1。近似——同名/宏/方法分派会有噪音,将来由引用图/调用图替换。
 *
 * 2026-07-13 分词化:每文件单遍分词建词频表([A-Za-z0-9_]+,与 \b 词边界定义严格一致)。
 * 建表 O(总字符数);查表主循环仍是 O(名字×文件),但单次代价从「正则扫全文」降到 Map.get,
 * 实测 2800 文件×1.2 万名字约几秒。含非词字符的名字(ruby 的 valid?/save!,chatwoot 后端约 13%)
 * 走逐名字正则回退,将来可做词干+后缀专用分词。
 *
 * 2026-07-14 泛用名截断:df(名字出现过的文件数,含定义文件)超过 max(⌈5%×N⌉, 20) 的名字
 * 视为词汇噪音,贡献归零。撞语言关键字的叶子名(chatwoot 的 import action 匹配全库 import
 * 语句 9611 次)和大众词(get/new/default)由此消音;5% 阈值实测天然吸收语言关键字停用表
 * (开关结果一字不差),故不维护关键字清单;20 文件下限保护小仓库(umwelt N=68 时 5%=4
 * 会误杀 place_neuron 等真领域名)。实测定稿见 spec:2026-07-14-centrality-generic-cutoff-design.md。
 */
const WORD = /[A-Za-z0-9_]+/g;
const isWordName = (s: string) => /^[A-Za-z0-9_]+$/.test(s);

export const GENERIC_DF_RATIO = 0.05;
export const GENERIC_DF_FLOOR = 20;

export function genericDfCutoff(fileCount: number): number {
  return Math.max(Math.ceil(fileCount * GENERIC_DF_RATIO), GENERIC_DF_FLOOR);
}

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

  // 逐唯一名字统计 df;非词名在同一趟正则扫描里顺手记逐文件出现次数
  // (旧实现按 (文件,名字) 对全库扫,同名多处定义会重复扫——此处按唯一名字扫一趟,行为不变)。
  const allNames = new Set<string>();
  for (const names of filesByLeafFile.values()) for (const n of names) allNames.add(n);

  const df = new Map<string, number>();
  const nonWordOcc = new Map<string, Map<string, number>>();
  for (const name of allNames) {
    if (isWordName(name)) {
      let d = 0;
      for (const counts of tokenCounts.values()) if (counts.has(name)) d++;
      df.set(name, d);
    } else {
      const re = new RegExp(`\\b${escapeRe(name)}\\b`, 'g');
      const occ = new Map<string, number>();
      let d = 0;
      for (const [file, src] of Object.entries(sources)) {
        const c = (src.match(re) ?? []).length;
        if (c > 0) { occ.set(file, c); d++; }
      }
      df.set(name, d);
      nonWordOcc.set(name, occ);
    }
  }

  const cutoff = genericDfCutoff(Object.keys(sources).length);

  const raw: Record<string, number> = {};
  for (const [file, names] of filesByLeafFile) {
    let count = 0;
    for (const name of names) {
      if (df.get(name)! > cutoff) continue; // 泛用名:词汇噪音,不计入扇入
      if (isWordName(name)) {
        for (const [otherFile, counts] of tokenCounts) {
          if (otherFile === file) continue;
          count += counts.get(name) ?? 0;
        }
      } else {
        for (const [otherFile, c] of nonWordOcc.get(name)!) {
          if (otherFile === file) continue;
          count += c;
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
