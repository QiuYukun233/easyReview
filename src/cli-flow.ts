import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRubyRunnerConfig, expandCmd } from './verify/rspec.js';
import { sandboxFor, syncSandbox } from './verify/sandbox.js';
import { realExec, type Exec } from './verify/cargo.js';
import { TRACER_RB, foldTrace, type RawCall } from './flow/trace.js';
import { loadFlows, saveFlows, upsertFlow } from './flow/flows.js';

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
      throw new Error(`行号非法:「${tail}」——用法 spec/xxx_spec.rb:55(正整数行号定位单 example)`);
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
