import type { TestRun } from './runner.js';

/** 解析 vitest --reporter=json(jest 兼容)输出,聚合到文件级。
 *  实测(2026-07-13):单行 JSON,testResults[].name=spec 绝对路径(正斜杠,Windows 也是),
 *  status='passed'|'failed';加载失败也是对应文件条目 failed(vitest 逐文件隔离,
 *  无 rspec 式全套件崩)。输出可能混杂 docker/编译噪音:自底向上找含 testResults 键的 JSON 行。
 *  解析不出 / testResults 空 → compiled:false(套件没跑起来)。 */
export function parseVitestJson(output: string): TestRun {
  // 整段兜底:某些版本/配置可能 pretty-print 多行 JSON——整个输出就是一个 JSON 时直接取
  const whole = tryParseObject(output.trim());
  if (whole && Array.isArray(whole.testResults)) return fromResults(whole.testResults);
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t.startsWith('{')) continue;
    const j = tryParseObject(t);
    if (!j || !Array.isArray(j.testResults)) continue;
    return fromResults(j.testResults);
  }
  return { compiled: false, results: [] };
}

type VitestReport = { testResults?: Array<{ name?: string; status?: string }> };

/** 尝试把一段文本解析为 JSON 对象;直接失败则截到最后一个 '}' 再试
 *  (vitest --outputFile=/dev/stdout 会在同一行 JSON 后追加 "JSON report written to ..." 提示)。 */
function tryParseObject(t: string): VitestReport | null {
  try { return JSON.parse(t) as VitestReport; } catch { /* 试截断 */ }
  const i = t.lastIndexOf('}');
  if (i > 0) {
    try { return JSON.parse(t.slice(0, i + 1)) as VitestReport; } catch { /* 不是 */ }
  }
  return null;
}

/** testResults → TestRun 映射(整段兜底与行扫两分支共用);空数组 → compiled:false(套件没跑起来)。 */
function fromResults(testResults: Array<{ name?: string; status?: string }>): TestRun {
  if (testResults.length === 0) return { compiled: false, results: [] };
  const results = testResults.map((r) => ({
    name: toRepoRelative(String(r.name ?? '')),
    // 白名单极性:实测文件级 status 只有 passed/failed;万一出现 skipped/todo,按未通过处理——baseline/predict 两侧同函数,不会误判 newly-failing(进不了任何一侧的 green 集)
    passed: r.status === 'passed',
  }));
  return { compiled: true, results };
}

/** 绝对→仓相对:剥容器 /app/ 前缀(配方 working_dir=/app);不中按 /app/javascript/ 锚点截取
 *  (chatwoot 前端 spec 全在其下);再不中原样保留(确定性降级,不抛)。 */
function toRepoRelative(p: string): string {
  const n = p.replace(/\\/g, '/');
  if (n.startsWith('/app/')) return n.slice('/app/'.length);
  const i = n.indexOf('/app/javascript/');
  if (i >= 0) return n.slice(i + 1);
  return n;
}
