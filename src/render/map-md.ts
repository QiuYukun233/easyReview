import type { GradedTree, Chapter, RiskBucket, ContribBucket } from '../types.js';

const RISK_ROWS: RiskBucket[] = ['high', 'med', 'low', 'none'];
const CONTRIB_COLS: ContribBucket[] = ['filler', 'low', 'med', 'high'];
const RISK_LABEL: Record<RiskBucket, string> = { high: '风险 高', med: '风险 中', low: '风险 低', none: '风险 无' };
const CONTRIB_LABEL: Record<ContribBucket, string> = { filler: '填充', low: '低', med: '中', high: '高' };

function mode<T>(xs: T[]): T {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function chapterBuckets(ch: Chapter, g: GradedTree): { risk: RiskBucket; contrib: ContribBucket } {
  const rs = ch.chunkIds.map((id) => g.grades[id].riskBucket);
  const cs = ch.chunkIds.map((id) => g.grades[id].contribBucket);
  return { risk: mode(rs), contrib: mode(cs) };
}

export function renderMapMarkdown(g: GradedTree): string {
  const grid = new Map<string, string[]>();
  for (const ch of g.chapters) {
    const { risk, contrib } = chapterBuckets(ch, g);
    const key = `${risk}|${contrib}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push(ch.name);
  }

  const lines: string[] = [];
  lines.push('# easyReview 地图');
  lines.push('');
  lines.push('> 接地地图：章按 git 历史算出的风险 × 架构贡献度落位。从左下（填充/低风险）起步，爬向右上核心。');
  lines.push('');
  lines.push(`| | ${CONTRIB_COLS.map((c) => CONTRIB_LABEL[c]).join(' | ')} |`);
  lines.push(`|---|${CONTRIB_COLS.map(() => '---').join('|')}|`);
  for (const risk of RISK_ROWS) {
    const cells = CONTRIB_COLS.map((contrib) => {
      const names = grid.get(`${risk}|${contrib}`) ?? [];
      return names.join('<br>') || '·';
    });
    lines.push(`| **${RISK_LABEL[risk]}** | ${cells.join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}
