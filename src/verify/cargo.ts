import { execFile } from 'node:child_process';
import type { CargoTestRun } from '../types.js';
import { parseCargoTest } from './parse.js';

/** (cmd, args, cwd, env?) → 合并的 stdout+stderr。不因非零退出码抛出。env 缺省=继承进程环境。 */
export type Exec = (cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<string>;

export const realExec: Exec = (cmd, args, cwd, env) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, env: env ?? process.env }, (_err, stdout, stderr) => {
      resolve(`${stdout ?? ''}\n${stderr ?? ''}`);
    });
  });

/** cwd 由调用方决定(沙箱化后传沙箱 src/);targetDir 提供时经 CARGO_TARGET_DIR 注入。 */
export async function runCargoTests(cwd: string, crate: string, exec: Exec = realExec, targetDir?: string): Promise<CargoTestRun> {
  const env = targetDir ? { ...process.env, CARGO_TARGET_DIR: targetDir } : undefined;
  const out = await exec('cargo', ['test', '-p', crate, '--', '--test-threads=1'], cwd, env);
  return parseCargoTest(out);
}
