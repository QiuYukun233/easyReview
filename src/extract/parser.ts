import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import Parser from 'web-tree-sitter';

const require = createRequire(import.meta.url);

let initPromise: Promise<{ parser: Parser; lang: Parser.Language }> | null = null;

/** 共享的 Rust tree-sitter parser 单例（parser + language）。多处复用，避免重复 init。 */
export async function getRustParser(): Promise<{ parser: Parser; lang: Parser.Language }> {
  if (!initPromise) {
    initPromise = (async () => {
      await Parser.init();
      const wasmPath = require.resolve('tree-sitter-wasms/out/tree-sitter-rust.wasm');
      const lang = await Parser.Language.load(readFileSync(wasmPath));
      const parser = new Parser();
      parser.setLanguage(lang);
      return { parser, lang };
    })();
  }
  return initPromise;
}
