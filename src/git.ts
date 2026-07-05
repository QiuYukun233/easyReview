import { execFileSync } from 'node:child_process';

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo, stdio: 'pipe', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

export function listTrackedFiles(repo: string): string[] {
  return git(repo, ['ls-files'])
    .split('\n').map((s) => s.trim()).filter(Boolean);
}

export interface CommitRecord {
  hash: string;
  author: string;
  files: string[];
}

export function logNameOnly(repo: string): CommitRecord[] {
  const SEP = '\x1e';
  const raw = git(repo, [
    'log', '--no-merges', `--format=${SEP}%H%x00%an`, '--name-only',
  ]);
  const records: CommitRecord[] = [];
  for (const block of raw.split(SEP)) {
    if (!block.trim()) continue;
    const [header, ...rest] = block.split('\n');
    const [hash, author] = header.split('\x00');
    const files = rest.map((s) => s.trim()).filter(Boolean);
    records.push({ hash, author: author ?? '', files });
  }
  return records;
}
