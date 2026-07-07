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

  it('unwraps a ?-terminated call statement', async () => {
    const src = 'fn f(&mut self) -> Result<(), E> {\n    self.step()?;\n    Ok(())\n}\n';
    expect(await pickPreferredSite(src)).toEqual({ line: 2, original: '    self.step()?;' });
  });

  it('unwraps a .await call statement', async () => {
    const src = 'fn f(&mut self) {\n    self.step().await;\n}\n';
    expect(await pickPreferredSite(src)).toEqual({ line: 2, original: '    self.step().await;' });
  });

  it('picks a macro invocation statement', async () => {
    const src = 'fn f() {\n    println!("{}", 1);\n}\n';
    expect(await pickPreferredSite(src)).toEqual({ line: 2, original: '    println!("{}", 1);' });
  });

  it('descends into nested control-flow blocks', async () => {
    const src = 'fn f(&mut self) {\n    if cond {\n        self.x = 1;\n    }\n}\n';
    expect(await pickPreferredSite(src)).toEqual({ line: 3, original: '        self.x = 1;' });
  });
});
