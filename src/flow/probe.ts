import type { Flow, FlowStep } from '../types.js';
import type { TestRun } from '../verify/runner.js';
import type { ProbeSite } from './probe-site.js';

export type ProbePrediction = 'red' | 'green';
export interface ProbeVerdict { actual: ProbePrediction; predicted: ProbePrediction; hit: boolean }

/** red = 该 example 失败或加载崩(compiled=false)——加载崩=正常爆炸半径(rspec 探针先例)。
 *  依赖 parseRspecJson 的不变式:results 为空 ⟹ compiled=false(0 个 example 不会被误判 green);换判定来源时必须复核。 */
export function judgeProbe(run: TestRun, predicted: ProbePrediction): ProbeVerdict {
  const actual: ProbePrediction = !run.compiled || run.results.some((r) => !r.passed) ? 'red' : 'green';
  return { actual, predicted, hit: actual === predicted };
}

export interface ProbeReportInput {
  flow: Flow; step: number; target: FlowStep; site: ProbeSite; fallback: boolean; verdict: ProbeVerdict;
}

export function renderProbeMd(a: ProbeReportInput): string {
  const lines: string[] = [
    '# 流程探针 · 判定',
    `流程:「${a.flow.name}」(${a.flow.source.spec})`,
    `目标:第 ${a.step} 步 \`${a.target.chunkId}\``,
    `刀落点:第 ${a.site.line} 行` + (a.site.scope === 'method' ? `(流程命中方法 \`${a.site.method}\` 体内)` : ''),
  ];
  if (a.fallback) {
    lines.push('⚠ 回退:方法体内无可注释语句,刀落在流程未必经过的位置' +
      (a.verdict.actual === 'green' ? '——绿色结果不可作为理解凭据。' : '(本次实际断了,红色结论仍有效)。'));
  }
  lines.push(`- 你的预测:${a.verdict.predicted === 'red' ? '断(red)' : '不断(green)'}`);
  lines.push(`- 实际结果:${a.verdict.actual === 'red' ? '断了(red)' : '没断(green)'}`);
  if (a.verdict.actual === 'green' && !a.fallback) {
    lines.push('- 绿的两种解释:该行是防御性/旁路代码,或不在这条 example 的断言路径上——都值得回看。');
  }
  lines.push(a.verdict.hit
    ? '✅ 预测命中——你懂这一步在流程里的角色。'
    : '❌ 预测未命中——回去重读这一步:它在流程里干的事和你想的不一样。');
  return lines.join('\n') + '\n';
}
