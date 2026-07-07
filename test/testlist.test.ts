import { describe, it, expect } from 'vitest';
import { groupTestsByModule } from '../src/verify/testlist.js';

describe('groupTestsByModule', () => {
  it('groups by module prefix, keeps full names, preserves in-group order', () => {
    const out = groupTestsByModule([
      'build_ui::routing_fsm::b_test',
      'build_ui::routing_fsm::a_test',
      'constants::eval::curve',
    ]);
    expect(out).toEqual([
      { module: 'build_ui::routing_fsm', tests: ['build_ui::routing_fsm::b_test', 'build_ui::routing_fsm::a_test'] },
      { module: 'constants::eval', tests: ['constants::eval::curve'] },
    ]);
  });

  it('puts names without :: under the crate-root group', () => {
    const out = groupTestsByModule(['smoke', 'core::field::t1']);
    expect(out).toEqual([
      { module: '(crate 根)', tests: ['smoke'] },
      { module: 'core::field', tests: ['core::field::t1'] },
    ]);
  });

  it('sorts groups by module name but keeps original order within a group', () => {
    const out = groupTestsByModule(['z_mod::t1', 'a_mod::t2', 'a_mod::t1']);
    expect(out.map((g) => g.module)).toEqual(['a_mod', 'z_mod']);
    expect(out[0].tests).toEqual(['a_mod::t2', 'a_mod::t1']); // 组内保原序，不排序
  });

  it('returns [] for empty input', () => {
    expect(groupTestsByModule([])).toEqual([]);
  });
});
