import { readFileSync, writeFileSync } from 'node:fs';
import type { Chunk, Leaf, MutationOp } from '../types.js';
import { pickPreferredSite } from './pick-site.js';
import { langOf } from '../extract/lang.js';

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

function isCommentableRust(line: string): boolean {
  const t = line.trim();
  if (t === '') return false;
  if (t.startsWith('//') || t.startsWith('#[')) return false;
  if (t.startsWith('fn ') || t.startsWith('pub fn ')) return false;
  if (t.startsWith('}') || t.startsWith('{')) return false;
  if (t.endsWith('{')) return false; // 块起始（if/for/impl 头等）
  return true;
}

function isCommentableRuby(line: string): boolean {
  const t = line.trim();
  if (t === '' || t.startsWith('#')) return false;
  if (/^(def |end\b|class |module |if |unless |elsif |else\b|when |case\b|begin\b|rescue\b|ensure\b|until |while |for )/.test(t)) return false;
  if (/\bdo(\s*\|[^|]*\|)?\s*$/.test(t)) return false; // 块头(xxx.each do |i|)
  if (/<<[-~]?['"`]?[A-Za-z_]/.test(t)) return false; // heredoc 开头行——注释会让 heredoc 体变裸代码
  return true;
}

/** JS/Vue regex 回退:只要完整单行语句(以 ; 结尾);含反引号的行保守跳过——
 *  regex 层判不了模板串上下文。已知局限:多行模板串的内部行若不含反引号且以 ; 结尾
 *  仍可能被选中(注释它只是改字符串内容,不破坏语法,最坏 uncovered 兜底)。 */
function isCommentableJs(line: string): boolean {
  const t = line.trim();
  if (t === '' || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return false;
  if (!t.endsWith(';')) return false;
  if (t.includes('`')) return false;
  return true;
}

function buildOp(file: string, line: number, original: string): MutationOp {
  const indent = original.match(/^\s*/)?.[0] ?? '';
  const prefix = langOf(file)?.id === 'ruby' ? '# ' : '// ';
  return {
    file,
    line,
    original,
    mutated: `${indent}${prefix}${original.trim()}`,
    description: `注释掉 ${file}:${line} 的一行语句`,
  };
}

/** 为一个 chunk 选突变位点：优先 tree-sitter 挑"好语句"（赋值/调用→大概率红测试），
 *  挑不到回退 regex 扫描（loc≥3 函数逐行找第一条可注释语句,规则按语言）。都没有返回 null。 */
export async function chooseMutation(chunk: Chunk, leaves: Leaf[], source: string): Promise<MutationOp | null> {
  // 显式分派:未知语言返回 null,不再回退 RUST(PR #11 终审回访——拆掉被 runnerFor 遮蔽的陷阱)
  const lang = langOf(chunk.file);
  if (!lang) return null;
  const pref = await pickPreferredSite(source, lang);
  if (pref) return buildOp(chunk.file, pref.line, pref.original);

  // 回退：regex 逐行扫描（绝不退步）
  const commentable =
    lang.id === 'ruby' ? isCommentableRuby :
    lang.id === 'rust' ? isCommentableRust : isCommentableJs;
  const lines = source.split('\n');
  const fns = leaves.filter((l) => l.file === chunk.file && l.loc >= 3).sort((a, b) => a.startLine - b.startLine);
  for (const fn of fns) {
    for (let ln = fn.startLine; ln <= fn.endLine; ln++) {
      const original = lines[ln - 1];
      if (original !== undefined && commentable(original)) {
        return buildOp(chunk.file, ln, original);
      }
    }
  }
  return null;
}
