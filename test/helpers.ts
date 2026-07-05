import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

export function makeTempRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'easyrev-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeRepoFile(dir: string, path: string, content: string): void {
  const abs = join(dir, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

export function commitAll(dir: string, msg: string, author?: string): void {
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  const env = author
    ? { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${author}@t`,
        GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: `${author}@t` }
    : process.env;
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir, stdio: 'pipe', env });
}
