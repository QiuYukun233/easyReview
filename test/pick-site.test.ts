import { describe, it, expect } from 'vitest';
import { pickPreferredSite } from '../src/verify/pick-site.js';

describe('pickPreferredSite', () => {
  it('skips a constructor struct literal and picks the assignment in a logic fn', async () => {
    const src = [
      'fn new() -> Self {',
      '    Self { x: 1, y: 2 }',
      '}',
      'fn step(&mut self) {',
      '    let a = 1;',
      '    self.x = compute();',
      '    a + 1',
      '}',
    ].join('\n');
    const site = await pickPreferredSite(src);
    expect(site).toEqual({ line: 6, original: '    self.x = compute();' });
  });

  it('picks a compound assignment', async () => {
    const src = 'fn f(&mut self) {\n    self.n += 1;\n}\n';
    expect(await pickPreferredSite(src)).toEqual({ line: 2, original: '    self.n += 1;' });
  });

  it('picks a bare side-effecting call', async () => {
    const src = 'fn f(&mut self) {\n    self.items.push(3);\n}\n';
    expect(await pickPreferredSite(src)).toEqual({ line: 2, original: '    self.items.push(3);' });
  });

  it('returns null when only let bindings / tail exprs exist (no good statement)', async () => {
    const src = 'fn f() -> i32 {\n    let a = 1;\n    a + 1\n}\n';
    expect(await pickPreferredSite(src)).toBeNull();
  });

  it('does not pick a multi-line statement', async () => {
    const src = 'fn f(&mut self) {\n    self.do_it(\n        1,\n    );\n}\n';
    expect(await pickPreferredSite(src)).toBeNull();
  });
});
