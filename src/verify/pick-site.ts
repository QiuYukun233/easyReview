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

function sitesOf(candidates: Parser.SyntaxNode[], lines: string[]): Array<{ line: number; original: string }> {
  return [...candidates]
    .sort((a, b) => a.startIndex - b.startIndex)
    .map((n) => ({ line: n.startPosition.row + 1, original: lines[n.startPosition.row] }));
}

/**
 * 挑一个"好语句"位点(注释后大概率某测试变红而非白改):
 * - Rust:单行 expression_statement,首个具名子节点是赋值/复合赋值/调用/宏调用。
 * - Ruby:单行 call/assignment/operator_assignment 且处于语句位。
 * - JS:单行 expression_statement,子节点是调用/赋值/复合赋值(await/括号下钻)。
 * - Vue:按 carve 区段逐段挑(JS 规则),行号还原到真实文件;半行守卫:区段行与真实
 *   文件行逐字节一致才可信——开标签行剩余、闭标签同行、字符串内假闭标签导致的截断行都被它挡住。
 * 找不到返回 null。返回 1-based 行号 + 该行完整原文。
 */
export async function pickPreferredSite(
  source: string,
  langSpec: LangSpec = RUST,
): Promise<{ line: number; original: string } | null> {
  if (langSpec.carve) {
    const fullLines = source.split('\n');
    for (const seg of langSpec.carve(source)) {
      for (const site of await pickInSource(seg.source, langSpec)) {
        const row = site.line - 1 + seg.lineOffset;
        // 字节一致性守卫:区段内该行必须与真实文件整行逐字节相同,才允许整行注释——
        // 开标签行剩余(前缀被切)、闭标签同行(后缀被切)等半行情形一律跳过。
        if (fullLines[row] === site.original) return { line: row + 1, original: site.original };
      }
    }
    return null;
  }
  const first = (await pickInSource(source, langSpec))[0];
  return first ?? null;
}

async function pickInSource(
  source: string,
  langSpec: LangSpec,
): Promise<Array<{ line: number; original: string }>> {
  const { parser } = await getParser(langSpec);
  const tree = parser.parse(source);
  const lines = source.split('\n');
  try {
    if (langSpec.id === 'ruby') {
      const candidates = collect(tree.rootNode, (n) =>
        RUBY_TARGET.has(n.type) &&
        n.startPosition.row === n.endPosition.row &&
        !!n.parent && RUBY_STMT_PARENT.has(n.parent.type) &&
        !hasHeredoc(n));
      return sitesOf(candidates, lines);
    }
    const target = langSpec.id === 'js' || langSpec.id === 'vue' ? JS_TARGET : RUST_TARGET;
    const stmts = collect(tree.rootNode, (n) => n.type === 'expression_statement');
    const candidates = stmts.filter((n) => {
      if (n.startPosition.row !== n.endPosition.row) return false;
      const inner = unwrap(n.namedChild(0));
      return !!inner && target.has(inner.type);
    });
    return sitesOf(candidates, lines);
  } finally {
    tree.delete();
  }
}
