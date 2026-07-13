/** Vue SFC 的 <script> 区段切取:regex 定位开标签,首个 </script> 收尾(HTML 规范同款切法)。
 *  lineOffset = 开标签结尾所在 0 基行号;区段从 > 之后开始(区段 row 0 = 开标签行剩余部分),
 *  故叶子真实行号 = 区段内 row + 1 + lineOffset。 */
export interface CarvedSegment { source: string; lineOffset: number }

const OPEN_TAG = /<script\b[^>]*>/g;

export function carveVueScript(source: string): CarvedSegment[] {
  const segments: CarvedSegment[] = [];
  OPEN_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OPEN_TAG.exec(source))) {
    const start = m.index + m[0].length;
    const end = source.indexOf('</script>', start);
    const stop = end === -1 ? source.length : end;
    let lineOffset = 0;
    for (let i = 0; i < start; i++) if (source.charCodeAt(i) === 10) lineOffset++;
    segments.push({ source: source.slice(start, stop), lineOffset });
    OPEN_TAG.lastIndex = stop;
  }
  return segments;
}
