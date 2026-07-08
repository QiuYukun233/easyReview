import { describe, it, expect } from 'vitest';
import { extractLeaves } from '../src/extract/leaves.js';
import { RUBY, RUST } from '../src/extract/lang.js';

const RUBY_SRC = `class User < ApplicationRecord
  def full_name
    "x"
  end

  def self.find_by_email(email)
    where(email: email).first
  end
end

module Util
  def helper; 1; end
end

CONST = 42
`;

describe('extractLeaves (ruby)', () => {
  it('extracts instance and singleton methods with correct lines/loc', async () => {
    const leaves = await extractLeaves('app/models/user.rb', RUBY_SRC, RUBY);
    expect(leaves.map((l) => l.name)).toEqual(['full_name', 'find_by_email', 'helper']);
    const full = leaves[0];
    expect(full.id).toBe('app/models/user.rb::full_name::2');
    expect(full.startLine).toBe(2);
    expect(full.endLine).toBe(4);
    expect(full.loc).toBe(3);
    const oneLiner = leaves[2];
    expect(oneLiner.startLine).toBe(12);
    expect(oneLiner.endLine).toBe(12);
    expect(oneLiner.loc).toBe(1);
  });

  it('returns empty for a ruby file without methods', async () => {
    const leaves = await extractLeaves('config/init.rb', 'CONST = 1\nOTHER = 2\n', RUBY);
    expect(leaves).toEqual([]);
  });

  it('still extracts rust functions through the same generic path', async () => {
    const leaves = await extractLeaves('crates/foo/src/lib.rs', 'pub fn a() {}\nfn b() {}\n', RUST);
    expect(leaves.map((l) => l.name)).toEqual(['a', 'b']);
  });
});
