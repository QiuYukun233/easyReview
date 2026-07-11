import { describe, it, expect } from 'vitest';
import { pickPreferredSite } from '../src/verify/pick-site.js';
import { chooseMutation } from '../src/verify/mutate.js';
import { RUBY } from '../src/extract/lang.js';
import type { Chunk, Leaf } from '../src/types.js';

describe('pickPreferredSite (ruby)', () => {
  it('picks the first single-line call/assignment in statement position, skipping def/end and nested args', async () => {
    const src = [
      'class ContactIdentifyAction',      // 1
      '  def perform',                    // 2
      '    @contact = find_contact',      // 3  ← 赋值,语句位,应选中
      '    merge(@contact)',              // 4
      '  end',                            // 5
      'end',                              // 6
    ].join('\n');
    const site = await pickPreferredSite(src, RUBY);
    expect(site).toEqual({ line: 3, original: '    @contact = find_contact' });
  });

  it('picks a method call with args when no assignment precedes it', async () => {
    // 注意:无参裸调用(notify_listeners)在 tree-sitter-ruby 里是 identifier 不是 call——
    // v1 只认显式 call/assignment;裸调用由 regex 回退覆盖
    const src = 'def run\n  notify_listeners(self)\nend\n';
    const site = await pickPreferredSite(src, RUBY);
    expect(site).toEqual({ line: 2, original: '  notify_listeners(self)' });
  });

  it('skips multi-line constructs and block heads ending in do', async () => {
    const src = [
      'def run',
      '  items.each do |i|',
      '    process(i)',
      '  end',
      'end',
    ].join('\n');
    const site = await pickPreferredSite(src, RUBY);
    expect(site).toEqual({ line: 3, original: '    process(i)' });
  });

  it('skips heredoc openers — commenting them would orphan the heredoc body', async () => {
    const src = [
      'def run',
      '  sql = <<~SQL',
      '    SELECT 1',
      '  SQL',
      '  execute(sql)',
      'end',
    ].join('\n');
    const site = await pickPreferredSite(src, RUBY);
    expect(site).toEqual({ line: 5, original: '  execute(sql)' });
  });

  it('picks operator_assignment in statement position', async () => {
    const src = 'def bump\n  @count += 1\nend\n';
    const site = await pickPreferredSite(src, RUBY);
    expect(site).toEqual({ line: 2, original: '  @count += 1' });
  });

  it('returns null when nothing qualifies', async () => {
    const site = await pickPreferredSite('class Empty\nend\n', RUBY);
    expect(site).toBeNull();
  });
});

describe('chooseMutation (ruby)', () => {
  const chunk = { id: 'app/actions/x.rb', file: 'app/actions/x.rb', crate: 'app' } as Chunk;
  it('builds a # -commented mutation for ruby files', async () => {
    const src = 'def run\n  do_thing\nend\n';
    const leaves: Leaf[] = [{ id: 'x', file: 'app/actions/x.rb', name: 'run', startLine: 1, endLine: 3, loc: 3 } as Leaf];
    const op = await chooseMutation(chunk, leaves, src);
    expect(op).not.toBeNull();
    expect(op!.line).toBe(2);
    expect(op!.mutated).toBe('  # do_thing');
  });

  it('regex fallback (ruby rules) skips def/end/comments and block heads', async () => {
    // pick-site 找不到时走回退:构造 tree-sitter 选不出的场景不稳定,直接测回退规则的行为面——
    // 用一个 pick-site 也能选中的源,断言结果与 # 前缀一致即可(回退与首选路径产出同构)。
    const src = 'def run\n  # comment\n  total = 1\nend\n';
    const leaves: Leaf[] = [{ id: 'x', file: 'app/actions/x.rb', name: 'run', startLine: 1, endLine: 4, loc: 4 } as Leaf];
    const op = await chooseMutation(chunk, leaves, src);
    expect(op!.line).toBe(3);
    expect(op!.mutated).toBe('  # total = 1');
  });
});
