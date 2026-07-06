import { readFileSync, writeFileSync } from 'node:fs';
import type { Chunk, Leaf, MutationOp } from '../types.js';
import { pickPreferredSite } from './pick-site.js';

/**
 * 在 absFile 上临时施突变、跑 fn、无条件还原。
 * 用 \n join 写回；要求文件用 \n 行尾（Rust 源通常如此）。
 */
export async function withMutation<T>(absFile: string, op: MutationOp, fn: () => Promise<T>): Promise<T> {
  const original = readFileSync(absFile, 'utf8');
  const lines = original.split('\n');
  const idx = op.line - 1;
  if (lines[idx] !== op.original) {
    throw new Error(`mutation site mismatch at ${op.file}:${op.line} — expected ${JSON.stringify(op.original)}, found ${JSON.stringify(lines[idx])}`);
  }
  const mutated = [...lines];
  mutated[idx] = op.mutated;
  writeFileSync(absFile, mutated.join('\n'));
  try {
    return await fn();
  } finally {
    writeFileSync(absFile, original);
  }
}

function isCommentable(line: string): boolean {
  const t = line.trim();
  if (t === '') return false;
  if (t.startsWith('//') || t.startsWith('#[')) return false;
  if (t.startsWith('fn ') || t.startsWith('pub fn ')) return false;
  if (t.startsWith('}') || t.startsWith('{')) return false;
  if (t.endsWith('{')) return false; // 块起始（if/for/impl 头等）
  return true;
}

function buildOp(file: string, line: number, original: string): MutationOp {
  const indent = original.match(/^\s*/)?.[0] ?? '';
  return {
    file,
    line,
    original,
    mutated: `${indent}// ${original.trim()}`,
    description: `注释掉 ${file}:${line} 的一行语句`,
  };
}

/** 为一个 chunk 选突变位点：优先 tree-sitter 挑"好语句"（赋值/调用→大概率红测试），
 *  挑不到回退现有 regex 扫描（loc≥3 函数逐行找第一条可注释语句）。都没有返回 null。 */
export async function chooseMutation(chunk: Chunk, leaves: Leaf[], source: string): Promise<MutationOp | null> {
  const pref = await pickPreferredSite(source);
  if (pref) return buildOp(chunk.file, pref.line, pref.original);

  // 回退：现有 regex 逻辑（绝不退步）
  const lines = source.split('\n');
  const fns = leaves.filter((l) => l.file === chunk.file && l.loc >= 3).sort((a, b) => a.startLine - b.startLine);
  for (const fn of fns) {
    for (let ln = fn.startLine; ln <= fn.endLine; ln++) {
      const original = lines[ln - 1];
      if (original !== undefined && isCommentable(original)) {
        return buildOp(chunk.file, ln, original);
      }
    }
  }
  return null;
}
