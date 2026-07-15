import { describe, it, expect } from 'vitest';
import { pickSiteInMethods } from '../src/flow/probe-site.js';

const RUBY_SRC = [
  'class Foo',
  '  def alpha',
  '    do_thing(1)',
  '  end',
  '',
  '  def beta',
  '    x = compute',
  '  end',
  '',
  '  def empty_guard',
  '  end',
  'end',
].join('\n');

describe('pickSiteInMethods(流程命中方法体内落刀,spec §4)', () => {
  it('定位含定义行的 method 节点,体内挑到语句且行号映射回全文件', async () => {
    const site = await pickSiteInMethods(RUBY_SRC, [{ method: 'alpha', line: 2 }]);
    expect(site).toEqual({ line: 3, original: '    do_thing(1)', scope: 'method', method: 'alpha' });
  });

  it('多方法按传入序优先(先命中先用)', async () => {
    const site = await pickSiteInMethods(RUBY_SRC, [
      { method: 'beta', line: 6 },
      { method: 'alpha', line: 2 },
    ]);
    expect(site!.method).toBe('beta');
    expect(site!.line).toBe(7);
  });

  it('方法体无可注释语句 → 试下一个方法', async () => {
    const site = await pickSiteInMethods(RUBY_SRC, [
      { method: 'empty_guard', line: 10 },
      { method: 'alpha', line: 2 },
    ]);
    expect(site!.method).toBe('alpha');
  });

  it('全部方法都挑不到 → null(调用方回退文件级)', async () => {
    const site = await pickSiteInMethods(RUBY_SRC, [{ method: 'empty_guard', line: 10 }]);
    expect(site).toBeNull();
  });

  it('单例方法(def self.x)也能定位落刀', async () => {
    const src = ['class Foo', '  def self.build', '    make_it(2)', '  end', 'end'].join('\n');
    const site = await pickSiteInMethods(src, [{ method: 'build', line: 2 }]);
    expect(site).toEqual({ line: 3, original: '    make_it(2)', scope: 'method', method: 'build' });
  });

  it('嵌套 def:范围包含只接受同名——内层被正确定位而非误归外层', async () => {
    const src = ['def outer', '  setup_thing', '  def inner', '    inner_call(3)', '  end', 'end'].join('\n');
    const site = await pickSiteInMethods(src, [{ method: 'inner', line: 4 }]);
    expect(site!.method).toBe('inner');
    expect(site!.line).toBe(4);
    expect(site!.original).toBe('    inner_call(3)');
  });

  it('范围包含但无同名方法 → 不冒认,返回 null(调用方回退并标注)', async () => {
    const src = ['def outer', '  setup_thing', 'end'].join('\n');
    const site = await pickSiteInMethods(src, [{ method: 'ghost', line: 2 }]);
    expect(site).toBeNull();
  });
});
