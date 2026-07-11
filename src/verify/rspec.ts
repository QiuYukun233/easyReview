import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerifyRunner } from './runner.js';
import { realExec, type Exec } from './cargo.js';
import { parseRspecJson } from './rspec-parse.js';
import { pickRspecScope, type RspecScope } from './rspec-scope.js';
import type { TestGroup } from './testlist.js';

export interface RubyRunnerConfig { cmd: string[]; scanLimit?: number; }

/** 读仓根 easyreview.runner.json 的 ruby 节。缺失/无效 → 可操作错误。 */
export function loadRubyRunnerConfig(repo: string): RubyRunnerConfig {
  const p = join(repo, 'easyreview.runner.json');
  if (!existsSync(p)) {
    throw new Error('verify Ruby 需要仓根 easyreview.runner.json——chatwoot 配方见 docs/recipes/chatwoot-rspec.md');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(p, 'utf8')); } catch {
    throw new Error('easyreview.runner.json 解析失败——检查 JSON 语法');
  }
  const ruby = (parsed as { ruby?: RubyRunnerConfig }).ruby;
  if (!ruby || !Array.isArray(ruby.cmd) || ruby.cmd.length === 0) {
    throw new Error('easyreview.runner.json 缺少 ruby.cmd——chatwoot 配方见 docs/recipes/chatwoot-rspec.md');
  }
  return ruby;
}

/** {specFiles} 占位符展开为多个参数(每个 spec 文件一个)。 */
export function expandCmd(cmd: string[], specFiles: string[]): string[] {
  return cmd.flatMap((c) => (c === '{specFiles}' ? specFiles : [c]));
}

function groupBySpecDir(names: string[]): TestGroup[] {
  const byDir = new Map<string, string[]>();
  for (const n of names) {
    const dir = n.split('/').slice(0, 2).join('/');
    const arr = byDir.get(dir);
    if (arr) arr.push(n);
    else byDir.set(dir, [n]);
  }
  return [...byDir.keys()].sort().map((module) => ({ module, tests: byDir.get(module)!.sort() }));
}

export function makeRspecRunner(config: RubyRunnerConfig): VerifyRunner {
  return {
    id: 'ruby',
    pickScope(_g, chunk, repo) {
      const scope = pickRspecScope(repo, chunk.file, config.scanLimit ?? 20);
      if (!scope) {
        throw new Error(`${chunk.file} 找不到可用的 spec 域(镜像 spec 不存在,或引用过广且无镜像)——换个有测试覆盖的块`);
      }
      return { scope, note: scope.scanNote };
    },
    async run(sandboxSrc, _sandboxTarget, scope, exec) {
      const { specFiles } = scope as RspecScope;
      const [cmd, ...args] = expandCmd(config.cmd, specFiles);
      const out = await (exec ?? realExec)(cmd, args, sandboxSrc);
      return parseRspecJson(out);
    },
    group: groupBySpecDir,
  };
}
