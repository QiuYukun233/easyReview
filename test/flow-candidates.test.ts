import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCandidates, saveCandidates, parseDryRun, emptyDryRunReason } from '../src/flow/candidates.js';

describe('候选落盘容错(镜像 flows.ts)', () => {
  it('save 后 load 往返一致', () => {
    const out = mkdtempSync(join(tmpdir(), 'er-cand-'));
    saveCandidates(out, { version: 1, candidates: [{ id: 'flow-a-L1', name: 'A', spec: 'spec/a_spec.rb:1' }] });
    expect(loadCandidates(out)!.candidates).toHaveLength(1);
    expect(loadCandidates(out)!.candidates[0].id).toBe('flow-a-L1');
  });

  it('文件不存在 → null(老产物,不渲染候选段)', () => {
    const out = mkdtempSync(join(tmpdir(), 'er-cand-'));
    expect(loadCandidates(out)).toBeNull();
  });

  it('损坏 JSON → null(不抛)', () => {
    const out = mkdtempSync(join(tmpdir(), 'er-cand-'));
    writeFileSync(join(out, 'easyreview.flow-candidates.json'), '{ not json');
    expect(loadCandidates(out)).toBeNull();
  });

  it('合法 JSON 但 candidates 非数组 → null', () => {
    const out = mkdtempSync(join(tmpdir(), 'er-cand-'));
    writeFileSync(join(out, 'easyreview.flow-candidates.json'), JSON.stringify({ version: 1, candidates: 'x' }));
    expect(loadCandidates(out)).toBeNull();
  });
});

describe('parseDryRun(dry-run JSON → 候选)', () => {
  const sample = JSON.stringify({
    examples: [
      { full_description: 'POST messages creates a new outgoing message',
        file_path: './spec/controllers/api/v1/messages_controller_spec.rb', line_number: 25 },
      { full_description: 'POST messages returns unauthorized',
        file_path: './spec/controllers/api/v1/messages_controller_spec.rb', line_number: 11 },
    ],
  });

  it('取 full_description 为名、归一 ./ 前缀、slug id、spec=文件:行号', () => {
    const cands = parseDryRun(sample);
    expect(cands).toHaveLength(2);
    expect(cands[0].name).toBe('POST messages creates a new outgoing message');
    expect(cands[0].spec).toBe('spec/controllers/api/v1/messages_controller_spec.rb:25');
    expect(cands[0].id).toBe('flow-controllers-api-v1-messages_controller-L25');
  });

  it('容忍容器提示语粘在 JSON 前后(取最后一个可解析的 { 行)', () => {
    const noisy = 'Creating network...\n' + sample + '\nRun options: ...';
    expect(parseDryRun(noisy)).toHaveLength(2);
  });

  it('无 examples / 无可解析 JSON → 空数组', () => {
    expect(parseDryRun('boot failed, nothing here')).toEqual([]);
    expect(parseDryRun(JSON.stringify({ examples: [] }))).toEqual([]);
  });

  it('缺 file_path 或 line_number 的 example 跳过', () => {
    const partial = JSON.stringify({ examples: [
      { full_description: 'no path', line_number: 3 },
      { full_description: 'ok', file_path: './spec/a_spec.rb', line_number: 7 },
    ] });
    const cands = parseDryRun(partial);
    expect(cands).toHaveLength(1);
    expect(cands[0].spec).toBe('spec/a_spec.rb:7');
  });
});

describe('emptyDryRunReason(0 候选时区分「加载期报错」与「真的空」)', () => {
  it('输出含 rspec 加载错误标记 → load-error', () => {
    const out = '{"version":"3.13.0","messages":["\\nAn error occurred while loading ./spec/x_spec.rb.\\n..."],"examples":[],"summary":{"errors_outside_of_examples_count":1}}';
    expect(emptyDryRunReason(out)).toBe('load-error');
  });

  it('干净的零 example 输出 → empty', () => {
    const out = '{"examples":[],"summary":{"errors_outside_of_examples_count":0}}';
    expect(emptyDryRunReason(out)).toBe('empty');
  });
});
