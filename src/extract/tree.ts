import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listTrackedFiles } from '../git.js';
import { extractLeaves } from './leaves.js';
import { RUST } from './lang.js';
import type { Tree, Chapter, Chunk, Leaf } from '../types.js';

function crateOf(file: string): string {
  const m = file.match(/^crates\/([^/]+)\//);
  if (m) return m[1];
  const top = file.split('/')[0];
  return top.endsWith('.rs') ? 'root' : top;
}

function dirOf(file: string, crate: string): string {
  const stripped = file.replace(new RegExp(`^crates/${crate}/`), '');
  const parts = stripped.split('/');
  parts.pop();
  return parts.join('/') || '';
}

function baseName(file: string): string {
  return file.split('/').pop()!.replace(/\.rs$/, '');
}

export async function buildTree(repo: string): Promise<Tree> {
  const files = listTrackedFiles(repo).filter((f) => f.endsWith('.rs'));
  const leaves: Leaf[] = [];
  const chunks: Chunk[] = [];
  const chapterMap = new Map<string, Chapter>();

  for (const file of files) {
    const crate = crateOf(file);
    const dir = dirOf(file, crate);
    const source = readFileSync(join(repo, file), 'utf8');
    const fileLeaves = await extractLeaves(file, source, RUST);
    leaves.push(...fileLeaves);

    const chunk: Chunk = {
      id: file, name: baseName(file), file, crate,
      leafIds: fileLeaves.map((l) => l.id),
    };
    chunks.push(chunk);

    const chId = `${crate}:${dir}`;
    let chapter = chapterMap.get(chId);
    if (!chapter) {
      chapter = { id: chId, name: `${crate}::${dir || '/'}`, crate, dir, chunkIds: [] };
      chapterMap.set(chId, chapter);
    }
    chapter.chunkIds.push(chunk.id);
  }

  return { repo, chapters: [...chapterMap.values()], chunks, leaves };
}
