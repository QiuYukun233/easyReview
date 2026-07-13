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

// 实测(2026-07-13):JS 语句 = expression_statement,子节点为调用/赋值/复合赋值;
// await x() 为 await_expression 包装(WRAPPERS 可复用下钻)。多行模板串使节点跨行,
// 单行过滤天然排除——无 Ruby heredoc 式兄弟节点陷阱。
const JS_TARGET = new Set(['call_expression', 'assignment_expression', 'augmented_assignment_expression']);

function unwrap(node: Parser.SyntaxNode | null): Parser.SyntaxNode | null {
  let n = node;
  while (n && WRAPPERS.has(n.type)) n = n.namedChild(0);
  return n;
}

// heredoc 陷阱:heredoc_body 是赋值/调用节点的兄弟而非后代,单行过滤拦不住开头行——
// 注释掉 `x = <<~SQL` 会让 heredoc 体变裸代码(SyntaxError),子树含 heredoc_beginning 一律排除。
function hasHeredoc(n: Parser.SyntaxNode): boolean {
  const stack: Parser.SyntaxNode[] = [n];
  while (stack.length) {
    const c = stack.pop()!;
    if (c.type === 'heredoc_beginning') return true;
    for (let i = 0; i < c.childCount; i++) stack.push(c.child(i)!);
  }
  return false;
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
 * - Rust:单行 expression_statement,首个具名子节点是赋值/复合赋值/调用/宏调用。
 * - Ruby:单行 call/assignment/operator_assignment 且处于语句位。
 * - JS:单行 expression_statement,子节点是调用/赋值/复合赋值(await/括号下钻)。
 * - Vue:按 carve 区段逐段挑(JS 规则),行号还原到真实文件;区段 row 0(与 <script>
 *   开标签同行)排除——注释整行会连标签一起注释掉。
 * 找不到返回 null。返回 1-based 行号 + 该行完整原文。
 */
export async function pickPreferredSite(
  source: string,
  langSpec: LangSpec = RUST,
): Promise<{ line: number; original: string } | null> {
  if (langSpec.carve) {
    const fullLines = source.split('\n');
    for (const seg of langSpec.carve(source)) {
      const site = await pickInSource(seg.source, langSpec, 1);
      if (site) {
        const row = site.line - 1 + seg.lineOffset;
        return { line: row + 1, original: fullLines[row] };
      }
    }
    return null;
  }
  return pickInSource(source, langSpec, 0);
}

async function pickInSource(
  source: string,
  langSpec: LangSpec,
  minRow: number,
): Promise<{ line: number; original: string } | null> {
  const { parser } = await getParser(langSpec);
  const tree = parser.parse(source);
  const lines = source.split('\n');
  try {
    if (langSpec.id === 'ruby') {
      const candidates = collect(tree.rootNode, (n) =>
        RUBY_TARGET.has(n.type) &&
        n.startPosition.row === n.endPosition.row &&
        n.startPosition.row >= minRow &&
        !!n.parent && RUBY_STMT_PARENT.has(n.parent.type) &&
        !hasHeredoc(n));
      return firstSiteOf(candidates, lines);
    }
    const target = langSpec.id === 'js' || langSpec.id === 'vue' ? JS_TARGET : RUST_TARGET;
    const stmts = collect(tree.rootNode, (n) => n.type === 'expression_statement');
    const candidates = stmts.filter((n) => {
      if (n.startPosition.row !== n.endPosition.row) return false;
      if (n.startPosition.row < minRow) return false;
      const inner = unwrap(n.namedChild(0));
      return !!inner && target.has(inner.type);
    });
    return firstSiteOf(candidates, lines);
  } finally {
    tree.delete();
  }
}
