import { z } from 'zod';
import type { InterpretInput } from '../types.js';
import { langOf } from '../extract/lang.js';

export const InterpretSchema = z.object({
  overview: z.string(),
  dataFlow: z.string(),
  calls: z.string(),
  functions: z.array(z.object({ name: z.string(), gist: z.string() })),
});

/** 铁律:只描述整文件可见结构 + 事实清单给的关系;跨文件只转述事实,不点名未出现的文件。 */
export const INTERPRET_SYSTEM =
  '你是代码库导览助手。给定一个文件的完整源码和一组确定性事实,你为它写一篇中文解读,四个字段:\n' +
  '- overview:职责展开,3-5 句——这个文件对外做什么、内部怎么组织。\n' +
  '- dataFlow:数据怎么进、怎么变、怎么出(参数/状态/返回/副作用)。\n' +
  '- calls:调用关系,只讲两类——①文件内可见的(use/mod/函数间调用);②事实清单里给的(同章邻居、信号档位)。跨文件关系只能转述事实,不得点名事实与源码中未出现的文件。\n' +
  '- functions:逐函数一句话职责,name 与给定函数名单一致、顺序相同。\n' +
  '严禁发明源码与事实中未出现的结构、依赖或调用关系。\n\n' +
  '请用 json 输出,且只输出 json,格式示例:' +
  '{"overview": "…", "dataFlow": "…", "calls": "…", "functions": [{"name": "f", "gist": "一句话"}]}';

function levelOf(v: number): string {
  return v >= 0.66 ? '高' : v >= 0.33 ? '中' : '低';
}

export function interpretUserPrompt(i: InterpretInput): string {
  const fence = langOf(i.file)?.fence ?? '';
  const s = i.signals;
  return (
    '确定性事实:\n' +
    `- 块:${i.chunkName}(文件 ${i.file},章 ${i.chapterName})\n` +
    `- 风险:${i.riskBucket} · 架构贡献度:${i.contribBucket}\n` +
    `- 信号档位:相对churn ${levelOf(s.relChurn)}(${s.relChurn.toFixed(2)}) · 共变耦合 ${levelOf(s.coupling)}(${s.coupling.toFixed(2)}) · 所有权集中 ${levelOf(s.ownership)}(${s.ownership.toFixed(2)}) · 名字扇入中心度 ${levelOf(s.centrality)}(${s.centrality.toFixed(2)})\n` +
    `- 同章邻居:${i.neighbors.join('、') || '(无)'}\n` +
    `- 函数名单:${i.functions.map((f) => `${f.name}(第${f.startLine}行)`).join('、') || '(无独立函数)'}` +
    (i.truncated ? '\n- 注意:文件超长,以下源码被截断,只含开头部分。' : '') +
    `\n\n完整源码:\n\`\`\`${fence}\n${i.source}\n\`\`\``
  );
}
