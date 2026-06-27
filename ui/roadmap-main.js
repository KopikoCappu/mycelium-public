//  * roadmap-main.js — COMPLETE
//  *
//  * Drop this file in ui/ and ensure index.html has:
//  *   <div id="roadmap-canvas" style="position:absolute;inset:0;display:none;overflow:hidden;"></div>
//  *   <div id="roadmap-ctx-menu" style="display:none;position:fixed;background:#0c0c0c;border:1px solid rgba(255,255,255,.15);z-index:400;padding:4px 0;min-width:190px;box-shadow:0 8px 32px rgba(0,0,0,.7);font-family:'SF Mono','Fira Code',monospace;"></div>
//  *   <script src="roadmap-main.js"></script>  ← right before </body>
//  *
//  * All features:
//  *   ✓ Add / edit features from sidebar (name, status, description, tags)
//  *   ✓ Connect features by clicking (dependency linking)
//  *   ✓ Remove dependencies via right-click on edge
//  *   ✓ Inline edit name/description/status, auto-saved via PATCH
//  *   ✓ Right-click node → subtree isolation, status change, hide, focus
//  *   ✓ ⬡ Show only subtree — BFS both directions with banner + clear
//  *   ✓ ⚡ Ready filter — show only features with all deps complete
//  *   ✓ Tag-based filtering — auto-injected from feature.tags
//  *   ✓ 🔴 Critical path — highlights longest incomplete dependency chain
//  *   ✓ "What's blocking me?" — shows incomplete prereq chain in detail panel
//  *   ✓ Blocker rank — how many features does this one transitively block
//  *   ✓ Hide done toggle — clears visual noise instantly
//  *   ✓ Smooth hide — position cache means nodes don't reshift on hide
//  *   ✓ Always-visible unhide button when anything is hidden
//  *   ✓ Export as markdown checklist (📋 copy to clipboard)
//  *   ✓ Topbar search — fuzzy filter while in roadmap mode
//  *   ✓ Keyboard shortcuts — Tab/Shift+Tab cycle, H hide, U unhide, C copy, Esc cancel
//  *   ✓ Zoom level-of-detail — labels fade out when zoomed too far out
//  *   ✓ Text stroke outline — labels readable over any background
//  *   ✓ Larger collision radius — eliminates label overlap
//  *   ✓ Status legend on canvas
//  *   ✓ Depth tier guides
//  *   ✓ Particle flow along dependency edges
//  *   ✓ Live SSE reload when server sends roadmap-updated
//  *   ✓ All changes persist via PATCH /roadmap/feature/:id
//  */

'use strict';

// ═══ INJECT STYLES ══════════════════════════════════════════════════════════
(function() {
  if (document.getElementById('rmap-injected-css')) return;
  const s = document.createElement('style');
  s.id = 'rmap-injected-css';
  s.textContent = [
    '.rmap-node.dimmed { opacity: 0.1; transition: opacity 0.2s; }',
    '.rmap-node.highlighted .rmap-circle { stroke-width: 2.5 !important; }',
    '.rmap-node.crit-path .rmap-circle { stroke: #EF9F27 !important; stroke-width: 2.5 !important; stroke-opacity: 1 !important; }',
    '.rmap-node.crit-path .rmap-glow { fill: rgba(239,159,39,.28) !important; }',
    '#rmap-sidebar-controls input, #rmap-sidebar-controls select, #rmap-sidebar-controls textarea { box-sizing: border-box; }',
    '.rmap-lbl { paint-order: stroke; stroke: rgba(6,6,6,.88); stroke-width: 3px; stroke-linejoin: round; }',
  ].join(' ');
  document.head.appendChild(s);
})();

// ═══ STATE ════════════════════════════════════════════════════════════════
let _hiddenFeatures  = new Set();
let _roadmapMainZoom = null;
let _roadmapMainSim  = null;
let _roadmapMainRaf  = null;
let _roadmapMainObs  = null;
let _savedChipHTML   = null;
let _connectMode     = false;
let _connectSource   = null;
let _inRoadmapMode   = false;
let _rNodeGsRef      = null;
let _rEdgesRef       = null;
let _rEdgeHitsRef    = null;
let _roadmapNodePos  = new Map();  // featureId → {x,y}, persists across re-renders
let _rmapIsolated    = false;
let _rmapHideDone    = false;
let _rmapCritPathIds = new Set();
let _rmapCritActive  = false;
let _rmapSelectedId  = null;

try { _hiddenFeatures = new Set(JSON.parse(localStorage.getItem('mycelium-hidden-features') || '[]')); } catch {}
try { _rmapHideDone   = !!JSON.parse(localStorage.getItem('mycelium-rmap-hide-done') || 'false'); } catch {}

// ═══ UTILITIES ════════════════════════════════════════════════════════════
function _rmapSlug(str) {
  return String(str).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
    || ('f-' + Date.now());
}
function _safe(str) { return String(str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

function _rmapToast(msg, ms=2000) {
  const c = document.getElementById('roadmap-canvas'); if (!c) return;
  c.querySelectorAll('.rmap-toast').forEach(t => t.remove());
  const t = document.createElement('div');
  t.className = 'rmap-toast';
  t.style.cssText = 'position:absolute;bottom:84px;left:50%;transform:translateX(-50%);' +
    'background:rgba(6,6,6,.94);border:1px solid var(--border);border-radius:4px;' +
    'padding:6px 14px;font-family:\'SF Mono\',monospace;font-size:11px;' +
    'color:var(--thread-bright);z-index:100;pointer-events:none;white-space:nowrap;';
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// ═══ SERVER HELPERS ════════════════════════════════════════════════════════
async function _roadmapPatchFeature(featureId, updates) {
  const res = await fetch(
    (typeof API_BASE !== 'undefined' ? API_BASE : '') + '/roadmap/feature/' + encodeURIComponent(featureId),
    { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(updates) }
  );
  if (!res.ok) throw new Error('PATCH ' + res.status);
  const data = await res.json();
  if (_roadmapData && data.feature) {
    const idx = _roadmapData.features.findIndex(f => f.id === featureId);
    if (idx >= 0) _roadmapData.features[idx] = data.feature;
  }
  return data.feature;
}

async function _roadmapPostFeature(featureData) {
  const res = await fetch(
    (typeof API_BASE !== 'undefined' ? API_BASE : '') + '/roadmap/feature',
    { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(featureData) }
  );
  if (!res.ok) throw new Error('POST ' + res.status);
  const data = await res.json();
  if (_roadmapData && data.feature) {
    const idx = _roadmapData.features.findIndex(f => f.id === data.feature.id);
    if (idx >= 0) _roadmapData.features[idx] = data.feature;
    else _roadmapData.features.push(data.feature);
  }
  return data.feature;
}

// ═══ OVERRIDES ══════════════════════════════════════════════════════════════
window.switchTab = function(name) {
  ['graph','history','help','roadmap'].forEach(t => {
    document.getElementById('tab-content-' + t).style.display = t === name ? 'flex' : 'none';
    const btn = document.getElementById('tab-' + t);
    if (btn) btn.classList.toggle('active', t === name);
  });
  const graphSvg = document.getElementById('graph-svg');
  const rCanvas  = document.getElementById('roadmap-canvas');
  if (name === 'roadmap') {
    _inRoadmapMode = true;
    if (graphSvg) graphSvg.style.display = 'none';
    if (rCanvas)  rCanvas.style.display  = 'block';
    _injectSidebarControls();
    loadRoadmapTab();
    _hookRoadmapSearch(true);
  } else {
    _inRoadmapMode = false;
    if (graphSvg) graphSvg.style.display = '';
    if (rCanvas)  rCanvas.style.display  = 'none';
    _stopRoadmapMain();
    _leaveRoadmapMode();
    _hookRoadmapSearch(false);
    if (_connectMode)   _cancelConnectMode();
    if (_rmapCritActive) _rmapClearCritPath();
  }
  if (name === 'history') loadHistory();
};

window.setRoadmapFilter = function(filter) {
  _roadmapFilter = filter;
  document.querySelectorAll('.roadmap-filter-btn')
    .forEach(btn => btn.classList.toggle('active', btn.dataset.filter === filter));
  if (_roadmapData) renderRoadmapMainCanvas(_roadmapData.features);
};

window.loadRoadmapTab = async function() {
  const statsEl = document.getElementById('roadmap-stats');
  if (statsEl) statsEl.innerHTML = '<span style="color:var(--text-faint);font-size:10px;">Loading\u2026</span>';
  const oldList = document.getElementById('roadmap-list');
  if (oldList) oldList.style.display = 'none';
  try {
    const res  = await fetch((typeof API_BASE !== 'undefined' ? API_BASE : '') + '/roadmap');
    const data = await res.json();
    _roadmapData = data;
    const s = data.stats || {};
    if (statsEl) {
      statsEl.innerHTML =
        '<span class="roadmap-status-done">'  + (s.complete   ||0) + ' done</span>\u00a0\u00a0' +
        '<span class="roadmap-status-active">' + (s.inProgress ||0) + ' active</span>\u00a0\u00a0' +
        '<span class="roadmap-status-plan">'   + (s.planned    ||0) + ' planned</span>' +
        (s.blocked ? '\u00a0\u00a0<span class="roadmap-status-block">' + s.blocked + ' blocked</span>' : '');
    }
    _enterRoadmapMode(data.features || []);
    _updateTagFilters(data.features || []);
    renderRoadmapMainCanvas(data.features || []);
  } catch {
    const panel = document.getElementById('roadmap-feature-detail');
    if (panel) panel.innerHTML = '<div style="padding:14px;font-size:11px;color:var(--text-dim)">Could not load roadmap. Is the server running?</div>';
  }
};

// ═══ TOPBAR CONTEXT ══════════════════════════════════════════════════════
function _enterRoadmapMode(features) {
  const chips = [...document.querySelectorAll('.stats-chip')];
  _savedChipHTML = chips.map(c => c.innerHTML);
  const total    = features.length;
  const complete = features.filter(f => f.status === 'complete').length;
  const active   = features.filter(f => f.status === 'in-progress').length;
  const deps     = features.reduce((n, f) => n + (f.dependsOn||[]).length, 0);
  if (chips[0]) chips[0].innerHTML = '<strong>' + total    + '</strong> features';
  if (chips[1]) chips[1].innerHTML = '<strong>' + deps     + '</strong> deps';
  if (chips[2]) chips[2].innerHTML = '<strong style="color:#7ECBA1">' + complete + '</strong> done';
  if (chips[3]) chips[3].innerHTML = '<strong style="color:#ff8c42">' + active   + '</strong> active';
}

function _leaveRoadmapMode() {
  const chips = [...document.querySelectorAll('.stats-chip')];
  if (_savedChipHTML) _savedChipHTML.forEach((html, i) => { if (chips[i]) chips[i].innerHTML = html; });
  const el = id => document.getElementById(id);
  if (el('stat-nodes') && typeof visNodes !== 'undefined')
    el('stat-nodes').textContent = visNodes.filter(n => n.kind === 'file').length || '\u2013';
  if (el('stat-edges') && typeof visLinks !== 'undefined')
    el('stat-edges').textContent = visLinks.length || '\u2013';
  if (el('stat-fns') && typeof allNodes !== 'undefined')
    el('stat-fns').textContent = allNodes.filter(n => n.kind === 'function').length || '\u2013';
  if (el('stat-lines') && typeof allNodes !== 'undefined') {
    const lines = allNodes.filter(n => n.kind === 'file')
      .reduce((s, n) => s + (n.lineCount ?? n.lines ?? n.loc ?? n.linesOfCode ?? 0), 0);
    el('stat-lines').textContent = lines > 0 ? lines.toLocaleString() : '\u2013';
  }
}

// ═══ TOPBAR SEARCH ════════════════════════════════════════════════════════
let _rmapSearchHandler = null;
function _hookRoadmapSearch(enable) {
  const inp = document.getElementById('task-input'); if (!inp) return;
  if (_rmapSearchHandler) {
    inp.removeEventListener('input', _rmapSearchHandler);
    _rmapSearchHandler = null;
    inp.placeholder = 'Describe your task to find relevant files\u2026';
    inp.value = '';
    if (_rNodeGsRef) _rNodeGsRef.classed('highlighted dimmed', false);
  }
  if (enable) {
    inp.placeholder = 'Search features by name, description, or tag\u2026';
    _rmapSearchHandler = function() {
      if (!_rNodeGsRef) return;
      const q = this.value.toLowerCase().trim();
      if (!q) { _rNodeGsRef.classed('highlighted dimmed', false); return; }
      _rNodeGsRef
        .classed('highlighted', d => _rmapMatchesSearch(d, q))
        .classed('dimmed',      d => !_rmapMatchesSearch(d, q));
    };
    inp.addEventListener('input', _rmapSearchHandler);
  }
}
function _rmapMatchesSearch(d, q) {
  return (d.name||'').toLowerCase().includes(q)
    || (d.description||'').toLowerCase().includes(q)
    || (d.tags||[]).some(t => t.toLowerCase().includes(q))
    || (d.id||'').toLowerCase().includes(q);
}

// ═══ CLEANUP ═══════════════════════════════════════════════════════════════
function _stopRoadmapMain() {
  if (_roadmapMainRaf) { cancelAnimationFrame(_roadmapMainRaf); _roadmapMainRaf = null; }
  if (_roadmapMainSim) { _roadmapMainSim.stop(); _roadmapMainSim = null; }
  if (_roadmapMainObs) { _roadmapMainObs.disconnect(); _roadmapMainObs = null; }
  _roadmapMainZoom = null; _rNodeGsRef = null; _rEdgesRef = null; _rEdgeHitsRef = null;
  window._rmapSimNodes = null;
}

// ═══ SIDEBAR CONTROLS ═══════════════════════════════════════════════════════
function _injectSidebarControls() {
  if (document.getElementById('rmap-sidebar-controls')) return;
  const header = document.querySelector('#tab-content-roadmap > div:first-child');
  if (!header) return;

  // Inject ⚡ Ready into the existing filter row
  const filterRow = document.querySelector('.roadmap-filter-btn[data-filter="blocked"]')?.parentElement;
  if (filterRow && !filterRow.querySelector('[data-filter="ready"]')) {
    const rb = document.createElement('button');
    rb.className = 'roadmap-filter-btn'; rb.dataset.filter = 'ready';
    rb.textContent = '\u26a1 Ready'; rb.title = 'Features with all dependencies complete';
    rb.onclick = () => setRoadmapFilter('ready');
    filterRow.appendChild(rb);
  }

  const div = document.createElement('div');
  div.id = 'rmap-sidebar-controls';
  div.innerHTML = `
    <div style="display:flex;gap:5px;margin-top:8px;flex-wrap:wrap;">
      <button id="rmap-add-btn" onclick="_roadmapOpenAddForm()"
        style="flex:1;min-width:80px;background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:11px;padding:5px 6px;border-radius:3px;"
        onmouseover="this.style.color='var(--text)';this.style.borderColor='rgba(255,255,255,.3)'"
        onmouseout="this.style.color='var(--text-dim)';this.style.borderColor='var(--border)'">+ Add feature</button>
      <button id="rmap-connect-btn" onclick="_toggleConnectMode()"
        title="Click two nodes to make the first require the second"
        style="flex:1;min-width:70px;background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:11px;padding:5px 6px;border-radius:3px;">\u27f6 Connect</button>
      <button id="rmap-crit-btn" onclick="_rmapToggleCritPath()"
        title="Highlight the longest incomplete dependency chain"
        style="flex:1;min-width:50px;background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:11px;padding:5px 6px;border-radius:3px;">\ud83d\udd34 Path</button>
    </div>
    <div style="display:flex;gap:5px;margin-top:5px;">
      <button id="rmap-hide-done-btn" onclick="_rmapToggleHideDone()"
        title="Hide/show all completed features"
        style="flex:1;background:none;border:1px solid var(--border);cursor:pointer;font-family:inherit;font-size:11px;padding:4px 6px;border-radius:3px;"></button>
      <button onclick="_rmapExportMarkdown()"
        title="Copy roadmap as markdown checklist"
        style="flex:1;background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:11px;padding:4px 6px;border-radius:3px;"
        onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--text-dim)'">\ud83d\udccb Markdown</button>
    </div>
    <div id="rmap-tag-row" style="display:none;margin-top:6px;display:flex;gap:4px;flex-wrap:wrap;"></div>
    <div id="rmap-hidden-row" style="display:none;margin-top:6px;align-items:center;gap:8px;font-size:10px;color:var(--text-dim);">
      <span id="rmap-hidden-count" style="color:var(--imported-edge);">0 hidden</span>
      <button onclick="_roadmapUnhideAll()" style="background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:10px;padding:2px 7px;border-radius:3px;">\u21a9 Show all</button>
    </div>
    <div id="rmap-connect-banner" style="display:none;margin-top:6px;padding:6px 8px;background:rgba(201,199,186,.06);border:1px solid rgba(201,199,186,.3);border-radius:3px;font-size:10px;color:var(--thread-bright);align-items:center;justify-content:space-between;">
      <span id="rmap-connect-msg">Click the DEPENDENT feature first</span>
      <button onclick="_cancelConnectMode()" style="background:none;border:none;color:var(--text-faint);cursor:pointer;font-size:13px;padding:0 2px;line-height:1;">\u2715</button>
    </div>
    <div id="rmap-add-form" style="display:none;margin-top:8px;padding:10px;background:var(--surface2);border:1px solid var(--border);border-radius:3px;">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-dim);margin-bottom:8px;">New Feature</div>
      <input id="rmap-add-name" placeholder="Name (required)" autocomplete="off"
        style="width:100%;background:var(--surface3);border:1px solid var(--border);border-radius:2px;color:var(--text);font-family:inherit;font-size:12px;padding:6px 8px;outline:none;margin-bottom:6px;"
        onfocus="this.style.borderColor='var(--thread-bright)'" onblur="this.style.borderColor='var(--border)'"
        onkeydown="if(event.key==='Enter')_roadmapSubmitAdd();if(event.key==='Escape')_roadmapCancelAdd()">
      <select id="rmap-add-status"
        style="width:100%;background:var(--surface3);border:1px solid var(--border);border-radius:2px;color:var(--text);font-family:inherit;font-size:11px;padding:5px 8px;outline:none;margin-bottom:6px;">
        <option value="planned">\u25cb Planned</option>
        <option value="in-progress">\u25d0 In Progress</option>
        <option value="complete">\u2713 Complete</option>
        <option value="blocked">\u2715 Blocked</option>
      </select>
      <input id="rmap-add-tags" placeholder="Tags: auth, billing, ui \u2026" autocomplete="off"
        style="width:100%;background:var(--surface3);border:1px solid var(--border);border-radius:2px;color:var(--text);font-family:inherit;font-size:11px;padding:5px 8px;outline:none;margin-bottom:6px;"
        onfocus="this.style.borderColor='var(--thread-bright)'" onblur="this.style.borderColor='var(--border)'">
      <textarea id="rmap-add-desc" placeholder="Description (optional)" rows="2"
        style="width:100%;background:var(--surface3);border:1px solid var(--border);border-radius:2px;color:var(--text);font-family:inherit;font-size:11px;padding:6px 8px;outline:none;resize:vertical;margin-bottom:8px;line-height:1.5;"
        onfocus="this.style.borderColor='var(--thread-bright)'" onblur="this.style.borderColor='var(--border)'"></textarea>
      <div style="display:flex;gap:6px;">
        <button onclick="_roadmapSubmitAdd()"
          style="flex:1;background:var(--thread-bright);border:none;color:#0a0a0a;cursor:pointer;font-family:inherit;font-size:11px;padding:5px 8px;font-weight:600;border-radius:2px;">Create</button>
        <button onclick="_roadmapCancelAdd()"
          style="background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:11px;padding:5px 10px;border-radius:2px;">Cancel</button>
      </div>
      <div id="rmap-add-msg" style="font-size:10px;color:var(--text-faint);margin-top:5px;display:none;min-height:14px;"></div>
    </div>`;
  header.appendChild(div);
  _updateRmapHiddenRow();
  _updateHideDoneBtn();
}

function _updateRmapHiddenRow() {
  const row   = document.getElementById('rmap-hidden-row');
  const count = document.getElementById('rmap-hidden-count');
  if (!row) return;
  const n = _hiddenFeatures.size;
  row.style.display = n > 0 ? 'flex' : 'none';
  if (count) count.textContent = n + ' hidden';
}

function _updateHideDoneBtn() {
  const btn = document.getElementById('rmap-hide-done-btn');
  if (!btn) return;
  btn.textContent    = _rmapHideDone ? '\u25c9 Done hidden' : '\u25cb Show done';
  btn.style.color    = _rmapHideDone ? 'var(--thread-bright)' : 'var(--text-dim)';
  btn.style.borderColor = _rmapHideDone ? 'rgba(201,199,186,.4)' : 'var(--border)';
}

function _updateTagFilters(features) {
  const tagRow = document.getElementById('rmap-tag-row'); if (!tagRow) return;
  const tagCounts = new Map();
  features.forEach(f => { (f.tags||[]).forEach(tag => { if (tag) tagCounts.set(tag, (tagCounts.get(tag)||0)+1); }); });
  if (tagCounts.size === 0) { tagRow.style.display = 'none'; return; }
  tagRow.style.display = 'flex';
  tagRow.innerHTML = '<span style="font-size:9px;color:var(--text-faint);margin-right:2px;align-self:center;flex-shrink:0;">tags</span>' +
    [...tagCounts.entries()].sort((a,b) => b[1]-a[1]).map(([tag, count]) => {
      const active = _roadmapFilter === 'tag:' + tag;
      const esc = tag.replace(/'/g, "\\'");
      return '<button class="roadmap-filter-btn' + (active ? ' active' : '') + '" data-filter="tag:' + esc + '"' +
        ' onclick="setRoadmapFilter(\'' + (active ? 'all' : 'tag:' + esc) + '\');_updateTagFilters(_roadmapData?.features||[])"' +
        ' style="font-size:10px;padding:2px 7px;">' + tag + ' <span style="opacity:.5;">' + count + '</span></button>';
    }).join('');
}

// ═══ ADD FEATURE FORM ════════════════════════════════════════════════════
function _roadmapOpenAddForm() {
  const form = document.getElementById('rmap-add-form');
  const btn  = document.getElementById('rmap-add-btn');
  if (!form) return;
  form.style.display = 'block';
  if (btn) btn.style.display = 'none';
  ['rmap-add-name','rmap-add-desc','rmap-add-tags'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('rmap-add-status').value = 'planned';
  const msg = document.getElementById('rmap-add-msg'); if (msg) msg.style.display = 'none';
  setTimeout(() => document.getElementById('rmap-add-name')?.focus(), 50);
}
function _roadmapCancelAdd() {
  const form = document.getElementById('rmap-add-form');
  const btn  = document.getElementById('rmap-add-btn');
  if (form) form.style.display = 'none';
  if (btn)  btn.style.display  = '';
}
async function _roadmapSubmitAdd() {
  const nameEl = document.getElementById('rmap-add-name');
  const name   = (nameEl?.value || '').trim();
  if (!name) {
    if (nameEl) { nameEl.style.borderColor='#e0524a'; nameEl.focus(); setTimeout(()=>nameEl.style.borderColor='var(--border)',1200); }
    return;
  }
  const msg = document.getElementById('rmap-add-msg');
  if (msg) { msg.textContent='Creating\u2026'; msg.style.display='block'; msg.style.color='var(--text-faint)'; }
  const tagsRaw = document.getElementById('rmap-add-tags')?.value || '';
  const tags    = tagsRaw ? tagsRaw.split(',').map(t=>t.trim()).filter(Boolean) : [];
  const feature = {
    id: _rmapSlug(name) + '-' + Math.floor(Math.random()*9000+1000),
    name,
    status:      document.getElementById('rmap-add-status')?.value || 'planned',
    description: document.getElementById('rmap-add-desc')?.value.trim() || '',
    files: [], dependsOn: [], tags,
    updatedAt: Date.now()
  };
  try {
    const saved = await _roadmapPostFeature(feature);
    if (msg) { msg.textContent='\u2713 Created!'; msg.style.color='#7ECBA1'; }
    setTimeout(() => {
      _roadmapCancelAdd();
      renderRoadmapMainCanvas(_roadmapData.features);
      setTimeout(() => { if (saved) _roadmapSelectFeature(saved.id); }, 300);
    }, 400);
  } catch (e) {
    if (msg) { msg.textContent='Error: '+e.message; msg.style.color='#e0524a'; msg.style.display='block'; }
  }
}

// ═══ CONNECT MODE ══════════════════════════════════════════════════════════
function _toggleConnectMode() {
  _connectMode = !_connectMode; _connectSource = null;
  const btn    = document.getElementById('rmap-connect-btn');
  const banner = document.getElementById('rmap-connect-banner');
  const msg    = document.getElementById('rmap-connect-msg');
  if (btn) {
    btn.style.background  = _connectMode ? 'rgba(201,199,186,.1)' : '';
    btn.style.borderColor = _connectMode ? 'rgba(201,199,186,.5)' : 'var(--border)';
    btn.style.color       = _connectMode ? 'var(--thread-bright)'  : 'var(--text-dim)';
  }
  if (banner) banner.style.display = _connectMode ? 'flex' : 'none';
  if (msg && _connectMode) msg.textContent = 'Click the DEPENDENT feature first';
  const c = document.getElementById('roadmap-canvas'); if (c) c.style.cursor = _connectMode ? 'crosshair' : '';
}
function _cancelConnectMode() {
  if (!_connectMode) return;
  _connectMode = false; _connectSource = null;
  const btn    = document.getElementById('rmap-connect-btn');
  const banner = document.getElementById('rmap-connect-banner');
  if (btn)    { btn.style.background=''; btn.style.borderColor='var(--border)'; btn.style.color='var(--text-dim)'; }
  if (banner) banner.style.display = 'none';
  const c = document.getElementById('roadmap-canvas'); if (c) c.style.cursor = '';
  if (_rNodeGsRef) _rNodeGsRef.select('circle.rmap-circle').attr('stroke-width',1).attr('stroke-opacity',0.65);
}
// Enter connect mode with a specific feature pre-selected as the dependent
function _rmapConnectFrom(featureId) {
  if (!_connectMode) _toggleConnectMode();
  const node = window._rmapSimNodes?.find(n => n.id === featureId);
  _connectSource = node || { id: featureId };
  const f   = _roadmapData?.features.find(x => x.id === featureId);
  const msg = document.getElementById('rmap-connect-msg');
  if (msg) msg.textContent = 'Now click what "' + (f?.name || featureId) + '" requires';
  if (_rNodeGsRef && node) {
    _rNodeGsRef.select('circle.rmap-circle')
      .attr('stroke-width',   n => n.id===featureId ? 3 : 1)
      .attr('stroke',         n => n.id===featureId ? 'rgba(255,255,255,.9)' : '#4a4a48')
      .attr('stroke-opacity', n => n.id===featureId ? 1 : 0.3);
  }
}
async function _roadmapCreateDependency(dependentId, dependencyId) {
  const dep = _roadmapData?.features.find(f => f.id === dependentId);
  if (!dep || (dep.dependsOn||[]).includes(dependencyId)) { _cancelConnectMode(); return; }
  try {
    const newDeps = [...(dep.dependsOn||[]), dependencyId];
    await _roadmapPatchFeature(dependentId, { dependsOn: newDeps });
    const f = _roadmapData.features.find(x => x.id === dependentId);
    if (f) f.dependsOn = newDeps;
    _cancelConnectMode();
    renderRoadmapMainCanvas(_roadmapData.features);
    _rmapToast('Dependency created');
  } catch(e) { console.error(e); _cancelConnectMode(); }
}
async function _roadmapRemoveDependency(dependentId, dependencyId) {
  const dep = _roadmapData?.features.find(f => f.id === dependentId);
  if (!dep) return;
  const newDeps = (dep.dependsOn||[]).filter(d => d !== dependencyId);
  try {
    await _roadmapPatchFeature(dependentId, { dependsOn: newDeps });
    const f = _roadmapData.features.find(x => x.id === dependentId);
    if (f) f.dependsOn = newDeps;
    renderRoadmapMainCanvas(_roadmapData.features);
    _rmapToast('Dependency removed');
  } catch(e) { console.error(e); }
}

// ═══ ANALYSIS ══════════════════════════════════════════════════════════════
function _rmapGetPrereqChain(featureId) {
  const features = _roadmapData?.features || [];
  const result = [], visited = new Set();
  function collect(id) {
    if (visited.has(id)) return; visited.add(id);
    const f = features.find(x => x.id === id); if (!f) return;
    (f.dependsOn||[]).forEach(depId => {
      const dep = features.find(x => x.id === depId);
      if (dep && dep.status !== 'complete') { result.push(dep); collect(depId); }
    });
  }
  collect(featureId);
  return result;
}

function _rmapGetBlockerRank(featureId) {
  const features = _roadmapData?.features || [];
  const reachable = new Set(), queue = [featureId];
  const revMap = new Map(features.map(f => [f.id, []]));
  features.forEach(f => { (f.dependsOn||[]).forEach(d => { if (revMap.has(d)) revMap.get(d).push(f.id); }); });
  while (queue.length) { const id=queue.shift(); (revMap.get(id)||[]).forEach(d => { if (!reachable.has(d)) { reachable.add(d); queue.push(d); } }); }
  return reachable.size;
}

function _rmapComputeCriticalPath(features) {
  const inc = features.filter(f => f.status !== 'complete');
  const ids = new Set(inc.map(f => f.id));
  const depMap = new Map(inc.map(f => [f.id, (f.dependsOn||[]).filter(d => ids.has(d))]));
  const visited = new Set(), topo = [];
  function dfs(id) { if (visited.has(id)) return; visited.add(id); (depMap.get(id)||[]).forEach(dfs); topo.push(id); }
  inc.forEach(f => dfs(f.id));
  const dist = new Map(inc.map(f => [f.id, 1])), parent = new Map();
  for (const id of topo) {
    for (const dep of (depMap.get(id)||[])) {
      if ((dist.get(id)||0) < (dist.get(dep)||0)+1) { dist.set(id,(dist.get(dep)||0)+1); parent.set(id,dep); }
    }
  }
  let maxId=null, maxDist=0;
  for (const [id,d] of dist) { if (d>maxDist) { maxDist=d; maxId=id; } }
  const path = new Set(); let cur=maxId;
  while (cur) { path.add(cur); cur=parent.get(cur); }
  return path;
}

function _rmapToggleCritPath() {
  if (_rmapCritActive) { _rmapClearCritPath(); return; }
  if (!_roadmapData) return;
  _rmapCritPathIds = _rmapComputeCriticalPath(_roadmapData.features);
  _rmapCritActive  = true;
  const btn = document.getElementById('rmap-crit-btn');
  if (btn) { btn.style.background='rgba(239,159,39,.15)'; btn.style.borderColor='rgba(239,159,39,.5)'; btn.style.color='#EF9F27'; }
  if (_rNodeGsRef) {
    _rNodeGsRef.classed('crit-path', d => _rmapCritPathIds.has(d.id));
    _rNodeGsRef.classed('dimmed',    d => !_rmapCritPathIds.has(d.id));
  }
  if (_rEdgesRef) {
    _rEdgesRef
      .attr('stroke-opacity', d => { const s=d.source?.id||d.sourceId,t=d.target?.id||d.targetId; return (_rmapCritPathIds.has(s)&&_rmapCritPathIds.has(t)) ? 0.7 : 0.03; })
      .attr('stroke',         d => { const s=d.source?.id||d.sourceId,t=d.target?.id||d.targetId; return (_rmapCritPathIds.has(s)&&_rmapCritPathIds.has(t)) ? '#EF9F27' : '#4a4a48'; });
  }
  _rmapToast('\ud83d\udd34 Critical path: ' + _rmapCritPathIds.size + ' features');
}

function _rmapClearCritPath() {
  _rmapCritActive = false; _rmapCritPathIds.clear();
  const btn = document.getElementById('rmap-crit-btn');
  if (btn) { btn.style.background=''; btn.style.borderColor='var(--border)'; btn.style.color='var(--text-dim)'; }
  if (_rNodeGsRef) _rNodeGsRef.classed('crit-path dimmed', false);
  if (_rEdgesRef)  _rEdgesRef.attr('stroke-opacity', 0.25);
}

function _rmapToggleHideDone() {
  _rmapHideDone = !_rmapHideDone;
  try { localStorage.setItem('mycelium-rmap-hide-done', JSON.stringify(_rmapHideDone)); } catch {}
  _updateHideDoneBtn();
  if (_roadmapData) renderRoadmapMainCanvas(_roadmapData.features);
}

// ═══ FEATURE DETAIL PANEL ═════════════════════════════════════════════════
const _RMAP_COL = { complete:'#7ECBA1','in-progress':'#ff8c42',planned:'var(--text-dim)',blocked:'#e0524a',backlog:'var(--text-faint)' };
const _RMAP_ICO = { complete:'\u2713','in-progress':'\u25d0',planned:'\u25cb',blocked:'\u2715',backlog:'\u00b7' };

function _roadmapSelectFeature(featureId) {
  _rmapSelectedId = featureId;
  const panel = document.getElementById('roadmap-feature-detail');
  if (!_roadmapData || !panel) return;
  const feature = _roadmapData.features.find(f => f.id === featureId);
  if (!feature) return;

  const color  = _RMAP_COL[feature.status] || 'var(--text-dim)';
  const icon   = _RMAP_ICO[feature.status] || '\u25cb';
  const safe   = _safe(featureId);
  const safeN  = _safe(feature.name);

  const statusOpts = ['planned','in-progress','complete','blocked','backlog'].map(s => {
    const lbl = { planned:'\u25cb Planned','in-progress':'\u25d0 Active',complete:'\u2713 Complete',blocked:'\u2715 Blocked',backlog:'\u00b7 Backlog' };
    return '<option value="' + s + '"' + (feature.status===s ? ' selected' : '') + '>' + lbl[s] + '</option>';
  }).join('');

  // Requires list
  const depHtml = (feature.dependsOn||[]).length ? (() => {
    const rows = (feature.dependsOn||[]).map(id => {
      const d = _roadmapData.features.find(x => x.id === id);
      const s = _safe(id);
      const ic = _RMAP_ICO[d?.status] || '?';
      const c  = _RMAP_COL[d?.status] || 'var(--text-faint)';
      return '<div class="dep-item dep-import" style="display:flex;align-items:center;gap:4px;">' +
        '<span style="color:' + c + ';flex-shrink:0;">' + ic + '</span>' +
        '<span onclick="_roadmapFocusFeature(\'' + s + '\')" style="flex:1;cursor:pointer;overflow:hidden;text-overflow:ellipsis;">' + (d?d.name:id) + '</span>' +
        '<button onclick="_roadmapRemoveDependency(\'' + safe + '\',\'' + s + '\')" title="Remove" style="background:none;border:none;color:var(--text-faint);cursor:pointer;font-size:11px;padding:0 2px;line-height:1;" onmouseover="this.style.color=\'#e0524a\'" onmouseout="this.style.color=\'var(--text-faint)\'">\u2715</button>' +
        '</div>';
    }).join('');
    return '<div class="section-title" style="margin-top:12px;">Requires</div><div class="dep-list">' + rows + '</div>';
  })() : '';

  // Required by list
  const neededBy = (_roadmapData.features||[]).filter(f => (f.dependsOn||[]).includes(featureId));
  const neededByHtml = neededBy.length ? (() => {
    const rows = neededBy.map(f => {
      const s = _safe(f.id);
      const ic = _RMAP_ICO[f.status]||'\u25cb';
      const c  = _RMAP_COL[f.status]||'var(--text-dim)';
      return '<div class="dep-item dep-import" style="display:flex;align-items:center;gap:4px;">' +
        '<span style="color:' + c + ';flex-shrink:0;">' + ic + '</span>' +
        '<span onclick="_roadmapFocusFeature(\'' + s + '\')" style="flex:1;cursor:pointer;">' + f.name + '</span>' +
        '</div>';
    }).join('');
    return '<div class="section-title" style="margin-top:12px;">Required by</div><div class="dep-list">' + rows + '</div>';
  })() : '';

  // Files
  const fileSet = new Set(feature.files||[]);
  const filesHtml = fileSet.size > 0 ? (() => {
    const rows = [...fileSet].map(fid =>
      '<div class="dep-item dep-import" onclick="window.switchTab(\'graph\');requestAnimationFrame(()=>focusNode(\'' + _safe(fid) + '\'))" title="' + fid + '">' + fid.split('/').pop() + '</div>'
    ).join('');
    return '<div class="section-title" style="margin-top:12px;">Files (' + fileSet.size + ')</div><div class="dep-list">' + rows + '</div>';
  })() : '';

  // Tags
  const tagsHtml = (feature.tags||[]).length
    ? '<div style="margin-top:7px;display:flex;gap:4px;flex-wrap:wrap;">' +
      (feature.tags||[]).map(t => '<span style="font-size:10px;padding:1px 6px;background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:10px;color:var(--text-dim);">' + t + '</span>').join('') +
      '</div>'
    : '';

  // Blocker rank
  const blockerCount = _rmapGetBlockerRank(featureId);
  const blockerHtml  = blockerCount > 0
    ? '<div class="stat-row" style="margin-top:4px;"><span>Blocks</span><span class="stat-val" style="color:#ff8c42;">' + blockerCount + ' feature' + (blockerCount!==1?'s':'') + '</span></div>'
    : '';

  // What's blocking this
  let blockingHtml = '';
  if (feature.status !== 'complete') {
    const prereqs = _rmapGetPrereqChain(featureId);
    if (prereqs.length === 0 && (feature.dependsOn||[]).length === 0) {
      blockingHtml = '<div style="font-size:11px;color:#7ECBA1;margin-top:8px;">\u2713 Nothing blocking \u2014 ready to start</div>';
    } else if ((feature.dependsOn||[]).length > 0 && prereqs.length === 0) {
      blockingHtml = '<div style="font-size:11px;color:#7ECBA1;margin-top:8px;">\u2713 All dependencies complete \u2014 ready to start</div>';
    } else if (prereqs.length > 0) {
      const rows = prereqs.slice(0,8).map(f => {
        const ic = _RMAP_ICO[f.status]||'\u25cb';
        const c  = _RMAP_COL[f.status]||'var(--text-dim)';
        return '<div class="dep-item dep-import" style="display:flex;align-items:center;gap:4px;">' +
          '<span style="color:' + c + ';flex-shrink:0;">' + ic + '</span>' +
          '<span onclick="_roadmapFocusFeature(\'' + _safe(f.id) + '\')" style="flex:1;cursor:pointer;overflow:hidden;text-overflow:ellipsis;">' + f.name + '</span></div>';
      }).join('');
      blockingHtml = '<div class="section-title" style="margin-top:12px;color:#e0524a;">What\'s blocking this</div><div class="dep-list">' + rows +
        (prereqs.length > 8 ? '<div style="font-size:10px;color:var(--text-faint);padding:4px 0;">+ ' + (prereqs.length-8) + ' more</div>' : '') + '</div>';
    }
  }

  panel.innerHTML =
    '<div class="node-detail">' +
    '<div class="node-kind-badge kind-file">feature</div>' +
    '<div class="node-name" id="rmap-edit-name" contenteditable="true" spellcheck="false"' +
    ' style="color:' + color + ';outline:none;cursor:text;border-radius:2px;padding:1px 3px;margin:-1px -3px;"' +
    ' onfocus="this.style.background=\'rgba(255,255,255,.05)\'"' +
    ' onblur="this.style.background=\'\';_rmapAutoSaveName(\'' + safe + '\',this.innerText.trim())"' +
    ' onkeydown="if(event.key===\'Enter\'){event.preventDefault();this.blur();}">' +
    icon + ' ' + feature.name + '</div>' +
    tagsHtml +
    '<select id="rmap-edit-status" onchange="_rmapAutoSaveStatus(\'' + safe + '\',this.value)"' +
    ' style="width:100%;margin:8px 0;background:var(--surface2);border:1px solid var(--border);color:' + color + ';font-family:inherit;font-size:11px;padding:4px 8px;outline:none;border-radius:2px;cursor:pointer;">' +
    statusOpts + '</select>' +
    '<div class="node-description" id="rmap-edit-desc" contenteditable="true" spellcheck="false"' +
    ' style="outline:none;cursor:text;border-radius:2px;padding:2px 3px;margin:-2px -3px;min-height:20px;"' +
    ' onfocus="this.style.background=\'rgba(255,255,255,.05)\'"' +
    ' onblur="this.style.background=\'\';_rmapAutoSaveDesc(\'' + safe + '\',this.innerText.trim())">' +
    (feature.description || '<span style="color:var(--text-faint);font-style:italic;pointer-events:none;">No description \u2014 click to add</span>') + '</div>' +
    (feature.notes ? '<div style="font-size:11px;color:var(--text-faint);margin:8px 0;padding:6px 8px;background:rgba(255,255,255,.02);border-left:2px solid var(--border);">\u2192 ' + feature.notes + '</div>' : '') +
    '<div class="section-title" style="margin-top:12px;">Stats</div>' +
    '<div class="stat-row"><span>Priority</span><span class="stat-val">' + (feature.priority||'\u2013') + '</span></div>' +
    blockerHtml +
    '<div id="rmap-detail-save-msg" style="font-size:10px;color:var(--text-faint);margin:6px 0;min-height:14px;"></div>' +
    '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px;">' +
    '<button onclick="_rmapIsolateSubtree(\'' + safe + '\')" style="flex:1;background:none;border:1px solid var(--border);color:var(--thread-bright);cursor:pointer;font-family:inherit;font-size:11px;padding:4px 6px;border-radius:2px;">\u29c6 Subtree</button>' +
    '<button onclick="_rmapConnectFrom(\'' + safe + '\')" style="flex:1;background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:11px;padding:4px 6px;border-radius:2px;">\u27f6 Connect</button>' +
    '<button onclick="_roadmapHideFeature(\'' + safe + '\')" style="background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:11px;padding:4px 8px;border-radius:2px;">\ud83d\udc41 Hide</button>' +
    '</div>' +
    blockingHtml + filesHtml + depHtml + neededByHtml +
    '</div>';

  if (_rNodeGsRef) {
    _rNodeGsRef.select('circle.rmap-circle')
      .attr('stroke-width',   n => n.id===featureId ? 2.5 : 1)
      .attr('stroke-opacity', n => n.id===featureId ? 1 : 0.65);
  }
}

// ═══ AUTO-SAVE ════════════════════════════════════════════════════════════
function _rmapShowSaveMsg(text, isErr=false) {
  const el = document.getElementById('rmap-detail-save-msg'); if (!el) return;
  el.textContent=text; el.style.color=isErr?'#e0524a':'#7ECBA1';
  if (!isErr) setTimeout(()=>{ if(el.textContent===text) el.textContent=''; },2000);
}
async function _rmapAutoSaveName(featureId, newName) {
  if (!newName||!_roadmapData) return;
  const f = _roadmapData.features.find(x=>x.id===featureId);
  if (!f||f.name===newName) return;
  _rmapShowSaveMsg('Saving\u2026');
  try {
    await _roadmapPatchFeature(featureId, {name:newName});
    if (f) f.name=newName; _rmapShowSaveMsg('\u2713 Saved');
    if (_rNodeGsRef) {
      _rNodeGsRef.filter(d=>d.id===featureId).selectAll('.rmap-lbl')
        .text(newName.length>22 ? newName.slice(0,20)+'\u2026' : newName);
      const sn=window._rmapSimNodes?.find(n=>n.id===featureId); if(sn) sn.name=newName;
    }
  } catch { _rmapShowSaveMsg('Save failed',true); }
}
async function _rmapAutoSaveStatus(featureId, newStatus) {
  _rmapShowSaveMsg('Saving\u2026');
  try {
    await _roadmapPatchFeature(featureId, {status:newStatus});
    const f=_roadmapData?.features.find(x=>x.id===featureId); if(f) f.status=newStatus;
    _rmapShowSaveMsg('\u2713 Saved');
    setTimeout(()=>{ if(_roadmapData) renderRoadmapMainCanvas(_roadmapData.features); },150);
  } catch { _rmapShowSaveMsg('Save failed',true); }
}
async function _rmapAutoSaveDesc(featureId, newDesc) {
  if (!_roadmapData) return;
  const f=_roadmapData.features.find(x=>x.id===featureId);
  if (!f||f.description===newDesc) return;
  _rmapShowSaveMsg('Saving\u2026');
  try {
    await _roadmapPatchFeature(featureId, {description:newDesc});
    if(f) f.description=newDesc; _rmapShowSaveMsg('\u2713 Saved');
  } catch { _rmapShowSaveMsg('Save failed',true); }
}

// ═══ STATUS (from context menu) ════════════════════════════════════════════
window.setRoadmapStatus = async function(featureId, status) {
  try {
    await _roadmapPatchFeature(featureId, {status});
    const f=_roadmapData?.features.find(x=>x.id===featureId); if(f) f.status=status;
    if (_rmapSelectedId===featureId) _roadmapSelectFeature(featureId);
    renderRoadmapMainCanvas(_roadmapData.features);
  } catch(e) { console.error(e); }
};

// ═══ SUBTREE ISOLATION ═════════════════════════════════════════════════════
function _rmapIsolateSubtree(featureId) {
  if (!_roadmapData) return;
  const features  = _roadmapData.features;
  const reachable = new Set([featureId]), queue = [featureId];
  const revMap    = new Map(features.map(f => [f.id, []]));
  features.forEach(f => { (f.dependsOn||[]).forEach(d => { if(revMap.has(d)) revMap.get(d).push(f.id); }); });
  while (queue.length) {
    const id=queue.shift(), f=features.find(x=>x.id===id);
    (f?.dependsOn||[]).forEach(d=>{ if(!reachable.has(d)){reachable.add(d);queue.push(d);} });
    (revMap.get(id)||[]).forEach(d=>{ if(!reachable.has(d)){reachable.add(d);queue.push(d);} });
  }
  _rmapIsolated = true;
  if (_rNodeGsRef) {
    _rNodeGsRef.classed('highlighted', d=>reachable.has(d.id)).classed('dimmed', d=>!reachable.has(d.id));
  }
  if (_rEdgesRef) {
    _rEdgesRef.attr('stroke-opacity', d => {
      const s=d.source?.id||d.sourceId, t=d.target?.id||d.targetId;
      return (reachable.has(s)&&reachable.has(t)) ? 0.6 : 0.03;
    });
  }
  const old=document.getElementById('rmap-isolation-banner'); if(old) old.remove();
  const c=document.getElementById('roadmap-canvas'); if(!c) return;
  const f=features.find(x=>x.id===featureId);
  const banner=document.createElement('div');
  banner.id='rmap-isolation-banner';
  banner.style.cssText='position:absolute;top:10px;left:50%;transform:translateX(-50%);background:rgba(6,6,6,.9);border:1px solid var(--thread-bright);border-radius:4px;padding:5px 12px 5px 10px;display:flex;align-items:center;gap:10px;z-index:10;font-family:\'SF Mono\',\'Fira Code\',monospace;font-size:11px;color:var(--thread-bright);white-space:nowrap;backdrop-filter:blur(6px);';
  banner.innerHTML='<span style="opacity:.6">\u29c6</span><span>Subtree of <strong>'+(f?.name||featureId)+'</strong> \u00b7 '+reachable.size+' features</span>' +
    '<button onclick="_rmapClearIsolation()" style="background:none;border:1px solid rgba(255,255,255,.2);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:10px;padding:2px 8px;border-radius:2px;margin-left:4px;" onmouseover="this.style.borderColor=\'rgba(255,255,255,.5)\';this.style.color=\'var(--text)\'" onmouseout="this.style.borderColor=\'rgba(255,255,255,.2)\';this.style.color=\'var(--text-dim)\'">\u2715 Clear</button>';
  c.appendChild(banner);
}
function _rmapClearIsolation() {
  _rmapIsolated=false;
  if (_rNodeGsRef) _rNodeGsRef.classed('highlighted dimmed',false);
  if (_rEdgesRef)  _rEdgesRef.attr('stroke-opacity',0.25);
  const b=document.getElementById('rmap-isolation-banner'); if(b) b.remove();
}

// ═══ MARKDOWN EXPORT ══════════════════════════════════════════════════════
function _rmapExportMarkdown() {
  if (!_roadmapData) return;
  const features=_roadmapData.features, featureIds=new Set(features.map(f=>f.id));
  const visited=new Set(), lines=['# Mycelium Roadmap',''];
  function addFeature(f, indent) {
    if (visited.has(f.id)) return; visited.add(f.id);
    const check=f.status==='complete'?'x':' ';
    const icon=_RMAP_ICO[f.status]||'\u25cb';
    const desc=f.description ? ' \u2014 ' + f.description.split('\n')[0].slice(0,80) : '';
    lines.push('  '.repeat(indent)+'- ['+check+'] '+icon+' '+f.name+desc);
    features.filter(x=>(x.dependsOn||[]).includes(f.id)).forEach(d=>addFeature(d,indent+1));
  }
  features.filter(f=>(f.dependsOn||[]).filter(d=>featureIds.has(d)).length===0).forEach(r=>addFeature(r,0));
  features.forEach(f=>{ if(!visited.has(f.id)) { const c=f.status==='complete'?'x':''; lines.push('- ['+c+'] '+(_RMAP_ICO[f.status]||'\u25cb')+' '+f.name); } });
  const text=lines.join('\n');
  const fallback=()=>{ const ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); _rmapToast('\ud83d\udccb Copied!'); };
  navigator.clipboard?.writeText(text).then(()=>_rmapToast('\ud83d\udccb Copied to clipboard!')).catch(fallback) || fallback();
}

// ═══ FOCUS / HIDE / UNHIDE ════════════════════════════════════════════════
function _roadmapFocusFeature(featureId) {
  const nodes=window._rmapSimNodes; if(!nodes) return;
  const node=nodes.find(n=>n.id===featureId); if(!node||node.x===undefined) return;
  const c=document.getElementById('roadmap-canvas'), svgEl=c?.querySelector('svg');
  if(!svgEl||!_roadmapMainZoom) return;
  const W=c.clientWidth, H=c.clientHeight, s=d3.zoomTransform(svgEl).k;
  d3.select(svgEl).transition().duration(450).ease(d3.easeCubicOut)
    .call(_roadmapMainZoom.transform, d3.zoomIdentity.translate(W/2-node.x*s, H/2-node.y*s).scale(s));
  _roadmapSelectFeature(featureId);
}
function _roadmapHideFeature(id) {
  _hiddenFeatures.add(id);
  try { localStorage.setItem('mycelium-hidden-features', JSON.stringify([..._hiddenFeatures])); } catch {}
  _updateRmapHiddenRow();
  const panel=document.getElementById('roadmap-feature-detail');
  if (panel) panel.innerHTML='<div style="color:var(--text-dim);font-size:12px;text-align:center;margin-top:40px;line-height:1.9;">Feature hidden.<br><button onclick="_roadmapUnhideAll()" style="margin-top:8px;background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:11px;padding:4px 12px;border-radius:2px;">\u21a9 Show all hidden</button></div>';
  if (_roadmapData) renderRoadmapMainCanvas(_roadmapData.features);
}
function _roadmapUnhideAll() {
  _hiddenFeatures.clear();
  try { localStorage.setItem('mycelium-hidden-features','[]'); } catch {}
  _updateRmapHiddenRow();
  const panel=document.getElementById('roadmap-feature-detail');
  if (panel) panel.innerHTML='<div style="color:var(--text-dim);font-size:12px;text-align:center;margin-top:40px;line-height:1.9;">Click any node to see its details<br><br><span style="font-size:10px;opacity:.6">Right-click to hide or change status</span></div>';
  if (_roadmapData) renderRoadmapMainCanvas(_roadmapData.features);
}

// ═══ CONTEXT MENUS ════════════════════════════════════════════════════════
function _showRoadmapCtxMenu(event, d) {
  const safe=_safe(d.id), menu=document.getElementById('roadmap-ctx-menu');
  if (!menu) return;
  const statusRows=['planned','in-progress','complete','blocked'].map(s=>{
    const lbl={'planned':'\u25cb Planned','in-progress':'\u25d0 Active','complete':'\u2713 Complete','blocked':'\u2715 Blocked'};
    const c={'planned':'var(--text-dim)','in-progress':'#ff8c42','complete':'#7ECBA1','blocked':'#e0524a'};
    return '<div class="ctx-item" style="color:'+c[s]+';" onclick="window.setRoadmapStatus(\''+safe+'\',\''+s+'\');_hideRoadmapCtxMenu();">'+lbl[s]+'</div>';
  }).join('');
  menu.innerHTML=
    '<div class="ctx-item" onclick="_roadmapSelectFeature(\''+safe+'\');_hideRoadmapCtxMenu();">\ud83d\udccb View details</div>'+
    '<div class="ctx-item" onclick="_roadmapFocusFeature(\''+safe+'\');_hideRoadmapCtxMenu();">\ud83d\udd0d Focus</div>'+
    '<div class="ctx-item" style="color:var(--thread-bright);" onclick="_rmapIsolateSubtree(\''+safe+'\');_hideRoadmapCtxMenu();">\u29c6 Show only subtree</div>'+
    '<div class="ctx-divider"></div>'+
    '<div style="padding:3px 16px;font-size:9px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.08em;">Set status</div>'+
    statusRows+
    '<div class="ctx-divider"></div>'+
    '<div class="ctx-item" onclick="_roadmapHideFeature(\''+safe+'\');_hideRoadmapCtxMenu();">\ud83d\udc41 Hide</div>';
  menu.style.display='block';
  menu.style.left=(event.clientX+2)+'px';
  menu.style.top=(event.clientY+2)+'px';
}
function _showEdgeCtxMenu(event, link) {
  const menu=document.getElementById('roadmap-ctx-menu'); if(!menu) return;
  const srcId=link.sourceId||link.source?.id, tgtId=link.targetId||link.target?.id;
  const src=_roadmapData?.features.find(f=>f.id===srcId);
  const tgt=_roadmapData?.features.find(f=>f.id===tgtId);
  const sSafe=_safe(srcId||''), tSafe=_safe(tgtId||'');
  menu.innerHTML=
    '<div style="padding:6px 16px 2px;font-size:10px;color:var(--text-faint);">Dependency edge</div>'+
    '<div style="padding:1px 16px 5px;font-size:11px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:210px;">'+(src?.name||srcId)+' \u2192 '+(tgt?.name||tgtId)+'</div>'+
    '<div class="ctx-divider"></div>'+
    '<div class="ctx-item" style="color:#e0524a;" onclick="_roadmapRemoveDependency(\''+sSafe+'\',\''+tSafe+'\');_hideRoadmapCtxMenu();">\u2715 Remove dependency</div>';
  menu.style.display='block';
  menu.style.left=(event.clientX+2)+'px';
  menu.style.top=(event.clientY+2)+'px';
}
function _hideRoadmapCtxMenu() {
  const m=document.getElementById('roadmap-ctx-menu'); if(m) m.style.display='none';
}
document.addEventListener('click', _hideRoadmapCtxMenu);

// ═══ KEYBOARD NAVIGATION ══════════════════════════════════════════════════
document.addEventListener('keydown', function rmapKeys(e) {
  if (!_inRoadmapMode) return;
  const active=document.activeElement;
  if (active&&(active.tagName==='INPUT'||active.tagName==='TEXTAREA'||active.isContentEditable)) return;
  if (e.key==='Escape') {
    if (_connectMode)    { _cancelConnectMode();   e.stopPropagation(); return; }
    if (_rmapIsolated)   { _rmapClearIsolation();  e.stopPropagation(); return; }
    if (_rmapCritActive) { _rmapClearCritPath();   e.stopPropagation(); return; }
    return;
  }
  if (e.key==='Tab') {
    e.preventDefault();
    const nodes=window._rmapSimNodes||[]; if(!nodes.length) return;
    const curIdx=_rmapSelectedId?nodes.findIndex(n=>n.id===_rmapSelectedId):-1;
    const nextIdx=e.shiftKey?(curIdx<=0?nodes.length-1:curIdx-1):(curIdx+1)%nodes.length;
    _roadmapFocusFeature(nodes[nextIdx].id);
  }
  if ((e.key==='h'||e.key==='H')&&_rmapSelectedId) { _roadmapHideFeature(_rmapSelectedId); e.preventDefault(); }
  if (e.key==='u'||e.key==='U') { _roadmapUnhideAll(); e.preventDefault(); }
  if (e.key==='c'||e.key==='C') { _rmapExportMarkdown(); e.preventDefault(); }
}, true);

// ═══ MAIN CANVAS RENDERER ══════════════════════════════════════════════════
function renderRoadmapMainCanvas(allFeatures) {
  // Persist node positions before teardown
  if (window._rmapSimNodes) {
    window._rmapSimNodes.forEach(n => {
      if (n.x!==undefined&&n.y!==undefined) _roadmapNodePos.set(n.id,{x:n.x,y:n.y});
    });
  }
  _stopRoadmapMain();
  _injectSidebarControls();

  const container=document.getElementById('roadmap-canvas');
  if (!container||!window.d3) return;

  const filter=_roadmapFilter||'all';
  const features=allFeatures.filter(f => {
    if (_hiddenFeatures.has(f.id)) return false;
    if (_rmapHideDone && f.status==='complete') return false;
    if (filter==='all')     return true;
    if (filter==='done')    return f.status==='complete';
    if (filter==='active')  return f.status==='in-progress';
    if (filter==='planned') return f.status==='planned'||f.status==='backlog';
    if (filter==='blocked') return f.status==='blocked';
    if (filter==='ready')   return f.status!=='complete' &&
      (f.dependsOn||[]).every(depId => { const d=allFeatures.find(x=>x.id===depId); return !d||d.status==='complete'; });
    if (filter.startsWith('tag:')) return (f.tags||[]).includes(filter.slice(4));
    return true;
  });

  container.innerHTML='';
  if (!features.length) {
    container.innerHTML='<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:var(--text-dim);font-size:12px;text-align:center;line-height:1.9;">No features in this view.<br><span style="font-size:10px;opacity:.6">Try a different filter or click + Add feature</span></div>';
    return;
  }

  const W=container.clientWidth||800, H=container.clientHeight||600;
  const featureIds=new Set(features.map(f=>f.id));

  // Depth computation (with fallback)
  let depths={};
  try { depths=_calcFeatureDepths(features); }
  catch {
    features.forEach(f=>{depths[f.id]=0;});
    let changed=true, iter=0;
    while(changed&&iter++<500){changed=false;features.forEach(f=>{(f.dependsOn||[]).filter(d=>featureIds.has(d)).forEach(depId=>{const nd=(depths[depId]||0)+1;if(nd>(depths[f.id]||0)){depths[f.id]=nd;changed=true;}});});}
  }
  const maxDepth=Math.max(0,...Object.values(depths));

  const inDegree={};
  features.forEach(f=>{inDegree[f.id]=0;});
  features.forEach(f=>{(f.dependsOn||[]).forEach(d=>{if(inDegree[d]!==undefined)inDegree[d]++;});});

  const linkDefs=[];
  features.forEach(f=>{(f.dependsOn||[]).forEach(depId=>{if(featureIds.has(depId))linkDefs.push({source:depId,target:f.id});});});

  const STATUS_COLOR={complete:'#7ECBA1','in-progress':'#ff8c42',planned:'#4a4a48',blocked:'#e0524a',backlog:'#3a3836'};
  const STATUS_GLOW ={complete:'rgba(126,203,161,.2)','in-progress':'rgba(255,140,66,.25)',planned:'rgba(74,74,72,.1)',blocked:'rgba(224,82,74,.2)',backlog:'transparent'};
  const STATUS_ICON ={complete:'\u2713','in-progress':'\u25d0',planned:'\u25cb',blocked:'\u2715',backlog:'\u00b7'};
  const STATUS_LABEL={complete:'Complete','in-progress':'Active',planned:'Planned',blocked:'Blocked',backlog:'Backlog'};

  const nodeR=d=>13+Math.min(11,(inDegree[d.id]||0)*3);

  // Use cached positions — prevents jarring reshift on hide/filter changes
  const simNodes=features.map(f=>{
    const saved=_roadmapNodePos.get(f.id);
    return {...f,
      x:saved?.x??(W/2+(Math.random()-.5)*120),
      y:saved?.y??(60+((depths[f.id]||0)/Math.max(1,maxDepth))*(H-120))
    };
  });
  window._rmapSimNodes=simNodes;

  const nodeById=new Map(simNodes.map(n=>[n.id,n]));
  const simLinks=linkDefs.map(l=>({source:nodeById.get(l.source),target:nodeById.get(l.target),sourceId:l.source,targetId:l.target})).filter(l=>l.source&&l.target);

  const svg=d3.select(container).append('svg').attr('width','100%').attr('height','100%').style('display','block');
  const gMain=svg.append('g').attr('class','rmap-main');

  const mainZoom=d3.zoom()
    .scaleExtent([0.04,10])
    .filter(e=>e.type!=='dblclick')
    .on('zoom',({transform})=>{
      gMain.attr('transform',transform);
      // Level-of-detail: fade labels as you zoom out
      const k=transform.k;
      gMain.selectAll('.rmap-lbl').style('opacity',k<0.3?0:k<0.55?(k-0.3)/0.25:1);
    });
  svg.call(mainZoom);
  _roadmapMainZoom=mainZoom;

  svg.on('dblclick',e=>{
    if(e.target.closest&&e.target.closest('.rmap-node')) return;
    _rmapFitView(svg,mainZoom,W,H,simNodes);
  });
  svg.on('click',()=>{
    if(_connectMode) return;
    if(_rNodeGsRef) _rNodeGsRef.select('circle.rmap-circle').attr('stroke-width',1).attr('stroke-opacity',0.65);
  });

  svg.append('defs').append('marker')
    .attr('id','rmap-main-arr').attr('viewBox','0 0 8 8')
    .attr('refX',5).attr('refY',4).attr('markerWidth',5).attr('markerHeight',5)
    .attr('orient','auto-start-reverse')
    .append('path').attr('d','M1 1L7 4L1 7')
    .attr('fill','none').attr('stroke','context-stroke')
    .attr('stroke-width',1.5).attr('stroke-linecap','round').attr('stroke-linejoin','round');

  const tierLayer=gMain.append('g');
  const edgeLayer=gMain.append('g');
  const hitLayer=gMain.append('g');
  const particleLayer=gMain.append('g');
  const nodeLayer=gMain.append('g');

  // Depth tier guide lines
  if (maxDepth>0) {
    for (let d=0;d<=maxDepth;d++) {
      const y=60+(d/maxDepth)*(H-120);
      tierLayer.append('line').attr('x1',-5000).attr('y1',y).attr('x2',5000).attr('y2',y)
        .attr('stroke','rgba(255,255,255,.025)').attr('stroke-width',1).attr('stroke-dasharray','3,8');
      tierLayer.append('text').attr('x',-55).attr('y',y+10).attr('font-size',8)
        .attr('font-family',"'SF Mono','Fira Code',monospace")
        .attr('fill','rgba(255,255,255,.06)').attr('text-anchor','end')
        .text('tier '+d);
    }
  }

  function bezierD(sx,sy,tx,ty){const dy=ty-sy,dx=tx-sx;return 'M '+sx+' '+sy+' C '+(sx+dx*.12)+' '+(sy+dy*.48)+','+( tx-dx*.12)+' '+(ty-dy*.48)+','+tx+' '+ty;}

  const rEdges=edgeLayer.selectAll('path').data(simLinks).join('path')
    .attr('fill','none')
    .attr('stroke',d=>STATUS_COLOR[d.source.status]||'#4a4a48')
    .attr('stroke-width',1.4).attr('stroke-opacity',0.25)
    .attr('marker-end','url(#rmap-main-arr)');
  _rEdgesRef=rEdges;

  const rEdgeHits=hitLayer.selectAll('path').data(simLinks).join('path')
    .attr('fill','none').attr('stroke','transparent').attr('stroke-width',16).style('cursor','pointer')
    .on('contextmenu',(event,d)=>{event.preventDefault();event.stopPropagation();_showEdgeCtxMenu(event,d);})
    .on('mouseenter',function(ev,d){rEdges.filter(e=>e===d).attr('stroke-opacity',0.7).attr('stroke-width',2);})
    .on('mouseleave',function(){rEdges.attr('stroke-opacity',0.25).attr('stroke-width',1.4);});
  _rEdgeHitsRef=rEdgeHits;

  const rNodeGs=nodeLayer.selectAll('g').data(simNodes).join('g')
    .attr('class',d=>'rmap-node'+(d.status==='in-progress'?' rmap-node-active':''))
    .style('cursor','pointer')
    .on('click',(event,d)=>{
      event.stopPropagation(); _hideRoadmapCtxMenu();
      if (_connectMode) {
        if (!_connectSource) {
          _connectSource=d;
          rNodeGs.select('circle.rmap-circle')
            .attr('stroke-width',n=>n.id===d.id?3:1)
            .attr('stroke',n=>n.id===d.id?'rgba(255,255,255,.9)':(STATUS_COLOR[n.status]||'#4a4a48'))
            .attr('stroke-opacity',n=>n.id===d.id?1:0.3);
          const msg=document.getElementById('rmap-connect-msg');
          if(msg) msg.textContent='"'+d.name+'" \u2014 now click what it REQUIRES';
        } else if (_connectSource.id!==d.id) {
          _roadmapCreateDependency(_connectSource.id,d.id);
        }
        return;
      }
      rNodeGs.select('circle.rmap-circle')
        .attr('stroke-width',n=>n.id===d.id?2.5:1)
        .attr('stroke',n=>STATUS_COLOR[n.status]||'#4a4a48')
        .attr('stroke-opacity',n=>n.id===d.id?1:0.65);
      _roadmapSelectFeature(d.id);
    })
    .on('contextmenu',(event,d)=>{event.preventDefault();event.stopPropagation();_showRoadmapCtxMenu(event,d);})
    .on('mouseenter',(event,d)=>{
      if(_connectMode||_rmapIsolated||_rmapCritActive) return;
      try{_rmapHoverV2(d,rEdges,rNodeGs,simLinks,gMain,nodeR);}
      catch{rNodeGs.classed('dimmed',n=>n.id!==d.id);rEdges.attr('stroke-opacity',l=>{const s=l.source?.id||l.sourceId,t=l.target?.id||l.targetId;return(s===d.id||t===d.id)?0.7:0.04;});}
    })
    .on('mouseleave',()=>{
      if(_connectMode||_rmapIsolated||_rmapCritActive) return;
      try{_rmapUnhoverV2(rEdges,rNodeGs,gMain);}
      catch{rNodeGs.classed('dimmed',false);rEdges.attr('stroke-opacity',0.25);}
    });
  _rNodeGsRef=rNodeGs;

  rNodeGs.call(d3.drag()
    .clickDistance(8)
    .on('start',(e,d)=>{if(!e.active)_roadmapMainSim.alphaTarget(0.3).restart();d.fx=d.x;d.fy=d.y;})
    .on('drag', (e,d)=>{d.fx=e.x;d.fy=e.y;})
    .on('end',  (e,d)=>{
      if(!e.active)_roadmapMainSim.alphaTarget(0);
      _roadmapNodePos.set(d.id,{x:d.x,y:d.y});
      d.fx=null;d.fy=null;
    }));

  rNodeGs.append('circle').attr('class','rmap-glow')
    .attr('r',d=>nodeR(d)+7).attr('fill',d=>STATUS_GLOW[d.status]||'transparent').attr('stroke','none');

  rNodeGs.append('circle').attr('class','rmap-circle')
    .attr('r',nodeR)
    .attr('fill',d=>STATUS_COLOR[d.status]||'#4a4a48').attr('fill-opacity',0.18)
    .attr('stroke',d=>STATUS_COLOR[d.status]||'#4a4a48')
    .attr('stroke-width',1).attr('stroke-opacity',0.65);

  rNodeGs.append('text')
    .attr('text-anchor','middle').attr('dominant-baseline','central')
    .attr('font-size',d=>Math.max(10,nodeR(d)*.9))
    .attr('font-family',"'SF Mono','Fira Code',monospace")
    .attr('fill',d=>STATUS_COLOR[d.status]||'#4a4a48')
    .attr('pointer-events','none').attr('user-select','none')
    .text(d=>STATUS_ICON[d.status]||'\u25cb');

  // Label with paint-order stroke for readability — see CSS injection at top
  rNodeGs.append('text').attr('class','rmap-lbl')
    .attr('text-anchor','middle').attr('dominant-baseline','hanging')
    .attr('y',d=>nodeR(d)+7).attr('font-size',11)
    .attr('font-family',"'SF Mono','Fira Code',monospace")
    .attr('fill','var(--text)')
    .attr('pointer-events','none').attr('user-select','none')
    .text(d=>{const n=d.name||d.id;return n.length>22?n.slice(0,20)+'\u2026':n;});

  _roadmapMainSim=d3.forceSimulation(simNodes)
    .force('link',      d3.forceLink(simLinks).id(d=>d.id).distance(110).strength(0.3))
    .force('charge',    d3.forceManyBody().strength(-200).distanceMax(360))
    .force('x',         d3.forceX(W/2).strength(0.035))
    .force('y',         d3.forceY(d=>60+((depths[d.id]||0)/Math.max(1,maxDepth))*(H-120)).strength(0.5))
    .force('collision', d3.forceCollide(d=>nodeR(d)+46))  // +46 prevents label overlap
    .alphaDecay(0.025)
    .on('tick',()=>{
      rEdges.attr('d',d=>bezierD(d.source.x,d.source.y,d.target.x,d.target.y));
      rEdgeHits.attr('d',d=>bezierD(d.source.x,d.source.y,d.target.x,d.target.y));
      rNodeGs.attr('transform',d=>'translate('+d.x+','+d.y+')');
    })
    .on('end',()=>{
      simNodes.forEach(n=>{if(n.x!==undefined)_roadmapNodePos.set(n.id,{x:n.x,y:n.y});});
      const hadNoCached=simNodes.some(n=>!_roadmapNodePos.has(n.id));
      if (hadNoCached) _rmapFitView(svg,mainZoom,W,H,simNodes);
      _startRmapParticles(simLinks,edgeLayer,particleLayer,STATUS_COLOR);
    });

  // Status legend
  const legend=document.createElement('div');
  legend.style.cssText='position:absolute;bottom:16px;left:16px;z-index:5;background:rgba(6,6,6,.8);border:1px solid var(--border);border-radius:4px;padding:8px 10px;display:flex;flex-direction:column;gap:4px;backdrop-filter:blur(4px);font-size:10px;';
  legend.innerHTML=Object.entries(STATUS_LABEL).map(([s,l])=>
    '<div style="display:flex;align-items:center;gap:6px;"><div style="width:10px;height:10px;border-radius:50%;background:'+STATUS_COLOR[s]+';flex-shrink:0;opacity:.85;"></div><span style="color:'+STATUS_COLOR[s]+';">'+STATUS_ICON[s]+' '+l+'</span></div>'
  ).join('');
  container.appendChild(legend);

  // Keyboard hint
  const hint=document.createElement('div');
  hint.style.cssText='position:absolute;bottom:16px;right:16px;font-size:9px;color:var(--text-faint);font-family:\'SF Mono\',monospace;text-align:right;line-height:1.7;z-index:5;';
  hint.innerHTML='Tab cycle &nbsp;\u00b7&nbsp; H hide &nbsp;\u00b7&nbsp; U show all &nbsp;\u00b7&nbsp; C copy md<br>dbl-click canvas to fit &nbsp;\u00b7&nbsp; right-click for more';
  container.appendChild(hint);

  // Zoom buttons
  const zDiv=document.createElement('div');
  zDiv.style.cssText='position:absolute;bottom:100px;right:16px;display:flex;flex-direction:column;gap:4px;z-index:5;';
  [['+','Zoom in',1.5],['\u229f','Fit (or dbl-click)',null],['\u2212','Zoom out',0.667]].forEach(([l,t,f])=>{
    const b=document.createElement('div');
    b.className='zoom-btn';b.textContent=l;b.title=t;
    b.onclick=f?()=>svg.transition().duration(300).call(mainZoom.scaleBy,f):()=>_rmapFitView(svg,mainZoom,W,H,simNodes);
    zDiv.appendChild(b);
  });
  container.appendChild(zDiv);

  // ResizeObserver
  if (window.ResizeObserver) {
    let lastW=W,debounce=null;
    _roadmapMainObs=new ResizeObserver(()=>{
      const w=container.clientWidth;
      if(Math.abs(w-lastW)<8) return;
      lastW=w;clearTimeout(debounce);
      debounce=setTimeout(()=>{if(_roadmapData)renderRoadmapMainCanvas(_roadmapData.features);},200);
    });
    _roadmapMainObs.observe(container);
  }
}

// ═══ FIT VIEW ═════════════════════════════════════════════════════════════
function _rmapFitView(svg, zoom, W, H, nodes) {
  // Try the inline script's helper first, fall back to our own
  try { _fitRoadmapTree(svg, zoom, W, H, nodes); return; } catch {}
  if (!nodes?.length) return;
  const xs=nodes.map(n=>n.x).filter(x=>x!=null), ys=nodes.map(n=>n.y).filter(y=>y!=null);
  if (!xs.length) return;
  const [mnX,mxX,mnY,mxY]=[Math.min(...xs),Math.max(...xs),Math.min(...ys),Math.max(...ys)];
  const [pw,ph]=[mxX-mnX||100,mxY-mnY||100];
  const scale=Math.min(W*.88/pw, H*.88/ph, 2);
  svg.transition().duration(600).ease(d3.easeCubicInOut)
    .call(zoom.transform, d3.zoomIdentity.translate(W/2-(mnX+pw/2)*scale, H/2-(mnY+ph/2)*scale).scale(scale));
}

// ═══ PARTICLES ════════════════════════════════════════════════════════════
function _startRmapParticles(simLinks, edgeLayer, particleLayer, STATUS_COLOR) {
  const pathEls=edgeLayer.selectAll('path').nodes(), particles=[];
  simLinks.forEach((link,i)=>{
    const pathEl=pathEls[i]; if(!pathEl) return;
    const isActive=link.source.status==='in-progress'||link.target.status==='in-progress';
    const isComplete=link.source.status==='complete'&&link.target.status==='complete';
    const color=STATUS_COLOR[link.source.status]||'#4a4a48';
    const dot=particleLayer.append('circle')
      .attr('r',isActive?2.5:2).attr('fill',color)
      .attr('opacity',isActive?0.7:isComplete?0.45:0.1)
      .attr('pointer-events','none');
    const speed=isActive?0.13+Math.random()*.07:isComplete?0.08+Math.random()*.04:0.04+Math.random()*.03;
    particles.push({dot,pathEl,t:Math.random(),speed});
  });
  let lastTs=null;
  function tick(ts){
    if(!lastTs)lastTs=ts;
    const dt=Math.min((ts-lastTs)/1000,0.05);lastTs=ts;
    particles.forEach(p=>{
      p.t+=p.speed*dt;if(p.t>1)p.t-=1;
      try{const pt=p.pathEl.getPointAtLength(p.t*p.pathEl.getTotalLength());p.dot.attr('cx',pt.x).attr('cy',pt.y);}catch{}
    });
    _roadmapMainRaf=requestAnimationFrame(tick);
  }
  _roadmapMainRaf=requestAnimationFrame(tick);
}

// ═══ LIVE SSE RELOAD ══════════════════════════════════════════════════════
(function initRmapSSE() {
  const base=typeof API_BASE!=='undefined'?API_BASE:'';
  const es=new EventSource(base+'/events');
  es.addEventListener('roadmap-updated',()=>{ if(_inRoadmapMode) loadRoadmapTab(); });
  es.onerror=()=>{ es.close(); setTimeout(initRmapSSE,5000); };
})();