import type { FlowStep } from '../types.js';

export interface RawCall { file: string; method: string; line: number }

export const TRACE_LIMIT = 50000;
const METHODS_TOP_N = 8;

/** 容器内 tracer:TracePoint 采 app/ 调用序列,at_exit 落盘 JSON。
 *  经 rspec -r./easyreview_tracer.rb 注入(写进沙箱,compose 挂沙箱→真实仓零污染)。
 *  Ruby 内容禁反引号与美元花括号(本文件是 TS 模板字面量)。 */
export const TRACER_RB = `# easyreview flow tracer(自动生成,用后即删)
require 'json'
EASYREVIEW_CALLS = []
EASYREVIEW_TP = TracePoint.new(:call) do |t|
  path = t.path.to_s
  next unless path.start_with?('/app/app/')
  next if EASYREVIEW_CALLS.length >= ${TRACE_LIMIT}
  EASYREVIEW_CALLS << { 'file' => path, 'method' => t.method_id.to_s, 'line' => t.lineno }
end
EASYREVIEW_TP.enable
at_exit do
  begin
    File.write('/app/easyreview-trace.json', JSON.generate({
      'truncated' => EASYREVIEW_CALLS.length >= ${TRACE_LIMIT},
      'calls' => EASYREVIEW_CALLS,
    }))
  rescue => e
    warn "easyreview tracer: trace 落盘失败 #{e.class} #{e.message}"
  end
end
`;

/** 调用序列 → 文件级链:去容器前缀、只保 app/、步序=首现、hits=命中次数(相邻合并被此规则覆盖)。 */
export function foldTrace(calls: RawCall[], containerPrefix = '/app/'): FlowStep[] {
  const order: string[] = [];
  const byFile = new Map<string, { hits: number; methodCounts: Map<string, number> }>();
  for (const c of calls) {
    if (!c.file.startsWith(containerPrefix)) continue;
    const rel = c.file.slice(containerPrefix.length);
    if (!rel.startsWith('app/')) continue;
    let e = byFile.get(rel);
    if (!e) { e = { hits: 0, methodCounts: new Map() }; byFile.set(rel, e); order.push(rel); }
    e.hits++;
    e.methodCounts.set(c.method, (e.methodCounts.get(c.method) ?? 0) + 1);
  }
  return order.map((f) => {
    const e = byFile.get(f)!;
    const methods = [...e.methodCounts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, METHODS_TOP_N)
      .map(([m]) => m);
    return { chunkId: f, methods, hits: e.hits };
  });
}
