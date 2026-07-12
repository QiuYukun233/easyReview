import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadRubyRunnerConfig, makeRspecRunner, expandCmd } from '../src/verify/rspec.js';
import type { Exec } from '../src/verify/cargo.js';
import type { Chunk, GradedTree } from '../src/types.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ez-rrun-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(repo: string, rel: string, content: string): void {
  const p = join(repo, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}
const RSPEC_OK = JSON.stringify({ examples: [{ file_path: './spec/actions/x_spec.rb', status: 'passed' }], summary: {} });

describe('loadRubyRunnerConfig', () => {
  it('loads cmd + scanLimit from repo-root easyreview.runner.json', () => {
    const repo = makeRepo();
    write(repo, 'easyreview.runner.json', JSON.stringify({ version: 1, ruby: { cmd: ['docker', 'x', '{specFiles}'], scanLimit: 7 } }));
    const cfg = loadRubyRunnerConfig(repo);
    expect(cfg.cmd).toEqual(['docker', 'x', '{specFiles}']);
    expect(cfg.scanLimit).toBe(7);
  });
  it('missing file → actionable error pointing at the recipe', () => {
    expect(() => loadRubyRunnerConfig(makeRepo())).toThrow(/easyreview\.runner\.json/);
  });
  it('missing ruby.cmd → actionable error', () => {
    const repo = makeRepo();
    write(repo, 'easyreview.runner.json', JSON.stringify({ version: 1, ruby: {} }));
    expect(() => loadRubyRunnerConfig(repo)).toThrow(/ruby\.cmd/);
  });
  it('invalid JSON → parse error message', () => {
    const repo = makeRepo();
    write(repo, 'easyreview.runner.json', '{oops');
    expect(() => loadRubyRunnerConfig(repo)).toThrow(/解析失败/);
  });
});

describe('expandCmd', () => {
  it('expands {specFiles} into one argument per file', () => {
    expect(expandCmd(['docker', 'run', 'rspec', '{specFiles}', '--tag'], ['spec/a_spec.rb', 'spec/b_spec.rb']))
      .toEqual(['docker', 'run', 'rspec', 'spec/a_spec.rb', 'spec/b_spec.rb', '--tag']);
  });
});

describe('makeRspecRunner', () => {
  const tree = {} as GradedTree;

  it('pickScope throws actionable error when no spec scope exists', () => {
    const repo = makeRepo();
    const runner = makeRspecRunner({ cmd: ['x', '{specFiles}'] });
    const chunk = { id: 'app/models/ghost.rb', file: 'app/models/ghost.rb', crate: 'app' } as Chunk;
    expect(() => runner.pickScope(tree, chunk, repo)).toThrow(/找不到可用的 spec 域/);
  });

  it('pickScope returns specFiles scope + note; run executes expanded cmd with cwd=sandboxSrc and parses JSON', async () => {
    const repo = makeRepo();
    write(repo, 'spec/actions/x_spec.rb', 'describe X do end');
    const runner = makeRspecRunner({ cmd: ['docker', 'compose', 'run', 'rspec', '{specFiles}'] });
    const chunk = { id: 'app/actions/x.rb', file: 'app/actions/x.rb', crate: 'app' } as Chunk;
    const picked = runner.pickScope(tree, chunk, repo);
    expect((picked.scope as { specFiles: string[] }).specFiles).toEqual(['spec/actions/x_spec.rb']);
    expect(picked.note).toContain('零命中');

    let seen: { cmd?: string; args?: string[]; cwd?: string } = {};
    const fake: Exec = async (cmd, args, cwd) => { seen = { cmd, args, cwd }; return `noise\n${RSPEC_OK}`; };
    const run = await runner.run('/sb/src', '/sb/target', picked.scope, fake);
    expect(seen.cmd).toBe('docker');
    expect(seen.args).toEqual(['compose', 'run', 'rspec', 'spec/actions/x_spec.rb']);
    expect(seen.cwd).toBe('/sb/src');
    expect(run.compiled).toBe(true);
    expect(run.results).toEqual([{ name: 'spec/actions/x_spec.rb', passed: true }]);
  });

  it('group buckets file paths by top-level spec dir, sorted', () => {
    const runner = makeRspecRunner({ cmd: ['x', '{specFiles}'] });
    expect(runner.group(['spec/services/b_spec.rb', 'spec/actions/a_spec.rb', 'spec/actions/c_spec.rb'])).toEqual([
      { module: 'spec/actions', tests: ['spec/actions/a_spec.rb', 'spec/actions/c_spec.rb'] },
      { module: 'spec/services', tests: ['spec/services/b_spec.rb'] },
    ]);
  });
});
