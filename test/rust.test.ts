import { describe, it, expect } from 'vitest';
import { extractLeaves } from '../src/extract/leaves.js';
import { RUST } from '../src/extract/lang.js';

const SRC = `
pub fn top() -> i32 { 1 }

struct S;
impl S {
    fn method(&self) {
        let x = 1;
    }
}
`;

describe('extractLeaves', () => {
  it('finds free functions and impl methods with line spans', async () => {
    const leaves = await extractLeaves('src/s.rs', SRC, RUST);
    const names = leaves.map((l) => l.name).sort();
    expect(names).toEqual(['method', 'top']);
    const top = leaves.find((l) => l.name === 'top')!;
    expect(top.file).toBe('src/s.rs');
    expect(top.kind).toBe('fn');
    expect(top.startLine).toBeGreaterThan(0);
    expect(top.endLine).toBeGreaterThanOrEqual(top.startLine);
    expect(top.loc).toBe(top.endLine - top.startLine + 1);
  });
});
