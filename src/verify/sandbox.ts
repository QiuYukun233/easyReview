import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** 同步排除:版本库、依赖、构建产物、easyreview 自身产物。 */
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'target']);
const isArtifact = (name: string) => name.startsWith('easyreview.');

export interface Sandbox { dir: string; srcDir: string; targetDir: string; }

/** 纯路径计算,不碰磁盘。hash = 真实仓绝对路径的 sha256 前 12 位。 */
export function sandboxFor(repo: string): Sandbox {
  const hash = createHash('sha256').update(resolve(repo)).digest('hex').slice(0, 12);
  const dir = join(tmpdir(), 'easyreview-sandbox', hash);
  return { dir, srcDir: join(dir, 'src'), targetDir: join(dir, 'target') };
}

export interface SyncStats { copied: number; deleted: number; }

/**
 * 真实仓 → 沙箱 src/ 增量同步。只覆写内容有差异的文件(未变文件 mtime 不动——
 * cargo 增量编译的前提),删掉真实仓已不存在的条目。真实仓全程只读。
 */
export function syncSandbox(repo: string, srcDir: string): SyncStats {
  const stats: SyncStats = { copied: 0, deleted: 0 };
  try {
    mkdirSync(srcDir, { recursive: true });
    syncDir(repo, srcDir, stats);
  } catch (e) {
    throw new Error(
      `沙箱同步失败(${srcDir}):${e instanceof Error ? e.message : String(e)}——可 \`easyreview verify --clean\` 后重试`,
    );
  }
  return stats;
}

function syncDir(from: string, to: string, stats: SyncStats): void {
  const dirs: string[] = [];
  const files: string[] = [];
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!EXCLUDED_DIRS.has(e.name)) dirs.push(e.name); }
    else if (e.isFile()) { if (!isArtifact(e.name)) files.push(e.name); }
    // symlink 等其它类型跳过
  }

  // 先清幽灵/类型变更的旧条目,再拷——否则 file↔dir 类型转换时写入会撞上旧条目(EISDIR/EEXIST)
  const keepDirs = new Set(dirs);
  const keepFiles = new Set(files);
  for (const e of readdirSync(to, { withFileTypes: true })) {
    const keep = e.isDirectory() ? keepDirs.has(e.name) : keepFiles.has(e.name);
    if (!keep) { rmSync(join(to, e.name), { recursive: true, force: true }); stats.deleted++; }
  }

  for (const name of files) {
    const srcBuf = readFileSync(join(from, name));
    const destPath = join(to, name);
    const st = statSync(destPath, { throwIfNoEntry: false });
    const same = st?.isFile() === true && st.size === srcBuf.length && srcBuf.equals(readFileSync(destPath));
    if (!same) { writeFileSync(destPath, srcBuf); stats.copied++; }
  }
  for (const name of dirs) {
    const destPath = join(to, name);
    mkdirSync(destPath, { recursive: true });
    syncDir(join(from, name), destPath, stats);
  }
}
