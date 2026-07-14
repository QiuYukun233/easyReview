import type { Leaf, Chunk, NodeId, ChunkRefIn } from '../types.js';

/**
 * v2 引用图中心度(2026-07-14,设计 spec:2026-07-14-centrality-refgraph-design.md):
 * 名字池 = 叶子名 ∪ 身份名(chunk.name;.rb 另加驼峰 url_helper→UrlHelper;非词 basename 不产),
 * df(名字出现过的文件数,含定义文件)> max(⌈5%N⌉,20) 的泛用名不建边;
 * 文件 f(非定义者)出现保留名字 ≥1 次即记 1(fin,防单文件刷分)→ 边 f→每个定义者,权重 1/定义者数;
 * 中心度 = 入边权重和归一化 0..1,全零 → {};refsIn = 每块入边 top-10(权重降序/平权 from 字典序/names 字典序)。
 *
 * 实测(chatwoot 2425 块):身份名边是最大单项增益(ApiClient #284→#14 级);PageRank 双仓实测
 * 差于加权入度(簇内自引环流霸榜),已否,数据留档 spec。身份名撞大众词的核心文件(message.rb)
 * 仍被低估——文本匹配固有局限。尾缀 ?/! 名字的 \b 怪癖原样继承(见 PR #14 spec)。
 * 仍是纯文本 token 级:「解析具体代码是复现阶段做的,不是读代码阶段做的」。
 *
 * 隐含约定:sources 与 chunks/leaves 必须同源于同一 inScope 文件集(cli.ts 保证)。sources 多出的
 * 文件会成为合法引用方(from),但 to 恒为块(definers 只来自 chunks/leaves);两套集合不一致时
 * refsIn.from 可能指向非块文件——别在别处以不一致的集合调用。
 * 词边界怪癖(评审实测)比「低估」更重:尾缀 ?/! 名字在真实调用点(后跟空格/括号/分号)基本
 * 建不了边,只有 valid?x 型后跟词字符的写法能命中——ruby bang/question 方法的扇入接近于零。
 */
const WORD = /[A-Za-z0-9_]+/g;
const isWordName = (s: string) => /^[A-Za-z0-9_]+$/.test(s);

export const GENERIC_DF_RATIO = 0.05;
export const GENERIC_DF_FLOOR = 20;
export const REFS_IN_TOP_K = 10;

export function genericDfCutoff(fileCount: number): number {
  return Math.max(Math.ceil(fileCount * GENERIC_DF_RATIO), GENERIC_DF_FLOOR);
}

/** url_helper → UrlHelper */
const camelize = (s: string) =>
  s.split('_').map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p)).join('');

export interface ReferenceGraphResult {
  centrality: Record<NodeId, number>;
  refsIn: Record<NodeId, ChunkRefIn[]>;
}

export function referenceGraphCentrality(
  chunks: Chunk[],
  leaves: Leaf[],
  sources: Record<string, string>,
): ReferenceGraphResult {
  // 名字池:name -> 定义者(块)文件集合
  const definers = new Map<string, Set<string>>();
  const addName = (name: string, file: string) => {
    if (!definers.has(name)) definers.set(name, new Set());
    definers.get(name)!.add(file);
  };
  for (const l of leaves) addName(l.name, l.file);
  for (const c of chunks) {
    if (isWordName(c.name)) addName(c.name, c.file);
    if (c.file.endsWith('.rb')) {
      const cam = camelize(c.name);
      if (isWordName(cam)) addName(cam, c.file);
    }
  }

  // 每文件词频表(词名的 df 与出现判定共用;与 \b 词边界定义严格一致)
  const tokenCounts = new Map<string, Map<string, number>>();
  for (const [file, src] of Object.entries(sources)) {
    const counts = new Map<string, number>();
    for (const m of src.matchAll(WORD)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
    tokenCounts.set(file, counts);
  }

  const cutoff = genericDfCutoff(Object.keys(sources).length);

  // 建边。键 `${from}\u0000${to}`——块 id 是相对路径,不含 NUL。
  const weights = new Map<string, number>();
  const edgeNames = new Map<string, string[]>();
  for (const [name, defs] of definers) {
    // 出现文件集合:词名查表;非词名 re.test(fin 只需存在性,不数次数)
    const hits: string[] = [];
    if (isWordName(name)) {
      for (const [f, counts] of tokenCounts) if (counts.has(name)) hits.push(f);
    } else {
      const re = new RegExp(`\\b${escapeRe(name)}\\b`);
      for (const [f, src] of Object.entries(sources)) if (re.test(src)) hits.push(f);
    }
    if (hits.length > cutoff) continue; // df 截断(df 含定义文件)
    const share = 1 / defs.size;
    for (const f of hits) {
      if (defs.has(f)) continue; // 自引不成边
      for (const d of defs) {
        const k = `${f}\u0000${d}`;
        weights.set(k, (weights.get(k) ?? 0) + share);
        if (!edgeNames.has(k)) edgeNames.set(k, []);
        edgeNames.get(k)!.push(name);
      }
    }
  }

  // 汇总:入度 + 每块入边
  const inDeg: Record<string, number> = {};
  for (const c of chunks) inDeg[c.file] = 0;
  const inEdges = new Map<string, ChunkRefIn[]>();
  for (const [k, w] of weights) {
    const [from, to] = k.split('\u0000');
    inDeg[to] = (inDeg[to] ?? 0) + w;
    if (!inEdges.has(to)) inEdges.set(to, []);
    inEdges.get(to)!.push({ from, weight: w, names: edgeNames.get(k)!.slice().sort() });
  }

  const max = Math.max(0, ...Object.values(inDeg));
  const centrality: Record<NodeId, number> = {};
  if (max > 0) for (const [f, n] of Object.entries(inDeg)) centrality[f] = n / max;

  const refsIn: Record<NodeId, ChunkRefIn[]> = {};
  for (const [to, list] of inEdges) {
    list.sort((a, b) => b.weight - a.weight || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    refsIn[to] = list.slice(0, REFS_IN_TOP_K);
  }
  return { centrality, refsIn };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
