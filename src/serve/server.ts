import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GradedTree } from '../types.js';
import { loadLabelCache } from '../label/cache.js';
import { loadProgress } from '../progress/progress.js';
import { buildViewerState } from './state.js';
import { applyDone } from './done.js';
import { renderPage } from './page.js';

/** 没有 tree.json 就没得看——启动即失败,给出明确指引。 */
export function loadTreeOrThrow(outDir: string): GradedTree {
  const p = join(outDir, 'easyreview.tree.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as GradedTree;
  } catch {
    throw new Error(`找不到/读不了 ${p}——先运行 \`easyreview map --repo <path> --out ${outDir}\``);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function createViewerServer(outDir: string): Server {
  loadTreeOrThrow(outDir); // 启动校验
  return createServer((req, res) => {
    handle(outDir, req, res).catch((e) => {
      sendJson(res, 500, { ok: false, error: String(e) });
    });
  });
}

async function handle(outDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = (req.url ?? '/').split('?')[0];

  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderPage());
    return;
  }

  if (req.method === 'GET' && url === '/api/state') {
    // 每请求现读磁盘:另一终端重跑 map/done 后,F5 即最新
    const tree = loadTreeOrThrow(outDir);
    const labels = loadLabelCache(join(outDir, 'easyreview.labels.json'));
    const progress = loadProgress(join(outDir, 'easyreview.progress.json'));
    sendJson(res, 200, buildViewerState(tree, labels, progress));
    return;
  }

  if (req.method === 'POST' && url === '/api/done') {
    let chunkId: unknown;
    try {
      chunkId = (JSON.parse(await readBody(req)) as { chunkId?: unknown }).chunkId;
    } catch {
      sendJson(res, 400, { ok: false, error: 'body 不是合法 JSON' });
      return;
    }
    const tree = loadTreeOrThrow(outDir);
    const result = applyDone(tree, outDir, chunkId);
    sendJson(res, result.status, result.body);
    return;
  }

  sendJson(res, 404, { ok: false, error: `没有这个路由:${req.method} ${url}` });
}
