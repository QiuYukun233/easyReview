import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSource } from '../src/serve/source.js';
import { makeViewerTree } from './viewer-fixture.js';

const A = 'crates/foo/src/a.rs';

let dirs: string[] = [];
afterEach(() => { dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); dirs = []; });

describe('readSource', () => {
  it('已知 chunk → 200,带 lang 与已高亮行', () => {
    const repo = mkdtempSync(join(tmpdir(), 'easyrev-src-'));
    dirs.push(repo);
    mkdirSync(join(repo, 'crates/foo/src'), { recursive: true });
    writeFileSync(join(repo, 'crates/foo/src/a.rs'), 'fn f1() {}\n');
    const tree = { ...makeViewerTree(), repo };
    const r = readSource(tree, A);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.file).toBe(A);
    expect(r.body.lang).toBe('rust');
    expect(r.body.lines![0]).toContain('tok-k'); // fn 已高亮
  });

  it('非字符串/空串/不在地图的 id(含 ../ 穿越)→ 400,不读盘', () => {
    const tree = makeViewerTree(); // repo=/fake,真读盘必炸——400 即证明没读
    expect(readSource(tree, undefined).status).toBe(400);
    expect(readSource(tree, '').status).toBe(400);
    expect(readSource(tree, '../../etc/passwd').status).toBe(400);
  });

  it('文件不在了 → 404,报错带 repo 路径与 --repo 提示', () => {
    const tree = { ...makeViewerTree(), repo: join(tmpdir(), 'easyrev-no-such-repo') };
    const r = readSource(tree, A);
    expect(r.status).toBe(404);
    expect(r.body.error).toContain('easyrev-no-such-repo');
    expect(r.body.error).toContain('--repo');
  });
});
