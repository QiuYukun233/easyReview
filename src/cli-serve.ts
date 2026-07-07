import { createViewerServer } from './serve/server.js';

export interface ServeOptions { outDir: string; port: number; }

export async function runServe(opts: ServeOptions): Promise<void> {
  const server = createViewerServer(opts.outDir);
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      reject(e.code === 'EADDRINUSE'
        ? new Error(`端口 ${opts.port} 被占用——换一个:easyreview serve --port <其它端口>`)
        : e);
    });
    server.listen(opts.port, '127.0.0.1', () => resolve());
  });
  console.log(`easyReview viewer: http://localhost:${opts.port}  (Ctrl+C 退出)`);
}
