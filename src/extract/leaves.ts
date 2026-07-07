import Parser from 'web-tree-sitter';
import { getParser } from './parser.js';
import type { LangSpec } from './lang.js';
import type { Leaf } from '../types.js';

const queries = new Map<string, Parser.Query>();

export async function extractLeaves(file: string, source: string, spec: LangSpec): Promise<Leaf[]> {
  const { parser, lang } = await getParser(spec);
  let query = queries.get(spec.id);
  if (!query) {
    query = lang.query(spec.query);
    queries.set(spec.id, query);
  }
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
