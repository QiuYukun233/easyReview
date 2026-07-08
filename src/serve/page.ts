/** 自包含单页：无外部资源、无构建。数据全部来自 /api/state。 */
export function renderPage(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>easyReview</title>
<style>
:root {
  --bg: #f7f7f5; --panel-bg: #ffffff; --text: #222; --muted: #777;
  --border: #ddd; --dot: #b9b9b3; --lit: #2f9e63; --next: #e0a52e;
  --accent: #2f6fde; --danger: #c0392b;
}
:root[data-theme="dark"] {
  --bg: #16181d; --panel-bg: #1f2229; --text: #e6e6e3; --muted: #9a9a94;
  --border: #383c45; --dot: #4a4e58; --lit: #3fbf78; --next: #e8b542;
  --accent: #6ea1ff; --danger: #e06050;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #16181d; --panel-bg: #1f2229; --text: #e6e6e3; --muted: #9a9a94;
    --border: #383c45; --dot: #4a4e58; --lit: #3fbf78; --next: #e8b542;
    --accent: #6ea1ff; --danger: #e06050;
  }
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.6 system-ui, sans-serif; background: var(--bg); color: var(--text); }
header { display: flex; align-items: center; gap: 16px; padding: 10px 20px; border-bottom: 1px solid var(--border); }
header h1 { font-size: 16px; margin: 0; }
#progress-wrap { flex: 1; display: flex; align-items: center; gap: 10px; }
#progress-bar { flex: 1; height: 10px; background: var(--border); border-radius: 5px; overflow: hidden; max-width: 420px; }
#progress-fill { height: 100%; width: 0; background: var(--lit); transition: width .2s; }
#progress-text { color: var(--muted); white-space: nowrap; }
#theme-toggle { background: none; border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
#error-banner { background: var(--danger); color: #fff; padding: 6px 20px; }
main { display: flex; gap: 16px; padding: 16px 20px; align-items: flex-start; }
#map { flex: 3; min-width: 0; }
#grid { display: grid; grid-template-columns: 60px repeat(4, 1fr); gap: 6px; }
.axis { display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 12px; }
.cell { border: 1px solid var(--border); border-radius: 8px; min-height: 64px; padding: 6px; display: flex; flex-wrap: wrap; gap: 5px; align-content: flex-start; background: var(--panel-bg); }
.dot { width: 14px; height: 14px; border-radius: 4px; background: var(--dot); cursor: pointer; border: 2px solid transparent; }
.dot.lit { background: var(--lit); }
.dot.verified { border-color: var(--lit); }
.dot.next { background: var(--next); }
.dot.selected { outline: 2px solid var(--accent); }
#legend { margin-top: 10px; color: var(--muted); font-size: 12px; }
#panel { flex: 2; max-width: 460px; position: sticky; top: 16px; }
.card { border: 1px solid var(--border); border-radius: 10px; background: var(--panel-bg); padding: 16px; }
.card h2 { margin: 0 0 6px; font-size: 15px; }
.card .meta, .card .muted { color: var(--muted); font-size: 13px; }
.card ul { margin: 6px 0; padding-left: 20px; }
.card .nb { color: var(--accent); cursor: pointer; text-decoration: underline; }
.back { display: inline-block; margin-bottom: 8px; color: var(--accent); cursor: pointer; }
button.done-btn { margin-top: 10px; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--lit); background: none; color: var(--lit); cursor: pointer; font-size: 14px; }
button.done-btn:disabled { border-color: var(--border); color: var(--muted); cursor: default; }
</style>
</head>
<body>
<header>
  <h1>easyReview</h1>
  <div id="progress-wrap">
    <div id="progress-bar"><div id="progress-fill"></div></div>
    <span id="progress-text"></span>
  </div>
  <button id="theme-toggle" title="亮/暗切换">🌓</button>
</header>
<div id="error-banner" hidden></div>
<main>
  <section id="map">
    <div id="grid"></div>
    <div id="legend">■ 灰=未学 · <span style="color:var(--lit)">■</span> 绿=已理解 · 绿框=已验证 · <span style="color:var(--next)">■</span> 黄=下一步 · 行=风险(高→无) 列=贡献度(填充→高)</div>
  </section>
  <aside id="panel"></aside>
</main>
<script>
'use strict';
var state = null;
var selectedId = null; // null = 面板显示"下一步"

var RISK_CN = { high: '高', med: '中', low: '低', none: '无' };
var CONTRIB_CN = { filler: '填充', low: '低', med: '中', high: '高' };

function $(id) { return document.getElementById(id); }
function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML.replace(/"/g, '&quot;'); }

// ── 主题:默认跟系统,手动选择存 localStorage ──
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
}
function currentTheme() {
  var forced = document.documentElement.getAttribute('data-theme');
  if (forced) return forced;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
applyTheme(localStorage.getItem('easyreview-theme'));
$('theme-toggle').addEventListener('click', function () {
  var next = currentTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('easyreview-theme', next);
  applyTheme(next);
});

// ── 数据 ──
function refresh() {
  return fetch('/api/state')
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (s) { state = s; $('error-banner').hidden = true; render(); })
    .catch(function (e) {
      $('error-banner').hidden = false;
      $('error-banner').textContent = '服务器没响应(' + e.message + ')——确认 easyreview serve 还在跑,然后刷新。';
    });
}

function markDone(id) {
  fetch('/api/done', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chunkId: id }),
  })
    .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
    .then(function (res) {
      if (!res.ok) { alert('标记失败:' + (res.body.error || '未知错误')); return; }
      if (id === state.nextId) selectedId = null; // 标的是下一步 → 面板自动跳到新的下一步
      return refresh();                            // 跳着标 → selectedId 不动,卡片变已理解态
    })
    .catch(function (e) { alert('标记失败:' + e.message); });
}

// ── 渲染 ──
function render() { renderProgress(); renderGrid(); renderPanel(); }

function renderProgress() {
  var p = state.progress;
  var pct = p.total ? Math.round((p.understood / p.total) * 100) : 0;
  $('progress-fill').style.width = pct + '%';
  $('progress-text').textContent = '已理解 ' + p.understood + '/' + p.total + ' (' + pct + '%) · 已验证 ' + p.verified;
}

function renderGrid() {
  var g = state.grid;
  var html = '<div class="axis"></div>';
  for (var ci = 0; ci < g.contribBuckets.length; ci++) html += '<div class="axis">' + CONTRIB_CN[g.contribBuckets[ci]] + '</div>';
  for (var ri = 0; ri < g.riskBuckets.length; ri++) {
    var r = g.riskBuckets[ri];
    html += '<div class="axis">' + RISK_CN[r] + '</div>';
    for (var cj = 0; cj < g.contribBuckets.length; cj++) {
      var ids = g.cells[r + ':' + g.contribBuckets[cj]] || [];
      html += '<div class="cell">';
      for (var k = 0; k < ids.length; k++) {
        var id = ids[k];
        var c = state.chunks[id];
        var cls = 'dot';
        if (c.understood) cls += ' lit';
        if (c.verified) cls += ' verified';
        if (id === state.nextId) cls += ' next';
        if (id === (selectedId || state.nextId)) cls += ' selected';
        html += '<span class="' + cls + '" data-id="' + esc(id) + '" title="' + esc(c.name + ' · ' + c.chapterName) + '"></span>';
      }
      html += '</div>';
    }
  }
  $('grid').innerHTML = html;
  var dots = $('grid').querySelectorAll('.dot');
  for (var i = 0; i < dots.length; i++) {
    dots[i].addEventListener('click', function (ev) {
      selectedId = ev.currentTarget.getAttribute('data-id');
      render();
    });
  }
}

function renderPanel() {
  var showId = selectedId || state.nextId;
  if (!showId) {
    $('panel').innerHTML = '<div class="card"><h2>🎉 全部走完</h2><p>你已经走遍这个项目。回头看地图,它现在应该读得懂了。</p>' +
      '<p class="muted">下一步:用 <code>npm run verify -- &lt;chunkId&gt;</code> 验证你的理解(突变探针)。</p></div>';
    return;
  }
  var c = state.chunks[showId];
  var isNext = showId === state.nextId;
  var stepNo = state.path.indexOf(showId) + 1;
  var html = '';
  if (!isNext && state.nextId) html += '<span class="back" id="back-next">← 回到下一步</span>';
  html += '<div class="card">';
  html += '<h2>' + (isNext ? '下一步(第 ' + stepNo + '/' + state.path.length + ' 步):' : '') + esc(c.name) + '</h2>';
  html += '<div class="meta">' + esc(c.chapterName) + ' · <code>' + esc(c.file) + '</code><br>风险 ' + RISK_CN[c.riskBucket] + ' · 贡献度 ' + CONTRIB_CN[c.contribBucket] +
          (c.verified ? ' · <b>已验证 ✓</b>' : '') + '</div>';
  if (c.responsibility) html += '<p><b>职责:</b>' + esc(c.responsibility) + '</p>';
  html += '<p><b>为什么现在学它:</b>' + esc(c.whyNow) + '</p>';
  html += '<p><b>函数(' + c.functions.length + ')</b></p>';
  html += c.functions.length
    ? '<ul>' + c.functions.map(function (f) { return '<li><code>' + esc(f.name) + '</code></li>'; }).join('') + '</ul>'
    : '<p class="muted">(本文件无独立函数,可能是模块声明/重导出)</p>';
  html += '<p><b>自测</b>(答得上来再标记)</p><ul class="muted">' +
    '<li>这个块对外做什么?一句话说清职责。</li>' +
    '<li>它读/写了哪些状态或数据?</li>' +
    '<li>谁会调用它、它又依赖谁?</li></ul>';
  if (c.neighbors.length) {
    html += '<p><b>顺便看看</b>(防盲区觅食)</p><ul>' + c.neighbors.slice(0, 6).map(function (n) {
      var nc = state.chunks[n];
      return '<li><span class="nb" data-id="' + esc(n) + '">' + esc(nc ? nc.name : n) + '</span>' + (nc && nc.understood ? ' ✓' : '') + '</li>';
    }).join('') + '</ul>';
  }
  html += c.understood
    ? '<button class="done-btn" disabled>已理解 ✓</button>'
    : '<button class="done-btn" id="done-btn">✓ 标记已理解</button>';
  html += '</div>';
  $('panel').innerHTML = html;
  var back = $('back-next');
  if (back) back.addEventListener('click', function () { selectedId = null; render(); });
  var btn = $('done-btn');
  if (btn) btn.addEventListener('click', function () { markDone(showId); });
  var nbs = $('panel').querySelectorAll('.nb');
  for (var i = 0; i < nbs.length; i++) {
    nbs[i].addEventListener('click', function (ev) { selectedId = ev.currentTarget.getAttribute('data-id'); render(); });
  }
}

refresh();
</script>
</body>
</html>
`;
}
