import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerifyShow, runVerifyPredict } from '../src/cli-verify.js';

let dirs: string[] = [];
afterEach(() => { dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); dirs = []; });

function outDirWithRubyChunk(): string {
  const dir = mkdtempSync(join(tmpdir(), 'easyrev-vrb-'));
  dirs.push(dir);
  const tree = {
    repo: '/fake',
    chapters: [{ id: 'app:models', name: 'app::models', crate: 'app', dir: 'models', chunkIds: ['app/models/user.rb'] }],
    chunks: [{ id: 'app/models/user.rb', name: 'user', file: 'app/models/user.rb', crate: 'app', leafIds: [] }],
    leaves: [],
    grades: {},
  };
  writeFileSync(join(dir, 'easyreview.tree.json'), JSON.stringify(tree));
  return dir;
}

describe('verify rejects non-rust chunks', () => {
  it('show: throws a friendly not-supported error before touching cargo', async () => {
    const dir = outDirWithRubyChunk();
    await expect(runVerifyShow({ repo: dir, outDir: dir, chunkId: 'app/models/user.rb' }))
      .rejects.toThrow(/暂只支持 Rust/);
  });

  it('predict: same rejection', async () => {
    const dir = outDirWithRubyChunk();
    await expect(runVerifyPredict({ repo: dir, outDir: dir, chunkId: 'app/models/user.rb', predicted: [] }))
      .rejects.toThrow(/暂只支持 Rust/);
  });
});
