import { execFile } from 'node:child_process';
import type { CargoTestRun } from '../types.js';
import { parseCargoTest } from './parse.js';

/** (cmd, args, cwd) → 合并的 stdout+stderr。不因非零退出码抛出。 */
export type Exec = (cmd: string, args: string[], cwd: string) => Promise<string>;

const realExec: Exec = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (_err, stdout, stderr) => {
      resolve(`${stdout ?? ''}\n${stderr ?? ''}`);
    });
  });

export async function runCargoTests(repo: string, crate: string, exec: Exec = realExec): Promise<CargoTestRun> {
  const out = await exec('cargo', ['test', '-p', crate, '--', '--test-threads=1'], repo);
  return parseCargoTest(out);
}
