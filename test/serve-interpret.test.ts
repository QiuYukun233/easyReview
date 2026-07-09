import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyInterpret, type InterpretResult } from '../src/serve/interpret.js';
import { makeViewerTree } from './viewer-fixture.js';
import type { Interpreter, ChunkInterpretation } from '../src/types.js';

const A = 'crates/foo/src/a.rs';
const INTERP: ChunkInterpretation = { overview: 'o', dataFlow: 'd', calls: 'c', functions: [{ name: 'f1', gist: 'g' }] };

let dirs: string[] = [];
afterEach(() => { dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); dirs = []; });

function makeDirs() {
  const out = mkdtempSync(join(tmpdir(), 'easyrev-interp-'));
  dirs.push(out);
  const repo = join(out, 'repo');
  mkdirSync(join(repo, 'crates/foo/src'), { recursive: true });
  writeFileSync(join(repo, 'crates/foo/src/a.rs'), 'fn f1() {}\n');
  return { out, tree: { ...makeViewerTree(), repo } };
}

/** 计数 fake:调用即计数(在 delay 前),供在途去重断言。 */
function countingInterpreter(result: ChunkInterpretation | null = INTERP, delayMs = 0) {
  let calls = 0;
  const fake: Interpreter = {
    interpret: () => { calls++; return new Promise((res) => setTimeout(() => res(result), delayMs)); },
  };
  return { fake, calls: () => calls };
}

function newInflight(): Map<string, Promise<InterpretResult>> { return new Map(); }

describe('applyInterpret', () => {
  it('缺参/未知块/../ 穿越 → 400,不调 LLM', async () => {
    const { tree } = makeDirs();
    const { fake, calls } = countingInterpreter();
    expect((await applyInterpret(tree, '/nope', undefined, fake, newInflight())).status).toBe(400);
    expect((await applyInterpret(tree, '/nope', '', fake, newInflight())).status).toBe(400);
    expect((await applyInterpret(tree, '/nope', '../../etc/passwd', fake, newInflight())).status).toBe(400);
    expect(calls()).toBe(0);
  });

  it('文件没了 → 404 带 repo 路径与 --repo 提示', async () => {
    const tree = { ...makeViewerTree(), repo: join(tmpdir(), 'easyrev-no-such-repo') };
    const r = await applyInterpret(tree, tmpdir(), A, null, newInflight());
    expect(r.status).toBe(404);
    expect(r.body.error).toContain('easyrev-no-such-repo');
    expect(r.body.error).toContain('--repo');
  });

  it('无 interpreter → 503,报错提到 DEEPSEEK_API_KEY', async () => {
    const { out, tree } = makeDirs();
    const r = await applyInterpret(tree, out, A, null, newInflight());
    expect(r.status).toBe(503);
    expect(r.body.error).toContain('DEEPSEEK_API_KEY');
  });

  it('miss → 生成落盘;二次请求命中缓存零 LLM 调用', async () => {
    const { out, tree } = makeDirs();
    const { fake, calls } = countingInterpreter();
    const inflight = newInflight();
    const r1 = await applyInterpret(tree, out, A, fake, inflight);
    expect(r1.status).toBe(200);
    expect(r1.body.cached).toBe(false);
    expect(r1.body.interpretation).toEqual(INTERP);
    const disk = JSON.parse(readFileSync(join(out, 'easyreview.interpret.json'), 'utf8'));
    expect(disk.entries[A].overview).toBe('o');
    const r2 = await applyInterpret(tree, out, A, fake, inflight);
    expect(r2.body.cached).toBe(true);
    expect(r2.body.interpretation).toEqual(INTERP);
    expect(calls()).toBe(1);
  });

  it('源码变了 → hash 失效重新生成', async () => {
    const { out, tree } = makeDirs();
    const { fake, calls } = countingInterpreter();
    const inflight = newInflight();
    await applyInterpret(tree, out, A, fake, inflight);
    writeFileSync(join(tree.repo, A), 'fn f1() { /* changed */ }\n');
    const r = await applyInterpret(tree, out, A, fake, inflight);
    expect(r.body.cached).toBe(false);
    expect(calls()).toBe(2);
  });

  it('生成失败 → 502,不落盘', async () => {
    const { out, tree } = makeDirs();
    const { fake } = countingInterpreter(null);
    const r = await applyInterpret(tree, out, A, fake, newInflight());
    expect(r.status).toBe(502);
    expect(existsSync(join(out, 'easyreview.interpret.json'))).toBe(false);
  });

  it('在途去重:并发两请求只生成一次', async () => {
    const { out, tree } = makeDirs();
    const { fake, calls } = countingInterpreter(INTERP, 30);
    const inflight = newInflight();
    const [r1, r2] = await Promise.all([
      applyInterpret(tree, out, A, fake, inflight),
      applyInterpret(tree, out, A, fake, inflight),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(calls()).toBe(1);
  });
});
