import { describe, it, expect } from 'vitest';
import { chooseMutation } from '../src/verify/mutate.js';
import type { Chunk, Leaf } from '../src/types.js';

const chunk: Chunk = { id: 'crates/chem_field/src/core/field.rs', name: 'field', file: 'crates/chem_field/src/core/field.rs', crate: 'chem_field', leafIds: ['f::step::5'] };
const leaves: Leaf[] = [
  { id: 'f::step::5', kind: 'fn', name: 'step', file: chunk.file, startLine: 5, endLine: 9, loc: 5 },
];

describe('chooseMutation', () => {
  it('upgrades: prefers the compound-assignment statement over the earlier let binding', async () => {
    const source = [
      'line1', 'line2', 'line3', 'line4',
      'pub fn step(&mut self) {',   // 5
      '    let dt = 0.1;',          // 6  (旧行为会挑这行)
      '    self.value += dt;',      // 7  (新行为：复合赋值=好语句，优先)
      '}',                          // 8
    ].join('\n');
    const op = (await chooseMutation(chunk, leaves, source))!;
    expect(op).not.toBeNull();
    expect(op.file).toBe(chunk.file);
    expect(op.line).toBe(7);
    expect(op.original).toBe('    self.value += dt;');
    expect(op.mutated).toBe('    // self.value += dt;');
  });

  it('falls back to regex when no preferred statement exists (never regresses)', async () => {
    const source = [
      'line1', 'line2', 'line3', 'line4',
      'pub fn calc() -> f32 {',   // 5
      '    let dt = 0.1;',        // 6  (只有 let + tail，无好语句)
      '    dt + 1.0',             // 7  (tail 表达式，不选)
      '}',                        // 8
    ].join('\n');
    const op = (await chooseMutation(chunk, leaves, source))!;
    expect(op).not.toBeNull();
    expect(op.line).toBe(6); // 回退 regex：第一条 commentable 是 let dt = 0.1;
    expect(op.original).toBe('    let dt = 0.1;');
    expect(op.mutated).toBe('    // let dt = 0.1;');
  });

  it('returns null when no commentable line exists', async () => {
    const emptyLeaf: Leaf[] = [{ id: 'x', kind: 'fn', name: 'x', file: chunk.file, startLine: 1, endLine: 2, loc: 2 }];
    expect(await chooseMutation(chunk, emptyLeaf, 'pub fn x() {}\n')).toBeNull();
  });
});
