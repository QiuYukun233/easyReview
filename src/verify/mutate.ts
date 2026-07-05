import { readFileSync, writeFileSync } from 'node:fs';
import type { Chunk, Leaf, MutationOp } from '../types.js';

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

/** 为一个 chunk 选一个突变位点（注释掉某函数体内第一条语句）。找不到返回 null。 */
export function chooseMutation(chunk: Chunk, leaves: Leaf[], source: string): MutationOp | null {
  const lines = source.split('\n');
  const fns = leaves.filter((l) => l.file === chunk.file && l.loc >= 3).sort((a, b) => a.startLine - b.startLine);
  for (const fn of fns) {
    for (let ln = fn.startLine; ln <= fn.endLine; ln++) {
      const original = lines[ln - 1];
      if (original !== undefined && isCommentable(original)) {
        const indent = original.match(/^\s*/)?.[0] ?? '';
        return {
          file: chunk.file,
          line: ln,
          original,
          mutated: `${indent}// ${original.trim()}`,
          description: `注释掉 ${chunk.file}:${ln} 的一行语句`,
        };
      }
    }
  }
  return null;
}
