import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface VitestScope { specFiles: string[]; scanNote?: string; }

const SPEC_RE = /\.(spec|test)\.js$/;
// 与 verify/sandbox.ts 的 EXCLUDED_DIRS 同一排除集
const SKIP_DIRS = new Set(['.git', 'node_modules', 'target']);

/** 收集仓内全部 *.spec.js / *.test.js(仓相对、正斜杠)。 */
export function walkSpecs(repo: string, dir = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(repo, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...walkSpecs(repo, rel)); }
    else if (SPEC_RE.test(e.name)) out.push(rel);
  }
  return out;
}

function commonPrefixLen(a: string, b: string): number {
  const as = a.split('/'); const bs = b.split('/');
  let n = 0;
  while (n < as.length && n < bs.length && as[n] === bs[n]) n++;
  return n;
}

function baseOf(file: string): string {
  return file.split('/').pop()!.replace(/\.[^.]+$/, '');
}

/** 镜像 = basename 命中(URLHelper.js → URLHelper.spec.js,specs/ 在哪层都认);
 *  撞名(各 Vuex 模块的 actions.spec.js)取与源文件目录公共前缀最长者,平手取字典序第一。 */
export function mirrorSpecOf(chunkFile: string, specs: string[]): string | null {
  const base = baseOf(chunkFile);
  const candidates = specs
    .filter((s) => { const m = s.split('/').pop()!.match(/^(.*)\.(spec|test)\.js$/); return m?.[1] === base; })
    .sort();
  if (candidates.length === 0) return null;
  const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
  const srcDir = dirOf(chunkFile);
  let best = candidates[0];
  let bestLen = commonPrefixLen(srcDir, dirOf(best));
  for (const c of candidates.slice(1)) {
    const len = commonPrefixLen(srcDir, dirOf(c));
    if (len > bestLen) { best = c; bestLen = len; }
  }
  return best;
}

/** 圈定:镜像 + 引用扫描(词边界 grep 源 basename——JS import 语句天然含它);
 *  超上限回退只跑镜像+显式 note(不静默截断);镜像与扫描皆空 → null。 */
export function pickVitestScope(repo: string, chunkFile: string, scanLimit: number): VitestScope | null {
  const specs = walkSpecs(repo);
  const mirror = mirrorSpecOf(chunkFile, specs);
  const base = baseOf(chunkFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // basename 已转义;JS/Vue 文件名首尾是词字符(字母/数字/_),\b 语义安全
  const re = new RegExp(`\\b${base}\\b`);
  const hits: string[] = [];
  for (const s of specs) {
    if (s === mirror) continue;
    if (re.test(readFileSync(join(repo, s), 'utf8'))) hits.push(s);
  }
  if (hits.length > scanLimit) {
    if (!mirror) return null;
    return { specFiles: [mirror], scanNote: `引用扫描命中 ${hits.length} 个 spec(超上限 ${scanLimit})——本次只跑镜像 spec。` };
  }
  const specFiles = [...(mirror ? [mirror] : []), ...hits.sort()];
  if (specFiles.length === 0) return null;
  const scanNote = hits.length > 0
    ? `引用扫描命中 ${hits.length} 个 spec(已并入)。`
    : '引用扫描零命中——只跑镜像 spec。';
  return { specFiles, scanNote };
}
