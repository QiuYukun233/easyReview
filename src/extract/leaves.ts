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
  // carve：parse 前区段切取（Vue 切 <script> 块）；缺省 = 整文件一个区段
  const segments = spec.carve ? spec.carve(source) : [{ source, lineOffset: 0 }];
  const leaves: Leaf[] = [];
  for (const seg of segments) {
    const tree = parser.parse(seg.source);
    try {
      for (const m of query.matches(tree.rootNode)) {
        const fnNode = m.captures.find((c) => c.name === 'fn')!.node;
        const nameNode = m.captures.find((c) => c.name === 'name')!.node;
        const startLine = fnNode.startPosition.row + 1 + seg.lineOffset;
        const endLine = fnNode.endPosition.row + 1 + seg.lineOffset;
        const name = nameNode.text;
        leaves.push({
          // id 不带列号:同文件同行同名会撞——carve 前对单段文件已如此,非新引入
          id: `${file}::${name}::${startLine}`,
          kind: 'fn',
          name,
          file,
          startLine,
          endLine,
          loc: endLine - startLine + 1,
        });
      }
    } finally {
      tree.delete();
    }
  }
  return leaves;
}
