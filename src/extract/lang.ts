/** 语言注册表：加一门语言 = 在这里加一项（wasm 名以 tree-sitter-wasms/out/ 下真实文件为准）。 */
export interface LangSpec {
  id: 'rust' | 'ruby';
  exts: string[];      // 命中任一扩展名即属于该语言
  wasm: string;        // tree-sitter-wasms/out/ 下的文件名
  query: string;       // 叶子查询：必须捕获 @fn（整个函数节点）与 @name（名字节点）
  fence: string;       // 标签 prompt 代码围栏语言标签
}

export const RUST: LangSpec = {
  id: 'rust',
  exts: ['.rs'],
  wasm: 'tree-sitter-rust.wasm',
  query: '(function_item name: (identifier) @name) @fn',
  fence: 'rust',
};

export const RUBY: LangSpec = {
  id: 'ruby',
  exts: ['.rb'],
  wasm: 'tree-sitter-ruby.wasm',
  // 实测（2026-07-08）：def foo → method / def self.foo → singleton_method，name 字段均为 identifier
  query: '(method name: (identifier) @name) @fn (singleton_method name: (identifier) @name) @fn',
  fence: 'ruby',
};

export const LANGS: LangSpec[] = [RUST, RUBY];

export function langOf(file: string): LangSpec | null {
  for (const l of LANGS) if (l.exts.some((e) => file.endsWith(e))) return l;
  return null;
}

/** 已注册语言 + 可选目录前缀过滤。前缀按目录边界匹配：'app' 只命中 app/ 下，不命中 apps/。 */
export function inScope(file: string, include?: string[]): boolean {
  if (!langOf(file)) return false;
  if (!include || include.length === 0) return true;
  return include.some((p) => file.startsWith(p.endsWith('/') ? p : p + '/'));
}
