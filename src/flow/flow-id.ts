/** 流程 id:去 spec/ 前缀与 _spec.rb 后缀、/ → -,前缀 flow-,带行号则尾 -L<line>。
 *  trace 与 discover 共用此一处——候选与已追踪流程靠同 id 去重对号(spec:2026-07-19-flow-discover-design.md §5)。 */
export function flowIdFor(spec: string, line: number | null): string {
  const slug = spec
    .replace(/^spec\//, '')
    .replace(/_spec\.rb$/, '')
    .replace(/\//g, '-');
  return 'flow-' + slug + (line != null ? '-L' + line : '');
}
