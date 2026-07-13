import { describe, it, expect } from 'vitest';
import { parseVitestJson } from '../src/verify/vitest-parse.js';

const line = (results: Array<{ name: string; status: string }>) =>
  JSON.stringify({ numTotalTests: results.length, success: true, testResults: results.map((r) => ({ ...r, assertionResults: [] })) });

describe('parseVitestJson', () => {
  it('aggregates file-level pass/fail from jest-compatible JSON', () => {
    const out = line([
      { name: '/app/app/javascript/helper/specs/url.spec.js', status: 'passed' },
      { name: '/app/app/javascript/store/specs/actions.spec.js', status: 'failed' },
    ]);
    const run = parseVitestJson(out);
    expect(run.compiled).toBe(true);
    expect(run.results).toEqual([
      { name: 'app/javascript/helper/specs/url.spec.js', passed: true },
      { name: 'app/javascript/store/specs/actions.spec.js', passed: false },
    ]);
  });

  it('finds the JSON line under docker/vitest noise (bottom-up scan)', () => {
    const out = ['Pulling image...', 'stderr noise {not json}', line([{ name: '/app/a.spec.js', status: 'passed' }]), ''].join('\n');
    const run = parseVitestJson(out);
    expect(run.compiled).toBe(true);
    expect(run.results).toEqual([{ name: 'a.spec.js', passed: true }]);
  });

  it('strips windows/sandbox absolute paths via app/javascript anchor', () => {
    const out = line([{ name: 'E:/tmp/easyreview-sandbox/abc/src/app/javascript/x/specs/y.spec.js', status: 'passed' }]);
    expect(parseVitestJson(out).results[0].name).toBe('app/javascript/x/specs/y.spec.js');
  });

  it('empty testResults → compiled:false(套件没跑起来)', () => {
    expect(parseVitestJson(line([]))).toEqual({ compiled: false, results: [] });
  });

  it('no parseable JSON → compiled:false', () => {
    expect(parseVitestJson('docker: error\nnothing here')).toEqual({ compiled: false, results: [] });
  });

  it('a JSON line without testResults key is skipped, real one above it still found', () => {
    const out = [line([{ name: '/app/a.spec.js', status: 'passed' }]), '{"unrelated": true}'].join('\n');
    expect(parseVitestJson(out).compiled).toBe(true);
  });
});
