import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface RspecScope { specFiles: string[]; scanNote: string; }

/** basename(无 .rb)→ Rails camelize:contact_identify_action → ContactIdentifyAction。 */
export function camelize(basename: string): string {
  return basename.split('_').map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s)).join('');
}

/** 镜像 spec 路径:app/x/y.rb → spec/x/y_spec.rb;非 app/ 前缀 → spec/<原路径>_spec.rb。 */
export function mirrorSpecOf(file: string): string {
  const stripped = file.startsWith('app/') ? file.slice('app/'.length) : file;
  return 'spec/' + stripped.replace(/\.rb$/, '_spec.rb');
}

function walkSpecs(dir: string, rel: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walkSpecs(join(dir, e.name), r, out);
    else if (e.isFile() && e.name.endsWith('_spec.rb')) out.push(r);
  }
}

/**
 * 镜像 + 引用扫描(真实仓 spec/ 内容里词边界 grep 类名;类名来自 snake_case 文件名,只含字母数字,无需转义)。
 * 命中超 scanLimit → 回退只跑镜像(显式 note,不做静默截断);镜像与命中皆空、或超限且无镜像 → null。
 */
export function pickRspecScope(repo: string, chunkFile: string, scanLimit: number): RspecScope | null {
  const mirror = mirrorSpecOf(chunkFile);
  const hasMirror = existsSync(join(repo, mirror));

  const base = chunkFile.replace(/^.*\//, '').replace(/\.rb$/, '');
  const className = camelize(base);
  const re = new RegExp(`\\b${className}\\b`);
  const specRoot = join(repo, 'spec');
  const all: string[] = [];
  if (existsSync(specRoot)) walkSpecs(specRoot, 'spec', all);
  const hits = all.filter((f) => f !== mirror && re.test(readFileSync(join(repo, f), 'utf8'))).sort();

  if (hits.length > scanLimit) {
    if (!hasMirror) return null;
    return {
      specFiles: [mirror],
      scanNote: `引用扫描命中 ${hits.length} 个 spec,超过上限 ${scanLimit}——本次只跑镜像 spec(该类是全仓热点)。`,
    };
  }
  if (!hasMirror && hits.length === 0) return null;
  return {
    specFiles: hasMirror ? [mirror, ...hits] : hits,
    scanNote: hits.length
      ? `引用扫描命中 ${hits.length} 个 spec(类名 ${className})。`
      : `引用扫描零命中(类名 ${className})——只跑镜像 spec。`,
  };
}
