import { describe, it, expect } from 'vitest';
import { flowIdFor } from '../src/flow/flow-id.js';

describe('flowIdFor(路径 slug + 可选行号)', () => {
  it('顶层 spec 保持 basename 结果(与旧 trace id 兼容)', () => {
    expect(flowIdFor('spec/msg_spec.rb', null)).toBe('flow-msg');
    expect(flowIdFor('spec/msg_spec.rb', 25)).toBe('flow-msg-L25');
  });

  it('嵌套 spec 用全路径 slug 防 basename 撞名', () => {
    expect(flowIdFor('spec/controllers/api/v1/accounts/conversations/messages_controller_spec.rb', 25))
      .toBe('flow-controllers-api-v1-accounts-conversations-messages_controller-L25');
  });

  it('无 spec/ 前缀也不炸;无行号无 -L 尾缀', () => {
    expect(flowIdFor('other/x_spec.rb', null)).toBe('flow-other-x');
  });
});
