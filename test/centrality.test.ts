import { describe, it, expect } from 'vitest';
import { nameFanInCentrality, genericDfCutoff } from '../src/grade/centrality.js';
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

// —— 以下为 2026-07-14 泛用名截断新增(spec:2026-07-14-centrality-generic-cutoff-design.md)——
// 注意:上面的 naiveReference 对拍夹具都 <20 文件,截断永不触发,契约原样成立。

describe('genericDfCutoff', () => {
  it('小仓库走 20 文件下限(umwelt N=68 时 5% 阈值=4 会误杀真领域名)', () => {
    expect(genericDfCutoff(68)).toBe(20);
  });

  it('N=400 恰为 5% 与下限的交界,401 起 5% 分支生效', () => {
    expect(genericDfCutoff(400)).toBe(20);
    expect(genericDfCutoff(401)).toBe(21);
  });

  it('大仓库走 ceil(5%)(chatwoot N=2425 → 122)', () => {
    expect(genericDfCutoff(2425)).toBe(122);
  });
});

describe('nameFanInCentrality 泛用名截断', () => {
  it('df == cutoff 计入、df == cutoff+1 截断(下限档,22 个合成文件)', () => {
    const leaves = [leaf('a.js', 'cut21'), leaf('b.js', 'keep20')];
    const sources: Record<string, string> = { 'a.js': 'cut21();', 'b.js': 'keep20();' };
    // cut21 出现在 a.js + o1..o20 → df=21 > cutoff(20) → 截断
    // keep20 出现在 b.js + o1..o19 → df=20 == cutoff → 计入,他文件出现 19 次
    for (let i = 1; i <= 20; i++) sources[`o${i}.js`] = 'cut21();';
    for (let i = 1; i <= 19; i++) sources[`o${i}.js`] += ' keep20();';
    const cen = nameFanInCentrality(leaves, sources);
    expect(cen['b.js']).toBe(1); // keep20 的 19 次是全场唯一非零 → max → 1
    expect(cen['a.js'] ?? 0).toBe(0); // cut21 被截断 → raw 0
  });

  it('撞关键字的叶子名(import)不再霸榜——chatwoot 灾难合成用例', () => {
    const leaves = [leaf('actions.js', 'import'), leaf('api.js', 'fetchThing')];
    const sources: Record<string, string> = {
      'actions.js': 'export const doImport = () => {}; // import action',
      'api.js': 'export function fetchThing() {}',
    };
    // 每个消费者文件都有 import 语句;只有 c1..c5 真调 fetchThing
    for (let i = 1; i <= 21; i++) {
      sources[`c${i}.js`] = `import x from 'y';` + (i <= 5 ? ' fetchThing();' : '');
    }
    // 23 文件,cutoff=20;import df=22(actions.js 注释 + c1..c21)→ 截断;fetchThing df=6 → 计 5 次
    const cen = nameFanInCentrality(leaves, sources);
    expect(cen['api.js']).toBe(1);
    expect(cen['actions.js'] ?? 0).toBe(0);
  });

  it('非词名(valid?)走正则回退同样受截断', () => {
    const leaves = [leaf('m.rb', 'valid?'), leaf('n.rb', 'compute_thing')];
    // \bvalid\?\b 要求 ? 后紧跟词字符才有边界(新旧实现一致的既有怪癖),夹具统一用 valid?x 形式
    const sources: Record<string, string> = { 'm.rb': 'valid?x = 1', 'n.rb': 'def compute_thing; end' };
    for (let i = 1; i <= 20; i++) {
      sources[`r${i}.rb`] = 'valid?x && go' + (i <= 3 ? '; compute_thing' : '');
    }
    // 22 文件,cutoff=20;valid? df=21(m.rb+r1..r20)→ 截断;compute_thing df=4 → 计 3 次
    const cen = nameFanInCentrality(leaves, sources);
    expect(cen['n.rb']).toBe(1);
    expect(cen['m.rb'] ?? 0).toBe(0);
  });

  it('非词名 df == cutoff 恰好计入(回退路径边界)', () => {
    const leaves = [leaf('m.rb', 'valid?'), leaf('n.rb', 'compute_thing')];
    const sources: Record<string, string> = { 'm.rb': 'valid?x = 1', 'n.rb': 'def compute_thing; end' };
    for (let i = 1; i <= 19; i++) sources[`r${i}.rb`] = 'valid?x && go';
    sources['r20.rb'] = 'compute_thing';
    sources['r21.rb'] = 'compute_thing';
    // 23 文件,cutoff=20;valid? df=20(m.rb+r1..r19)== cutoff → 计入 19 次;compute_thing df=3 → 计 2 次
    const cen = nameFanInCentrality(leaves, sources);
    expect(cen['m.rb']).toBe(1);
    expect(cen['n.rb']).toBeCloseTo(2 / 19);
  });

  it('同文件混合:超限名字归零、其余名字照常累计', () => {
    const leaves = [leaf('mix.js', 'ubiquitous'), leaf('mix.js', 'special'), leaf('z.js', 'anchor')];
    const sources: Record<string, string> = {
      'mix.js': 'ubiquitous(); special(); anchor();',
      'z.js': 'anchor(); special(); special();',
    };
    for (let i = 1; i <= 21; i++) sources[`u${i}.js`] = 'ubiquitous();';
    // 23 文件,cutoff=20;ubiquitous df=22 → 截断;special df=2 → mix 计 2;anchor df=2 → z 计 1
    const cen = nameFanInCentrality(leaves, sources);
    expect(cen['mix.js']).toBe(1); // 2/2;若 ubiquitous 未被截,raw=2+21=23
    expect(cen['z.js']).toBe(0.5); // 1/2;若 ubiquitous 未被截,z≈1/23≈0.043 —— 此断言使截断不可少
  });

  it('文件全部名字被截断且无其它信号 → 空表(沿用 max=0 行为)', () => {
    const leaves = [leaf('a.js', 'everywhere')];
    const sources: Record<string, string> = { 'a.js': 'everywhere();' };
    for (let i = 1; i <= 21; i++) sources[`e${i}.js`] = 'everywhere();';
    // 22 文件,cutoff=20;everywhere df=22 → 截断 → raw 全 0 → {}
    expect(nameFanInCentrality(leaves, sources)).toEqual({});
  });
});
