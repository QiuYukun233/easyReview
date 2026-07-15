import { describe, it, expect } from 'vitest';
import { renderPage } from '../src/serve/page.js';

describe('renderPage', () => {
  it('returns a self-contained html page with the agreed structure', () => {
    const html = renderPage();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('id="grid"');            // 网格区
    expect(html).toContain('id="panel"');           // 右侧卡片面板
    expect(html).toContain('id="progress-fill"');   // 进度条
    expect(html).toContain('id="theme-toggle"');    // 主题切换
    expect(html).toContain('id="error-banner"');    // fetch 失败红条
    expect(html).toContain('/api/state');
    expect(html).toContain('/api/done');
    expect(html).toContain('data-theme');           // 暗色主题变量挂载点
    expect(html).not.toContain('src=');             // 零外部资源(自包含)
  });

  it('v2: Tab 双视图 + 树 + 源码抽屉的结构都在', () => {
    const html = renderPage();
    expect(html).toContain('id="tab-grid"');
    expect(html).toContain('id="tab-tree"');
    expect(html).toContain('id="tree"');
    expect(html).toContain('id="drawer"');
    expect(html).toContain('id="drawer-src"');
    expect(html).toContain('/api/source');
    expect(html).toContain('tok-k');                // 高亮 token 样式
    expect(html).toContain('easyreview-view');      // Tab 持久化 key
    expect(html).toContain('easyreview-collapsed-rows');
    expect(html).toContain('easyreview-collapsed-dirs');
  });

  it('B: AI 解读——开关/面板/端点/持久化键/加载态都在', () => {
    const html = renderPage();
    expect(html).toContain('id="interp-toggle"');
    expect(html).toContain('id="interp"');
    expect(html).toContain('/api/interpret');
    expect(html).toContain('easyreview-interpret-collapsed');
    expect(html).toContain('解读生成中');
    expect(html).not.toContain('src=');
  });

  it('refsIn: 抽屉容器与折叠持久化键都在', () => {
    const html = renderPage();
    expect(html).toContain('id="drawer-refs"');
    expect(html).toContain('easyreview-refs-collapsed');
    expect(html).not.toContain('src=');             // 仍自包含
  });

  it('refsIn: 共用渲染函数与被谁依赖/空态文案都在', () => {
    const html = renderPage();
    expect(html).toContain('refsHtml');
    expect(html).toContain('被谁依赖');
    expect(html).toContain('未检出');
  });

  it('refsOut: 抽屉第二折叠区与折叠持久化键都在', () => {
    const html = renderPage();
    expect(html).toContain('id="drawer-refs-out"');
    expect(html).toContain('easyreview-refs-out-collapsed');
    expect(html).not.toContain('src=');             // 仍自包含
  });

  it('refsOut: 它依赖谁文案与出边空态都在', () => {
    const html = renderPage();
    expect(html).toContain('它依赖谁');
    expect(html).toContain('只统计仓内块之间的引用');
  });

  it('hidden 属性守卫:作者 display 声明不得压过 [hidden](抽屉常驻可见 bug 的回归锁)', () => {
    const html = renderPage();
    // UA 的 [hidden]{display:none} 会被作者 display:flex/grid 压过——#drawer/#grid 都踩过。
    // 守卫必须存在且带 !important,否则抽屉自加载起常驻、盖住贡献度「高」列与右侧面板。
    expect(html).toContain('[hidden] { display: none !important; }');
  });
});
