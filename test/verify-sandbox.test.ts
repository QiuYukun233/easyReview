import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { sandboxFor, syncSandbox } from '../src/verify/sandbox.js';

let cleanups: Array<() => void> = [];
afterEach(() => { cleanups.forEach((c) => c()); cleanups = []; });

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ez-sbx-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function trackSandbox(repo: string) {
  const sb = sandboxFor(repo);
  cleanups.push(() => rmSync(sb.dir, { recursive: true, force: true }));
  return sb;
}

function write(repo: string, rel: string, content: string): void {
  const p = join(repo, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

describe('sandboxFor', () => {
  it('is stable for the same repo and distinct across repos; srcDir/targetDir live under dir', () => {
    const a = makeRepo(); const b = makeRepo();
    const s1 = sandboxFor(a); const s2 = sandboxFor(a); const s3 = sandboxFor(b);
    expect(s1.dir).toBe(s2.dir);
    expect(s1.dir).not.toBe(s3.dir);
    expect(s1.srcDir).toBe(join(s1.dir, 'src'));
    expect(s1.targetDir).toBe(join(s1.dir, 'target'));
    expect(s1.dir.startsWith(join(tmpdir(), 'easyreview-sandbox'))).toBe(true);
  });
});

describe('syncSandbox', () => {
  it('first sync copies source files and excludes .git/target/node_modules/easyreview.*', () => {
    const repo = makeRepo();
    write(repo, 'Cargo.toml', '[workspace]');
    write(repo, 'crates/a/src/lib.rs', 'pub fn f() {}');
    write(repo, '.git/HEAD', 'ref: refs/heads/main');
    write(repo, 'target/debug.bin', 'junk');
    write(repo, 'node_modules/m/index.js', 'x');
    write(repo, 'easyreview.tree.json', '{}');
    const sb = trackSandbox(repo);
    const stats = syncSandbox(repo, sb.srcDir);
    expect(stats.copied).toBe(2);
    expect(readFileSync(join(sb.srcDir, 'Cargo.toml'), 'utf8')).toBe('[workspace]');
    expect(readFileSync(join(sb.srcDir, 'crates/a/src/lib.rs'), 'utf8')).toBe('pub fn f() {}');
    expect(existsSync(join(sb.srcDir, '.git'))).toBe(false);
    expect(existsSync(join(sb.srcDir, 'target'))).toBe(false);
    expect(existsSync(join(sb.srcDir, 'node_modules'))).toBe(false);
    expect(existsSync(join(sb.srcDir, 'easyreview.tree.json'))).toBe(false);
  });

  it('incremental sync only rewrites changed files — untouched files keep their mtime', () => {
    const repo = makeRepo();
    write(repo, 'Cargo.toml', '[workspace]');
    write(repo, 'crates/a/src/lib.rs', 'pub fn f() {}');
    const sb = trackSandbox(repo);
    syncSandbox(repo, sb.srcDir);
    const untouched = join(sb.srcDir, 'crates/a/src/lib.rs');
    const mtimeBefore = statSync(untouched).mtimeMs;

    write(repo, 'Cargo.toml', '[workspace]\nmembers = []');
    const stats = syncSandbox(repo, sb.srcDir);
    expect(stats.copied).toBe(1);
    expect(readFileSync(join(sb.srcDir, 'Cargo.toml'), 'utf8')).toBe('[workspace]\nmembers = []');
    expect(statSync(untouched).mtimeMs).toBe(mtimeBefore);
  });

  it('deletes sandbox files and dirs that no longer exist in the repo', () => {
    const repo = makeRepo();
    write(repo, 'keep.rs', 'k');
    write(repo, 'gone.rs', 'g');
    write(repo, 'olddir/x.rs', 'x');
    const sb = trackSandbox(repo);
    syncSandbox(repo, sb.srcDir);
    rmSync(join(repo, 'gone.rs'));
    rmSync(join(repo, 'olddir'), { recursive: true });
    const stats = syncSandbox(repo, sb.srcDir);
    expect(stats.deleted).toBe(2);
    expect(existsSync(join(sb.srcDir, 'keep.rs'))).toBe(true);
    expect(existsSync(join(sb.srcDir, 'gone.rs'))).toBe(false);
    expect(existsSync(join(sb.srcDir, 'olddir'))).toBe(false);
  });

  it('survives type transitions: repo file→dir and dir→file between syncs', () => {
    const repo = makeRepo();
    write(repo, 'thing', 'was a file');
    write(repo, 'bar/inner.rs', 'was a dir');
    const sb = trackSandbox(repo);
    syncSandbox(repo, sb.srcDir);

    rmSync(join(repo, 'thing'));
    write(repo, 'thing/nested.rs', 'now a dir');
    rmSync(join(repo, 'bar'), { recursive: true });
    write(repo, 'bar', 'now a file');
    syncSandbox(repo, sb.srcDir);

    expect(readFileSync(join(sb.srcDir, 'thing/nested.rs'), 'utf8')).toBe('now a dir');
    expect(readFileSync(join(sb.srcDir, 'bar'), 'utf8')).toBe('now a file');
  });

  it('copies binary files byte-for-byte', () => {
    const repo = makeRepo();
    const bytes = Buffer.from([0, 255, 1, 254, 10, 13, 0]);
    mkdirSync(join(repo, 'assets'), { recursive: true });
    writeFileSync(join(repo, 'assets/blob.bin'), bytes);
    const sb = trackSandbox(repo);
    syncSandbox(repo, sb.srcDir);
    expect(readFileSync(join(sb.srcDir, 'assets/blob.bin')).equals(bytes)).toBe(true);
  });
});
