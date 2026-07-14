import { describe, it, expect } from 'vitest';
import { referenceGraphCentrality, genericDfCutoff } from '../src/grade/centrality.js';
import type { Leaf, Chunk } from '../src/types.js';

const leaf = (file: string, name: string): Leaf => ({
  id: `${file}::${name}::1`, kind: 'fn', name, file, startLine: 1, endLine: 1, loc: 1,
});
// 与 buildTree 一致:name = 无扩展名 basename
const chunk = (file: string): Chunk => ({
  id: file, name: file.split('/').pop()!.replace(/\.[^.]+$/, ''), file, crate: 'app', leafIds: [],
});

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

describe('referenceGraphCentrality(引用图加权入度,spec:2026-07-14-centrality-refgraph-design.md)', () => {
  it('叶子名成边:引用方指向定义块,中心度与 refsIn 都记账', () => {
    const chunks = [chunk('util.js'), chunk('main.js')];
    const leaves = [leaf('util.js', 'helperFn')];
    const sources = { 'util.js': 'export function helperFn() {}', 'main.js': 'helperFn();' };
    const { centrality, refsIn } = referenceGraphCentrality(chunks, leaves, sources);
    expect(centrality['util.js']).toBe(1);
    expect(centrality['main.js']).toBe(0);
    expect(refsIn['util.js']).toEqual([{ from: 'main.js', weight: 1, names: ['helperFn'] }]);
    expect(refsIn['main.js'] ?? []).toEqual([]);
  });

  it('fin 计数:同一引用文件出现 5 次,权重仍 1', () => {
    const chunks = [chunk('lib.js'), chunk('spam.js')];
    const leaves = [leaf('lib.js', 'thing')];
    const sources = { 'lib.js': 'thing', 'spam.js': 'thing thing thing thing thing' };
    const { refsIn } = referenceGraphCentrality(chunks, leaves, sources);
    expect(refsIn['lib.js']).toEqual([{ from: 'spam.js', weight: 1, names: ['thing'] }]);
  });

  it('身份名成边:import ApiClient 场景,叶子名不可见时块仍有入度', () => {
    const chunks = [chunk('ApiClient.js'), chunk('users.js')];
    const leaves = [leaf('ApiClient.js', 'get')]; // 只在定义文件出现,产不了叶子边
    const sources = {
      'ApiClient.js': 'export default class ApiClient {}',
      'users.js': "import ApiClient from './ApiClient';",
    };
    const { centrality, refsIn } = referenceGraphCentrality(chunks, leaves, sources);
    expect(refsIn['ApiClient.js']).toEqual([{ from: 'users.js', weight: 1, names: ['ApiClient'] }]);
    expect(centrality['ApiClient.js']).toBe(1);
  });

  it('rb 驼峰身份名:url_helper.rb 被 UrlHelper 引用成边', () => {
    const chunks = [chunk('app/helpers/url_helper.rb'), chunk('app/models/msg.rb')];
    const leaves = [leaf('app/helpers/url_helper.rb', 'build_url')];
    const sources = {
      'app/helpers/url_helper.rb': 'module UrlHelper; def build_url; end; end',
      'app/models/msg.rb': 'include UrlHelper',
    };
    const { refsIn } = referenceGraphCentrality(chunks, leaves, sources);
    expect(refsIn['app/helpers/url_helper.rb']).toEqual([
      { from: 'app/models/msg.rb', weight: 1, names: ['UrlHelper'] },
    ]);
  });

  it('非词 basename(foo-bar.js)不产身份名', () => {
    const chunks = [chunk('foo-bar.js'), chunk('user.js')];
    const leaves = [leaf('foo-bar.js', 'doThing')];
    const sources = { 'foo-bar.js': 'export const doThing = () => {};', 'user.js': 'bar(); foo();' };
    const { centrality, refsIn } = referenceGraphCentrality(chunks, leaves, sources);
    expect(refsIn['foo-bar.js'] ?? []).toEqual([]);
    expect(centrality).toEqual({}); // 无任何边 → 全零 → {}
  });

  it('df 截断作用于身份名:泛用文件名 index 不建边,具体叶子名照常', () => {
    const chunks = [chunk('lib/index.js'), ...Array.from({ length: 21 }, (_, i) => chunk(`c${i + 1}.js`))];
    const leaves = [leaf('lib/index.js', 'specialFn')];
    const sources: Record<string, string> = { 'lib/index.js': 'export const specialFn = () => {}; // index' };
    for (let i = 1; i <= 21; i++) sources[`c${i}.js`] = `import x from '../index';` + (i === 1 ? ' specialFn();' : '');
    // 22 文件,cutoff=20;index df=22(lib/index.js 注释 + c1..c21)→ 截;specialFn df=2 → 成边
    const { refsIn } = referenceGraphCentrality(chunks, leaves, sources);
    expect(refsIn['lib/index.js']).toEqual([{ from: 'c1.js', weight: 1, names: ['specialFn'] }]);
  });

  it('多定义均分:同名两定义者各得 0.5', () => {
    const chunks = [chunk('a.js'), chunk('b.js'), chunk('c.js')];
    const leaves = [leaf('a.js', 'sharedFn'), leaf('b.js', 'sharedFn')];
    const sources = { 'a.js': 'sharedFn', 'b.js': 'sharedFn', 'c.js': 'sharedFn();' };
    const { centrality, refsIn } = referenceGraphCentrality(chunks, leaves, sources);
    expect(refsIn['a.js']).toEqual([{ from: 'c.js', weight: 0.5, names: ['sharedFn'] }]);
    expect(refsIn['b.js']).toEqual([{ from: 'c.js', weight: 0.5, names: ['sharedFn'] }]);
    expect(centrality['a.js']).toBe(1); // 0.5 是全场最大 → 归一化 1
    expect(centrality['c.js']).toBe(0);
  });

  it('自引不成边:定义文件里出现自己的名字不计', () => {
    const chunks = [chunk('solo.js')];
    const leaves = [leaf('solo.js', 'me')];
    const sources = { 'solo.js': 'const me = () => me();' };
    expect(referenceGraphCentrality(chunks, leaves, sources)).toEqual({ centrality: {}, refsIn: {} });
  });

  it('同一引用方多名字:权重累加、names 字典序', () => {
    const chunks = [chunk('Util.js'), chunk('use.js')];
    const leaves = [leaf('Util.js', 'zip'), leaf('Util.js', 'alpha')];
    const sources = {
      'Util.js': 'export const zip = 1, alpha = 2;',
      'use.js': "import Util from './Util'; Util.zip(); Util.alpha();",
    };
    const { refsIn } = referenceGraphCentrality(chunks, leaves, sources);
    expect(refsIn['Util.js']).toEqual([{ from: 'use.js', weight: 3, names: ['Util', 'alpha', 'zip'] }]);
  });

  it('归一化:入度除以全场最大,无边块为 0', () => {
    const chunks = [chunk('pop.js'), chunk('mid.js'), chunk('u1.js'), chunk('u2.js')];
    const leaves = [leaf('pop.js', 'popFn'), leaf('mid.js', 'midFn')];
    const sources = {
      'pop.js': 'popFn', 'mid.js': 'midFn',
      'u1.js': 'popFn(); midFn();', 'u2.js': 'popFn();',
    };
    const { centrality } = referenceGraphCentrality(chunks, leaves, sources);
    expect(centrality['pop.js']).toBe(1);   // 入度 2
    expect(centrality['mid.js']).toBe(0.5); // 入度 1
    expect(centrality['u1.js']).toBe(0);
  });

  it('refsIn top-10:权重降序、平权 from 字典序、超出截断', () => {
    const chunks = [chunk('core.js'), ...Array.from({ length: 11 }, (_, i) => chunk(`f${String(i + 1).padStart(2, '0')}.js`))];
    const leaves = [leaf('core.js', 'coreFnA'), leaf('core.js', 'coreFnB')];
    const sources: Record<string, string> = { 'core.js': 'coreFnA coreFnB' };
    for (let i = 1; i <= 11; i++) sources[`f${String(i).padStart(2, '0')}.js`] = 'coreFnA' + (i === 11 ? '; coreFnB' : '');
    const { refsIn } = referenceGraphCentrality(chunks, leaves, sources);
    const list = refsIn['core.js'];
    expect(list).toHaveLength(10);
    expect(list[0]).toEqual({ from: 'f11.js', weight: 2, names: ['coreFnA', 'coreFnB'] }); // 权重最高在前
    expect(list.slice(1).map((r) => r.from)).toEqual(
      ['f01.js', 'f02.js', 'f03.js', 'f04.js', 'f05.js', 'f06.js', 'f07.js', 'f08.js', 'f09.js'],
    ); // 平权按 from 字典序,f10.js 被 top-10 截掉
  });
});
