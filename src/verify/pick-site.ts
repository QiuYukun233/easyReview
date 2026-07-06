import Parser from 'web-tree-sitter';
import { getRustParser } from '../extract/parser.js';

const TARGET = new Set([
  'assignment_expression',
  'compound_assignment_expr',
  'call_expression',
  'macro_invocation',
]);

/**
 * 用 tree-sitter 挑一个"好语句"位点：单行的 expression_statement，其首个具名子节点
 * 是赋值/复合赋值/裸调用/宏调用——注释后大概率某测试变红（而非编译崩）。
 * 天然跳过 let 绑定、结构体字面量字段、tail 返回表达式。找不到返回 null。
 * 返回该行 1-based 行号 + 该行完整原文。
 */
export async function pickPreferredSite(
  source: string,
): Promise<{ line: number; original: string } | null> {
  const { parser } = await getRustParser();
  const tree = parser.parse(source);
  const lines = source.split('\n');

  // 递归收集所有 expression_statement 节点
  const stmts: Parser.SyntaxNode[] = [];
  const stack: Parser.SyntaxNode[] = [tree.rootNode];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'expression_statement') stmts.push(n);
    for (let i = 0; i < n.childCount; i++) stack.push(n.child(i)!);
  }

  const candidates = stmts.filter((n) => {
    if (n.startPosition.row !== n.endPosition.row) return false; // 仅单行
    const inner = n.namedChild(0);
    return !!inner && TARGET.has(inner.type);
  });
  tree.delete();

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.startIndex - b.startIndex); // 源码顺序
  const row = candidates[0].startPosition.row;
  return { line: row + 1, original: lines[row] };
}
