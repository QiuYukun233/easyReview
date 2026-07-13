import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerifyRunner } from './runner.js';
import { realExec, type Exec } from './cargo.js';
import { expandCmd, groupBySpecDir } from './rspec.js';
import { parseVitestJson } from './vitest-parse.js';
import { pickVitestScope, type VitestScope } from './vitest-scope.js';

export interface JsRunnerConfig { cmd: string[]; scanLimit?: number; }

/** 读仓根 easyreview.runner.json 的 js 节。缺失/无效 → 可操作错误。 */
export function loadJsRunnerConfig(repo: string): JsRunnerConfig {
  const p = join(repo, 'easyreview.runner.json');
  if (!existsSync(p)) {
    throw new Error('verify JS/Vue 需要仓根 easyreview.runner.json——chatwoot 配方见 docs/recipes/chatwoot-vitest.md');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(p, 'utf8')); } catch {
    throw new Error('easyreview.runner.json 解析失败——检查 JSON 语法');
  }
  const js = (parsed as { js?: JsRunnerConfig }).js;
  if (!js || !Array.isArray(js.cmd) || js.cmd.length === 0) {
    throw new Error('easyreview.runner.json 缺少 js.cmd——chatwoot 配方见 docs/recipes/chatwoot-vitest.md');
  }
  return js;
}

/** vitest runner:一个实例同时服务 js 与 vue 块(圈定/执行/分组与语言无关,按 spec 文件走)。 */
export function makeVitestRunner(config: JsRunnerConfig): VerifyRunner {
  return {
    id: 'js',
    pickScope(_g, chunk, repo) {
      const scope = pickVitestScope(repo, chunk.file, config.scanLimit ?? 20);
      if (!scope) {
        throw new Error(`${chunk.file} 找不到可用的 spec 域(镜像 spec 不存在,或引用过广且无镜像)——换个有测试覆盖的块`);
      }
      return { scope, note: scope.scanNote };
    },
    async run(sandboxSrc, _sandboxTarget, scope, exec) {
      const { specFiles } = scope as VitestScope;
      const [cmd, ...args] = expandCmd(config.cmd, specFiles);
      const out = await ((exec ?? realExec) as Exec)(cmd, args, sandboxSrc);
      return parseVitestJson(out);
    },
    group: groupBySpecDir,
  };
}
