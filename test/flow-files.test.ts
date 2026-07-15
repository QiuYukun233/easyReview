import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFlows, saveFlows, upsertFlow } from '../src/flow/flows.js';
import type { Flow } from '../src/types.js';

const flow = (id: string, name: string): Flow => ({
  id, name,
  source: { kind: 'rspec-trace', spec: 'spec/x_spec.rb', tracedAt: '2026-07-15T00:00:00Z' },
  steps: [{ chunkId: 'app/a.rb', methods: ['f'], hits: 1 }],
  rawTrace: [{ file: '/app/app/a.rb', method: 'f', line: 1 }],
});

describe('flows 文件读写(独立 easyreview.flows.json,spec §5)', () => {
  it('文件不存在 → null(视同无流程)', () => {
    expect(loadFlows(mkdtempSync(join(tmpdir(), 'er-')))).toBeNull();
  });

  it('损坏 JSON → null(容错,不抛)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'er-'));
    writeFileSync(join(dir, 'easyreview.flows.json'), '{broken');
    expect(loadFlows(dir)).toBeNull();
  });

  it('合法 JSON 但 flows 非数组 → null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'er-'));
    writeFileSync(join(dir, 'easyreview.flows.json'), JSON.stringify({ version: 1, flows: 'x' }));
    expect(loadFlows(dir)).toBeNull();
  });

  it('save→load 往返一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'er-'));
    saveFlows(dir, { version: 1, flows: [flow('flow-a', 'A 流程')] });
    expect(loadFlows(dir)).toEqual({ version: 1, flows: [flow('flow-a', 'A 流程')] });
  });

  it('upsertFlow:同 id 替换、新 id 追加、null 起新文件', () => {
    const f1 = upsertFlow(null, flow('flow-a', '旧名'));
    expect(f1.flows).toHaveLength(1);
    const f2 = upsertFlow(f1, flow('flow-b', 'B'));
    expect(f2.flows.map((f) => f.id)).toEqual(['flow-a', 'flow-b']);
    const f3 = upsertFlow(f2, flow('flow-a', '新名'));
    expect(f3.flows).toHaveLength(2);
    expect(f3.flows[0].name).toBe('新名');
  });
});
