import { describe, it, expect } from 'vitest';
import { runCargoTests, type Exec } from '../src/verify/cargo.js';

describe('runCargoTests', () => {
  it('passes cwd and CARGO_TARGET_DIR through to exec when targetDir is given', async () => {
    let seenCwd = '';
    let seenEnv: NodeJS.ProcessEnv | undefined;
    let seenArgs: string[] = [];
    const fake: Exec = async (_cmd, args, cwd, env) => {
      seenCwd = cwd; seenEnv = env; seenArgs = args;
      return 'test a::t1 ... ok';
    };
    const run = await runCargoTests('/sb/src', 'my_crate', fake, '/sb/target');
    expect(run.compiled).toBe(true);
    expect(seenCwd).toBe('/sb/src');
    expect(seenEnv?.CARGO_TARGET_DIR).toBe('/sb/target');
    expect(seenArgs).toEqual(['test', '-p', 'my_crate', '--', '--test-threads=1']);
  });

  it('passes no env override when targetDir is omitted', async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined = { sentinel: 'x' };
    const fake: Exec = async (_cmd, _args, _cwd, env) => { seenEnv = env; return 'test a::t1 ... ok'; };
    await runCargoTests('/repo', 'c', fake);
    expect(seenEnv).toBeUndefined();
  });
});
