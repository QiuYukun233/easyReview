import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createViewerServer } from '../src/serve/server.js';
import { makeViewerTree, makeViewerLabels } from './viewer-fixture.js';

const A = 'crates/foo/src/a.rs';

let dirs: string[] = [];
let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((res) => s.close(res))));
  servers = [];
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  dirs = [];
});

function makeOutDir(withLabels = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'easyrev-http-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'easyreview.tree.json'), JSON.stringify(makeViewerTree()));
  if (withLabels) writeFileSync(join(dir, 'easyreview.labels.json'), JSON.stringify(makeViewerLabels()));
  return dir;
}

async function listen(dir: string): Promise<string> {
  const server = createViewerServer(dir);
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('viewer http server', () => {
  it('throws at construction when tree.json is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easyrev-http-'));
    dirs.push(dir);
    expect(() => createViewerServer(dir)).toThrow(/easyreview map/);
  });

  it('GET / serves the html page', async () => {
    const url = await listen(makeOutDir());
    const r = await fetch(url + '/');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(await r.text()).toContain('easyReview');
  });

  it('GET /api/state returns the merged viewer state', async () => {
    const url = await listen(makeOutDir());
    const r = await fetch(url + '/api/state');
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(s.progress.total).toBe(3);
    expect(s.nextId).toBe(A);
    expect(s.chunks[A].responsibility).toBe('演示职责');
  });

  it('POST /api/done marks understood end-to-end (state reflects it)', async () => {
    const dir = makeOutDir();
    const url = await listen(dir);
    const r = await fetch(url + '/api/done', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chunkId: A }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
    const p = JSON.parse(readFileSync(join(dir, 'easyreview.progress.json'), 'utf8'));
    expect(p.understood).toEqual([A]);
    const s = await (await fetch(url + '/api/state')).json();
    expect(s.chunks[A].understood).toBe(true);
    expect(s.nextId).not.toBe(A);
  });

  it('POST /api/done rejects unknown chunk (400) and bad json (400)', async () => {
    const url = await listen(makeOutDir());
    const bad = await fetch(url + '/api/done', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chunkId: 'nope.rs' }),
    });
    expect(bad.status).toBe(400);
    const garbage = await fetch(url + '/api/done', { method: 'POST', body: 'not json' });
    expect(garbage.status).toBe(400);
  });

  it('works without labels.json (responsibility null) and unknown route is 404', async () => {
    const url = await listen(makeOutDir(false));
    const s = await (await fetch(url + '/api/state')).json();
    expect(s.chunks[A].responsibility).toBeNull();
    expect((await fetch(url + '/api/nope')).status).toBe(404);
  });

  it('GET /api/source returns highlighted lines; missing param is 400', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'easyrev-http-'));
    dirs.push(dir);
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'crates/foo/src'), { recursive: true });
    writeFileSync(join(repo, 'crates/foo/src/a.rs'), 'fn f1() {}\n');
    writeFileSync(join(dir, 'easyreview.tree.json'), JSON.stringify({ ...makeViewerTree(), repo }));
    const url = await listen(dir);
    const r = await fetch(url + '/api/source?chunk=' + encodeURIComponent(A));
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.lang).toBe('rust');
    expect(b.lines[0]).toContain('tok-k');
    expect((await fetch(url + '/api/source')).status).toBe(400);
  });

  it('GET /api/interpret: 注入 fake → 200 落盘;interpreter null → 503;无参 → 400', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'easyrev-http-'));
    dirs.push(dir);
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'crates/foo/src'), { recursive: true });
    writeFileSync(join(repo, 'crates/foo/src/a.rs'), 'fn f1() {}\n');
    writeFileSync(join(dir, 'easyreview.tree.json'), JSON.stringify({ ...makeViewerTree(), repo }));
    const fake = { interpret: async () => ({ overview: 'o', dataFlow: 'd', calls: 'c', functions: [] }) };
    const server = createViewerServer(dir, { interpreter: fake });
    servers.push(server);
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const r = await fetch(url + '/api/interpret?chunk=' + encodeURIComponent(A));
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.interpretation.overview).toBe('o');
    expect(JSON.parse(readFileSync(join(dir, 'easyreview.interpret.json'), 'utf8')).entries[A].overview).toBe('o');
    expect((await fetch(url + '/api/interpret')).status).toBe(400);

    // 无 key + 已有缓存 → 仍然能看(缓存命中优先于 503,这是设计行为)
    const serverNoKey = createViewerServer(dir, { interpreter: null });
    servers.push(serverNoKey);
    await new Promise<void>((res) => serverNoKey.listen(0, '127.0.0.1', res));
    const urlNoKey = `http://127.0.0.1:${(serverNoKey.address() as AddressInfo).port}`;
    const rc = await fetch(urlNoKey + '/api/interpret?chunk=' + encodeURIComponent(A));
    expect(rc.status).toBe(200);
    expect((await rc.json()).cached).toBe(true);

    // 无 key + 无缓存 → 503
    const dir2 = mkdtempSync(join(tmpdir(), 'easyrev-http-'));
    dirs.push(dir2);
    writeFileSync(join(dir2, 'easyreview.tree.json'), JSON.stringify({ ...makeViewerTree(), repo }));
    const server503 = createViewerServer(dir2, { interpreter: null });
    servers.push(server503);
    await new Promise<void>((res) => server503.listen(0, '127.0.0.1', res));
    const url2 = `http://127.0.0.1:${(server503.address() as AddressInfo).port}`;
    expect((await fetch(url2 + '/api/interpret?chunk=' + encodeURIComponent(A))).status).toBe(503);
  });
});
