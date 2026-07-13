import type { Chunk, GradedTree, CargoTestRun } from '../types.js';
import { runCargoTests, type Exec } from './cargo.js';
import { groupTestsByModule, type TestGroup } from './testlist.js';

/** 结构通用:compiled = 套件可编译/可加载;results 为【预测粒度】的名字(cargo=测试名,rspec=spec 文件路径)。 */
export type TestRun = CargoTestRun;

export interface VerifyRunner {
  id: 'rust' | 'ruby' | 'js';  // js = vitest runner,同时服务 js 与 vue 两种块
  /** 圈定测试域(只读真实仓)。scope 可序列化,原样进 baseline JSON,predict 时原样传回。 */
  pickScope(g: GradedTree, chunk: Chunk, repo: string): { scope: unknown; note?: string };
  /** 在沙箱里跑该域测试。rspec 忽略 sandboxTarget。 */
  run(sandboxSrc: string, sandboxTarget: string, scope: unknown, exec?: Exec): Promise<TestRun>;
  /** verify.md 测试清单分组。 */
  group(names: string[]): TestGroup[];
}

export interface CargoScope { crate: string; }

/** cargo 逻辑纯搬运——行为与直接调 runCargoTests 完全一致。 */
export const cargoRunner: VerifyRunner = {
  id: 'rust',
  pickScope(_g, chunk) {
    return { scope: { crate: chunk.crate } satisfies CargoScope };
  },
  run(sandboxSrc, sandboxTarget, scope, exec) {
    const { crate } = scope as CargoScope;
    return runCargoTests(sandboxSrc, crate, exec, sandboxTarget);
  },
  group: groupTestsByModule,
};
