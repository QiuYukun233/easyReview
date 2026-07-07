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
});
