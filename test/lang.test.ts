import { describe, it, expect } from 'vitest';
import { langOf, inScope, RUST, RUBY } from '../src/extract/lang.js';

describe('langOf', () => {
  it('maps extensions to registered langs, unknown → null', () => {
    expect(langOf('crates/foo/src/lib.rs')).toBe(RUST);
    expect(langOf('app/models/user.rb')).toBe(RUBY);
    expect(langOf('README.md')).toBeNull();
    expect(langOf('a.vue')).toBeNull();          // 本轮未注册
  });

  it('carries fence tags for label prompts', () => {
    expect(RUST.fence).toBe('rust');
    expect(RUBY.fence).toBe('ruby');
  });
});

describe('inScope', () => {
  it('filters by registered language and optional dir-boundary prefixes', () => {
    expect(inScope('app/models/user.rb')).toBe(true);                      // 无 include = 全收
    expect(inScope('app/models/user.rb', ['app'])).toBe(true);
    expect(inScope('apps/other.rb', ['app'])).toBe(false);                 // 目录边界:app ≠ apps
    expect(inScope('lib/util.rb', ['app'])).toBe(false);
    expect(inScope('lib/util.rb', ['app', 'lib'])).toBe(true);
    expect(inScope('app/readme.md', ['app'])).toBe(false);                 // 未注册语言永远 false
    expect(inScope('app/models/user.rb', [])).toBe(true);                  // 空数组 = 不过滤
  });
});
