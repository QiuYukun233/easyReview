import type { FlowStep, FlowPhase } from '../types.js';

export interface RawCall { file: string; method: string; line: number }

export const TRACE_LIMIT = 50000;
const METHODS_TOP_N = 8;
const BOUNDARY_PREFIX = 'app/controllers/'; // 分界锚点;将来多锚点(jobs/mailer 入口)扩成数组

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

/** 调用序列 → 文件级链 + 分相(spec:2026-07-16-flow-phase-design.md):
 *  去容器前缀、只保 app/、hits=全链命中次数。
 *  分界点 = 首次进 app/controllers/ 的调用(含自身);分界起仍被命中 → request,否则 setup。
 *  steps 重排:setup 段(首现序)在前、request 段(按分界后首次命中序,叙事从 controller 开场)在后;
 *  无分界点 → 全部 request、不分段(model spec 等,行为同分相前)。 */
export function foldTrace(calls: RawCall[], containerPrefix = '/app/'): FlowStep[] {
  const rels: string[] = calls.map((c) => {
    if (!c.file.startsWith(containerPrefix)) return '';
    const rel = c.file.slice(containerPrefix.length);
    return rel.startsWith('app/') ? rel : '';
  });
  const boundary = rels.findIndex((r) => r.startsWith(BOUNDARY_PREFIX));

  const byFile = new Map<string, { hits: number; methodCounts: Map<string, number>; firstAfterBoundary: number }>();
  const order: string[] = [];
  for (let i = 0; i < calls.length; i++) {
    const rel = rels[i];
    if (!rel) continue;
    let e = byFile.get(rel);
    if (!e) { e = { hits: 0, methodCounts: new Map(), firstAfterBoundary: -1 }; byFile.set(rel, e); order.push(rel); }
    e.hits++;
    e.methodCounts.set(calls[i].method, (e.methodCounts.get(calls[i].method) ?? 0) + 1);
    if (boundary >= 0 && i >= boundary && e.firstAfterBoundary < 0) e.firstAfterBoundary = i;
  }

  const toStep = (f: string, phase: FlowPhase): FlowStep => {
    const e = byFile.get(f)!;
    const methods = [...e.methodCounts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, METHODS_TOP_N)
      .map(([m]) => m);
    return { chunkId: f, methods, hits: e.hits, phase };
  };

  if (boundary < 0) return order.map((f) => toStep(f, 'request'));
  const setup = order.filter((f) => byFile.get(f)!.firstAfterBoundary < 0);
  const request = order.filter((f) => byFile.get(f)!.firstAfterBoundary >= 0)
    .sort((a, b) => byFile.get(a)!.firstAfterBoundary - byFile.get(b)!.firstAfterBoundary);
  return [...setup.map((f) => toStep(f, 'setup')), ...request.map((f) => toStep(f, 'request'))];
}
