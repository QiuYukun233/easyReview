import { describe, it, expect } from 'vitest';
import { highlightLines } from '../src/serve/highlight.js';

describe('highlightLines', () => {
  it('rust:关键字/字符串/注释/数字各着色', () => {
    const lines = highlightLines('fn main() {\n  let s = "yo"; // c\n  let n = 42;\n}', 'rust');
    expect(lines[0]).toContain('<span class="tok-k">fn</span>');
    expect(lines[1]).toContain('<span class="tok-s">&quot;yo&quot;</span>');
    expect(lines[1]).toContain('<span class="tok-c">// c</span>');
    expect(lines[2]).toContain('<span class="tok-n">42</span>');
  });

  it('ruby:def/end 关键字、# 注释、单引号字符串', () => {
    const lines = highlightLines("def foo\n  x = 'hi' # note\nend", 'ruby');
    expect(lines[0]).toContain('<span class="tok-k">def</span>');
    expect(lines[1]).toContain("<span class=\"tok-s\">'hi'</span>");
    expect(lines[1]).toContain('<span class="tok-c"># note</span>');
    expect(lines[2]).toContain('<span class="tok-k">end</span>');
  });

  it('HTML 必须被转义——<script> 绝不能原样穿透', () => {
    const lines = highlightLines('let x = "<script>alert(1)</script>";', 'rust');
    expect(lines[0]).not.toContain('<script>');
    expect(lines[0]).toContain('&lt;script&gt;');
  });

  it('lang=null → 纯转义,无 span', () => {
    expect(highlightLines('a < b\nc & d', null)).toEqual(['a &lt; b', 'c &amp; d']);
  });

  it('超长行(>2000)直接纯转义,不进 tokenizer(防病态正则回溯)', () => {
    const evil = ('"' + '\\').repeat(3000); // 引号+奇数反斜杠的病态构造,长度 6000 > 上限
    const start = Date.now();
    const [out] = highlightLines(evil, 'rust');
    expect(Date.now() - start).toBeLessThan(500);
    expect(out).not.toContain('<span');
    expect(out).toContain('&quot;');
  });
});
