/** 轻量行级高亮:四类 token(注释/字符串/数字/关键字),先转义 HTML 再包 span——与页面 esc() 同一条纪律。
 *  行级=不处理跨行结构(块注释/heredoc/跨行模板字符串),换取零状态、绝不误伤;失败降级为纯转义文本。 */
import type { LangSpec } from '../extract/lang.js';

type LangId = LangSpec['id'];

const JS_KEYWORDS = new Set(['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield']);

const KEYWORDS: Record<LangId, Set<string>> = {
  rust: new Set(['as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while']),
  ruby: new Set(['alias', 'and', 'begin', 'break', 'case', 'class', 'def', 'do', 'else', 'elsif', 'end', 'ensure', 'false', 'for', 'if', 'in', 'module', 'next', 'nil', 'not', 'or', 'raise', 'redo', 'rescue', 'retry', 'return', 'self', 'super', 'then', 'true', 'undef', 'unless', 'until', 'when', 'while', 'yield', 'require', 'require_relative', 'include', 'extend', 'attr_reader', 'attr_writer', 'attr_accessor']),
  js: JS_KEYWORDS,
  vue: JS_KEYWORDS,
};

const JS_TOKEN_RE = /(\/\/.*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_]*(?:\.\d+)?)|([A-Za-z_$][A-Za-z0-9_$]*)/g;

// 捕获组次序即 token 类型:1=注释 2=字符串 3=数字 4=词(查关键字表)
const TOKEN_RE: Record<LangId, RegExp> = {
  rust: /(\/\/.*)|("(?:[^"\\]|\\.)*")|(\b\d[\d_]*(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*!?)/g,
  ruby: /(#.*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d[\d_]*(?:\.\d+)?)|(:?[A-Za-z_][A-Za-z0-9_]*[?!]?)/g,
  js: JS_TOKEN_RE,
  vue: JS_TOKEN_RE,
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function highlightLines(source: string, langId: LangId | null): string[] {
  const lines = source.split('\n');
  if (!langId) return lines.map(escapeHtml);
  try {
    return lines.map((l) => highlightLine(l, langId));
  } catch {
    return lines.map(escapeHtml); // 高亮挂了就纯文本,绝不影响源码展示
  }
}

function highlightLine(line: string, langId: LangId): string {
  if (line.length > 2000) return escapeHtml(line); // 病态长行(压缩/生成文件)不值得着色,防正则 O(n²) 拖死事件循环
  const re = TOKEN_RE[langId];
  const kw = KEYWORDS[langId];
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out += escapeHtml(line.slice(last, m.index));
    const tok = m[0];
    if (m[1] !== undefined) out += '<span class="tok-c">' + escapeHtml(tok) + '</span>';
    else if (m[2] !== undefined) out += '<span class="tok-s">' + escapeHtml(tok) + '</span>';
    else if (m[3] !== undefined) out += '<span class="tok-n">' + escapeHtml(tok) + '</span>';
    else if (kw.has(tok)) out += '<span class="tok-k">' + escapeHtml(tok) + '</span>';
    else out += escapeHtml(tok);
    last = m.index + tok.length;
  }
  return out + escapeHtml(line.slice(last));
}
