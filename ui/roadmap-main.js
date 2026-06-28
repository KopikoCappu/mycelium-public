/**
 * roadmap-main.js
 *
 * Interactive roadmap canvas built on D3.js + a REST/SSE backend.
 *
 * Architecture
 * ────────────
 *  State          – single source of truth for all mutable values
 *  API            – thin wrappers around fetch (PATCH / POST)
 *  Algorithms     – pure functions: depth, critical-path, prereq-chain
 *  Undo / Redo    – immutable snapshots of feature state
 *  Snapshots      – user-named saves persisted to localStorage
 *  Canvas         – D3 force-simulation, edges, particles
 *  Nodes          – per-node rendering, drag-to-connect, hover
 *  Sidebar        – filter buttons, add-form, toolbar
 *  Detail panel   – selected feature view / inline edit
 *  Spotlight      – ⌘K search modal
 *  Isolation      – supertree / subtree focus modes
 *  Keyboard       – global shortcuts
 *  SSE            – live reload on server events
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// SECTION 1 — GLOBAL STATE
// ─────────────────────────────────────────────────────────────

/**
 * All mutable module-level state lives here so it's easy to find,
 * reset, and reason about. Nothing is scattered across closures.
 */
const State = {
  // D3 objects kept alive across renders
  zoom:          null,   // d3.ZoomBehavior
  sim:           null,   // d3.Simulation
  rafId:         null,   // requestAnimationFrame handle (particles)
  resizeObs:     null,   // ResizeObserver

  // D3 selections reused by event handlers
  nodeGroups:    null,   // d3 selection of node <g> elements
  edges:         null,   // d3 selection of edge <path> elements
  edgeHitAreas:  null,   // d3 selection of invisible wide-hit paths
  svg:           null,   // d3 selection of the root <svg>
  particleLayer: null,   // d3 selection of the particle <g>

  // Simulation data (shared between canvas and event handlers)
  simNodes:      null,   // array – live D3 simulation nodes
  simLinks:      null,   // array – live D3 simulation links
  nodeRadiusFn:  null,   // (d) => number

  // Persisted layout – maps feature id → {x, y}
  nodePositions: new Map(),

  // Drag-to-connect
  dragLine:      null,   // d3 selection of the in-progress edge path
  dragSourceId:  null,

  // Edge tooltip
  edgeTooltip:   null,

  // UI mode flags
  isRoadmapMode:   false,
  isConnectMode:   false,
  isIsolated:      false,
  connectSource:   null,

  // Filter / display
  filter:          'all',
  hideDone:        false,
  hiddenFeatures:  new Set(),

  // Selection
  selectedId:      null,

  // Critical path
  critPathActive:  false,
  critPathIds:     new Set(),

  // Undo / redo
  undoStack:       [],
  redoStack:       [],

  // Pending node position from right-click "add here"
  pendingNewNodePos: null,

  // Chip HTML saved from graph tab (restored on tab leave)
  savedChipHTML:   null,
};

// Restore persisted values
try {
  State.hiddenFeatures = new Set(
    JSON.parse(localStorage.getItem('mycelium-hidden-features') || '[]')
  );
} catch {}

try {
  State.hideDone = !!JSON.parse(
    localStorage.getItem('mycelium-rmap-hide-done') || 'false'
  );
} catch {}

// ─────────────────────────────────────────────────────────────
// SECTION 2 — CONSTANTS
// ─────────────────────────────────────────────────────────────

/** Visual style by feature status. */
const STATUS_STYLE = {
  complete:    { fill: '#7ECBA1',  glow: 'rgba(126,203,161,.2)',    icon: '✓',  label: 'Complete'  },
  'in-progress':{ fill: '#ff8c42', glow: 'rgba(255,140,66,.25)',    icon: '◐',  label: 'Active'    },
  planned:     { fill: '#4a4a48',  glow: 'rgba(74,74,72,.1)',       icon: '○',  label: 'Planned'   },
  blocked:     { fill: '#e0524a',  glow: 'rgba(224,82,74,.2)',      icon: '✕',  label: 'Blocked'   },
  backlog:     { fill: '#3a3836',  glow: 'transparent',             icon: '·',  label: 'Backlog'   },
};

const FILTER_LABELS = {
  all:     'Show all features',
  active:  'Active: currently being worked on',
  done:    'Done: completed',
  planned: 'Planned: not yet started',
  blocked: 'Blocked: waiting on something external',
  ready:   '⚡ Ready: all dependencies complete — nothing blocking this',
};

const MAX_UNDO_STEPS = 20;
const SNAPSHOT_STORAGE_KEY = 'mycelium-roadmap-snapshots';

// ─────────────────────────────────────────────────────────────
// SECTION 3 — UTILITY HELPERS
// ─────────────────────────────────────────────────────────────

/** Return the API base URL (falls back to '' for same-origin). */
function apiBase() {
  return typeof API_BASE !== 'undefined' ? API_BASE : '';
}

/**
 * Escape a value for safe embedding inside a JS string literal
 * in an HTML attribute (e.g. onclick="fn('HERE')").
 */
function escapeJsString(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

/** Convert a human name into a URL/id-safe slug. */
function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'f-' + Date.now();
}

/**
 * Show a brief toast message on the roadmap canvas.
 * @param {string} message
 * @param {number} [duration=2000] ms before auto-dismiss
 */
function showToast(message, duration = 2000) {
  const canvas = document.getElementById('roadmap-canvas');
  if (!canvas) return;

  canvas.querySelectorAll('.rmap-toast').forEach(t => t.remove());

  const toast = document.createElement('div');
  toast.className = 'rmap-toast';
  Object.assign(toast.style, {
    position:    'absolute',
    bottom:      '84px',
    left:        '50%',
    transform:   'translateX(-50%)',
    background:  'rgba(6,6,6,.94)',
    border:      '1px solid var(--border)',
    borderRadius:'4px',
    padding:     '6px 14px',
    fontFamily:  "'SF Mono',monospace",
    fontSize:    '11px',
    color:       'var(--thread-bright)',
    zIndex:      '100',
    pointerEvents:'none',
    whiteSpace:  'nowrap',
  });
  toast.textContent = message;
  canvas.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

/**
 * Convert a DOM mouse/pointer event into SVG-space coordinates,
 * respecting the current pan/zoom transform.
 */
function clientToSvgCoords(event) {
  const svgEl = State.svg?.node();
  if (!svgEl) return [0, 0];
  const rect = svgEl.getBoundingClientRect();
  return d3.zoomTransform(svgEl).invert([
    event.clientX - rect.left,
    event.clientY - rect.top,
  ]);
}

/**
 * Cubic bezier path string between two SVG points.
 * Used for all dependency edges.
 */
function bezierPath(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return (
    `M ${x1} ${y1} ` +
    `C ${x1 + dx * 0.12} ${y1 + dy * 0.48},` +
    `  ${x2 - dx * 0.12} ${y2 - dy * 0.48},` +
    `  ${x2} ${y2}`
  );
}

/**
 * Return true if a feature matches the search query string.
 * Checks name, description, tags, and id.
 */
function featureMatchesQuery(feature, query) {
  const q = query.toLowerCase();
  return (
    (feature.name        || '').toLowerCase().includes(q) ||
    (feature.description || '').toLowerCase().includes(q) ||
    (feature.tags        || []).some(t => t.toLowerCase().includes(q)) ||
    (feature.id          || '').toLowerCase().includes(q)
  );
}

// ─────────────────────────────────────────────────────────────
// SECTION 4 — CSS INJECTION
// ─────────────────────────────────────────────────────────────

/**
 * Inject the handful of CSS rules that can't live in a stylesheet
 * because they reference dynamic class toggles or need !important.
 * Idempotent – only runs once.
 */
function injectGlobalStyles() {
  if (document.getElementById('rmap-injected-css')) return;

  const rules = [
    '.rmap-node.dimmed { opacity: .1; transition: opacity .2s }',
    '.rmap-node.highlighted .rmap-circle { stroke-width: 2.5 !important }',
    '.rmap-node.crit-path .rmap-circle { stroke: #EF9F27 !important; stroke-width: 2.5 !important; stroke-opacity: 1 !important }',
    '.rmap-node.crit-path .rmap-glow   { fill: rgba(239,159,39,.28) !important }',
    '.rmap-lbl { paint-order: stroke; stroke: rgba(6,6,6,.88); stroke-width: 3px; stroke-linejoin: round }',
    '.rmap-conn-handle { pointer-events: all }',
    '.rmap-edge-tooltip { position:fixed; background:rgba(6,6,6,.92); border:1px solid #e0524a; border-radius:3px; padding:3px 8px; font-family:"SF Mono",monospace; font-size:10px; color:#e0524a; pointer-events:none; z-index:500; white-space:nowrap }',
    '#rmap-spot-overlay * { box-sizing: border-box }',
  ];

  const style = document.createElement('style');
  style.id = 'rmap-injected-css';
  style.textContent = rules.join(' ');
  document.head.appendChild(style);
}

injectGlobalStyles();

// ─────────────────────────────────────────────────────────────
// SECTION 5 — API LAYER
// ─────────────────────────────────────────────────────────────

/**
 * PATCH a single feature on the server.
 * Also updates the in-memory _roadmapData.features array on success.
 *
 * @param {string} featureId
 * @param {object} updates  – partial feature fields to update
 * @returns {Promise<object>} the updated feature from the server
 */
async function apiPatchFeature(featureId, updates) {
  const res = await fetch(
    `${apiBase()}/roadmap/feature/${encodeURIComponent(featureId)}`,
    {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(updates),
    }
  );
  if (!res.ok) throw new Error(`PATCH failed: ${res.status}`);

  const data = await res.json();
  if (_roadmapData?.features && data.feature) {
    const idx = _roadmapData.features.findIndex(f => f.id === featureId);
    if (idx >= 0) _roadmapData.features[idx] = data.feature;
  }
  return data.feature;
}

/**
 * POST (create or upsert) a feature on the server.
 * Also updates _roadmapData.features.
 *
 * @param {object} featureData – full feature object
 * @returns {Promise<object>} the saved feature
 */
async function apiPostFeature(featureData) {
  const res = await fetch(`${apiBase()}/roadmap/feature`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(featureData),
  });
  if (!res.ok) throw new Error(`POST failed: ${res.status}`);

  const data = await res.json();
  if (_roadmapData?.features && data.feature) {
    const idx = _roadmapData.features.findIndex(f => f.id === data.feature.id);
    if (idx >= 0) _roadmapData.features[idx] = data.feature;
    else _roadmapData.features.push(data.feature);
  }
  return data.feature;
}

// ─────────────────────────────────────────────────────────────
// SECTION 6 — GRAPH ALGORITHMS  (pure functions)
// ─────────────────────────────────────────────────────────────

/**
 * Compute the topological "tier" (depth) of every feature,
 * where tier 0 = no dependencies, tier N = deepest chain.
 *
 * @param {object[]} features
 * @returns {Record<string, number>} map of feature.id → depth
 */
function computeFeatureDepths(features) {
  const depths = Object.fromEntries(features.map(f => [f.id, 0]));
  const featureIds = new Set(features.map(f => f.id));

  // Iterative Bellman-Ford style relaxation (handles cycles gracefully)
  let changed = true;
  let iterations = 0;
  while (changed && iterations++ < 500) {
    changed = false;
    features.forEach(feature => {
      (feature.dependsOn || [])
        .filter(depId => featureIds.has(depId))
        .forEach(depId => {
          const candidate = (depths[depId] || 0) + 1;
          if (candidate > (depths[feature.id] || 0)) {
            depths[feature.id] = candidate;
            changed = true;
          }
        });
    });
  }
  return depths;
}

/**
 * Find the critical path: the longest chain of *incomplete* features.
 * This is the sequence that, if shortened, speeds up the whole roadmap.
 *
 * Returns a Set of feature ids on the critical path.
 *
 * @param {object[]} features
 * @returns {Set<string>}
 */
function computeCriticalPath(features) {
  const incomplete   = features.filter(f => f.status !== 'complete');
  const incompleteIds = new Set(incomplete.map(f => f.id));

  // Build adjacency: feature.id → [dependency ids that are also incomplete]
  const deps = new Map(
    incomplete.map(f => [
      f.id,
      (f.dependsOn || []).filter(d => incompleteIds.has(d)),
    ])
  );

  // Topological sort via DFS
  const visited = new Set();
  const topo    = [];
  function dfs(id) {
    if (visited.has(id)) return;
    visited.add(id);
    (deps.get(id) || []).forEach(dfs);
    topo.push(id);
  }
  incomplete.forEach(f => dfs(f.id));

  // Longest-path DP over the topo order
  const dist   = new Map(incomplete.map(f => [f.id, 1]));
  const parent = new Map();

  for (const id of topo) {
    for (const depId of (deps.get(id) || [])) {
      const candidate = (dist.get(depId) || 0) + 1;
      if (candidate > (dist.get(id) || 0)) {
        dist.set(id, candidate);
        parent.set(id, depId);
      }
    }
  }

  // Walk back from the node with the longest distance
  let maxId   = null;
  let maxDist = 0;
  for (const [id, d] of dist) {
    if (d > maxDist) { maxDist = d; maxId = id; }
  }

  const pathIds = new Set();
  let cur = maxId;
  while (cur) { pathIds.add(cur); cur = parent.get(cur); }

  return pathIds;
}

/**
 * Return all *incomplete* transitive prerequisites of a feature
 * (everything it depends on, recursively).
 *
 * @param {string} featureId
 * @returns {object[]} array of feature objects
 */
function getPrerequisiteChain(featureId) {
  const features = _roadmapData?.features || [];
  const result   = [];
  const visited  = new Set();

  function collect(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const feature = features.find(f => f.id === id);
    if (!feature) return;

    (feature.dependsOn || []).forEach(depId => {
      const dep = features.find(f => f.id === depId);
      if (dep && dep.status !== 'complete') {
        result.push(dep);
        collect(depId);
      }
    });
  }

  collect(featureId);
  return result;
}

/**
 * Count how many features are blocked (directly or transitively)
 * by the given feature — its "blocker rank".
 *
 * @param {string} featureId
 * @returns {number}
 */
function getBlockerRank(featureId) {
  const features  = _roadmapData?.features || [];

  // Build reverse adjacency: dep → [features that depend on dep]
  const reverseDeps = new Map(features.map(f => [f.id, []]));
  features.forEach(f => {
    (f.dependsOn || []).forEach(depId => {
      reverseDeps.get(depId)?.push(f.id);
    });
  });

  // BFS to count reachable descendants
  const reachable = new Set();
  const queue     = [featureId];
  while (queue.length) {
    const id = queue.shift();
    (reverseDeps.get(id) || []).forEach(descendantId => {
      if (!reachable.has(descendantId)) {
        reachable.add(descendantId);
        queue.push(descendantId);
      }
    });
  }
  return reachable.size;
}

// ─────────────────────────────────────────────────────────────
// SECTION 7 — UNDO / REDO
// ─────────────────────────────────────────────────────────────

/** Serialize the current state into a snapshot string. */
function captureStateSnapshot() {
  if (!_roadmapData) return null;
  return JSON.stringify({
    features: JSON.parse(JSON.stringify(_roadmapData.features)),
    hidden:   [...State.hiddenFeatures],
  });
}

/** Push the current state onto the undo stack (and clear redo). */
function pushUndoSnapshot() {
  const snapshot = captureStateSnapshot();
  if (!snapshot) return;

  State.undoStack.push(snapshot);
  if (State.undoStack.length > MAX_UNDO_STEPS) State.undoStack.shift();
  State.redoStack = [];
  refreshUndoButtons();
}

/**
 * Restore the roadmap to a previously captured snapshot,
 * persisting each feature back to the server.
 */
async function applySnapshot(snapshotString) {
  const state = JSON.parse(snapshotString);
  _roadmapData.features  = state.features;
  State.hiddenFeatures   = new Set(state.hidden || []);

  try {
    localStorage.setItem('mycelium-hidden-features',
      JSON.stringify(state.hidden || []));
  } catch {}

  refreshHiddenCountBadge();
  renderRoadmapCanvas(_roadmapData.features);

  // Sync each feature to the server (best-effort)
  await Promise.all(
    state.features.map(f =>
      apiPatchFeature(f.id, f).catch(() => {})
    )
  ).catch(() => {});
}

async function undo() {
  if (!State.undoStack.length) { showToast('Nothing to undo'); return; }
  const current = captureStateSnapshot();
  if (current) State.redoStack.push(current);
  await applySnapshot(State.undoStack.pop());
  showToast(`↩ Undone — ${State.undoStack.length} more`);
  refreshUndoButtons();
}

async function redo() {
  if (!State.redoStack.length) { showToast('Nothing to redo'); return; }
  const current = captureStateSnapshot();
  if (current) State.undoStack.push(current);
  await applySnapshot(State.redoStack.pop());
  showToast('↪ Redone');
  refreshUndoButtons();
}

/** Sync the disabled state and title of undo/redo toolbar buttons. */
function refreshUndoButtons() {
  const undoBtn = document.getElementById('rmap-undo-btn');
  const redoBtn = document.getElementById('rmap-redo-btn');

  if (undoBtn) {
    undoBtn.disabled     = !State.undoStack.length;
    undoBtn.style.opacity = State.undoStack.length ? 1 : 0.4;
    undoBtn.title        = `Undo (Ctrl+Z) — ${State.undoStack.length} available`;
  }
  if (redoBtn) {
    redoBtn.disabled     = !State.redoStack.length;
    redoBtn.style.opacity = State.redoStack.length ? 1 : 0.4;
    redoBtn.title        = `Redo (Ctrl+Y) — ${State.redoStack.length} available`;
  }
}

// ─────────────────────────────────────────────────────────────
// SECTION 8 — USER-NAMED SNAPSHOTS (localStorage)
// ─────────────────────────────────────────────────────────────

function loadSnapshots() {
  try { return JSON.parse(localStorage.getItem(SNAPSHOT_STORAGE_KEY) || '[]'); }
  catch { return []; }
}

function persistSnapshots(snapshots) {
  try { localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshots)); }
  catch (e) {
    // If storage is full, drop the oldest snapshot and retry
    if (e.name === 'QuotaExceededError') {
      snapshots.pop();
      try { localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshots)); }
      catch {}
    }
  }
}

function saveSnapshot(name) {
  if (!_roadmapData) return;

  const label = (name || '').trim() ||
    'Snapshot ' + new Date().toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });

  const snapshots = loadSnapshots();
  snapshots.unshift({
    id:            'snap-' + Date.now(),
    name:          label,
    timestamp:     Date.now(),
    featureCount:  _roadmapData.features.length,
    completeCount: _roadmapData.features.filter(f => f.status === 'complete').length,
    features:      JSON.parse(JSON.stringify(_roadmapData.features)),
  });
  if (snapshots.length > 10) snapshots.length = 10;

  persistSnapshots(snapshots);

  const nameInput = document.getElementById('rmap-snap-name-inp');
  if (nameInput) nameInput.value = '';

  renderSnapshotList();
  showToast(`📸 Snapshot saved: ${label}`);
}

async function restoreSnapshot(snapshotId) {
  const snapshots = loadSnapshots();
  const snap      = snapshots.find(s => s.id === snapshotId);
  if (!snap) return;

  if (!confirm(`Restore "${snap.name}"?\n\nThis replaces your current roadmap. You can undo with Ctrl+Z.`)) return;

  pushUndoSnapshot();
  _roadmapData.features = JSON.parse(JSON.stringify(snap.features));

  renderSnapshotList();
  renderRoadmapCanvas(_roadmapData.features);
  showToast(`↩ Restored: ${snap.name}`);

  // Best-effort server sync
  await Promise.all(
    snap.features.map(f =>
      apiPostFeature(f).catch(() => {})
    )
  ).catch(() => {});
}

function deleteSnapshot(snapshotId) {
  const filtered = loadSnapshots().filter(s => s.id !== snapshotId);
  persistSnapshots(filtered);
  renderSnapshotList();
}

/** Re-render the snapshot list in the sidebar. */
function renderSnapshotList() {
  const list  = document.getElementById('rmap-snap-list');
  const badge = document.getElementById('rmap-snap-badge');
  if (!list) return;

  const snapshots = loadSnapshots();
  if (badge) badge.textContent = snapshots.length ? `${snapshots.length} saved` : '';

  if (!snapshots.length) {
    list.innerHTML = '<div style="font-size:10px;color:var(--text-faint);padding:6px 2px;text-align:center;">No snapshots yet</div>';
    return;
  }

  list.innerHTML = snapshots.map(snap => {
    const date  = new Date(snap.timestamp).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const sid = escapeJsString(snap.id);
    return `
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:3px;padding:7px 9px;margin-bottom:4px;">
        <div style="display:flex;align-items:center;gap:5px;margin-bottom:3px;">
          <span style="flex:1;font-size:11px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
                title="${snap.name}">${snap.name}</span>
          <button onclick="restoreSnapshot('${sid}')"
                  style="background:none;border:1px solid var(--border);color:var(--thread-bright);cursor:pointer;font-family:inherit;font-size:10px;padding:2px 6px;border-radius:2px;flex-shrink:0;">
            Restore
          </button>
          <button onclick="deleteSnapshot('${sid}')"
                  style="background:none;border:none;color:var(--text-faint);cursor:pointer;font-size:12px;padding:0 2px;line-height:1;flex-shrink:0;"
                  onmouseover="this.style.color='#e0524a'" onmouseout="this.style.color='var(--text-faint)'">
            &#x2715;
          </button>
        </div>
        <div style="font-size:10px;color:var(--text-faint);">
          ${date} &middot; ${snap.featureCount || 0} features &middot; ${snap.completeCount || 0} done
        </div>
      </div>
    `;
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// SECTION 9 — FEATURE FILTERING
// ─────────────────────────────────────────────────────────────

/**
 * Return the subset of features visible under the current filter,
 * hidden-feature exclusions, and hide-done toggle.
 *
 * @param {object[]} allFeatures
 * @returns {object[]}
 */
function applyFilter(allFeatures) {
  const filter = State.filter;

  return allFeatures.filter(feature => {
    // Always exclude user-hidden features
    if (State.hiddenFeatures.has(feature.id)) return false;

    // Optionally exclude completed features
    if (State.hideDone && feature.status === 'complete') return false;

    switch (filter) {
      case 'all':     return true;
      case 'done':    return feature.status === 'complete';
      case 'active':  return feature.status === 'in-progress';
      case 'planned': return feature.status === 'planned' || feature.status === 'backlog';
      case 'blocked': return feature.status === 'blocked';
      case 'ready': {
        // Ready = incomplete and every dependency is complete
        if (feature.status === 'complete') return false;
        return (feature.dependsOn || []).every(depId => {
          const dep = allFeatures.find(f => f.id === depId);
          return !dep || dep.status === 'complete';
        });
      }
      default:
        // Tag filter, e.g. 'tag:backend'
        if (filter.startsWith('tag:')) {
          return (feature.tags || []).includes(filter.slice(4));
        }
        return true;
    }
  });
}

// ─────────────────────────────────────────────────────────────
// SECTION 10 — DEPENDENCY MANAGEMENT
// ─────────────────────────────────────────────────────────────

/** Add a dependency edge: dependentId now depends on dependencyId. */
async function addDependency(dependentId, dependencyId) {
  const feature = _roadmapData?.features.find(f => f.id === dependentId);
  if (!feature) return;
  if ((feature.dependsOn || []).includes(dependencyId)) return; // already exists

  pushUndoSnapshot();
  const newDeps = [...(feature.dependsOn || []), dependencyId];

  try {
    await apiPatchFeature(dependentId, { dependsOn: newDeps });
    const f = _roadmapData.features.find(x => x.id === dependentId);
    if (f) f.dependsOn = newDeps;
    renderRoadmapCanvas(_roadmapData.features);
    showToast('⟶ Dependency created');
  } catch (err) {
    console.error('addDependency failed', err);
  }
}

/** Remove a dependency edge: dependentId no longer depends on dependencyId. */
async function removeDependency(dependentId, dependencyId) {
  const feature = _roadmapData?.features.find(f => f.id === dependentId);
  if (!feature) return;

  pushUndoSnapshot();
  const newDeps = (feature.dependsOn || []).filter(d => d !== dependencyId);

  try {
    await apiPatchFeature(dependentId, { dependsOn: newDeps });
    const f = _roadmapData.features.find(x => x.id === dependentId);
    if (f) f.dependsOn = newDeps;
    renderRoadmapCanvas(_roadmapData.features);
    showToast('✕ Dependency removed');
  } catch (err) {
    console.error('removeDependency failed', err);
  }
}

// ─────────────────────────────────────────────────────────────
// SECTION 11 — TAB SWITCHING & ROADMAP MODE
// ─────────────────────────────────────────────────────────────

window.switchTab = function (tabName) {
  ['graph', 'history', 'help', 'roadmap'].forEach(name => {
    document.getElementById(`tab-content-${name}`).style.display =
      name === tabName ? 'flex' : 'none';
    const btn = document.getElementById(`tab-${name}`);
    if (btn) btn.classList.toggle('active', name === tabName);
  });

  const graphSvg = document.getElementById('graph-svg');
  const canvas   = document.getElementById('roadmap-canvas');

  if (tabName === 'roadmap') {
    State.isRoadmapMode = true;
    if (graphSvg) graphSvg.style.display = 'none';
    if (canvas)   canvas.style.display   = 'block';
    injectSidebarControls();
    loadRoadmapTab();
    hookRoadmapSearch(true);
  } else {
    State.isRoadmapMode = false;
    if (graphSvg) graphSvg.style.display = '';
    if (canvas)   canvas.style.display   = 'none';
    stopCanvas();
    leaveRoadmapMode();
    hookRoadmapSearch(false);
    if (State.isConnectMode) cancelConnectMode();
    if (State.critPathActive) clearCriticalPath();
    removeEdgeTooltip();
    closeSpotlight();
  }

  if (tabName === 'history') loadHistory();
};

/** Load roadmap data from the server and render the canvas. */
window.loadRoadmapTab = async function () {
  const statsEl = document.getElementById('roadmap-stats');
  if (statsEl) statsEl.innerHTML = '<span style="color:var(--text-faint);font-size:10px;">Loading…</span>';

  const oldList = document.getElementById('roadmap-list');
  if (oldList) oldList.style.display = 'none';

  try {
    const res  = await fetch(`${apiBase()}/roadmap`);
    const data = await res.json();
    _roadmapData = data;

    const s = data.stats || {};
    if (statsEl) {
      statsEl.innerHTML = [
        `<span class="roadmap-status-done">${s.complete || 0} done</span>`,
        `<span class="roadmap-status-active">${s.inProgress || 0} active</span>`,
        `<span class="roadmap-status-plan">${s.planned || 0} planned</span>`,
        s.blocked ? `<span class="roadmap-status-block">${s.blocked} blocked</span>` : '',
      ].join('\u00a0\u00a0');
    }

    enterRoadmapMode(data.features || []);
    renderRoadmapCanvas(data.features || []);
  } catch {
    const panel = document.getElementById('roadmap-feature-detail');
    if (panel) {
      panel.innerHTML = '<div style="padding:14px;font-size:11px;color:var(--text-dim)">Could not load roadmap. Is the server running?</div>';
    }
  }
};

/** Replace the graph-tab stat chips with roadmap summary counts. */
function enterRoadmapMode(features) {
  const chips = [...document.querySelectorAll('.stats-chip')];
  State.savedChipHTML = chips.map(c => c.innerHTML);

  const total    = features.length;
  const complete = features.filter(f => f.status === 'complete').length;
  const active   = features.filter(f => f.status === 'in-progress').length;
  const deps     = features.reduce((n, f) => n + (f.dependsOn || []).length, 0);

  if (chips[0]) chips[0].innerHTML = `<strong>${total}</strong> features`;
  if (chips[1]) chips[1].innerHTML = `<strong>${deps}</strong> deps`;
  if (chips[2]) chips[2].innerHTML = `<strong style="color:#7ECBA1">${complete}</strong> done`;
  if (chips[3]) chips[3].innerHTML = `<strong style="color:#ff8c42">${active}</strong> active`;
}

/** Restore the graph-tab stat chips from the saved HTML. */
function leaveRoadmapMode() {
  const chips = [...document.querySelectorAll('.stats-chip')];
  if (State.savedChipHTML) {
    State.savedChipHTML.forEach((html, i) => {
      if (chips[i]) chips[i].innerHTML = html;
    });
  }

  // Restore graph stats if they're still in scope
  const el = id => document.getElementById(id);
  if (el('stat-nodes') && typeof visNodes  !== 'undefined') el('stat-nodes').textContent = visNodes.filter(n => n.kind === 'file').length || '–';
  if (el('stat-edges') && typeof visLinks  !== 'undefined') el('stat-edges').textContent = visLinks.length || '–';
  if (el('stat-fns')   && typeof allNodes  !== 'undefined') el('stat-fns').textContent   = allNodes.filter(n => n.kind === 'function').length || '–';
  if (el('stat-lines') && typeof allNodes  !== 'undefined') {
    const lines = allNodes.filter(n => n.kind === 'file')
      .reduce((s, n) => s + (n.lineCount ?? n.lines ?? n.loc ?? n.linesOfCode ?? 0), 0);
    el('stat-lines').textContent = lines > 0 ? lines.toLocaleString() : '–';
  }
}

// ─────────────────────────────────────────────────────────────
// SECTION 12 — FILTER TOOLBAR
// ─────────────────────────────────────────────────────────────

window.setRoadmapFilter = function (filter) {
  State.filter = filter;
  document.querySelectorAll('.roadmap-filter-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.filter === filter)
  );
  if (_roadmapData) renderRoadmapCanvas(_roadmapData.features);
};

// ─────────────────────────────────────────────────────────────
// SECTION 13 — SEARCH HOOK (task input doubles as feature search)
// ─────────────────────────────────────────────────────────────

let _searchHandler = null;

function hookRoadmapSearch(enable) {
  const input = document.getElementById('task-input');
  if (!input) return;

  if (_searchHandler) {
    input.removeEventListener('input', _searchHandler);
    _searchHandler = null;
    input.placeholder = 'Describe your task to find relevant files…';
    input.value = '';
    if (State.nodeGroups) State.nodeGroups.classed('highlighted dimmed', false);
  }

  if (!enable) return;

  input.placeholder = 'Search features… or press ⌘K for spotlight';
  _searchHandler = function () {
    if (!State.nodeGroups) return;
    const query = this.value.toLowerCase().trim();
    if (!query) {
      State.nodeGroups.classed('highlighted dimmed', false);
      return;
    }
    State.nodeGroups
      .classed('highlighted', d =>  featureMatchesQuery(d, query))
      .classed('dimmed',      d => !featureMatchesQuery(d, query));
  };
  input.addEventListener('input', _searchHandler);
}

// ─────────────────────────────────────────────────────────────
// SECTION 14 — CANVAS LIFECYCLE
// ─────────────────────────────────────────────────────────────

/** Tear down the D3 simulation and all canvas references. */
function stopCanvas() {
  if (State.rafId)  { cancelAnimationFrame(State.rafId); State.rafId = null; }
  if (State.sim)    { State.sim.stop(); State.sim = null; }
  if (State.resizeObs) { State.resizeObs.disconnect(); State.resizeObs = null; }

  State.zoom          = null;
  State.nodeGroups    = null;
  State.edges         = null;
  State.edgeHitAreas  = null;
  State.svg           = null;
  State.nodeRadiusFn  = null;
  State.simLinks      = null;
  State.particleLayer = null;
  State.simNodes      = null;

  if (State.dragLine) { State.dragLine.remove(); State.dragLine = null; }
  State.dragSourceId = null;
}

// ─────────────────────────────────────────────────────────────
// SECTION 15 — MAIN CANVAS RENDER
// ─────────────────────────────────────────────────────────────

/**
 * Full render of the roadmap canvas.
 * Tears down any existing simulation, re-filters the data,
 * and builds a new D3 force graph from scratch.
 *
 * @param {object[]} allFeatures – unfiltered features from _roadmapData
 */
function renderRoadmapCanvas(allFeatures) {
  // Save current node positions before stopping the simulation
  if (State.simNodes) {
    State.simNodes.forEach(n => {
      if (n.x !== undefined && n.y !== undefined) {
        State.nodePositions.set(n.id, { x: n.x, y: n.y });
      }
    });
  }

  stopCanvas();
  injectSidebarControls();

  const container = document.getElementById('roadmap-canvas');
  if (!container || !window.d3) return;

  const features  = applyFilter(allFeatures);
  container.innerHTML = '';

  if (!features.length) {
    container.innerHTML = `
      <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:var(--text-dim);font-size:12px;text-align:center;line-height:1.9;">
        No features in this view.<br>
        <span style="font-size:10px;opacity:.6">Try a different filter, or right-click to add one</span>
      </div>`;
    return;
  }

  const W = container.clientWidth  || 800;
  const H = container.clientHeight || 600;

  // ── Layout pre-computation ────────────────────────────────
  const featureIds = new Set(features.map(f => f.id));
  const depths     = computeFeatureDepths(features);
  const maxDepth   = Math.max(0, ...Object.values(depths));

  // In-degree used to scale node radius (more dependents = bigger circle)
  const inDegree = Object.fromEntries(features.map(f => [f.id, 0]));
  features.forEach(f => {
    (f.dependsOn || []).forEach(depId => {
      if (inDegree[depId] !== undefined) inDegree[depId]++;
    });
  });

  const nodeRadius = d => 13 + Math.min(11, (inDegree[d.id] || 0) * 3);
  State.nodeRadiusFn = nodeRadius;

  // ── Build simulation data ─────────────────────────────────
  const simNodes = features.map(f => {
    const saved = State.nodePositions.get(f.id);
    return {
      ...f,
      x: saved?.x ?? (W / 2 + (Math.random() - 0.5) * 120),
      y: saved?.y ?? (60 + ((depths[f.id] || 0) / Math.max(1, maxDepth)) * (H - 120)),
    };
  });
  State.simNodes = simNodes;

  const nodeById  = new Map(simNodes.map(n => [n.id, n]));
  const linkDefs  = [];
  features.forEach(f => {
    (f.dependsOn || []).forEach(depId => {
      if (featureIds.has(depId)) linkDefs.push({ source: depId, target: f.id });
    });
  });

  const simLinks = linkDefs
    .map(l => ({
      source:   nodeById.get(l.source),
      target:   nodeById.get(l.target),
      sourceId: l.source,
      targetId: l.target,
    }))
    .filter(l => l.source && l.target);
  State.simLinks = simLinks;

  // ── SVG scaffold ──────────────────────────────────────────
  const svg    = d3.select(container).append('svg').attr('width', '100%').attr('height', '100%').style('display', 'block');
  const gMain  = svg.append('g').attr('class', 'rmap-main');
  State.svg = svg;

  // Layers (back → front)
  const tierLayer     = gMain.append('g');  // background depth guides
  const edgeLayer     = gMain.append('g');  // dependency paths
  const hitLayer      = gMain.append('g');  // invisible wide hit areas for edges
  const particleLayer = gMain.append('g');  // animated flow particles
  const nodeLayer     = gMain.append('g');  // node groups
  const dragLineLayer = gMain.append('g');  // live edge during drag-to-connect
  State.particleLayer = particleLayer;

  // ── Zoom & pan ────────────────────────────────────────────
  const zoom = d3.zoom()
    .scaleExtent([0.04, 10])
    .filter(e => e.type !== 'dblclick')
    .on('zoom', ({ transform }) => {
      gMain.attr('transform', transform);
      // Fade labels when zoomed far out
      const k = transform.k;
      gMain.selectAll('.rmap-lbl').style('opacity',
        k < 0.3 ? 0 : k < 0.55 ? (k - 0.3) / 0.25 : 1
      );
    });

  svg.call(zoom);
  State.zoom = zoom;

  // Double-click blank canvas → fit view
  svg.on('dblclick', () => fitView(svg, zoom, W, H, simNodes));

  // Click blank canvas → clear selection highlight
  svg.on('click', () => {
    if (State.isConnectMode) return;
    if (State.nodeGroups) {
      State.nodeGroups.select('circle.rmap-circle')
        .attr('stroke-width', 1)
        .attr('stroke-opacity', 0.65);
    }
  });

  // Right-click blank canvas → context menu
  svg.on('contextmenu', function (event) {
    if (event.target.closest?.('.rmap-node')) return;
    event.preventDefault();
    event.stopPropagation();
    const [svgX, svgY] = clientToSvgCoords(event);
    showCanvasContextMenu(event, svgX, svgY, W, H, simNodes);
  });

  // ── Tier depth guides ─────────────────────────────────────
  if (maxDepth > 0) {
    for (let depth = 0; depth <= maxDepth; depth++) {
      const y = 60 + (depth / maxDepth) * (H - 120);
      tierLayer.append('line')
        .attr('x1', -5000).attr('y1', y).attr('x2', 5000).attr('y2', y)
        .attr('stroke', 'rgba(255,255,255,.025)')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '3,8');
      tierLayer.append('text')
        .attr('x', -55).attr('y', y + 10)
        .attr('font-size', 8).attr('font-family', "'SF Mono','Fira Code',monospace")
        .attr('fill', 'rgba(255,255,255,.06)').attr('text-anchor', 'end')
        .text(`tier ${depth}`);
    }
  }

  // ── Edges ─────────────────────────────────────────────────
  const edges = edgeLayer.selectAll('path')
    .data(simLinks).join('path')
    .attr('fill', 'none')
    .attr('stroke', d => STATUS_STYLE[d.source.status]?.fill || '#4a4a48')
    .attr('stroke-width', 1.4)
    .attr('stroke-opacity', 0.25);
  State.edges = edges;

  // Invisible wide paths for easy hover/click on edges
  const edgeHitAreas = hitLayer.selectAll('path')
    .data(simLinks).join('path')
    .attr('fill', 'none')
    .attr('stroke', 'transparent')
    .attr('stroke-width', 16)
    .style('cursor', 'pointer');
  State.edgeHitAreas = edgeHitAreas;

  attachEdgeHoverAndClick(edgeHitAreas, edges);

  // ── Nodes ─────────────────────────────────────────────────
  const nodeGroups = nodeLayer.selectAll('g')
    .data(simNodes).join('g')
    .attr('class', d => 'rmap-node' + (d.status === 'in-progress' ? ' rmap-node-active' : ''))
    .style('cursor', 'pointer');
  State.nodeGroups = nodeGroups;

  attachNodeInteractions(nodeGroups, edges, dragLineLayer);

  nodeGroups.call(buildNodeDragBehavior());

  buildNodeVisuals(nodeGroups, nodeRadius);

  // ── Force simulation ──────────────────────────────────────
  // If all positions are cached, lock them immediately (no animation)
  const allPositionsCached = simNodes.length > 0 && simNodes.every(n => {
    const p = State.nodePositions.get(n.id);
    return p && !isNaN(p.x) && !isNaN(p.y);
  });

  if (allPositionsCached) {
    simNodes.forEach(n => { n.fx = n.x; n.fy = n.y; });
  }

  const sim = d3.forceSimulation(simNodes)
    .alpha(allPositionsCached ? 0.001 : 0.8)
    .alphaDecay(allPositionsCached ? 0.1 : 0.025)
    .velocityDecay(allPositionsCached ? 0.8 : 0.4)
    .force('link',      d3.forceLink(simLinks).id(d => d.id).distance(110).strength(0.3))
    .force('charge',    d3.forceManyBody().strength(-200).distanceMax(360))
    .force('x',         d3.forceX(W / 2).strength(0.035))
    .force('y',         d3.forceY(d => 60 + ((depths[d.id] || 0) / Math.max(1, maxDepth)) * (H - 120)).strength(0.5))
    .force('collision', d3.forceCollide(d => nodeRadius(d) + 40).strength(0.4))
    .on('tick', () => {
      edges.attr('d', d => bezierPath(d.source.x, d.source.y, d.target.x, d.target.y));
      edgeHitAreas.attr('d', d => bezierPath(d.source.x, d.source.y, d.target.x, d.target.y));
      nodeGroups.attr('transform', d => `translate(${d.x},${d.y})`);
    })
    .on('end', () => {
      // Persist final positions
      simNodes.forEach(n => {
        if (n.x !== undefined) State.nodePositions.set(n.id, { x: n.x, y: n.y });
        n.fx = null;
        n.fy = null;
      });
      if (!allPositionsCached) fitView(svg, zoom, W, H, simNodes);
      startParticles(simLinks, edgeLayer, particleLayer);
    });

  State.sim = sim;

  // ── Overlay UI ────────────────────────────────────────────
  appendLegend(container);
  appendHintOverlay(container);
  appendZoomButtons(container, svg, zoom, W, H, simNodes);

  // Watch container resize → re-render (debounced)
  if (window.ResizeObserver) {
    let lastWidth = W;
    let debounce  = null;
    State.resizeObs = new ResizeObserver(() => {
      const w = container.clientWidth;
      if (Math.abs(w - lastWidth) < 8) return;
      lastWidth = w;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (_roadmapData) renderRoadmapCanvas(_roadmapData.features);
      }, 200);
    });
    State.resizeObs.observe(container);
  }
}

// ─────────────────────────────────────────────────────────────
// SECTION 16 — NODE VISUALS
// ─────────────────────────────────────────────────────────────

/**
 * Append all SVG child elements to each node group:
 * background rect, glow circle, status circle, icon text, label text.
 */
function buildNodeVisuals(nodeGroups, nodeRadius) {
  // Transparent background rect — extends hover area down to cover
  // the gap between the circle and the connect handle.
  nodeGroups.append('rect')
    .attr('class', 'rmap-node-bg')
    .attr('x', -28)
    .attr('y', d => -(nodeRadius(d) + 4))
    .attr('width', 56)
    .attr('height', d => nodeRadius(d) * 2 + 52)
    .attr('fill', 'transparent')
    .attr('rx', 4);

  // Soft glow behind the circle
  nodeGroups.append('circle')
    .attr('class', 'rmap-glow')
    .attr('r', d => nodeRadius(d) + 7)
    .attr('fill', d => STATUS_STYLE[d.status]?.glow || 'transparent')
    .attr('stroke', 'none');

  // Main status circle
  nodeGroups.append('circle')
    .attr('class', 'rmap-circle')
    .attr('r', nodeRadius)
    .attr('fill', d => STATUS_STYLE[d.status]?.fill || '#4a4a48')
    .attr('fill-opacity', 0.18)
    .attr('stroke', d => STATUS_STYLE[d.status]?.fill || '#4a4a48')
    .attr('stroke-width', 1)
    .attr('stroke-opacity', 0.65);

  // Status icon (✓ / ◐ / ○ / …)
  nodeGroups.append('text')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('font-size', d => Math.max(10, nodeRadius(d) * 0.9))
    .attr('font-family', "'SF Mono','Fira Code',monospace")
    .attr('fill', d => STATUS_STYLE[d.status]?.fill || '#4a4a48')
    .attr('pointer-events', 'none')
    .attr('user-select', 'none')
    .text(d => STATUS_STYLE[d.status]?.icon || '○');

  // Feature name label below the circle
  nodeGroups.append('text')
    .attr('class', 'rmap-lbl')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'hanging')
    .attr('y', d => nodeRadius(d) + 7)
    .attr('font-size', 11)
    .attr('font-family', "'SF Mono','Fira Code',monospace")
    .attr('fill', 'var(--text)')
    .attr('pointer-events', 'none')
    .attr('user-select', 'none')
    .text(d => {
      const name = d.name || d.id;
      return name.length > 22 ? name.slice(0, 20) + '…' : name;
    });
}

// ─────────────────────────────────────────────────────────────
// SECTION 17 — NODE DRAG (REPOSITION)
// ─────────────────────────────────────────────────────────────

/** Build the D3 drag behaviour that lets users reposition nodes. */
function buildNodeDragBehavior() {
  return d3.drag()
    .clickDistance(8)
    .filter(e => !e.target.closest?.('.rmap-conn-handle'))
    .on('start', (e, d) => {
      if (!e.active) State.sim.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    })
    .on('drag', (e, d) => {
      d.fx = e.x;
      d.fy = e.y;
    })
    .on('end', (e, d) => {
      if (!e.active) State.sim.alphaTarget(0);
      State.nodePositions.set(d.id, { x: d.x, y: d.y });
      d.fx = null;
      d.fy = null;
    });
}

// ─────────────────────────────────────────────────────────────
// SECTION 18 — NODE INTERACTIONS (click, hover, connect handle)
// ─────────────────────────────────────────────────────────────

function attachNodeInteractions(nodeGroups, edges, dragLineLayer) {
  nodeGroups
    .on('click', (event, d) => {
      event.stopPropagation();
      hideContextMenu();
      // Highlight selected node
      nodeGroups.select('circle.rmap-circle')
        .attr('stroke-width', n => n.id === d.id ? 2.5 : 1)
        .attr('stroke', n => STATUS_STYLE[n.status]?.fill || '#4a4a48')
        .attr('stroke-opacity', n => n.id === d.id ? 1 : 0.65);
      selectFeature(d.id);
    })

    .on('contextmenu', (event, d) => {
      event.preventDefault();
      event.stopPropagation();
      showNodeContextMenu(event, d);
    })

    .on('mouseenter', function (event, d) {
      if (State.isConnectMode || State.isIsolated || State.critPathActive) return;

      // Dim everything except this node and its immediate neighbors
      dimNonNeighbors(d, edges, nodeGroups, State.simLinks);

      // Append a drag handle below the circle
      const r      = State.nodeRadiusFn(d);
      const handle = d3.select(this).append('g')
        .attr('class', 'rmap-conn-handle')
        .attr('transform', `translate(0,${r + 30})`)
        .style('cursor', 'crosshair');

      handle.append('rect')
        .attr('x', -20).attr('y', -9).attr('width', 40).attr('height', 18).attr('rx', 9)
        .attr('fill', 'rgba(201,199,186,.08)')
        .attr('stroke', 'var(--thread-bright)').attr('stroke-width', 0.8)
        .attr('opacity', 0).transition().duration(180).attr('opacity', 1);

      handle.append('text')
        .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
        .attr('font-size', 11).attr('fill', 'var(--thread-bright)')
        .attr('pointer-events', 'none').attr('opacity', 0)
        .text('⟶').transition().duration(180).attr('opacity', 1);

      // Drag-to-connect behaviour on the handle
      handle.call(buildConnectDragBehavior(d, dragLineLayer));
    })

    .on('mouseleave', function () {
      d3.select(this).select('.rmap-conn-handle').remove();
      if (State.isConnectMode || State.isIsolated || State.critPathActive) return;
      undimAll(edges, nodeGroups);
    });
}

/** Dim all nodes and edges that are not immediate neighbors of `hoveredNode`. */
function dimNonNeighbors(hoveredNode, edges, nodeGroups, simLinks) {
  const neighborIds = new Set([hoveredNode.id]);
  simLinks.forEach(l => {
    const s = l.source?.id || l.sourceId;
    const t = l.target?.id || l.targetId;
    if (s === hoveredNode.id) neighborIds.add(t);
    if (t === hoveredNode.id) neighborIds.add(s);
  });

  nodeGroups.classed('dimmed', n => !neighborIds.has(n.id));
  edges.attr('stroke-opacity', l => {
    const s = l.source?.id || l.sourceId;
    const t = l.target?.id || l.targetId;
    return (s === hoveredNode.id || t === hoveredNode.id) ? 0.7 : 0.04;
  });
}

/** Remove all dimming applied during hover. */
function undimAll(edges, nodeGroups) {
  nodeGroups.classed('dimmed', false);
  edges.attr('stroke-opacity', 0.25);
}

// ─────────────────────────────────────────────────────────────
// SECTION 19 — DRAG-TO-CONNECT
// ─────────────────────────────────────────────────────────────

/**
 * Build the D3 drag behaviour attached to a node's connect handle.
 * Dragging from one node's handle to another node creates a dependency.
 */
function buildConnectDragBehavior(sourceNode, dragLineLayer) {
  return d3.drag()
    .clickDistance(4)
    .on('start', e => {
      e.sourceEvent.stopPropagation();
      State.dragSourceId = sourceNode.id;
      State.dragLine = dragLineLayer.append('path')
        .attr('fill', 'none')
        .attr('stroke', 'var(--thread-bright)')
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '5,4')
        .attr('opacity', 0.8);
    })
    .on('drag', e => {
      if (!State.dragLine || !State.dragSourceId) return;
      const src = State.simNodes?.find(n => n.id === State.dragSourceId);
      if (!src) return;
      const [tx, ty] = clientToSvgCoords(e.sourceEvent);
      State.dragLine.attr('d', bezierPath(src.x, src.y, tx, ty));
    })
    .on('end', e => {
      if (State.dragLine) { State.dragLine.remove(); State.dragLine = null; }
      const srcId = State.dragSourceId;
      State.dragSourceId = null;
      if (!srcId) return;

      // Find the node under the cursor on drop
      const [tx, ty] = clientToSvgCoords(e.sourceEvent);
      let target   = null;
      let minDist  = Infinity;

      (State.simNodes || []).forEach(n => {
        if (n.id === srcId) return;
        const dist = Math.hypot(n.x - tx, n.y - ty);
        const hitR = (State.nodeRadiusFn ? State.nodeRadiusFn(n) : 16) + 20;
        if (dist < hitR && dist < minDist) {
          minDist = dist;
          target  = n;
        }
      });

      if (target) addDependency(srcId, target.id);
    });
}

// ─────────────────────────────────────────────────────────────
// SECTION 20 — EDGE INTERACTIONS
// ─────────────────────────────────────────────────────────────

function attachEdgeHoverAndClick(edgeHitAreas, edges) {
  edgeHitAreas
    .on('mouseenter', function (event, d) {
      removeEdgeTooltip();

      // Highlight the hovered edge
      edges.filter(e => e === d)
        .attr('stroke', '#e0524a').attr('stroke-opacity', 0.65).attr('stroke-width', 2);

      const src = _roadmapData?.features.find(f => f.id === (d.sourceId || d.source?.id));
      const tgt = _roadmapData?.features.find(f => f.id === (d.targetId || d.target?.id));

      State.edgeTooltip = document.createElement('div');
      State.edgeTooltip.className = 'rmap-edge-tooltip';
      State.edgeTooltip.textContent = `click to remove: ${src?.name || '?'} → ${tgt?.name || '?'}`;
      State.edgeTooltip.style.left = `${event.clientX + 12}px`;
      State.edgeTooltip.style.top  = `${event.clientY - 24}px`;
      document.body.appendChild(State.edgeTooltip);
    })

    .on('mousemove', event => {
      if (State.edgeTooltip) {
        State.edgeTooltip.style.left = `${event.clientX + 12}px`;
        State.edgeTooltip.style.top  = `${event.clientY - 24}px`;
      }
    })

    .on('mouseleave', () => {
      removeEdgeTooltip();
      edges
        .attr('stroke', d => STATUS_STYLE[d.source.status]?.fill || '#4a4a48')
        .attr('stroke-opacity', 0.25)
        .attr('stroke-width', 1.4);
    })

    .on('click', (event, d) => {
      event.stopPropagation();
      removeEdgeTooltip();
      removeDependency(d.targetId || d.target?.id, d.sourceId || d.source?.id);
    })

    .on('contextmenu', (event, d) => {
      event.preventDefault();
      event.stopPropagation();
      showEdgeContextMenu(event, d);
    });
}

function removeEdgeTooltip() {
  if (State.edgeTooltip) { State.edgeTooltip.remove(); State.edgeTooltip = null; }
}

// ─────────────────────────────────────────────────────────────
// SECTION 21 — FIT VIEW
// ─────────────────────────────────────────────────────────────

/**
 * Pan/zoom the SVG so all nodes are comfortably visible.
 *
 * @param {d3.Selection} svg
 * @param {d3.ZoomBehavior} zoom
 * @param {number} W  – container width
 * @param {number} H  – container height
 * @param {object[]} nodes
 */
function fitView(svg, zoom, W, H, nodes) {
  if (!nodes?.length) return;

  const xs = nodes.map(n => n.x).filter(x => x != null);
  const ys = nodes.map(n => n.y).filter(y => y != null);
  if (!xs.length) return;

  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const pw   = maxX - minX || 100;
  const ph   = maxY - minY || 100;
  const scale = Math.min(W * 0.88 / pw, H * 0.88 / ph, 2);

  svg.transition().duration(600).ease(d3.easeCubicInOut).call(
    zoom.transform,
    d3.zoomIdentity
      .translate(W / 2 - (minX + pw / 2) * scale, H / 2 - (minY + ph / 2) * scale)
      .scale(scale)
  );
}

// ─────────────────────────────────────────────────────────────
// SECTION 22 — PARTICLES
// ─────────────────────────────────────────────────────────────

/**
 * Animate small dots flowing along each dependency edge.
 * Active (in-progress) edges move faster and are more visible.
 */
function startParticles(simLinks, edgeLayer, particleLayer) {
  const pathElements = edgeLayer.selectAll('path').nodes();
  const particles    = [];

  simLinks.forEach((link, i) => {
    const pathEl = pathElements[i];
    if (!pathEl) return;

    const isActive   = link.source.status === 'in-progress' || link.target.status === 'in-progress';
    const isComplete = link.source.status === 'complete'    && link.target.status === 'complete';

    const dot = particleLayer.append('circle')
      .attr('r',       isActive ? 2.5 : 2)
      .attr('fill',    STATUS_STYLE[link.source.status]?.fill || '#4a4a48')
      .attr('opacity', isActive ? 0.7 : isComplete ? 0.45 : 0.1)
      .attr('pointer-events', 'none');

    const speed = isActive  ? 0.13 + Math.random() * 0.07
                : isComplete? 0.08 + Math.random() * 0.04
                :             0.04 + Math.random() * 0.03;

    particles.push({ dot, pathEl, t: Math.random(), speed });
  });

  let lastTimestamp = null;

  function tick(timestamp) {
    if (!lastTimestamp) lastTimestamp = timestamp;
    const dt = Math.min((timestamp - lastTimestamp) / 1000, 0.05);
    lastTimestamp = timestamp;

    particles.forEach(p => {
      p.t += p.speed * dt;
      if (p.t > 1) p.t -= 1;
      try {
        const totalLength = p.pathEl.getTotalLength();
        const pt          = p.pathEl.getPointAtLength(p.t * totalLength);
        p.dot.attr('cx', pt.x).attr('cy', pt.y);
      } catch {}
    });

    State.rafId = requestAnimationFrame(tick);
  }

  State.rafId = requestAnimationFrame(tick);
}

// ─────────────────────────────────────────────────────────────
// SECTION 23 — CANVAS OVERLAY WIDGETS
// ─────────────────────────────────────────────────────────────

function appendLegend(container) {
  const legend = document.createElement('div');
  Object.assign(legend.style, {
    position:       'absolute',
    bottom:         '16px',
    left:           '16px',
    zIndex:         '5',
    background:     'rgba(6,6,6,.8)',
    border:         '1px solid var(--border)',
    borderRadius:   '4px',
    padding:        '8px 10px',
    display:        'flex',
    flexDirection:  'column',
    gap:            '4px',
    backdropFilter: 'blur(4px)',
    fontSize:       '10px',
  });
  legend.innerHTML = Object.entries(STATUS_STYLE)
    .map(([, { fill, icon, label }]) =>
      `<div style="display:flex;align-items:center;gap:6px;">
         <div style="width:10px;height:10px;border-radius:50%;background:${fill};flex-shrink:0;opacity:.85;"></div>
         <span style="color:${fill};">${icon} ${label}</span>
       </div>`
    ).join('');
  container.appendChild(legend);
}

function appendHintOverlay(container) {
  const hint = document.createElement('div');
  Object.assign(hint.style, {
    position:   'absolute',
    bottom:     '16px',
    right:      '16px',
    fontSize:   '9px',
    color:      'var(--text-faint)',
    fontFamily: "'SF Mono',monospace",
    textAlign:  'right',
    lineHeight: '1.8',
    zIndex:     '5',
  });
  hint.innerHTML = '⌘K spotlight · Ctrl+Z undo · Ctrl+Y redo<br>Tab cycle · H hide · C copy md · ? help<br>hover node → drag ⟶ to connect · right-click canvas';
  container.appendChild(hint);
}

function appendZoomButtons(container, svg, zoom, W, H, simNodes) {
  const zDiv = document.createElement('div');
  Object.assign(zDiv.style, {
    position:      'absolute',
    bottom:        '110px',
    right:         '16px',
    display:       'flex',
    flexDirection: 'column',
    gap:           '4px',
    zIndex:        '5',
  });

  [
    ['+',    'Zoom in',  () => svg.transition().duration(300).call(zoom.scaleBy, 1.5)],
    ['⊟',   'Fit',      () => fitView(svg, zoom, W, H, simNodes)],
    ['−',    'Zoom out', () => svg.transition().duration(300).call(zoom.scaleBy, 0.667)],
  ].forEach(([label, title, onClick]) => {
    const btn = document.createElement('div');
    btn.className = 'zoom-btn';
    btn.textContent = label;
    btn.title = title;
    btn.onclick = onClick;
    zDiv.appendChild(btn);
  });

  container.appendChild(zDiv);
}

// ─────────────────────────────────────────────────────────────
// SECTION 24 — CONTEXT MENUS
// ─────────────────────────────────────────────────────────────

/** Right-click on a node. */
function showNodeContextMenu(event, feature) {
  const safe = escapeJsString(feature.id);
  const statusOptions = ['planned', 'in-progress', 'complete', 'blocked']
    .map(s => {
      const labels = { planned: '○ Planned', 'in-progress': '◐ Active', complete: '✓ Complete', blocked: '✕ Blocked' };
      const colors = { planned: 'var(--text-dim)', 'in-progress': '#ff8c42', complete: '#7ECBA1', blocked: '#e0524a' };
      return `<div class="ctx-item" style="color:${colors[s]};" onclick="setRoadmapStatus('${safe}','${s}');hideContextMenu();">${labels[s]}</div>`;
    }).join('');

  populateContextMenu(`
    <div class="ctx-item" onclick="selectFeature('${safe}');hideContextMenu();">📋 View details</div>
    <div class="ctx-item" onclick="focusFeature('${safe}');hideContextMenu();">🔍 Focus</div>
    <div class="ctx-item" style="color:var(--thread-bright);" onclick="isolateSupertree('${safe}');hideContextMenu();">⧆ Supertree — prereqs</div>
    <div class="ctx-item" style="color:var(--thread-bright);" onclick="isolateSubtree('${safe}');hideContextMenu();">⧆ Subtree — dependents</div>
    <div class="ctx-divider"></div>
    <div style="padding:3px 16px;font-size:9px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.08em;">Set status</div>
    ${statusOptions}
    <div class="ctx-divider"></div>
    <div class="ctx-item" onclick="hideFeature('${safe}');hideContextMenu();">👁 Hide</div>
  `, event.clientX, event.clientY);
}

/** Right-click on a blank area of the canvas. */
function showCanvasContextMenu(event, svgX, svgY, W, H, simNodes) {
  populateContextMenu(`
    <div style="padding:5px 16px 3px;font-size:9px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.08em;">Canvas</div>
    <div class="ctx-item" onclick="openNewFeatureAt(${svgX.toFixed(1)},${svgY.toFixed(1)});hideContextMenu();">+ New feature here</div>
    <div class="ctx-divider"></div>
    <div class="ctx-item" onclick="openSpotlight();hideContextMenu();">⌘K Search</div>
    <div class="ctx-item" onclick="undo();hideContextMenu();">↩ Undo</div>
    <div class="ctx-item" onclick="unhideAllFeatures();hideContextMenu();">↩ Show all hidden</div>
    <div class="ctx-item" onclick="clearIsolation();hideContextMenu();">⧆ Clear isolation</div>
    <div class="ctx-item" onclick="fitView(State.svg,State.zoom,${W},${H},State.simNodes);hideContextMenu();">⊟ Fit to screen</div>
  `, event.clientX, event.clientY);
}

/** Right-click on an edge. */
function showEdgeContextMenu(event, link) {
  const srcId = link.sourceId || link.source?.id;
  const tgtId = link.targetId || link.target?.id;
  const src   = _roadmapData?.features.find(f => f.id === srcId);
  const tgt   = _roadmapData?.features.find(f => f.id === tgtId);

  populateContextMenu(`
    <div style="padding:6px 16px 2px;font-size:10px;color:var(--text-faint);">Dependency</div>
    <div style="padding:1px 16px 5px;font-size:11px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px;">
      ${src?.name || srcId} → ${tgt?.name || tgtId}
    </div>
    <div class="ctx-divider"></div>
    <div class="ctx-item" style="color:#e0524a;"
         onclick="removeDependency('${escapeJsString(tgtId || '')}','${escapeJsString(srcId || '')}');hideContextMenu();">
      ✕ Remove dependency
    </div>
  `, event.clientX, event.clientY);
}

function populateContextMenu(innerHtml, clientX, clientY) {
  const menu = document.getElementById('roadmap-ctx-menu');
  if (!menu) return;
  menu.innerHTML = innerHtml;
  menu.style.display = 'block';
  menu.style.left    = `${clientX + 2}px`;
  menu.style.top     = `${clientY + 2}px`;
}

function hideContextMenu() {
  const menu = document.getElementById('roadmap-ctx-menu');
  if (menu) menu.style.display = 'none';
}

document.addEventListener('click', hideContextMenu);

// ─────────────────────────────────────────────────────────────
// SECTION 25 — FEATURE SELECTION (DETAIL PANEL)
// ─────────────────────────────────────────────────────────────

/**
 * Render the right-side detail panel for the selected feature,
 * with inline-editable name, description, status picker, and dependency lists.
 *
 * @param {string} featureId
 */
function selectFeature(featureId) {
  State.selectedId = featureId;

  const panel = document.getElementById('roadmap-feature-detail');
  if (!_roadmapData || !panel) return;

  const feature = _roadmapData.features.find(f => f.id === featureId);
  if (!feature) return;

  const style = STATUS_STYLE[feature.status] || STATUS_STYLE.planned;
  const safe  = escapeJsString(featureId);

  // Status picker
  const statusOptions = ['planned', 'in-progress', 'complete', 'blocked', 'backlog']
    .map(s => {
      const labels = { planned: '○ Planned', 'in-progress': '◐ Active', complete: '✓ Complete', blocked: '✕ Blocked', backlog: '· Backlog' };
      return `<option value="${s}" ${feature.status === s ? 'selected' : ''}>${labels[s]}</option>`;
    }).join('');

  // "Requires" list (things this feature depends on)
  const requiresHtml = buildDependencyList(feature, safe, 'requires');

  // "Required by" list (features that depend on this one)
  const requiredByFeatures = (_roadmapData.features || []).filter(f =>
    (f.dependsOn || []).includes(featureId)
  );
  const requiredByHtml = buildDependencyList(requiredByFeatures, safe, 'requiredBy');

  // Associated files
  const filesHtml = buildFilesSection(feature);

  // Tags
  const tagsHtml = (feature.tags || []).length
    ? `<div style="margin-top:7px;display:flex;gap:4px;flex-wrap:wrap;">
         ${(feature.tags || []).map(t =>
           `<span style="font-size:10px;padding:1px 6px;background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:10px;color:var(--text-dim);">${t}</span>`
         ).join('')}
       </div>`
    : '';

  // Blocker rank
  const blockerCount = getBlockerRank(featureId);
  const blockerHtml  = blockerCount > 0
    ? `<div class="stat-row" style="margin-top:4px;">
         <span>Blocks</span>
         <span class="stat-val" style="color:#ff8c42;">${blockerCount} feature${blockerCount !== 1 ? 's' : ''}</span>
       </div>`
    : '';

  // Blocking / ready status
  const blockingHtml = buildBlockingSection(feature, safe);

  panel.innerHTML = `
    <div class="node-detail">
      <div class="node-kind-badge kind-file">feature</div>

      <div class="node-name"
           contenteditable="true" spellcheck="false"
           style="color:${style.fill};outline:none;cursor:text;border-radius:2px;padding:1px 3px;margin:-1px -3px;"
           onfocus="this.style.background='rgba(255,255,255,.05)'"
           onblur="this.style.background='';autoSaveName('${safe}',this.innerText.trim())"
           onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}">
        ${style.icon} ${feature.name}
      </div>

      ${tagsHtml}

      <select onchange="autoSaveStatus('${safe}',this.value)"
              style="width:100%;margin:8px 0;background:var(--surface2);border:1px solid var(--border);color:${style.fill};font-family:inherit;font-size:11px;padding:4px 8px;outline:none;border-radius:2px;cursor:pointer;">
        ${statusOptions}
      </select>

      <div class="node-description"
           contenteditable="true" spellcheck="false"
           style="outline:none;cursor:text;border-radius:2px;padding:2px 3px;margin:-2px -3px;min-height:20px;"
           onfocus="this.style.background='rgba(255,255,255,.05)'"
           onblur="this.style.background='';autoSaveDescription('${safe}',this.innerText.trim())">
        ${feature.description ||
          '<span style="color:var(--text-faint);font-style:italic;pointer-events:none;">No description — click to add</span>'}
      </div>

      ${feature.notes
        ? `<div style="font-size:11px;color:var(--text-faint);margin:8px 0;padding:6px 8px;background:rgba(255,255,255,.02);border-left:2px solid var(--border);">→ ${feature.notes}</div>`
        : ''}

      <div class="section-title" style="margin-top:12px;">Stats</div>
      <div class="stat-row"><span>Priority</span><span class="stat-val">${feature.priority || '–'}</span></div>
      ${blockerHtml}

      <div id="rmap-detail-save-msg" style="font-size:10px;color:var(--text-faint);margin:6px 0;min-height:14px;"></div>

      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px;">
        <button onclick="isolateSupertree('${safe}')" title="Prerequisites of this feature (what it depends on)"
                style="flex:1;background:none;border:1px solid var(--border);color:var(--thread-bright);cursor:pointer;font-family:inherit;font-size:10px;padding:3px 5px;border-radius:2px;">
          ⧆ Supertree
        </button>
        <button onclick="isolateSubtree('${safe}')" title="Features that depend on this one (descendants)"
                style="flex:1;background:none;border:1px solid var(--border);color:var(--thread-bright);cursor:pointer;font-family:inherit;font-size:10px;padding:3px 5px;border-radius:2px;">
          ⧆ Subtree
        </button>
        <button onclick="hideFeature('${safe}')"
                style="background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:11px;padding:4px 8px;border-radius:2px;">
          👁 Hide
        </button>
      </div>

      ${blockingHtml}
      ${filesHtml}
      ${requiresHtml}
      ${requiredByHtml}
    </div>
  `;

  // Highlight the selected node's circle
  if (State.nodeGroups) {
    State.nodeGroups.select('circle.rmap-circle')
      .attr('stroke-width',  n => n.id === featureId ? 2.5 : 1)
      .attr('stroke-opacity', n => n.id === featureId ? 1 : 0.65);
  }
}

/** Build the "Requires" or "Required by" dependency list HTML. */
function buildDependencyList(featureOrList, safeSelf, mode) {
  let items;
  let sectionTitle;

  if (mode === 'requires') {
    const feature = featureOrList;
    if (!(feature.dependsOn || []).length) return '';
    sectionTitle = 'Requires';
    items = (feature.dependsOn || []).map(depId => {
      const dep   = _roadmapData.features.find(x => x.id === depId);
      const sId   = escapeJsString(depId);
      const style = STATUS_STYLE[dep?.status] || STATUS_STYLE.planned;
      return `
        <div class="dep-item dep-import" style="display:flex;align-items:center;gap:4px;">
          <span style="color:${style.fill};flex-shrink:0;">${style.icon}</span>
          <span onclick="focusFeature('${sId}')" style="flex:1;cursor:pointer;overflow:hidden;text-overflow:ellipsis;">${dep ? dep.name : depId}</span>
          <button onclick="removeDependency('${safeSelf}','${sId}')" title="Remove dependency"
                  style="background:none;border:none;color:var(--text-faint);cursor:pointer;font-size:11px;padding:0 2px;line-height:1;"
                  onmouseover="this.style.color='#e0524a'" onmouseout="this.style.color='var(--text-faint)'">&#x2715;</button>
        </div>`;
    });
  } else {
    // mode === 'requiredBy'
    const features = featureOrList;
    if (!features.length) return '';
    sectionTitle = 'Required by';
    items = features.map(f => {
      const style = STATUS_STYLE[f.status] || STATUS_STYLE.planned;
      return `
        <div class="dep-item dep-import" style="display:flex;align-items:center;gap:4px;">
          <span style="color:${style.fill};flex-shrink:0;">${style.icon}</span>
          <span onclick="focusFeature('${escapeJsString(f.id)}')" style="flex:1;cursor:pointer;">${f.name}</span>
        </div>`;
    });
  }

  return `
    <div class="section-title" style="margin-top:12px;">${sectionTitle}</div>
    <div class="dep-list">${items.join('')}</div>
  `;
}

/** Build the associated-files section HTML for the detail panel. */
function buildFilesSection(feature) {
  const fileIds = new Set(feature.files || []);
  if (!fileIds.size) return '';
  return `
    <div class="section-title" style="margin-top:12px;">Files (${fileIds.size})</div>
    <div class="dep-list">
      ${[...fileIds].map(fid =>
        `<div class="dep-item dep-import"
              onclick="window.switchTab('graph');requestAnimationFrame(()=>focusNode('${escapeJsString(fid)}'))"
              title="${fid}">${fid.split('/').pop()}</div>`
      ).join('')}
    </div>
  `;
}

/** Build the "What's blocking this" / "Ready to start" section. */
function buildBlockingSection(feature, safe) {
  if (feature.status === 'complete') return '';

  const prereqs = getPrerequisiteChain(feature.id);
  const hasDeps = (feature.dependsOn || []).length > 0;

  if (!hasDeps && !prereqs.length) {
    return '<div style="font-size:11px;color:#7ECBA1;margin-top:8px;">✓ Nothing blocking — ready to start</div>';
  }
  if (hasDeps && !prereqs.length) {
    return '<div style="font-size:11px;color:#7ECBA1;margin-top:8px;">✓ All deps complete — ready to start</div>';
  }
  if (prereqs.length) {
    const rows = prereqs.slice(0, 8).map(f => {
      const style = STATUS_STYLE[f.status] || STATUS_STYLE.planned;
      return `
        <div class="dep-item dep-import" style="display:flex;align-items:center;gap:4px;">
          <span style="color:${style.fill};flex-shrink:0;">${style.icon}</span>
          <span onclick="focusFeature('${escapeJsString(f.id)}')" style="flex:1;cursor:pointer;overflow:hidden;text-overflow:ellipsis;">${f.name}</span>
        </div>`;
    }).join('');
    const overflow = prereqs.length > 8
      ? `<div style="font-size:10px;color:var(--text-faint);padding:4px 0;">+ ${prereqs.length - 8} more</div>`
      : '';
    return `
      <div class="section-title" style="margin-top:12px;color:#e0524a;">What's blocking this</div>
      <div class="dep-list">${rows}${overflow}</div>
    `;
  }
  return '';
}

// ─────────────────────────────────────────────────────────────
// SECTION 26 — INLINE AUTO-SAVE (detail panel edits)
// ─────────────────────────────────────────────────────────────

function showDetailSaveMessage(text, isError = false) {
  const el = document.getElementById('rmap-detail-save-msg');
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? '#e0524a' : '#7ECBA1';
  if (!isError) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2000);
}

async function autoSaveName(featureId, newName) {
  if (!newName || !_roadmapData) return;
  const feature = _roadmapData.features.find(x => x.id === featureId);
  if (!feature || feature.name === newName) return;

  pushUndoSnapshot();
  showDetailSaveMessage('Saving…');
  try {
    await apiPatchFeature(featureId, { name: newName });
    feature.name = newName;
    showDetailSaveMessage('✓ Saved');

    // Update the label on the canvas without a full re-render
    if (State.nodeGroups) {
      State.nodeGroups.filter(d => d.id === featureId)
        .selectAll('.rmap-lbl')
        .text(newName.length > 22 ? newName.slice(0, 20) + '…' : newName);
      const simNode = State.simNodes?.find(n => n.id === featureId);
      if (simNode) simNode.name = newName;
    }
  } catch {
    showDetailSaveMessage('Save failed', true);
  }
}

async function autoSaveStatus(featureId, newStatus) {
  pushUndoSnapshot();
  showDetailSaveMessage('Saving…');
  try {
    await apiPatchFeature(featureId, { status: newStatus });
    const feature = _roadmapData?.features.find(x => x.id === featureId);
    if (feature) feature.status = newStatus;
    showDetailSaveMessage('✓ Saved');
    setTimeout(() => { if (_roadmapData) renderRoadmapCanvas(_roadmapData.features); }, 150);
  } catch {
    showDetailSaveMessage('Save failed', true);
  }
}

async function autoSaveDescription(featureId, newDesc) {
  if (!_roadmapData) return;
  const feature = _roadmapData.features.find(x => x.id === featureId);
  if (!feature || feature.description === newDesc) return;

  pushUndoSnapshot();
  showDetailSaveMessage('Saving…');
  try {
    await apiPatchFeature(featureId, { description: newDesc });
    feature.description = newDesc;
    showDetailSaveMessage('✓ Saved');
  } catch {
    showDetailSaveMessage('Save failed', true);
  }
}

// Public API surface used by inline onchange handlers
window.setRoadmapStatus = async function (featureId, status) {
  pushUndoSnapshot();
  try {
    await apiPatchFeature(featureId, { status });
    const f = _roadmapData?.features.find(x => x.id === featureId);
    if (f) f.status = status;
    if (State.selectedId === featureId) selectFeature(featureId);
    renderRoadmapCanvas(_roadmapData.features);
  } catch (err) { console.error(err); }
};

// ─────────────────────────────────────────────────────────────
// SECTION 27 — FEATURE VISIBILITY (hide / unhide)
// ─────────────────────────────────────────────────────────────

function hideFeature(id) {
  pushUndoSnapshot();
  State.hiddenFeatures.add(id);
  try { localStorage.setItem('mycelium-hidden-features', JSON.stringify([...State.hiddenFeatures])); } catch {}
  refreshHiddenCountBadge();

  const panel = document.getElementById('roadmap-feature-detail');
  if (panel) {
    panel.innerHTML = `
      <div style="color:var(--text-dim);font-size:12px;text-align:center;margin-top:40px;line-height:1.9;">
        Feature hidden.<br>
        <button onclick="unhideAllFeatures()"
                style="margin-top:8px;background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:11px;padding:4px 12px;border-radius:2px;">
          ↩ Show all hidden
        </button>
      </div>`;
  }

  // Try a smooth animated removal; fall back to full re-render
  if (!smoothRemoveNode(id) && _roadmapData) {
    renderRoadmapCanvas(_roadmapData.features);
  }
}

function unhideAllFeatures() {
  pushUndoSnapshot();
  State.hiddenFeatures.clear();
  try { localStorage.setItem('mycelium-hidden-features', '[]'); } catch {}
  refreshHiddenCountBadge();

  const panel = document.getElementById('roadmap-feature-detail');
  if (panel) {
    panel.innerHTML = `
      <div style="color:var(--text-dim);font-size:12px;text-align:center;margin-top:40px;line-height:1.9;">
        Click any node to see its details<br><br>
        <span style="font-size:10px;opacity:.6">Right-click canvas or hover nodes to connect</span>
      </div>`;
  }
  if (_roadmapData) renderRoadmapCanvas(_roadmapData.features);
}

function refreshHiddenCountBadge() {
  const row   = document.getElementById('rmap-hidden-row');
  const count = document.getElementById('rmap-hidden-count');
  if (!row) return;
  const n = State.hiddenFeatures.size;
  row.style.display = n > 0 ? 'flex' : 'none';
  if (count) count.textContent = `${n} hidden`;
}

/**
 * Animate a node's removal from the live simulation without re-rendering.
 * Falls back to false if the simulation isn't running.
 *
 * @param {string} id
 * @returns {boolean} true if smooth removal succeeded
 */
function smoothRemoveNode(id) {
  if (!State.nodeGroups || !State.sim || !State.simNodes) return false;
  if (!State.simNodes.find(n => n.id === id)) return false;

  // Save positions before touching anything
  State.simNodes.forEach(n => {
    if (n.x !== undefined) State.nodePositions.set(n.id, { x: n.x, y: n.y });
  });

  // Lock remaining nodes in place during transition
  const remaining = State.simNodes.filter(n => n.id !== id);
  remaining.forEach(n => { n.fx = n.x; n.fy = n.y; });

  // Fade out node and its edges
  State.nodeGroups.filter(d => d.id === id)
    .transition().duration(220).style('opacity', 0).remove();

  [State.edges, State.edgeHitAreas].forEach(sel => {
    if (!sel) return;
    sel.filter(d => {
      const s = d.sourceId || d.source?.id;
      const t = d.targetId || d.target?.id;
      return s === id || t === id;
    }).transition().duration(220).attr('stroke-opacity', 0).remove();
  });

  // Update simulation data
  State.simNodes = remaining;
  State.sim.nodes(remaining);

  const newLinks = State.simLinks.filter(l => {
    const s = l.sourceId || l.source?.id;
    const t = l.targetId || l.target?.id;
    return s !== id && t !== id;
  });
  State.simLinks = newLinks;
  State.sim.force('link',
    d3.forceLink(newLinks).id(d => d.id).distance(110).strength(0.3)
  );

  // Release the position locks after the animation
  setTimeout(() => {
    remaining.forEach(n => { n.fx = null; n.fy = null; });
    if (State.sim) State.sim.alpha(0.04).alphaDecay(0.1).velocityDecay(0.8).restart();
  }, 230);

  return true;
}

// ─────────────────────────────────────────────────────────────
// SECTION 28 — CRITICAL PATH
// ─────────────────────────────────────────────────────────────

function toggleCriticalPath() {
  if (State.critPathActive) { clearCriticalPath(); return; }
  if (!_roadmapData) return;

  State.critPathIds    = computeCriticalPath(_roadmapData.features);
  State.critPathActive = true;

  const btn = document.getElementById('rmap-crit-btn');
  if (btn) {
    btn.style.background   = 'rgba(239,159,39,.15)';
    btn.style.borderColor  = 'rgba(239,159,39,.5)';
    btn.style.color        = '#EF9F27';
  }

  if (State.nodeGroups) {
    State.nodeGroups
      .classed('crit-path', d =>  State.critPathIds.has(d.id))
      .classed('dimmed',    d => !State.critPathIds.has(d.id));
  }

  if (State.edges) {
    State.edges
      .attr('stroke-opacity', d => {
        const s = d.source?.id || d.sourceId;
        const t = d.target?.id || d.targetId;
        return (State.critPathIds.has(s) && State.critPathIds.has(t)) ? 0.7 : 0.03;
      })
      .attr('stroke', d => {
        const s = d.source?.id || d.sourceId;
        const t = d.target?.id || d.targetId;
        return (State.critPathIds.has(s) && State.critPathIds.has(t)) ? '#EF9F27' : '#4a4a48';
      });
  }

  showToast(`🔴 Critical path: ${State.critPathIds.size} features`);
}

function clearCriticalPath() {
  State.critPathActive = false;
  State.critPathIds.clear();

  const btn = document.getElementById('rmap-crit-btn');
  if (btn) {
    btn.style.background  = '';
    btn.style.borderColor = 'var(--border)';
    btn.style.color       = 'var(--text-dim)';
  }

  if (State.nodeGroups) State.nodeGroups.classed('crit-path dimmed', false);
  if (State.edges)      State.edges.attr('display', null).attr('stroke-opacity', 0.25);
}

// ─────────────────────────────────────────────────────────────
// SECTION 29 — ISOLATION (SUPERTREE / SUBTREE)
// ─────────────────────────────────────────────────────────────

/**
 * Show only the selected node and all its prerequisites (upward traversal).
 */
function isolateSupertree(featureId) {
  if (!_roadmapData) return;
  const reachable = new Set([featureId]);
  const queue     = [featureId];

  while (queue.length) {
    const id      = queue.shift();
    const feature = _roadmapData.features.find(f => f.id === id);
    (feature?.dependsOn || []).forEach(depId => {
      if (!reachable.has(depId)) { reachable.add(depId); queue.push(depId); }
    });
  }

  applyIsolation(reachable, 'Supertree', featureId, reachable.size);
}

/**
 * Show only the selected node and all features that depend on it (downward traversal).
 */
function isolateSubtree(featureId) {
  if (!_roadmapData) return;

  // Build reverse adjacency map
  const features    = _roadmapData.features;
  const reverseDeps = new Map(features.map(f => [f.id, []]));
  features.forEach(f => {
    (f.dependsOn || []).forEach(depId => reverseDeps.get(depId)?.push(f.id));
  });

  const reachable = new Set([featureId]);
  const queue     = [featureId];
  while (queue.length) {
    const id = queue.shift();
    (reverseDeps.get(id) || []).forEach(childId => {
      if (!reachable.has(childId)) { reachable.add(childId); queue.push(childId); }
    });
  }

  applyIsolation(reachable, 'Subtree', featureId, reachable.size);
}

/** Dim everything outside the reachable set and show an isolation banner. */
function applyIsolation(reachableIds, label, originId, count) {
  State.isIsolated = true;

  if (State.particleLayer) State.particleLayer.attr('display', 'none');

  if (State.nodeGroups) {
    State.nodeGroups.attr('opacity', d => reachableIds.has(d.id) ? 1 : 0.08);
  }

  if (State.edges) {
    State.edges
      .attr('display', d => {
        const s = d.source?.id || d.sourceId;
        const t = d.target?.id || d.targetId;
        return (reachableIds.has(s) && reachableIds.has(t)) ? null : 'none';
      })
      .attr('stroke-opacity', d => {
        const s = d.source?.id || d.sourceId;
        const t = d.target?.id || d.targetId;
        return (reachableIds.has(s) && reachableIds.has(t)) ? 0.55 : 0;
      });
  }

  // Remove old banner and add a new one
  document.getElementById('rmap-isolation-banner')?.remove();

  const canvas = document.getElementById('roadmap-canvas');
  if (!canvas) return;

  const origin  = _roadmapData?.features.find(f => f.id === originId);
  const banner  = document.createElement('div');
  banner.id = 'rmap-isolation-banner';
  Object.assign(banner.style, {
    position:       'absolute',
    top:            '10px',
    left:           '50%',
    transform:      'translateX(-50%)',
    background:     'rgba(6,6,6,.9)',
    border:         '1px solid var(--thread-bright)',
    borderRadius:   '4px',
    padding:        '5px 12px 5px 10px',
    display:        'flex',
    alignItems:     'center',
    gap:            '10px',
    zIndex:         '10',
    fontFamily:     "'SF Mono','Fira Code',monospace",
    fontSize:       '11px',
    color:          'var(--thread-bright)',
    whiteSpace:     'nowrap',
    backdropFilter: 'blur(6px)',
  });
  banner.innerHTML = `
    <span style="opacity:.6">⧆</span>
    <span>${label} of <strong>${origin?.name || originId}</strong> · ${count} features</span>
    <button onclick="clearIsolation()"
            style="background:none;border:1px solid rgba(255,255,255,.2);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:10px;padding:2px 8px;border-radius:2px;margin-left:4px;"
            onmouseover="this.style.borderColor='rgba(255,255,255,.5)';this.style.color='var(--text)'"
            onmouseout="this.style.borderColor='rgba(255,255,255,.2)';this.style.color='var(--text-dim)'">
      ✕ Clear
    </button>`;
  canvas.appendChild(banner);
}

function clearIsolation() {
  State.isIsolated = false;

  if (State.particleLayer) State.particleLayer.attr('display', null);
  if (State.nodeGroups)    State.nodeGroups.attr('opacity', null);
  if (State.edges)         State.edges.attr('display', null).attr('stroke-opacity', 0.25);

  document.getElementById('rmap-isolation-banner')?.remove();
}

// ─────────────────────────────────────────────────────────────
// SECTION 30 — FEATURE NAVIGATION (focus / spotlight)
// ─────────────────────────────────────────────────────────────

/**
 * Pan/zoom the canvas to bring a feature into view and select it.
 * @param {string} featureId
 */
function focusFeature(featureId) {
  const node = State.simNodes?.find(n => n.id === featureId);
  if (!node || node.x === undefined) return;

  const canvas = document.getElementById('roadmap-canvas');
  const svgEl  = canvas?.querySelector('svg');
  if (!svgEl || !State.zoom) return;

  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  const k = d3.zoomTransform(svgEl).k;

  d3.select(svgEl).transition().duration(450).ease(d3.easeCubicOut).call(
    State.zoom.transform,
    d3.zoomIdentity
      .translate(W / 2 - node.x * k, H / 2 - node.y * k)
      .scale(k)
  );

  selectFeature(featureId);
}

// ─────────────────────────────────────────────────────────────
// SECTION 31 — SPOTLIGHT (⌘K search modal)
// ─────────────────────────────────────────────────────────────

function openSpotlight() {
  if (document.getElementById('rmap-spot-overlay')) return;

  const features = _roadmapData?.features || [];
  let selectedIndex = 0;

  // Build overlay
  const overlay = document.createElement('div');
  overlay.id = 'rmap-spot-overlay';
  Object.assign(overlay.style, {
    position:       'fixed',
    inset:          '0',
    background:     'rgba(0,0,0,.6)',
    zIndex:         '9000',
    display:        'flex',
    alignItems:     'flex-start',
    justifyContent: 'center',
    paddingTop:     '15vh',
  });

  const modal = document.createElement('div');
  Object.assign(modal.style, {
    width:       'min(540px,94vw)',
    background:  '#0c0c0c',
    border:      '1px solid rgba(255,255,255,.2)',
    borderRadius:'8px',
    overflow:    'hidden',
    fontFamily:  "'SF Mono','Fira Code',monospace",
  });
  modal.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.08);">
      <span style="font-size:15px;color:var(--text-faint);">🔍</span>
      <input id="rmap-spot-inp" placeholder="Jump to feature…" autocomplete="off" spellcheck="false"
             style="flex:1;background:none;border:none;color:var(--text);font-family:inherit;font-size:13px;outline:none;">
      <kbd style="font-size:10px;color:var(--text-faint);border:1px solid rgba(255,255,255,.15);border-radius:3px;padding:2px 6px;flex-shrink:0;">Esc</kbd>
    </div>
    <div id="rmap-spot-results" style="max-height:360px;overflow-y:auto;"></div>
    <div style="padding:7px 16px;border-top:1px solid rgba(255,255,255,.06);display:flex;gap:16px;font-size:10px;color:var(--text-faint);">
      <span>↑↓ navigate</span><span>⏎ jump to</span><span>⌘K or Esc close</span>
    </div>`;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  overlay.addEventListener('mousedown', e => {
    if (e.target === overlay) closeSpotlight();
  });

  const resultsEl = () => document.getElementById('rmap-spot-results');

  function renderResults(query) {
    const matches = query
      ? features.filter(f => featureMatchesQuery(f, query.toLowerCase())).slice(0, 15)
      : features.slice(0, 15);

    if (!matches.length) {
      resultsEl().innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-faint);font-size:12px;">No features match</div>';
      return;
    }

    resultsEl().innerHTML = matches.map((f, i) => {
      const style  = STATUS_STYLE[f.status] || STATUS_STYLE.planned;
      const tags   = (f.tags || []).slice(0, 2)
        .map(t => `<span style="font-size:9px;padding:1px 5px;background:rgba(255,255,255,.06);border-radius:8px;color:var(--text-faint);">${t}</span>`)
        .join(' ');

      const prereqs   = getPrerequisiteChain(f.id);
      const isReady   = (f.dependsOn || []).length > 0 && !prereqs.length;
      const statusHint =
        f.status === 'complete' ? '<span style="font-size:9px;color:#7ECBA1;margin-left:6px;">✓ done</span>'
        : prereqs.length        ? `<span style="font-size:9px;color:#e0524a;margin-left:6px;">↑${prereqs.length} blocking</span>`
        : isReady               ? '<span style="font-size:9px;color:#7ECBA1;margin-left:6px;">⚡ ready</span>'
        : '';

      const isSelected = i === selectedIndex;
      return `
        <div class="rmap-spot-item" data-id="${f.id}" data-i="${i}"
             style="padding:10px 16px;cursor:pointer;display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(255,255,255,.035);${isSelected ? 'background:rgba(255,255,255,.08);' : ''}"
             onmouseenter="spotlightHover(${i})"
             onclick="spotlightPick('${escapeJsString(f.id)}')">
          <span style="color:${style.fill};font-size:14px;flex-shrink:0;">${style.icon}</span>
          <div style="flex:1;min-width:0;">
            <div style="color:var(--text);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${f.name} ${tags}</div>
            ${f.description ? `<div style="font-size:10px;color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px;">${f.description.slice(0, 90)}</div>` : ''}
          </div>
          ${statusHint}
        </div>`;
    }).join('');
  }

  // Expose to inline handlers
  window.spotlightHover = i => { selectedIndex = i; };
  window.spotlightPick  = id => { closeSpotlight(); setTimeout(() => focusFeature(id), 40); };

  const input = document.getElementById('rmap-spot-inp');
  input.addEventListener('input', () => { selectedIndex = 0; renderResults(input.value); });
  input.addEventListener('keydown', e => {
    const items = resultsEl().querySelectorAll('.rmap-spot-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
      items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
      renderResults(input.value);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
      renderResults(input.value);
    } else if (e.key === 'Enter') {
      const item = items[selectedIndex];
      if (item) spotlightPick(item.dataset.id);
    } else if (e.key === 'Escape') {
      closeSpotlight();
    }
  });

  renderResults('');
  setTimeout(() => input?.focus(), 30);
}

function closeSpotlight() {
  document.getElementById('rmap-spot-overlay')?.remove();
}

// ─────────────────────────────────────────────────────────────
// SECTION 32 — ADD FEATURE FORM
// ─────────────────────────────────────────────────────────────

function openAddFeatureForm() {
  const form = document.getElementById('rmap-add-form');
  const btn  = document.getElementById('rmap-add-btn');
  if (!form) return;

  form.style.display = 'block';
  if (btn) btn.style.display = 'none';

  ['rmap-add-name', 'rmap-add-desc', 'rmap-add-tags'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('rmap-add-status').value = 'planned';

  const msg = document.getElementById('rmap-add-msg');
  if (msg) msg.style.display = 'none';

  setTimeout(() => document.getElementById('rmap-add-name')?.focus(), 50);
}

function cancelAddFeatureForm() {
  const form = document.getElementById('rmap-add-form');
  const btn  = document.getElementById('rmap-add-btn');
  if (form) form.style.display = 'none';
  if (btn)  btn.style.display  = '';
  State.pendingNewNodePos = null;
}

async function submitAddFeatureForm() {
  const nameInput = document.getElementById('rmap-add-name');
  const name      = (nameInput?.value || '').trim();

  if (!name) {
    if (nameInput) {
      nameInput.style.borderColor = '#e0524a';
      nameInput.focus();
      setTimeout(() => (nameInput.style.borderColor = 'var(--border)'), 1200);
    }
    return;
  }

  const msg = document.getElementById('rmap-add-msg');
  if (msg) { msg.textContent = 'Creating…'; msg.style.display = 'block'; msg.style.color = 'var(--text-faint)'; }

  const tags = (document.getElementById('rmap-add-tags')?.value || '')
    .split(',').map(t => t.trim()).filter(Boolean);

  const feature = {
    id:          `${slugify(name)}-${Math.floor(Math.random() * 9000 + 1000)}`,
    name,
    status:      document.getElementById('rmap-add-status')?.value || 'planned',
    description: document.getElementById('rmap-add-desc')?.value.trim() || '',
    files:       [],
    dependsOn:   [],
    tags,
    updatedAt:   Date.now(),
  };

  pushUndoSnapshot();

  try {
    const saved = await apiPostFeature(feature);
    if (msg) { msg.textContent = '✓ Created!'; msg.style.color = '#7ECBA1'; }

    if (saved && State.pendingNewNodePos) {
      State.nodePositions.set(saved.id, State.pendingNewNodePos);
    }
    State.pendingNewNodePos = null;

    setTimeout(() => {
      cancelAddFeatureForm();
      renderRoadmapCanvas(_roadmapData.features);
      setTimeout(() => { if (saved) selectFeature(saved.id); }, 300);
    }, 400);
  } catch (err) {
    if (msg) { msg.textContent = `Error: ${err.message}`; msg.style.color = '#e0524a'; msg.style.display = 'block'; }
  }
}

/** Open the add form and pre-seed the position for "new feature here" canvas clicks. */
function openNewFeatureAt(svgX, svgY) {
  State.pendingNewNodePos = { x: svgX, y: svgY };
  injectSidebarControls();
  openAddFeatureForm();
}

// ─────────────────────────────────────────────────────────────
// SECTION 33 — HIDE DONE TOGGLE
// ─────────────────────────────────────────────────────────────

function toggleHideDone() {
  State.hideDone = !State.hideDone;
  try { localStorage.setItem('mycelium-rmap-hide-done', JSON.stringify(State.hideDone)); } catch {}
  refreshHideDoneButton();
  if (_roadmapData) renderRoadmapCanvas(_roadmapData.features);
}

function refreshHideDoneButton() {
  const btn = document.getElementById('rmap-hide-done-btn');
  if (!btn) return;
  btn.textContent   = State.hideDone ? '◉ Done hidden' : '○ Show done';
  btn.style.color   = State.hideDone ? 'var(--thread-bright)' : 'var(--text-dim)';
  btn.style.borderColor = State.hideDone ? 'rgba(201,199,186,.4)' : 'var(--border)';
}

// ─────────────────────────────────────────────────────────────
// SECTION 34 — EXPORT (Markdown)
// ─────────────────────────────────────────────────────────────

function exportMarkdown() {
  if (!_roadmapData) return;

  const features   = _roadmapData.features;
  const featureIds = new Set(features.map(f => f.id));
  const visited    = new Set();
  const lines      = ['# Mycelium Roadmap', ''];

  function addFeatureRow(feature, indent) {
    if (visited.has(feature.id)) return;
    visited.add(feature.id);

    const checked  = feature.status === 'complete' ? 'x' : ' ';
    const icon     = STATUS_STYLE[feature.status]?.icon || '○';
    const excerpt  = feature.description
      ? ' — ' + feature.description.split('\n')[0].slice(0, 80)
      : '';

    lines.push('  '.repeat(indent) + `- [${checked}] ${icon} ${feature.name}${excerpt}`);

    // Recursively add features that depend on this one
    features
      .filter(f => (f.dependsOn || []).includes(feature.id))
      .forEach(child => addFeatureRow(child, indent + 1));
  }

  // Start from root features (no in-scope dependencies)
  features
    .filter(f => (f.dependsOn || []).filter(d => featureIds.has(d)).length === 0)
    .forEach(root => addFeatureRow(root, 0));

  // Any features not yet visited (islands / cycles)
  features.forEach(f => {
    if (!visited.has(f.id)) {
      const checked = f.status === 'complete' ? 'x' : ' ';
      lines.push(`- [${checked}] ${STATUS_STYLE[f.status]?.icon || '○'} ${f.name}`);
    }
  });

  const text     = lines.join('\n');
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('📋 Copied!');
  };

  navigator.clipboard?.writeText(text)
    .then(() => showToast('📋 Copied to clipboard!'))
    .catch(fallback) || fallback();
}

// ─────────────────────────────────────────────────────────────
// SECTION 35 — SIDEBAR CONTROLS INJECTION
// ─────────────────────────────────────────────────────────────

/**
 * Inject the sidebar control panel beneath the filter buttons.
 * Idempotent — runs on every tab switch but only renders once.
 */
function injectSidebarControls() {
  if (document.getElementById('rmap-sidebar-controls')) return;

  const header = document.querySelector('#tab-content-roadmap > div:first-child');
  if (!header) return;

  // Add "Ready" filter button if not already present
  const filterRow = document.querySelector('.roadmap-filter-btn[data-filter="blocked"]')?.parentElement;
  if (filterRow && !filterRow.querySelector('[data-filter="ready"]')) {
    const readyBtn = document.createElement('button');
    readyBtn.className       = 'roadmap-filter-btn';
    readyBtn.dataset.filter  = 'ready';
    readyBtn.textContent     = '⚡ Ready';
    readyBtn.onclick         = () => setRoadmapFilter('ready');
    filterRow.appendChild(readyBtn);

    // Add titles to all filter buttons
    Object.entries(FILTER_LABELS).forEach(([filter, tip]) => {
      const btn = document.querySelector(`.roadmap-filter-btn[data-filter="${filter}"]`);
      if (btn) btn.title = tip;
    });
  }

  const container = document.createElement('div');
  container.id = 'rmap-sidebar-controls';
  container.innerHTML = `
    <!-- Primary actions -->
    <div style="display:flex;gap:5px;margin-top:8px;">
      <button id="rmap-add-btn" onclick="openAddFeatureForm()"
              style="flex:1;background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:11px;padding:5px 6px;border-radius:3px;"
              onmouseover="this.style.color='var(--text)';this.style.borderColor='rgba(255,255,255,.3)'"
              onmouseout="this.style.color='var(--text-dim)';this.style.borderColor='var(--border)'">
        + Add feature
      </button>
      <button id="rmap-crit-btn" onclick="toggleCriticalPath()"
              title="Critical path: the longest chain of incomplete dependencies. What is bottlenecking your roadmap. Shown in amber."
              style="flex:1;background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:11px;padding:5px 6px;border-radius:3px;">
        🔴 Path
      </button>
    </div>

    <!-- Secondary actions -->
    <div style="display:flex;gap:5px;margin-top:5px;">
      <button id="rmap-hide-done-btn" onclick="toggleHideDone()"
              style="flex:1;background:none;border:1px solid var(--border);cursor:pointer;font-family:inherit;font-size:11px;padding:4px 6px;border-radius:3px;"></button>
      <button onclick="exportMarkdown()" title="Copy roadmap as markdown checklist"
              style="flex:1;background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:11px;padding:4px 6px;border-radius:3px;"
              onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--text-dim)'">
        📋 Markdown
      </button>
    </div>

    <!-- Undo / redo / spotlight -->
    <div style="display:flex;gap:5px;margin-top:5px;">
      <button id="rmap-undo-btn" onclick="undo()" disabled
              style="flex:1;background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:11px;padding:4px 6px;border-radius:3px;opacity:.4;">
        ↩ Undo
      </button>
      <button id="rmap-redo-btn" onclick="redo()" disabled
              style="flex:1;background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:11px;padding:4px 6px;border-radius:3px;opacity:.4;">
        ↪ Redo
      </button>
      <button onclick="openSpotlight()" title="Search features (⌘K)"
              style="flex:1;background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:11px;padding:4px 6px;border-radius:3px;"
              onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--text-dim)'">
        ⌘K
      </button>
    </div>

    <!-- Hidden features badge -->
    <div id="rmap-hidden-row" style="display:none;margin-top:6px;align-items:center;gap:8px;font-size:10px;color:var(--text-dim);">
      <span id="rmap-hidden-count" style="color:var(--imported-edge);">0 hidden</span>
      <button onclick="unhideAllFeatures()"
              style="background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:10px;padding:2px 7px;border-radius:3px;">
        ↩ Show all
      </button>
    </div>

    <!-- Add feature form (hidden by default) -->
    <div id="rmap-add-form" style="display:none;margin-top:8px;padding:10px;background:var(--surface2);border:1px solid var(--border);border-radius:3px;">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-dim);margin-bottom:8px;">New Feature</div>
      <input id="rmap-add-name" placeholder="Name (required)" autocomplete="off"
             style="width:100%;background:var(--surface3);border:1px solid var(--border);border-radius:2px;color:var(--text);font-family:inherit;font-size:12px;padding:6px 8px;outline:none;margin-bottom:6px;"
             onfocus="this.style.borderColor='var(--thread-bright)'" onblur="this.style.borderColor='var(--border)'"
             onkeydown="if(event.key==='Enter')submitAddFeatureForm();if(event.key==='Escape')cancelAddFeatureForm()">
      <select id="rmap-add-status"
              style="width:100%;background:var(--surface3);border:1px solid var(--border);border-radius:2px;color:var(--text);font-family:inherit;font-size:11px;padding:5px 8px;outline:none;margin-bottom:6px;">
        <option value="planned">○ Planned</option>
        <option value="in-progress">◐ In Progress</option>
        <option value="complete">✓ Complete</option>
        <option value="blocked">✕ Blocked</option>
      </select>
      <input id="rmap-add-tags" placeholder="Tags (comma-separated, optional)" autocomplete="off"
             style="width:100%;background:var(--surface3);border:1px solid var(--border);border-radius:2px;color:var(--text);font-family:inherit;font-size:11px;padding:5px 8px;outline:none;margin-bottom:6px;"
             onfocus="this.style.borderColor='var(--thread-bright)'" onblur="this.style.borderColor='var(--border)'">
      <textarea id="rmap-add-desc" placeholder="Description (optional)" rows="2"
                style="width:100%;background:var(--surface3);border:1px solid var(--border);border-radius:2px;color:var(--text);font-family:inherit;font-size:11px;padding:6px 8px;outline:none;resize:vertical;margin-bottom:8px;line-height:1.5;"
                onfocus="this.style.borderColor='var(--thread-bright)'" onblur="this.style.borderColor='var(--border)'"></textarea>
      <div style="display:flex;gap:6px;">
        <button onclick="submitAddFeatureForm()"
                style="flex:1;background:var(--thread-bright);border:none;color:#0a0a0a;cursor:pointer;font-family:inherit;font-size:11px;padding:5px 8px;font-weight:600;border-radius:2px;">
          Create
        </button>
        <button onclick="cancelAddFeatureForm()"
                style="background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:11px;padding:5px 10px;border-radius:2px;">
          Cancel
        </button>
      </div>
      <div id="rmap-add-msg" style="font-size:10px;color:var(--text-faint);margin-top:5px;display:none;min-height:14px;"></div>
    </div>

    <!-- Snapshots panel -->
    <details id="rmap-snap-panel" style="margin-top:10px;">
      <summary style="cursor:pointer;user-select:none;list-style:none;display:flex;align-items:center;justify-content:space-between;padding:5px 0;font-size:11px;color:var(--text-dim);">
        <span>📸 Snapshots</span>
        <span id="rmap-snap-badge" style="font-size:10px;color:var(--text-faint);"></span>
      </summary>
      <div style="padding-top:5px;">
        <div style="display:flex;gap:5px;margin-bottom:6px;">
          <input id="rmap-snap-name-inp" placeholder='Name (e.g. "v1 plan")' autocomplete="off"
                 style="flex:1;background:var(--surface3);border:1px solid var(--border);border-radius:2px;color:var(--text);font-family:inherit;font-size:11px;padding:4px 8px;outline:none;"
                 onfocus="this.style.borderColor='var(--thread-bright)'" onblur="this.style.borderColor='var(--border)'"
                 onkeydown="if(event.key==='Enter'){saveSnapshot(this.value.trim());this.value='';}">
          <button onclick="saveSnapshot(document.getElementById('rmap-snap-name-inp')?.value.trim())"
                  style="background:none;border:1px solid var(--border);color:var(--text-dim);cursor:pointer;font-family:inherit;font-size:11px;padding:4px 10px;border-radius:2px;flex-shrink:0;"
                  onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--text-dim)'">
            Save
          </button>
        </div>
        <div id="rmap-snap-list"></div>
      </div>
    </details>

    <!-- Keyboard / UI reference -->
    <div style="margin-top:8px;padding:8px;background:rgba(255,255,255,.02);border:1px solid var(--border);border-radius:3px;font-size:10px;color:var(--text-faint);line-height:1.9;">
      <strong style="color:var(--text-dim);">Filters</strong><br>
      <span style="color:var(--text);">Active</span> — currently being worked on<br>
      <span style="color:var(--text);">Done</span> — completed<br>
      <span style="color:var(--text);">Planned</span> — not started yet<br>
      <span style="color:var(--text);">Blocked</span> — waiting on something external<br>
      <span style="color:var(--text);">⚡ Ready</span> — all deps done, can start now<br><br>
      <strong style="color:var(--text-dim);">Toolbar</strong><br>
      <span style="color:var(--text);">🔴 Path</span> — critical path: longest chain of incomplete deps. What is bottlenecking the entire roadmap. Shown amber.<br>
      <span style="color:var(--text);">⧆ Supertree</span> — prerequisites of the selected node<br>
      <span style="color:var(--text);">⧆ Subtree</span> — features that depend on this one<br><br>
      <strong style="color:var(--text-dim);">Canvas</strong><br>
      Hover node → drag ⟶ to connect<br>
      Hover edge → click to remove<br>
      Right-click canvas → new feature<br>
      ⌘K spotlight · Ctrl+Z undo · Ctrl+Y redo
    </div>
  `;

  header.appendChild(container);

  // Wire up snapshot panel toggle
  const snapPanel = container.querySelector('#rmap-snap-panel');
  if (snapPanel) {
    snapPanel.addEventListener('toggle', () => {
      if (snapPanel.open) renderSnapshotList();
    });
  }

  refreshHiddenCountBadge();
  refreshHideDoneButton();
  refreshUndoButtons();
  renderSnapshotList();
}

// ─────────────────────────────────────────────────────────────
// SECTION 36 — KEYBOARD SHORTCUTS
// ─────────────────────────────────────────────────────────────

document.addEventListener('keydown', function (e) {
  if (!State.isRoadmapMode) return;

  const activeElement = document.activeElement;
  const isTyping = activeElement && (
    activeElement.tagName === 'INPUT' ||
    activeElement.tagName === 'TEXTAREA' ||
    activeElement.isContentEditable
  );

  // Shortcuts that work even while typing
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    e.preventDefault();
    redo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    document.getElementById('rmap-spot-overlay') ? closeSpotlight() : openSpotlight();
    return;
  }

  if (isTyping) return;

  // Shortcuts that don't work while typing
  if (e.key === 'Escape') {
    if (document.getElementById('rmap-spot-overlay')) { closeSpotlight();    e.stopPropagation(); return; }
    if (State.isConnectMode)                           { cancelConnectMode(); e.stopPropagation(); return; }
    if (State.isIsolated)                              { clearIsolation();    e.stopPropagation(); return; }
    if (State.critPathActive)                          { clearCriticalPath(); e.stopPropagation(); return; }
    return;
  }

  if (e.key === 'Tab') {
    e.preventDefault();
    const nodes = State.simNodes || [];
    if (!nodes.length) return;
    const currentIdx = State.selectedId ? nodes.findIndex(n => n.id === State.selectedId) : -1;
    const nextIdx    = e.shiftKey
      ? (currentIdx <= 0 ? nodes.length - 1 : currentIdx - 1)
      : (currentIdx + 1) % nodes.length;
    focusFeature(nodes[nextIdx].id);
    return;
  }

  if ((e.key === 'h' || e.key === 'H') && State.selectedId) {
    hideFeature(State.selectedId);
    e.preventDefault();
    return;
  }
  if (e.key === 'u' || e.key === 'U') { unhideAllFeatures(); e.preventDefault(); return; }
  if (e.key === 'c' || e.key === 'C') { exportMarkdown();    e.preventDefault(); return; }
  if (e.key === '?') {
    showToast('⌘K spotlight · Ctrl+Z undo · Ctrl+Y redo · Tab cycle · H hide · U show all · C copy', 4000);
    e.preventDefault();
  }
}, true);

// ─────────────────────────────────────────────────────────────
// SECTION 37 — CONNECT MODE (legacy toggle, now superseded by drag handle)
// ─────────────────────────────────────────────────────────────

function cancelConnectMode() {
  State.isConnectMode = false;
  State.connectSource = null;

  const banner = document.getElementById('rmap-connect-banner');
  if (banner) banner.style.display = 'none';

  const canvas = document.getElementById('roadmap-canvas');
  if (canvas) canvas.style.cursor = '';

  if (State.dragLine) { State.dragLine.remove(); State.dragLine = null; }

  if (State.nodeGroups) {
    State.nodeGroups.select('circle.rmap-circle')
      .attr('stroke-width', 1)
      .attr('stroke-opacity', 0.65);
  }
}

// ─────────────────────────────────────────────────────────────
// SECTION 38 — SERVER-SENT EVENTS (live reload)
// ─────────────────────────────────────────────────────────────

(function initSSE() {
  const es = new EventSource(`${apiBase()}/events`);

  es.addEventListener('roadmap-updated', () => {
    if (State.isRoadmapMode) loadRoadmapTab();
  });

  es.onerror = () => {
    es.close();
    setTimeout(initSSE, 5000); // Reconnect after 5s
  };
})();

// ─────────────────────────────────────────────────────────────
// PUBLIC API — expose named functions so HTML onclick= attrs work
// ─────────────────────────────────────────────────────────────
//
// Everything above is module-scoped. These assignments expose the
// small subset that inline HTML event attributes need to reach.
//
Object.assign(window, {
  // Tab / load
  loadRoadmapTab,
  setRoadmapFilter,

  // Canvas actions
  openNewFeatureAt,
  fitView: (svg, zoom, W, H, nodes) => fitView(svg || State.svg, zoom || State.zoom, W, H, nodes || State.simNodes),

  // Feature CRUD
  selectFeature,
  focusFeature,
  hideFeature,
  unhideAllFeatures,
  removeDependency,
  addDependency,

  // Inline save handlers
  autoSaveName,
  autoSaveStatus,
  autoSaveDescription,

  // Add form
  openAddFeatureForm,
  cancelAddFeatureForm,
  submitAddFeatureForm,

  // Undo / redo
  undo,
  redo,

  // Snapshots
  saveSnapshot,
  restoreSnapshot,
  deleteSnapshot,

  // Isolation
  isolateSupertree,
  isolateSubtree,
  clearIsolation,

  // Critical path
  toggleCriticalPath,
  clearCriticalPath,

  // Spotlight
  openSpotlight,
  closeSpotlight,
  spotlightHover: () => {}, // placeholder; real fn assigned inside openSpotlight
  spotlightPick:  () => {}, // placeholder

  // UI toggles
  toggleHideDone,
  cancelConnectMode,

  // Export
  exportMarkdown,

  // Context menu
  hideContextMenu,
});