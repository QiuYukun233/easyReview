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
});
