import { carveVueScript, type CarvedSegment } from './carve-vue.js';

/** 语言注册表：加一门语言 = 在这里加一项（wasm 名以 tree-sitter-wasms/out/ 下真实文件为准）。 */
export interface LangSpec {
  id: 'rust' | 'ruby' | 'js' | 'vue';
  exts: string[];      // 命中任一扩展名即属于该语言
  wasm: string;        // tree-sitter-wasms/out/ 下的文件名
  query: string;       // 叶子查询：必须捕获 @fn（整个函数节点）与 @name（名字节点）
  fence: string;       // 标签 prompt 代码围栏语言标签
  carve?: (source: string) => CarvedSegment[]; // parse 前区段切取；缺省=整文件、offset 0；[] = 无叶子
  exclude?: RegExp[];  // 命中任一即不进 scope（langOf 命中后 inScope 先查它）
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

// 实测（2026-07-13，对真实 tree-sitter-javascript.wasm）：五种形态覆盖 chatwoot 实际代码
// （function 声明含 generator / const 绑定箭头与函数表达式 / 对象与 class 的 shorthand 方法 /
//   pair 属性值为箭头或函数表达式）；export 外层包装不挡匹配；匿名回调与解构不被捕获。
const JS_QUERY = [
  '(function_declaration name: (identifier) @name) @fn',
  '(generator_function_declaration name: (identifier) @name) @fn',
  '(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @fn',
  '(method_definition name: (property_identifier) @name) @fn',
  '(pair key: (property_identifier) @name value: [(arrow_function) (function_expression)]) @fn',
].join('\n');

// 测试文件不进学习地图（与 Rails 侧 spec/ 被 --include app 天然排除对称）
const TEST_EXCLUDES = [/\.spec\.(js|vue)$/, /\.test\.(js|vue)$/, /(^|\/)specs?\//, /(^|\/)__tests__\//];

export const JS: LangSpec = {
  id: 'js',
  exts: ['.js'],
  wasm: 'tree-sitter-javascript.wasm',
  query: JS_QUERY,
  fence: 'javascript',
  exclude: TEST_EXCLUDES,
};

export const VUE: LangSpec = {
  id: 'vue',
  exts: ['.vue'],
  wasm: 'tree-sitter-javascript.wasm', // 复用 JS 语法：SFC 只切 <script> 区段来 parse
  query: JS_QUERY,
  fence: 'vue',
  carve: carveVueScript,
  exclude: TEST_EXCLUDES,
};

export const LANGS: LangSpec[] = [RUST, RUBY, JS, VUE];

export function langOf(file: string): LangSpec | null {
  for (const l of LANGS) if (l.exts.some((e) => file.endsWith(e))) return l;
  return null;
}

/** 已注册语言 + 排除规则 + 可选目录前缀过滤。前缀按目录边界匹配：'app' 只命中 app/ 下，不命中 apps/。 */
export function inScope(file: string, include?: string[]): boolean {
  const lang = langOf(file);
  if (!lang) return false;
  if (lang.exclude?.some((re) => re.test(file))) return false;
  if (!include || include.length === 0) return true;
  return include.some((p) => file.startsWith(p.endsWith('/') ? p : p + '/'));
}
