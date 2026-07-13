import { describe, it, expect } from 'vitest';
import { nameFanInCentrality } from '../src/grade/centrality.js';
import type { Leaf } from '../src/types.js';

const leaf = (file: string, name: string): Leaf => ({
  id: `${file}::${name}::1`, kind: 'fn', name, file, startLine: 1, endLine: 1, loc: 1,
});

describe('nameFanInCentrality', () => {
  it('counts cross-file identifier occurrences of a chunk\'s function names', () => {
    const leaves = [leaf('util.rs', 'helper'), leaf('main.rs', 'run')];
    const sources: Record<string, string> = {
      'util.rs': 'pub fn helper() {}',
      'main.rs': 'fn run() { helper(); helper(); }',
    };
    const cen = nameFanInCentrality(leaves, sources);
    expect(cen['util.rs']).toBe(1);
    expect(cen['main.rs'] ?? 0).toBe(0);
  });
});

// —— 以下为 2026-07-13 分词化新增:与旧正则实现的等价性由 naiveReference 锁定 ——

/** 旧实现原样搬来做参照(每名字建正则×每文件扫)。 */
function naiveReference(leaves: Leaf[], sources: Record<string, string>): Record<string, number> {
  const filesByLeafFile = new Map<string, Set<string>>();
  for (const l of leaves) {
    if (!filesByLeafFile.has(l.file)) filesByLeafFile.set(l.file, new Set());
    filesByLeafFile.get(l.file)!.add(l.name);
  }
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const raw: Record<string, number> = {};
  for (const [file, names] of filesByLeafFile) {
    let count = 0;
    for (const name of names) {
      const re = new RegExp(`\\b${esc(name)}\\b`, 'g');
      for (const [otherFile, src] of Object.entries(sources)) {
        if (otherFile === file) continue;
        count += (src.match(re) ?? []).length;
      }
    }
    raw[file] = count;
  }
  const max = Math.max(0, ...Object.values(raw));
  if (max === 0) return {};
  const out: Record<string, number> = {};
  for (const [f, n] of Object.entries(raw)) out[f] = n / max;
  return out;
}

describe('nameFanInCentrality tokenized rewrite', () => {
  it('matches the old regex implementation on word-boundary edge cases', () => {
    const leaves = [
      leaf('a.js', 'foo'), leaf('a.js', 'bar'),
      leaf('b.js', 'foo_bar'),
      leaf('c.js', 'baz'),
    ];
    const sources: Record<string, string> = {
      'a.js': 'foo_bar(); foo(); bar();',
      'b.js': 'foo(); foo.bar(); "foo"; foo_bar_x(); x_foo_bar();',
      'c.js': 'foofoo(); foo(); { bar: 1 } foo_bar();',
    };
    expect(nameFanInCentrality(leaves, sources)).toEqual(naiveReference(leaves, sources));
  });

  it('non-word-char names (ruby valid?/save!) fall back to regex, same as old', () => {
    const leaves = [leaf('m.rb', 'valid?'), leaf('n.rb', 'plain')];
    const sources: Record<string, string> = {
      'm.rb': 'def valid?; end',
      'n.rb': 'valid?x; valid? ; plain(); if valid?y then plain end',
    };
    expect(nameFanInCentrality(leaves, sources)).toEqual(naiveReference(leaves, sources));
  });

  it('all-zero stays empty record', () => {
    const leaves = [leaf('a.js', 'nowhere')];
    const sources = { 'a.js': 'nowhere()', 'b.js': 'unrelated()' };
    expect(nameFanInCentrality(leaves, sources)).toEqual({});
  });

  it('names with $ or unicode chars stay equivalent via fallback (WORD must mirror \\w)', () => {
    const leaves = [leaf('u.js', 'get$ref'), leaf('v.js', 'café')];
    const sources: Record<string, string> = {
      'u.js': 'caféx(); get$ref();',
      'v.js': 'x$get$ref; get$ref(); x = café + caféx;',
    };
    expect(nameFanInCentrality(leaves, sources)).toEqual(naiveReference(leaves, sources));
  });
});
