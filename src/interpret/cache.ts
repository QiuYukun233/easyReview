import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { InterpretCache } from '../types.js';

export function loadInterpretCache(path: string): InterpretCache {
  if (!existsSync(path)) return { version: 1, entries: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as InterpretCache;
  } catch {
    console.warn('⚠ easyreview.interpret.json 解析失败,忽略并重建缓存');
    return { version: 1, entries: {} };
  }
}

export function saveInterpretCache(path: string, cache: InterpretCache): void {
  writeFileSync(path, JSON.stringify(cache, null, 2));
}
