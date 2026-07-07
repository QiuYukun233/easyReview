import Parser from 'web-tree-sitter';
import { getRustParser } from './parser.js';
import type { Leaf } from '../types.js';

const QUERY = '(function_item name: (identifier) @name) @fn';
let query: Parser.Query | null = null;

export async function extractLeaves(file: string, source: string): Promise<Leaf[]> {
  const { parser, lang } = await getRustParser();
  if (!query) query = lang.query(QUERY);
  const tree = parser.parse(source);
  const leaves: Leaf[] = [];
  for (const m of query.matches(tree.rootNode)) {
    const fnNode = m.captures.find((c) => c.name === 'fn')!.node;
    const nameNode = m.captures.find((c) => c.name === 'name')!.node;
    const startLine = fnNode.startPosition.row + 1;
    const endLine = fnNode.endPosition.row + 1;
    const name = nameNode.text;
    leaves.push({
      id: `${file}::${name}::${startLine}`,
      kind: 'fn',
      name,
      file,
      startLine,
      endLine,
      loc: endLine - startLine + 1,
    });
  }
  tree.delete();
  return leaves;
}
