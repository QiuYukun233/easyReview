export interface TestGroup {
  module: string;
  tests: string[]; // 完整测试名（如 core::field::t1），非叶名
}

/** 按 `::` 模块前缀把测试名分组：最后一段是测试函数名，前面是模块路径；
 *  无 `::` 的归到 "(crate 根)"。组内保持原始顺序；组按模块名字典序排序（确定性输出）。 */
export function groupTestsByModule(names: string[]): TestGroup[] {
  const byModule = new Map<string, string[]>();
  for (const name of names) {
    const idx = name.lastIndexOf('::');
    const module = idx >= 0 ? name.slice(0, idx) : '(crate 根)';
    const arr = byModule.get(module);
    if (arr) arr.push(name);
    else byModule.set(module, [name]);
  }
  return [...byModule.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((module) => ({ module, tests: byModule.get(module)! }));
}
