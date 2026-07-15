import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRubyRunnerConfig, expandCmd } from './verify/rspec.js';
import { sandboxFor, syncSandbox } from './verify/sandbox.js';
import { realExec, type Exec } from './verify/cargo.js';
import { TRACER_RB, foldTrace, type RawCall } from './flow/trace.js';
import { loadFlows, saveFlows, upsertFlow } from './flow/flows.js';
import { withMutation, chooseMutation } from './verify/mutate.js';
import { parseRspecJson } from './verify/rspec-parse.js';
import { pickSiteInMethods, type ProbeSite } from './flow/probe-site.js';
import { judgeProbe, renderProbeMd, type ProbePrediction } from './flow/probe.js';
import type { MutationOp } from './types.js';

const TRACER_NAME = 'easyreview_tracer.rb';
const TRACE_OUT = 'easyreview-trace.json';

export interface SpecRef { file: string; line: number | null }

/** 解析 spec 引用:尾部 :<正整数> 定位单 example(spec:2026-07-16-flow-example-window-design.md)。
 *  多 example spec 下每个 example 重建工厂数据会污染双相判定——单 example 窗口恢复其语义。 */
export function parseSpecRef(ref: string): SpecRef {
  const i = ref.lastIndexOf(':');
  if (i > 0 && ref.slice(0, i).endsWith('_spec.rb')) {
    const tail = ref.slice(i + 1);
    const digits = tail.length > 0 && [...tail].every((ch) => ch >= '0' && ch <= '9');
    if (!digits || Number(tail) < 1) {
      throw new Error(`行号非法:「${tail || '(空)'}」——用法 spec/xxx_spec.rb:55(正整数行号定位单 example)`);
    }
    return { file: ref.slice(0, i), line: Number(tail) };
  }
  return { file: ref, line: null };
}

export interface FlowTraceOpts {
  repo: string; outDir: string; specFile: string; name: string;
  exec?: Exec; // 测试注入;缺省 realExec(非零退出不抛——trace 不受 spec 红绿影响)
}

/** 编排:沙箱同步→tracer 写进沙箱(compose 挂沙箱,真实仓零污染)→rspec -r 注入→读回→折叠→落盘→finally 清理。 */
export async function runFlowTrace(o: FlowTraceOpts): Promise<void> {
  const ref = parseSpecRef(o.specFile);
  if (!ref.file.endsWith('_spec.rb')) {
    throw new Error('flow trace 打样期只支持 Ruby rspec——传 *_spec.rb 文件(spec §1,web 栈先行)');
  }
  const specArg = ref.line ? ref.file + ':' + ref.line : ref.file;
  const config = loadRubyRunnerConfig(o.repo);
  const sb = sandboxFor(o.repo);
  console.error('⏳ 同步沙箱…');
  syncSandbox(o.repo, sb.srcDir);
  if (!existsSync(join(sb.srcDir, ref.file))) throw new Error(`仓里没有 ${ref.file}`);
  writeFileSync(join(sb.srcDir, TRACER_NAME), TRACER_RB);
  try {
    console.error('⏳ 跑 rspec + TracePoint(docker 冷启动可能较慢)…');
    const [cmd, ...args] = expandCmd(config.cmd, ['-r./' + TRACER_NAME, specArg]);
    await (o.exec ?? realExec)(cmd, args, sb.srcDir);
    const tracePath = join(sb.srcDir, TRACE_OUT);
    if (!existsSync(tracePath)) {
      throw new Error('trace 输出不存在——rspec 可能在加载期崩了或进程被超时杀死(at_exit 没跑到);先手跑该 spec 确认环境(配方:docs/recipes/chatwoot-rspec.md)');
    }
    let raw: { truncated: boolean; calls: RawCall[] };
    try {
      raw = JSON.parse(readFileSync(tracePath, 'utf8')) as { truncated: boolean; calls: RawCall[] };
    } catch {
      throw new Error('trace 输出损坏(非法 JSON)——容器可能在落盘中途被杀,重跑一次;反复出现则先手跑该 spec 确认环境');
    }
    const steps = foldTrace(raw.calls);
    if (!steps.length) throw new Error('trace 没有触达 app/ 代码——换一条 request/controller spec');
    if (raw.truncated) console.error('⚠ trace 达上限被截断——首现序步链仍可用,hits 偏低');
    const flow = {
      id: 'flow-' + ref.file.split('/').pop()!.replace('_spec.rb', '') + (ref.line ? '-L' + ref.line : ''),
      name: o.name,
      source: { kind: 'rspec-trace' as const, spec: specArg, tracedAt: new Date().toISOString() },
      steps,
      rawTrace: raw.calls,
    };
    saveFlows(o.outDir, upsertFlow(loadFlows(o.outDir), flow));
    // 成功横幅在编排层打印(不走 cli.ts 的 .then 收口):横幅要用 steps.length,cli.ts 拿不到
    console.log(`✓ flow 「${o.name}」:${steps.length} 步已写入 easyreview.flows.json`);
  } finally {
    for (const f of [TRACER_NAME, TRACE_OUT]) {
      const p = join(sb.srcDir, f);
      if (existsSync(p)) unlinkSync(p);
    }
  }
}

export interface FlowProbeOpts {
  repo: string; outDir: string; flowId: string; step: number; predict: string;
  exec?: Exec;
}

/** 流程级突变探针:斩链上第 N 步(优先流程命中方法体内),真跑单 example,比对预测(spec:2026-07-16-flow-probe-design.md)。 */
export async function runFlowProbe(o: FlowProbeOpts): Promise<void> {
  if (o.predict !== 'red' && o.predict !== 'green') {
    throw new Error('--predict 只接受 red|green(断/不断)');
  }
  const predicted = o.predict as ProbePrediction;
  const flowsFile = loadFlows(o.outDir);
  const flow = flowsFile?.flows.find((f) => f.id === o.flowId);
  if (!flow) {
    const have = (flowsFile?.flows ?? []).map((f) => f.id).join(', ') || '(空)';
    throw new Error(`找不到流程「${o.flowId}」——现有:${have}`);
  }
  if (parseSpecRef(flow.source.spec).line === null) {
    throw new Error('该流程是全谱 trace(spec 无行号)——红绿会被其它 example 污染;先用 flow trace <spec>:<行号> 采单例流程');
  }
  if (!Number.isInteger(o.step) || o.step < 1 || o.step > flow.steps.length) {
    throw new Error(`--step 越界:${o.step}(该流程共 ${flow.steps.length} 步)`);
  }
  const target = flow.steps[o.step - 1];
  if (!target.chunkId.endsWith('.rb')) {
    throw new Error(`第 ${o.step} 步 ${target.chunkId} 非 Ruby 文件——流程探针目前只支持 rspec 可执行的 .rb 步(前端步靠 vitest 探针,见 verify)`);
  }
  const config = loadRubyRunnerConfig(o.repo);
  const sb = sandboxFor(o.repo);
  console.error('⏳ 同步沙箱…');
  syncSandbox(o.repo, sb.srcDir);
  const absFile = join(sb.srcDir, target.chunkId);
  if (!existsSync(absFile)) throw new Error(`沙箱里没有 ${target.chunkId}`);
  const source = readFileSync(absFile, 'utf8');

  // 主路径:该步 methods(频次序)∩ rawTrace 定义行 → 方法体内落刀
  const defLines: { method: string; line: number }[] = [];
  for (const m of target.methods) {
    const hit = flow.rawTrace.find((c) => c.file === '/app/' + target.chunkId && c.method === m);
    if (hit) defLines.push({ method: m, line: hit.line });
  }
  let site: ProbeSite | null = await pickSiteInMethods(source, defLines);
  let fallback = false;
  let fallbackOp: MutationOp | null = null;
  if (!site) {
    // 回退:文件级既有 chooseMutation(报告显式标注)
    const fbOp = await chooseMutation(
      { id: target.chunkId, name: target.chunkId, file: target.chunkId, crate: '', leafIds: [] }, [], source);
    if (!fbOp) throw new Error(`${target.chunkId} 找不到可注释的探针位点——换一步(与 verify 的 uncovered 先例一致)`);
    site = { line: fbOp.line, original: fbOp.original, scope: 'file-fallback' };
    fallback = true;
    fallbackOp = fbOp; // 复用 chooseMutation 的语言感知 mutated
  }
  const indent = site.original.slice(0, site.original.length - site.original.trimStart().length);
  const op: MutationOp = fallbackOp ?? {
    file: target.chunkId, line: site.line, original: site.original,
    mutated: indent + '# ' + site.original.trim(), // 主路径:方法体内已保证 .rb(见上方断言)
    description: `flow probe:斩「${flow.name}」第 ${o.step} 步`,
  };
  console.error(`⏳ 斩第 ${o.step} 步(${target.chunkId}:${site.line}${site.method ? ' · ' + site.method : ''})并重跑单 example…`);
  const [cmd, ...args] = expandCmd(config.cmd, [flow.source.spec]);
  const run = await withMutation(absFile, op, async () =>
    parseRspecJson(await (o.exec ?? realExec)(cmd, args, sb.srcDir)));
  const verdict = judgeProbe(run, predicted);
  writeFileSync(join(o.outDir, 'easyreview.flowprobe.md'),
    renderProbeMd({ flow, step: o.step, target, site, fallback, verdict }));
  console.log(verdict.hit
    ? '✓ 预测命中——报告已写入 easyreview.flowprobe.md'
    : '✗ 预测未命中——报告已写入 easyreview.flowprobe.md');
}
