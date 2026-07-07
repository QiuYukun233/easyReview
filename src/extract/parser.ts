import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import Parser from 'web-tree-sitter';
import { RUST, type LangSpec } from './lang.js';

const require = createRequire(import.meta.url);

let parserInit: Promise<void> | null = null;
const cache = new Map<string, Promise<{ parser: Parser; lang: Parser.Language }>>();

/** 按语言的 tree-sitter parser 单例（parser + language）。Parser.init 全局只跑一次。 */
export async function getParser(spec: LangSpec): Promise<{ parser: Parser; lang: Parser.Language }> {
  let p = cache.get(spec.id);
  if (!p) {
    p = (async () => {
      if (!parserInit) parserInit = Parser.init();
      await parserInit;
      const wasmPath = require.resolve(`tree-sitter-wasms/out/${spec.wasm}`);
      const lang = await Parser.Language.load(readFileSync(wasmPath));
      const parser = new Parser();
      parser.setLanguage(lang);
      return { parser, lang };
    })();
    cache.set(spec.id, p);
  }
  return p;
}

/** 兼容旧调用（verify/pick-site.ts）：Rust parser 单例。 */
export function getRustParser(): Promise<{ parser: Parser; lang: Parser.Language }> {
  return getParser(RUST);
}
