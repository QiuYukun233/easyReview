import Parser from 'web-tree-sitter';
import { getParser } from '../extract/parser.js';
import { RUST, RUBY, type LangSpec } from '../extract/lang.js';

const RUST_TARGET = new Set([
  'assignment_expression',
  'compound_assignment_expr',
  'call_expression',
  'macro_invocation',
]);

// 包装表达式：try(`x?`)/await(`x.await`)/括号(`(x)`)——下钻到内层真正的调用/赋值
const WRAPPERS = new Set(['try_expression', 'await_expression', 'parenthesized_expression']);

const RUBY_TARGET = new Set(['call', 'assignment', 'operator_assignment']);
// 语句位父节点:方法体/块体/begin/分支体/顶层
const RUBY_STMT_PARENT = new Set(['body_statement', 'do_block', 'block_body', 'begin', 'then', 'else', 'program']);

function unwrap(node: Parser.SyntaxNode | null): Parser.SyntaxNode | null {
  let n = node;
  while (n && WRAPPERS.has(n.type)) n = n.namedChild(0);
  return n;
}

function collect(root: Parser.SyntaxNode, pred: (n: Parser.SyntaxNode) => boolean): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  const stack: Parser.SyntaxNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (pred(n)) out.push(n);
    for (let i = 0; i < n.childCount; i++) stack.push(n.child(i)!);
  }
  return out;
}

function firstSiteOf(candidates: Parser.SyntaxNode[], lines: string[]): { line: number; original: string } | null {
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.startIndex - b.startIndex);
  const row = candidates[0].startPosition.row;
  return { line: row + 1, original: lines[row] };
}

/**
 * 挑一个"好语句"位点(注释后大概率某测试变红而非白改):
 * - Rust:单行 expression_statement,首个具名子节点是赋值/复合赋值/调用/宏调用(原逻辑不变)。
 * - Ruby:单行 call/assignment/operator_assignment 且处于语句位(父节点为方法体/块体等)。
 * 找不到返回 null。返回 1-based 行号 + 该行完整原文。
 */
export async function pickPreferredSite(
  source: string,
  langSpec: LangSpec = RUST,
): Promise<{ line: number; original: string } | null> {
  const { parser } = await getParser(langSpec);
  const tree = parser.parse(source);
  const lines = source.split('\n');
  try {
    if (langSpec.id === 'ruby') {
      const candidates = collect(tree.rootNode, (n) =>
        RUBY_TARGET.has(n.type) &&
        n.startPosition.row === n.endPosition.row &&
        !!n.parent && RUBY_STMT_PARENT.has(n.parent.type));
      return firstSiteOf(candidates, lines);
    }
    const stmts = collect(tree.rootNode, (n) => n.type === 'expression_statement');
    const candidates = stmts.filter((n) => {
      if (n.startPosition.row !== n.endPosition.row) return false;
      const inner = unwrap(n.namedChild(0));
      return !!inner && RUST_TARGET.has(inner.type);
    });
    return firstSiteOf(candidates, lines);
  } finally {
    tree.delete();
  }
}
