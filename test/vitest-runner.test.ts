import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadJsRunnerConfig, makeVitestRunner } from '../src/verify/vitest.js';

function tempDir(): string { return mkdtempSync(join(tmpdir(), 'easyrev-vt-')); }

describe('loadJsRunnerConfig', () => {
  it('missing file → actionable error mentioning the recipe', () => {
    const dir = tempDir();
    try { expect(() => loadJsRunnerConfig(dir)).toThrow(/easyreview\.runner\.json/); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('bad JSON → parse error; missing js.cmd → actionable error', () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'easyreview.runner.json'), '{oops');
      expect(() => loadJsRunnerConfig(dir)).toThrow(/解析失败/);
      writeFileSync(join(dir, 'easyreview.runner.json'), JSON.stringify({ version: 1, ruby: { cmd: ['x'] } }));
      expect(() => loadJsRunnerConfig(dir)).toThrow(/js\.cmd/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('valid js section loads (ruby section may coexist)', () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'easyreview.runner.json'),
        JSON.stringify({ version: 1, ruby: { cmd: ['r'] }, js: { cmd: ['node', 'vitest.mjs', '{specFiles}'], scanLimit: 5 } }));
      expect(loadJsRunnerConfig(dir)).toEqual({ cmd: ['node', 'vitest.mjs', '{specFiles}'], scanLimit: 5 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('makeVitestRunner.run', () => {
  it('expands {specFiles}, execs in sandbox src, parses vitest JSON', async () => {
    const runner = makeVitestRunner({ cmd: ['docker', 'run', '{specFiles}'] });
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const fake = async (cmd: string, args: string[], cwd: string) => {
      calls.push({ cmd, args, cwd });
      return JSON.stringify({ testResults: [{ name: '/app/a/specs/b.spec.js', status: 'passed', assertionResults: [] }] });
    };
    const run = await runner.run('/sb/src', '/sb/target', { specFiles: ['a/specs/b.spec.js', 'c.spec.js'] }, fake);
    expect(calls).toEqual([{ cmd: 'docker', args: ['run', 'a/specs/b.spec.js', 'c.spec.js'], cwd: '/sb/src' }]);
    expect(run).toEqual({ compiled: true, results: [{ name: 'a/specs/b.spec.js', passed: true }] });
  });

  it('groups prediction names by top-2 path segments (shared with rspec)', () => {
    const runner = makeVitestRunner({ cmd: ['x'] });
    const groups = runner.group(['app/javascript/x/a.spec.js', 'app/javascript/y/b.spec.js']);
    expect(groups).toHaveLength(1);
    expect(groups[0].module).toBe('app/javascript');
  });
});
