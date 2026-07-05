import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import Parser from 'web-tree-sitter';
import type { Leaf } from '../types.js';

const require = createRequire(import.meta.url);

let parserPromise: Promise<Parser> | null = null;
let lang: Parser.Language | null = null;

async function getParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init();
      const wasmPath = require.resolve('tree-sitter-wasms/out/tree-sitter-rust.wasm');
      lang = await Parser.Language.load(readFileSync(wasmPath));
      const p = new Parser();
      p.setLanguage(lang);
      return p;
    })();
  }
  return parserPromise;
}

const QUERY = '(function_item name: (identifier) @name) @fn';

export async function extractLeaves(file: string, source: string): Promise<Leaf[]> {
  const parser = await getParser();
  const tree = parser.parse(source);
  const query = lang!.query(QUERY);
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
  return leaves;
}
