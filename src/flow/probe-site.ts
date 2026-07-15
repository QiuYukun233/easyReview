import Parser from 'web-tree-sitter';
import { getParser } from '../extract/parser.js';
import { RUBY } from '../extract/lang.js';
import { pickPreferredSite } from '../verify/pick-site.js';

export interface ProbeSite {
  line: number;        // 1-based,全文件行号
  original: string;    // 原行(含缩进)
  scope: 'method' | 'file-fallback';
  method?: string;     // scope='method' 时:刀所在的流程命中方法
}

/** 在流程命中的方法体内挑位点:按传入序(=步的 methods 频次序)逐个方法试,
 *  方法体切片交给既有 pickPreferredSite(Ruby 语句偏好),行号映射回全文件并做整行一致性守卫。
 *  全部失败 → null(调用方回退文件级 chooseMutation 并标注)。 */
export async function pickSiteInMethods(
  source: string,
  defLines: { method: string; line: number }[],
): Promise<ProbeSite | null> {
  const { parser } = await getParser(RUBY);
  const tree = parser.parse(source);
  const lines = source.split('\n');
  try {
    const methods = collectMethodNodes(tree.rootNode);
    for (const d of defLines) {
      const node =
        methods.find((n) => n.startPosition.row + 1 === d.line) ??
        methods.find((n) => n.startPosition.row + 1 <= d.line && n.endPosition.row + 1 >= d.line);
      if (!node) continue;
      const startRow = node.startPosition.row;
      const slice = lines.slice(startRow, node.endPosition.row + 1).join('\n');
      const site = await pickPreferredSite(slice, RUBY);
      if (!site) continue;
      const row = startRow + site.line - 1;
      if (lines[row] !== site.original) continue; // 整行一致性守卫(理论上恒真——切片是整行拼接)
      return { line: row + 1, original: site.original, scope: 'method', method: d.method };
    }
    return null;
  } finally {
    tree.delete();
  }
}

function collectMethodNodes(root: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  const walk = (n: Parser.SyntaxNode): void => {
    if (n.type === 'method' || n.type === 'singleton_method') out.push(n);
    for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i)!);
  };
  walk(root);
  return out;
}
