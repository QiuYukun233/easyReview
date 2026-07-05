import type { GradedTree, JourneyPath, Progress, Grade, RiskBucket, ContribBucket } from '../types.js';

const RISK: Record<RiskBucket, string> = { high: '高', med: '中', low: '低', none: '无' };
const CONTRIB: Record<ContribBucket, string> = { filler: '填充', low: '低', med: '中', high: '高' };

function whyNow(grade: Grade): string {
  if (grade.contribBucket === 'filler') return '简单、重复、低风险——用来先熟悉项目的词汇与惯用法。';
  if (grade.riskBucket === 'high') return '高风险核心：改错代价大，是你最终要吃透的部分。';
  if (grade.contribBucket === 'high') return '架构中心：很多东西依赖它，理解它能解锁一大片。';
  return '难度适中，承上启下。';
}

function bar(pct: number): string {
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

export function renderJourneyMarkdown(g: GradedTree, path: JourneyPath, progress: Progress): string {
  const understood = new Set(progress.understood);
  const total = path.steps.length;
  const done = progress.understood.length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const lines: string[] = [];
  lines.push('# easyReview 学习旅程');
  lines.push('');
  lines.push(`进度 \`[${bar(pct)}]\` ${pct}%  （已理解 ${done}/${total}）`);
  lines.push('');

  const next = path.steps.find((s) => !understood.has(s.chunkId));
  if (!next) {
    lines.push('🎉 全部走完——你已经走遍这个项目。回头看地图，它现在应该读得懂了。');
    return lines.join('\n');
  }

  const chunk = g.chunks.find((c) => c.id === next.chunkId)!;
  const grade = g.grades[next.chunkId];
  const chapter = g.chapters.find((c) => c.id === next.chapterId)!;
  const leaves = g.leaves.filter((l) => l.file === next.chunkId);

  lines.push(`## 下一步（第 ${next.order + 1}/${total} 步）：\`${chunk.name}\``);
  lines.push('');
  lines.push(`- 所在章：${chapter.name}`);
  lines.push(`- 文件：\`${chunk.file}\``);
  lines.push(`- 风险：${RISK[grade.riskBucket]} · 架构贡献度：${CONTRIB[grade.contribBucket]}`);
  lines.push(`- 为什么现在学它：${whyNow(grade)}`);
  lines.push('');
  lines.push(`### 它有哪些函数（${leaves.length}）`);
  if (leaves.length === 0) lines.push('- （本文件无独立函数，可能是模块声明/重导出）');
  for (const l of leaves) lines.push(`- \`${l.name}\`  (${l.file}:${l.startLine}-${l.endLine})`);
  lines.push('');
  lines.push('### 自测（答得上来再标记理解）');
  lines.push('- 这个块对外做什么？用一句话说清它的职责。');
  lines.push('- 它读/写了哪些状态或数据？');
  lines.push('- 谁会调用它、它又依赖谁？');
  lines.push('');
  if (next.neighbors.length) {
    lines.push('### 顺便看看（防盲区觅食）');
    lines.push('同章相邻，别只盯着这一条路径：');
    for (const n of next.neighbors.slice(0, 6)) {
      const nc = g.chunks.find((c) => c.id === n);
      if (nc) lines.push(`- \`${nc.name}\` (\`${n}\`)${understood.has(n) ? ' ✓' : ''}`);
    }
    lines.push('');
  }
  lines.push('---');
  lines.push(`理解了就运行：\`easyreview done ${chunk.id}\``);
  return lines.join('\n');
}
