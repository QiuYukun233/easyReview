import { describe, it, expect } from 'vitest';
import { chooseMutation } from '../src/verify/mutate.js';
import type { Chunk, Leaf } from '../src/types.js';

const chunk: Chunk = { id: 'crates/chem_field/src/core/field.rs', name: 'field', file: 'crates/chem_field/src/core/field.rs', crate: 'chem_field', leafIds: ['f::step::5'] };
const leaves: Leaf[] = [
  { id: 'f::step::5', kind: 'fn', name: 'step', file: chunk.file, startLine: 5, endLine: 9, loc: 5 },
];
const source = [
  'line1', 'line2', 'line3', 'line4',
  'pub fn step(&mut self) {',        // 5
  '    let dt = 0.1;',               // 6  ← 第一个可注释语句
  '    self.value += dt;',           // 7
  '}',                               // 8
].join('\n');

describe('chooseMutation', () => {
  it('picks the first commentable statement line inside the function', () => {
    const op = chooseMutation(chunk, leaves, source)!;
    expect(op).not.toBeNull();
    expect(op.file).toBe(chunk.file);
    expect(op.line).toBe(6);
    expect(op.original).toBe('    let dt = 0.1;');
    expect(op.mutated).toBe('    // let dt = 0.1;');
  });

  it('returns null when no commentable line exists', () => {
    const emptyLeaf: Leaf[] = [{ id: 'x', kind: 'fn', name: 'x', file: chunk.file, startLine: 1, endLine: 2, loc: 2 }];
    expect(chooseMutation(chunk, emptyLeaf, 'pub fn x() {}\n')).toBeNull();
  });
});
