/** 自包含单页:无外部资源、无构建。数据来自 /api/state 与 /api/source(源码行已在服务端转义+高亮)。
 *  内嵌 JS 约定:单引号拼接,禁止反引号与 \${——外层是 TS 模板字面量。 */
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
  --tok-k: #a626a4; --tok-s: #50a14f; --tok-n: #986801;
  --risk-high: #d9534f; --risk-med: #e8a33d; --risk-low: #d6c53a;
}
:root[data-theme="dark"] {
  --bg: #16181d; --panel-bg: #1f2229; --text: #e6e6e3; --muted: #9a9a94;
  --border: #383c45; --dot: #4a4e58; --lit: #3fbf78; --next: #e8b542;
  --accent: #6ea1ff; --danger: #e06050;
  --tok-k: #c678dd; --tok-s: #98c379; --tok-n: #d19a66;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #16181d; --panel-bg: #1f2229; --text: #e6e6e3; --muted: #9a9a94;
    --border: #383c45; --dot: #4a4e58; --lit: #3fbf78; --next: #e8b542;
    --accent: #6ea1ff; --danger: #e06050;
    --tok-k: #c678dd; --tok-s: #98c379; --tok-n: #d19a66;
  }
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.6 system-ui, sans-serif; background: var(--bg); color: var(--text); }
header { display: flex; align-items: center; gap: 16px; padding: 10px 20px; border-bottom: 1px solid var(--border); }
header h1 { font-size: 16px; margin: 0; }
#tabs { display: flex; gap: 4px; }
#tabs button { background: none; border: 1px solid var(--border); color: var(--muted); border-radius: 6px; padding: 4px 12px; cursor: pointer; }
#tabs button.active { color: var(--text); border-color: var(--accent); }
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
.axis.risk { cursor: pointer; }
.cell { border: 1px solid var(--border); border-radius: 8px; min-height: 64px; padding: 6px; display: flex; flex-wrap: wrap; gap: 5px; align-content: flex-start; background: var(--panel-bg); }
.cell-collapsed { grid-column: 2 / -1; border: 1px dashed var(--border); border-radius: 8px; color: var(--muted); font-size: 12px; padding: 4px 10px; }
.dot { width: 14px; height: 14px; border-radius: 4px; background: var(--dot); cursor: pointer; border: 2px solid transparent; }
.dot.lit { background: var(--lit); }
.dot.verified { border-color: var(--lit); }
.dot.next { background: var(--next); }
.dot.selected { outline: 2px solid var(--accent); }
#legend { margin-top: 10px; color: var(--muted); font-size: 12px; }
#tree { font-family: ui-monospace, monospace; font-size: 13px; }
.tree-dir { cursor: pointer; padding: 2px 0; user-select: none; }
.tree-dir .cnt { color: var(--muted); font-size: 12px; }
.tree-kids { margin-left: 18px; }
.tree-file { cursor: pointer; padding: 2px 0; display: flex; align-items: center; gap: 6px; }
.tree-file:hover { color: var(--accent); }
.rdot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; flex: none; }
.rdot.high { background: var(--risk-high); } .rdot.med { background: var(--risk-med); }
.rdot.low { background: var(--risk-low); } .rdot.none { background: var(--dot); }
.tick { color: var(--lit); }
#panel { flex: 2; max-width: 460px; position: sticky; top: 16px; }
.card { border: 1px solid var(--border); border-radius: 10px; background: var(--panel-bg); padding: 16px; }
.card h2 { margin: 0 0 6px; font-size: 15px; }
.card .meta, .card .muted, .muted { color: var(--muted); font-size: 13px; }
.card ul { margin: 6px 0; padding-left: 20px; }
.card .nb { color: var(--accent); cursor: pointer; text-decoration: underline; }
.back { display: inline-block; margin-bottom: 8px; color: var(--accent); cursor: pointer; }
button.done-btn { margin-top: 10px; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--lit); background: none; color: var(--lit); cursor: pointer; font-size: 14px; }
button.done-btn:disabled { border-color: var(--border); color: var(--muted); cursor: default; }
#backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.15); z-index: 10; }
#drawer { position: fixed; top: 0; right: 0; height: 100vh; width: 55vw; max-width: 900px; background: var(--panel-bg); border-left: 1px solid var(--border); box-shadow: -6px 0 24px rgba(0,0,0,.25); display: flex; flex-direction: column; z-index: 20; }
#drawer.full { width: 100vw; max-width: none; }
#drawer-head { padding: 12px 16px; border-bottom: 1px solid var(--border); }
#drawer-head .row { display: flex; align-items: center; gap: 8px; }
#drawer-head h2 { flex: 1; margin: 0; font-size: 14px; min-width: 0; overflow-wrap: anywhere; }
#drawer-head button { background: none; border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 3px 10px; cursor: pointer; }
#drawer-head button.done-btn { border-color: var(--lit); color: var(--lit); }
#drawer-head button.done-btn:disabled { border-color: var(--border); color: var(--muted); }
#drawer-fns { padding: 6px 16px; border-bottom: 1px solid var(--border); display: flex; flex-wrap: wrap; gap: 6px; max-height: 40px; overflow: hidden; }
#drawer-fns.open { max-height: 180px; overflow: auto; }
.fn-chip { border: 1px solid var(--border); border-radius: 12px; padding: 1px 8px; font: 12px ui-monospace, monospace; cursor: pointer; color: var(--accent); background: none; }
#drawer-src { flex: 1; overflow: auto; font: 12px/1.55 ui-monospace, monospace; padding: 8px 0; }
.src-line { display: flex; }
.src-line .ln { flex: none; width: 52px; text-align: right; padding-right: 12px; color: var(--muted); user-select: none; }
.src-line .lc { white-space: pre; }
.src-line.flash { background: rgba(232, 181, 66, .28); }
.tok-k { color: var(--tok-k); } .tok-s { color: var(--tok-s); }
.tok-n { color: var(--tok-n); } .tok-c { color: var(--muted); font-style: italic; }
</style>
</head>
<body>
<header>
  <h1>easyReview</h1>
  <nav id="tabs">
    <button id="tab-grid">网格</button>
    <button id="tab-tree">文件树</button>
  </nav>
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
    <div id="tree" hidden></div>
    <div id="legend"></div>
  </section>
  <aside id="panel"></aside>
</main>
<div id="backdrop" hidden></div>
<aside id="drawer" hidden>
  <div id="drawer-head"></div>
  <div id="drawer-fns"></div>
  <div id="drawer-src"></div>
</aside>
<script>
'use strict';
var state = null;
var selectedId = null; // null = 面板显示"下一步"
var view = localStorage.getItem('easyreview-view') === 'tree' ? 'tree' : 'grid';
var collapsedRows = loadSet('easyreview-collapsed-rows');
var collapsedDirs = loadSet('easyreview-collapsed-dirs');
var drawerId = null;
var drawerFull = false;
var srcCache = {}; // chunkId → /api/source body(本页生命周期内缓存)

var RISK_CN = { high: '高', med: '中', low: '低', none: '无' };
var CONTRIB_CN = { filler: '填充', low: '低', med: '中', high: '高' };
var GRID_LEGEND = '■ 灰=未学 · <span style="color:var(--lit)">■</span> 绿=已理解 · 绿框=已验证 · <span style="color:var(--next)">■</span> 黄=下一步 · 行=风险(高→无) 列=贡献度(填充→高) · 点行头折叠该行';
var TREE_LEGEND = '● 风险色点(红高/橙中/黄低/灰无) · <span class="tick">✓</span>=已理解 <span class="tick">✓✓</span>=已验证 · 点目录折叠,点文件看源码';

function $(id) { return document.getElementById(id); }
function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML.replace(/"/g, '&quot;'); }
function loadSet(k) { try { return new Set(JSON.parse(localStorage.getItem(k) || '[]')); } catch (e) { return new Set(); } }
function saveSet(k, s) { localStorage.setItem(k, JSON.stringify(Array.from(s))); }

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
function render() {
  renderProgress();
  renderTabs();
  if (view === 'grid') renderGrid(); else renderTree();
  renderPanel();
  if (drawerId) { renderDrawerHead(); renderDrawerFns(); } // done 后按钮/✓ 即时更新
}

function renderTabs() {
  $('tab-grid').className = view === 'grid' ? 'active' : '';
  $('tab-tree').className = view === 'tree' ? 'active' : '';
  $('grid').hidden = view !== 'grid';
  $('tree').hidden = view !== 'tree';
  $('legend').innerHTML = view === 'grid' ? GRID_LEGEND : TREE_LEGEND;
}

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
    var folded = collapsedRows.has(r);
    html += '<div class="axis risk" data-row="' + r + '" title="点击折叠/展开">' + RISK_CN[r] + (folded ? ' ▸' : ' ▾') + '</div>';
    if (folded) {
      var n = 0;
      for (var cf = 0; cf < g.contribBuckets.length; cf++) n += (g.cells[r + ':' + g.contribBuckets[cf]] || []).length;
      html += '<div class="cell-collapsed">' + n + ' 块(已折叠)</div>';
      continue;
    }
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
  var rows = $('grid').querySelectorAll('.axis.risk');
  for (var x = 0; x < rows.length; x++) {
    rows[x].addEventListener('click', function (ev) {
      var row = ev.currentTarget.getAttribute('data-row');
      if (collapsedRows.has(row)) collapsedRows.delete(row); else collapsedRows.add(row);
      saveSet('easyreview-collapsed-rows', collapsedRows);
      render();
    });
  }
  var dots = $('grid').querySelectorAll('.dot');
  for (var i = 0; i < dots.length; i++) {
    dots[i].addEventListener('click', function (ev) {
      selectedId = ev.currentTarget.getAttribute('data-id');
      openDrawer(selectedId);
      render();
    });
  }
}

// ── 文件树:由 chunks 的 file 路径拼出(只含学习范围内的文件,这正是地图的范围) ──
function buildTreeData() {
  var root = { dirs: {}, files: [] };
  Object.keys(state.chunks).forEach(function (id) {
    var parts = state.chunks[id].file.split('/');
    var node = root;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!node.dirs[parts[i]]) node.dirs[parts[i]] = { dirs: {}, files: [] };
      node = node.dirs[parts[i]];
    }
    node.files.push(id);
  });
  return root;
}

function subtreeCounts(node) {
  var u = 0, t = 0;
  node.files.forEach(function (id) { t++; if (state.chunks[id].understood) u++; });
  Object.keys(node.dirs).forEach(function (d) {
    var c = subtreeCounts(node.dirs[d]);
    u += c.u; t += c.t;
  });
  return { u: u, t: t };
}

function renderDirHtml(node, path) {
  var html = '';
  Object.keys(node.dirs).sort().forEach(function (d) {
    var p = path ? path + '/' + d : d;
    var kid = node.dirs[d];
    var c = subtreeCounts(kid);
    var folded = collapsedDirs.has(p);
    html += '<div class="tree-dir" data-dir="' + esc(p) + '">' + (folded ? '▸ ' : '▾ ') + esc(d) + '/ <span class="cnt">(' + c.u + '/' + c.t + ')</span></div>';
    if (!folded) html += '<div class="tree-kids">' + renderDirHtml(kid, p) + '</div>';
  });
  node.files.slice().sort(function (a, b) { return state.chunks[a].file.localeCompare(state.chunks[b].file); }).forEach(function (id) {
    var c = state.chunks[id];
    var fname = c.file.split('/').pop();
    var mark = c.verified ? ' <span class="tick">✓✓</span>' : (c.understood ? ' <span class="tick">✓</span>' : '');
    html += '<div class="tree-file" data-id="' + esc(id) + '"><span class="rdot ' + c.riskBucket + '"></span>' + esc(fname) + mark + '</div>';
  });
  return html;
}

function renderTree() {
  $('tree').innerHTML = renderDirHtml(buildTreeData(), '');
  var dirs = $('tree').querySelectorAll('.tree-dir');
  for (var i = 0; i < dirs.length; i++) {
    dirs[i].addEventListener('click', function (ev) {
      var p = ev.currentTarget.getAttribute('data-dir');
      if (collapsedDirs.has(p)) collapsedDirs.delete(p); else collapsedDirs.add(p);
      saveSet('easyreview-collapsed-dirs', collapsedDirs);
      renderTree();
    });
  }
  var files = $('tree').querySelectorAll('.tree-file');
  for (var j = 0; j < files.length; j++) {
    files[j].addEventListener('click', function (ev) {
      selectedId = ev.currentTarget.getAttribute('data-id');
      openDrawer(selectedId);
      render();
    });
  }
}

// ── 源码抽屉 ──
function openDrawer(id) {
  drawerId = id;
  $('drawer').hidden = false;
  $('backdrop').hidden = false;
  renderDrawerHead();
  renderDrawerFns();
  var cached = srcCache[id];
  if (cached) { renderSource(cached); return; }
  $('drawer-src').innerHTML = '<p class="muted" style="padding:0 16px">加载源码…</p>';
  fetch('/api/source?chunk=' + encodeURIComponent(id))
    .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
    .then(function (res) {
      if (drawerId !== id) return; // 用户已切走
      if (!res.ok) { $('drawer-src').innerHTML = '<p class="muted" style="padding:0 16px">' + esc(res.body.error || '读源码失败') + '</p>'; return; }
      srcCache[id] = res.body;
      renderSource(res.body);
    })
    .catch(function (e) {
      if (drawerId === id) $('drawer-src').innerHTML = '<p class="muted" style="padding:0 16px">读源码失败:' + esc(e.message) + '</p>';
    });
}

function closeDrawer() {
  drawerId = null;
  drawerFull = false;
  $('drawer').classList.remove('full');
  $('drawer').hidden = true;
  $('backdrop').hidden = true;
}

function renderDrawerHead() {
  var c = state.chunks[drawerId];
  var html = '<div class="row">';
  html += '<button id="drawer-expand" title="收起/恢复左侧视图">' + (drawerFull ? '⟩ 恢复视图' : '⟨ 收起网格') + '</button>';
  html += '<h2><code>' + esc(c.file) + '</code></h2>';
  html += '<button id="drawer-close" title="关闭(Esc)">✕</button>';
  html += '</div>';
  html += '<div class="meta">风险 ' + RISK_CN[c.riskBucket] + ' · 贡献度 ' + CONTRIB_CN[c.contribBucket] + (c.verified ? ' · <b>已验证 ✓</b>' : '') + '</div>';
  if (c.responsibility) html += '<div class="meta">' + esc(c.responsibility) + '</div>';
  html += c.understood
    ? '<button class="done-btn" disabled>已理解 ✓</button>'
    : '<button class="done-btn" id="drawer-done">✓ 标记已理解</button>';
  $('drawer-head').innerHTML = html;
  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-expand').addEventListener('click', function () {
    drawerFull = !drawerFull;
    $('drawer').classList.toggle('full', drawerFull);
    renderDrawerHead();
  });
  var done = $('drawer-done');
  if (done) done.addEventListener('click', function () { markDone(drawerId); });
}

function renderDrawerFns() {
  var c = state.chunks[drawerId];
  var box = $('drawer-fns');
  if (!c.functions.length) { box.className = 'open'; box.innerHTML = '<span class="muted">(本文件无独立函数)</span>'; return; }
  var many = c.functions.length > 8;
  var html = many ? '<button class="fn-chip" id="fns-toggle">☰ ' + c.functions.length + ' 个函数</button>' : '';
  for (var i = 0; i < c.functions.length; i++) {
    var f = c.functions[i];
    html += '<button class="fn-chip" data-line="' + f.startLine + '">' + esc(f.name) + ':' + f.startLine + '</button>';
  }
  box.innerHTML = html;
  box.className = many ? '' : 'open';
  var t = $('fns-toggle');
  if (t) t.addEventListener('click', function () { box.classList.toggle('open'); });
  var chips = box.querySelectorAll('.fn-chip[data-line]');
  for (var j = 0; j < chips.length; j++) {
    chips[j].addEventListener('click', function (ev) {
      jumpTo(parseInt(ev.currentTarget.getAttribute('data-line'), 10));
    });
  }
}

function renderSource(body) {
  // body.lines 已在服务端转义+高亮,这里按行拼装(原样插入是约定行为)
  var html = '';
  for (var i = 0; i < body.lines.length; i++) {
    html += '<div class="src-line" id="L' + (i + 1) + '"><span class="ln">' + (i + 1) + '</span><span class="lc">' + body.lines[i] + '</span></div>';
  }
  $('drawer-src').innerHTML = html;
}

function jumpTo(line) {
  var el = document.getElementById('L' + line);
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(function () { el.classList.remove('flash'); }, 1200);
}

// ── 右侧"下一步"卡(两个视图下都保留) ──
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
  html += '<p><b>看源码:</b><span class="nb" id="open-src">打开源码抽屉</span></p>';
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
  var open = $('open-src');
  if (open) open.addEventListener('click', function () { openDrawer(showId); });
  var nbs = $('panel').querySelectorAll('.nb[data-id]');
  for (var i = 0; i < nbs.length; i++) {
    nbs[i].addEventListener('click', function (ev) { selectedId = ev.currentTarget.getAttribute('data-id'); render(); });
  }
}

// ── 全局交互 ──
$('tab-grid').addEventListener('click', function () { view = 'grid'; localStorage.setItem('easyreview-view', view); render(); });
$('tab-tree').addEventListener('click', function () { view = 'tree'; localStorage.setItem('easyreview-view', view); render(); });
$('backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && drawerId) closeDrawer(); });

refresh();
</script>
</body>
</html>
`;
}
