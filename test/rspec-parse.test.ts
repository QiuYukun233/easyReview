import { describe, it, expect } from 'vitest';
import { parseRspecJson } from '../src/verify/rspec-parse.js';

function rspecJson(examples: Array<{ file: string; status: string }>): string {
  return JSON.stringify({
    version: '3.13.0',
    examples: examples.map((e, i) => ({
      id: `${e.file}[1:${i + 1}]`, description: `case ${i}`, full_description: `X case ${i}`,
      status: e.status, file_path: e.file, line_number: i + 1,
    })),
    summary: { duration: 1.2, example_count: examples.length, failure_count: examples.filter((e) => e.status === 'failed').length, errors_outside_of_examples_count: 0 },
    summary_line: `${examples.length} examples`,
  });
}

describe('parseRspecJson', () => {
  it('aggregates examples to file level; all-pass file is passed', () => {
    const run = parseRspecJson(rspecJson([
      { file: './spec/actions/a_spec.rb', status: 'passed' },
      { file: './spec/actions/a_spec.rb', status: 'passed' },
      { file: './spec/services/b_spec.rb', status: 'passed' },
    ]));
    expect(run.compiled).toBe(true);
    expect(run.results).toEqual([
      { name: 'spec/actions/a_spec.rb', passed: true },
      { name: 'spec/services/b_spec.rb', passed: true },
    ]);
  });

  it('a file with >=1 failed example is failed; pending does not fail', () => {
    const run = parseRspecJson(rspecJson([
      { file: './spec/a_spec.rb', status: 'passed' },
      { file: './spec/a_spec.rb', status: 'failed' },
      { file: './spec/b_spec.rb', status: 'pending' },
    ]));
    expect(run.results).toEqual([
      { name: 'spec/a_spec.rb', passed: false },
      { name: 'spec/b_spec.rb', passed: true },
    ]);
  });

  it('extracts the JSON line from surrounding compose/bundler noise', () => {
    const out = ['Creating network...', 'warning: bundle stale', rspecJson([{ file: './spec/a_spec.rb', status: 'passed' }]), 'Stopping containers'].join('\n');
    const run = parseRspecJson(out);
    expect(run.compiled).toBe(true);
    expect(run.results).toEqual([{ name: 'spec/a_spec.rb', passed: true }]);
  });

  it('no parseable JSON → compiled:false (load crash equivalent)', () => {
    const run = parseRspecJson('NameError: uninitialized constant Foo\n  from app/x.rb:3');
    expect(run.compiled).toBe(false);
    expect(run.results).toEqual([]);
  });

  it('JSON with zero examples → compiled:false', () => {
    const run = parseRspecJson(rspecJson([]));
    expect(run.compiled).toBe(false);
  });

  it('ignores JSON-looking lines without examples key (e.g. npm logs)', () => {
    const out = ['{"level":"info","msg":"hi"}', rspecJson([{ file: './spec/a_spec.rb', status: 'failed' }])].join('\n');
    const run = parseRspecJson(out);
    expect(run.results).toEqual([{ name: 'spec/a_spec.rb', passed: false }]);
  });
});
