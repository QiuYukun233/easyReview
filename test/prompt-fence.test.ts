import { describe, it, expect } from 'vitest';
import { userPrompt } from '../src/label/prompt.js';
import type { ChunkLabelInput } from '../src/types.js';

const mk = (file: string): ChunkLabelInput => ({
  chunkId: file, chunkName: 'x', file, chapterName: 'c',
  riskBucket: 'low', contribBucket: 'filler',
  functions: [{ name: 'f', source: 'BODY' }], neighbors: [], contentHash: 'h',
});

describe('userPrompt fence', () => {
  it('uses the language fence matching the chunk file', () => {
    expect(userPrompt(mk('crates/foo/src/lib.rs'))).toContain('```rust');
    expect(userPrompt(mk('app/models/user.rb'))).toContain('```ruby');
  });
});
