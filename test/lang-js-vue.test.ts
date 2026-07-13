import { describe, it, expect } from 'vitest';
import { langOf, inScope, JS, VUE } from '../src/extract/lang.js';

describe('JS/Vue registry entries', () => {
  it('langOf maps extensions', () => {
    expect(langOf('app/javascript/dashboard/helper/URLHelper.js')?.id).toBe('js');
    expect(langOf('app/javascript/widget/App.vue')?.id).toBe('vue');
    expect(langOf('app/models/user.rb')?.id).toBe('ruby');
    expect(langOf('src/main.rs')?.id).toBe('rust');
  });

  it('vue reuses the JS grammar and query, but carves', () => {
    expect(VUE.wasm).toBe(JS.wasm);
    expect(VUE.query).toBe(JS.query);
    expect(typeof VUE.carve).toBe('function');
    expect(JS.carve).toBeUndefined();
  });

  it('test files are excluded from scope', () => {
    expect(inScope('app/javascript/dashboard/store/foo.spec.js')).toBe(false);
    expect(inScope('app/javascript/dashboard/store/foo.test.js')).toBe(false);
    expect(inScope('app/javascript/dashboard/specs/helper.js')).toBe(false);
    expect(inScope('app/javascript/widget/spec/thing.js')).toBe(false);
    expect(inScope('app/javascript/dashboard/__tests__/thing.vue')).toBe(false);
    expect(inScope('app/javascript/widget/Foo.spec.vue')).toBe(false);
    expect(inScope('app/javascript/widget/Foo.test.vue')).toBe(false);
  });

  it('exclusion respects directory boundaries and does not over-match', () => {
    expect(inScope('app/javascript/myspecs/helper.js')).toBe(true);   // myspecs/ 不是 specs/
    expect(inScope('app/javascript/dashboard/inspector.js')).toBe(true); // 文件名含 spec 不误伤
    expect(inScope('spec/models/user_spec.rb')).toBe(true);           // ruby 无 exclude,行为零变化
  });

  it('--include still filters by dir prefix on top of language', () => {
    expect(inScope('app/javascript/widget/App.vue', ['app'])).toBe(true);
    expect(inScope('config/webpack.js', ['app'])).toBe(false);
  });
});
