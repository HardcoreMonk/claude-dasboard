// ─── Cache busting ────────────────────────────────────────────────────
// Cache strategy is handled by the BACKEND:
//   1. @app.get("/") sends Cache-Control: no-store so the HTML shell always
//      refetches and picks up the current ?v=N or .vN filename markers.
//   2. /static/app.vN.js routes strip the .vN segment → same-file-different-
//      URL, bypassing any proxy that drops query strings.
// No client-side defense needed. This project never registers a service
// worker, so there's nothing to unregister here.

// ─── Persisted preferences (localStorage) ─────────────────────────────
const PREFS_KEY = 'claude-dashboard-prefs-v1';
function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function savePrefs(patch) {
  try {
    const cur = loadPrefs();
    const next = { ...cur, ...patch };
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    return next;
  } catch {
    return patch;
  }
}
const _prefs = loadPrefs();

// ─── State ──────────────────────────────────────────────────────────────
const state = {
  ws: null, stats: null, charts: {},
  currentPage: 1, totalPages: 1, searchQuery: '',
  currentSession: null,
  usageRange: _prefs.usageRange || '24h',
  theme: _prefs.theme || 'dark',
  dateFrom: _prefs.dateFrom || '',
  dateTo: _prefs.dateTo || '',
  advFilters: _prefs.advFilters || {},
  toastSeq: 0,
  pendingDeletes: {},    // id → { timer, row }
  newDataCounts: { sessions: 0, projects: 0 },
  bulkSelected: new Set(),  // session IDs selected for bulk ops
  lastUpdated: {},
  convSource: _prefs.convSource || 'claude-code',  // 'claude-code' | 'claude-ai'
  nodes: [],  // [{node_id, label, session_count, message_count, last_seen}]
};

// ─── Event bus (CustomEvent on document) ──────────────────────────────
// Decouples cross-file communication. Modules emit/listen without knowing
// each other. Events: 'dash:refresh', 'dash:viewChange', 'dash:themeChange'.
const bus = {
  emit(name, detail) { document.dispatchEvent(new CustomEvent('dash:' + name, { detail })); },
  on(name, fn) { document.addEventListener('dash:' + name, (e) => fn(e.detail)); },
};

// ─── Event delegation ────────────────────────────────────────────────
// Central click handler for data-action attributes. New code should prefer
// <button data-action="fnName"> over onclick="fnName()".
// The delegator calls window[action]() if it exists.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const fn = window[action];
  if (typeof fn !== 'function') return;
  e.preventDefault();
  // Collect data-arg-* attributes as positional arguments
  const args = [];
  // data-arg as single argument, or data-arg0, data-arg1, ... for multiple
  if (el.dataset.arg !== undefined) {
    args.push(el.dataset.arg);
  }
  for (let i = 0; ; i++) {
    const key = 'arg' + i;
    if (el.dataset[key] === undefined) break;
    args.push(el.dataset[key]);
  }
  // Coerce "true"/"false" strings to actual booleans
  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'true') args[i] = true;
    else if (args[i] === 'false') args[i] = false;
  }
  // If the function expects the clicked element (e.g. setUsageRange), pass el as first arg
  if (el.dataset.passEl !== undefined) args.unshift(el);
  fn(...args);
});

// ─── State accessor functions ────────────────────────────────────────
// Cross-file code MUST use these instead of touching state.* directly.
function getChart(name) { return state.charts[name] || null; }
function setChart(name, instance) {
  if (state.charts[name]) { try { state.charts[name].destroy(); } catch {} }
  state.charts[name] = instance;
}
function destroyChart(name) {
  if (state.charts[name]) { try { state.charts[name].destroy(); } catch {} state.charts[name] = null; }
}
// Session/filter state accessors
function setPage(p) { state.currentPage = p; }
function getPage() { return state.currentPage; }
function setSearchQuery(q) { state.searchQuery = q; }
function getSearchQuery() { return state.searchQuery; }
function setAdvFilters(f) { state.advFilters = f; }
function getAdvFilters() { return state.advFilters || {}; }
function getSortState(view) { return sortState[view]; }
function setSortState(view, obj) { Object.assign(sortState[view], obj); }

// ─── Sort state (persisted) ────────────────────────────────────────────
const sortState = {
  sessions:      { key:'updated_at',  order:'desc', pinned_only: false },
  projects:      { key:'last_active', order:'desc' },
  models:        { key:'messages',    order:'desc' },
  conversations: { key:'updated_at',  order:'desc' },
};
// Merge persisted values on boot (keys only, ignore unknown fields)
Object.keys(sortState).forEach(k => {
  const saved = _prefs[`sort_${k}`];
  if (saved && typeof saved === 'object') {
    Object.assign(sortState[k], saved);
  }
});
function persistSort(view) {
  savePrefs({ [`sort_${view}`]: sortState[view] });
}
function toggleSessionsPinnedOnly() {
  sortState.sessions.pinned_only = !sortState.sessions.pinned_only;
  state.currentPage = 1;
  persistSort('sessions');
  loadSessions();
}
function toggleSort(view, key) {
  const s = sortState[view];
  if (s.key === key) s.order = s.order === 'asc' ? 'desc' : 'asc';
  else { s.key = key; s.order = 'desc'; }
  persistSort(view);
  if (view === 'sessions')      { state.currentPage = 1; loadSessions(); }
  else if (view === 'projects') loadProjects();
  else if (view === 'models')   loadModels();
  else if (view === 'conversations') loadConvList();
}
function sortArrowHtml(view, key) {
  const s = sortState[view];
  if (s.key !== key) return '<span class="text-white/15 ml-1">↕</span>';
  return s.order === 'asc'
    ? '<span class="text-accent ml-1">↑</span>'
    : '<span class="text-accent ml-1">↓</span>';
}
function sortThHtml(view, col, label, align = 'text-left', extraCls = '') {
  const s = sortState[view];
  const ariaSort = s.key === col ? (s.order === 'asc' ? 'ascending' : 'descending') : 'none';
  return `<th aria-sort="${ariaSort}" class="${align} ${extraCls} px-3 py-2.5 font-bold cursor-pointer select-none hover:text-white/70 spring" onclick="toggleSort('${view}','${col}')" onkeydown="if(event.key==='Enter'||event.key===' ')toggleSort('${view}','${col}')" tabindex="0" role="button">${label}${sortArrowHtml(view, col)}</th>`;
}
function sortPillHtml(view, col, label, size = 'text-[10px]') {
  const s = sortState[view];
  const active = s.key === col;
  const arr = active ? (s.order === 'asc' ? ' ↑' : ' ↓') : '';
  return `<button onclick="toggleSort('${view}','${col}')" class="px-3 py-1 rounded-full border spring ${size} font-semibold ${active ? 'bg-accent/15 text-accent border-accent/30' : 'text-white/45 border-white/[0.07] hover:text-white/70'}">${label}${arr}</button>`;
}

// ─── Navigation + URL hash routing ─────────────────────────────────────
const VALID_VIEWS = new Set(['overview','cost','sessions','conversations','models','projects','subagents','timeline','search','export']);

function showView(view, { updateHash = true } = {}) {
  if (!VALID_VIEWS.has(view)) view = 'overview';
  document.querySelectorAll('.nav-pill[data-view]').forEach(b => {
    const active = b.dataset.view === view;
    b.classList.toggle('active', active);
    b.classList.toggle('text-white/40', !active);
    // U13: mark current nav item for assistive tech
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  clearNewDataBadge();
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  const el = document.getElementById('view-' + view);
  if (el) {
    el.classList.remove('hidden');
    el.querySelectorAll('.anim-in').forEach(a => { a.style.animation = 'none'; a.offsetHeight; a.style.animation = ''; });
    // Scroll-reveal: re-arm .reveal elements that became visible
    requestAnimationFrame(() => scrollRevealView(el));
  }
  if (updateHash) {
    const want = '#/' + view;
    if (location.hash !== want) history.replaceState(null, '', want);
  }
  onViewChange(view);
}

document.querySelectorAll('.nav-pill[data-view]').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

function onViewChange(view) {
  // Clean up timers from previous view
  if (typeof clearPlanTimer === 'function') clearPlanTimer();
  // Destroy overview/cost chart instances when leaving a chart-bearing view
  // to avoid Chart.js re-init conflicts on return. Project modal chart
  // (projDaily) has its own lifecycle and is left alone.
  if (view !== 'cost') {
    ['usage','models','dailyCost','cache','stopReason','modelCache'].forEach(k => destroyChart(k));
  } else {
    loadCharts();
  }
  if (view !== 'timeline') {
    destroyChart('timeline');
    if (typeof cleanupTimelineCharts === 'function') cleanupTimelineCharts();
  }
  if (view === 'sessions') loadSessions();
  if (view === 'conversations') loadConvList();
  if (view === 'models') loadModels();
  if (view === 'projects') loadProjects();
  if (view === 'subagents') { loadSubagentHeatmap(); loadSubagentDetails(); loadSubagentSuccessMatrix(); }
  if (view === 'timeline' && typeof loadTimeline === 'function') loadTimeline();
  if (view === 'export') { loadDbSize(); renderNodeList(); loadAdminStatus(); loadSchedule(); loadAuditLog(); }
  if (view === 'search') { setTimeout(() => document.getElementById('srchInput')?.focus(), 80); }
}

function parseHash() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  const [view, ...rest] = h.split('/');
  return { view: view || 'overview', rest };
}

function applyHash() {
  const { view, rest } = parseHash();
  showView(view, { updateHash: false });
  // Deep-link: #/project/<name>?path=<path>  opens a project modal
  if (view === 'project' && rest.length) {
    const q = location.hash.split('?')[1] || '';
    const params = new URLSearchParams(q);
    const name = decodeURIComponent(rest.join('/'));
    showView('projects', { updateHash: false });
    showProjectDetail(name, params.get('path') || null);
  }
}

window.addEventListener('hashchange', applyHash);

// ─── Safe Fetch (retry + timeout + deduplication) ───────────────────────
const FETCH_MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 15000;
const _inflightRequests = new Map();  // url → Promise
async function safeFetch(url) {
  // Deduplicate: if an identical GET is already in-flight, piggyback on it
  const existing = _inflightRequests.get(url);
  if (existing) return existing;
  const promise = _safeFetchInner(url).finally(() => {
    _inflightRequests.delete(url);
  });
  _inflightRequests.set(url, promise);
  return promise;
}
async function _safeFetchInner(url) {
  let lastErr;
  for (let attempt = 0; attempt < FETCH_MAX_RETRIES; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (r.ok) return r.json();
      // 5xx → retry with backoff; 4xx → fail immediately
      if (r.status < 500) throw new Error(`HTTP ${r.status}`);
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
      if (e.name === 'AbortError') lastErr = new Error('요청 시간 초과');
      // Don't retry on 4xx (thrown above) or non-network errors
      if (lastErr.message.startsWith('HTTP 4')) throw lastErr;
    }
    // Exponential backoff: 500ms, 1s, 2s
    if (attempt < FETCH_MAX_RETRIES - 1) {
      await new Promise(ok => setTimeout(ok, 500 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

// ─── Toast system ─────────────────────────────────────────────────────
// showToast(msg, {type, undoFn, duration})
//   type: 'info' | 'success' | 'warning' | 'error'
//   undoFn: if present, shows an "되돌리기" button for `duration` ms
function showToast(msg, opts = {}) {
  const tray = document.getElementById('toastTray');
  if (!tray) return;
  const type = opts.type || 'info';
  const duration = opts.duration || (opts.undoFn ? 5000 : 3000);
  const id = 'toast-' + (++state.toastSeq);
  const colors = {
    info:    'bg-white/[0.08] ring-white/[0.12] text-white/85',
    success: 'bg-emerald-500/10 ring-emerald-400/30 text-emerald-200',
    warning: 'bg-amber-500/10 ring-amber-400/30 text-amber-200',
    error:   'bg-red-500/10 ring-red-400/30 text-red-200',
  };
  const icons = { info: 'ⓘ', success: '✓', warning: '⚠', error: '✕' };
  const el = document.createElement('div');
  el.id = id;
  el.className = `pointer-events-auto ring-1 backdrop-blur-md rounded-xl px-4 py-3 shadow-[0_10px_30px_rgba(0,0,0,.5)] text-[12px] flex items-center gap-3 anim-in ${colors[type]}`;
  el.style.minWidth = '260px';
  el.innerHTML = `
    <span class="text-base">${icons[type]}</span>
    <span class="flex-1">${esc(msg)}</span>
    ${opts.undoFn ? `<button class="px-2 py-0.5 rounded-full bg-white/10 hover:bg-white/20 text-[11px] font-bold spring" data-undo>되돌리기</button>` : ''}
    <button class="text-white/40 hover:text-white/80 text-lg leading-none spring" data-close>&times;</button>
  `;
  tray.appendChild(el);
  let cancelled = false;
  const remove = () => { el.style.opacity = '0'; el.style.transform = 'translateX(12px)'; setTimeout(() => el.remove(), 300); };
  el.querySelector('[data-close]').addEventListener('click', remove);
  const undoBtn = el.querySelector('[data-undo]');
  if (undoBtn) {
    undoBtn.addEventListener('click', () => {
      cancelled = true;
      try { opts.undoFn(); } catch(e) { console.error(e); }
      showToast('되돌림', { type: 'info', duration: 1500 });
      remove();
    });
  }
  const timer = setTimeout(() => { if (!cancelled && opts.onExpire) opts.onExpire(); remove(); }, duration);
  el.addEventListener('click', (e) => { if (e.target === el) remove(); });
  return { id, remove, cancel: () => { cancelled = true; clearTimeout(timer); remove(); } };
}

// ─── Type-to-confirm delete modal (S1) ───────────────────────────────
// Used by deleteSession / deleteProject / runRetention. Caller supplies:
//   target:    the exact string the user must re-type (e.g. project name)
//   message:   human-readable description of what will be deleted
//   onConfirm: async function run if the user types the name + clicks button
let _pendingDelete = null;

function openDeleteConfirm({ target, message, onConfirm }) {
  _pendingDelete = { target: String(target || ''), onConfirm };
  document.getElementById('delConfirmMessage').textContent = message || '';
  document.getElementById('delConfirmTarget').textContent = _pendingDelete.target;
  const input = document.getElementById('delConfirmInput');
  const btn = document.getElementById('delConfirmBtn');
  const mismatch = document.getElementById('delConfirmMismatch');
  input.value = '';
  btn.disabled = true;
  mismatch.classList.add('hidden');
  const check = () => {
    const match = input.value === _pendingDelete.target;
    btn.disabled = !match;
    mismatch.classList.toggle('hidden', match || input.value.length === 0);
  };
  input.oninput = check;
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !btn.disabled) { e.preventDefault(); runPendingDelete(); }
    if (e.key === 'Escape') { e.preventDefault(); closeDeleteConfirm(); }
  };
  document.getElementById('deleteConfirmModal').classList.remove('hidden');
  setTimeout(() => input.focus(), 50);
}

function closeDeleteConfirm() {
  document.getElementById('deleteConfirmModal').classList.add('hidden');
  _pendingDelete = null;
}

async function runPendingDelete() {
  if (!_pendingDelete) return;
  const { onConfirm } = _pendingDelete;
  closeDeleteConfirm();
  try {
    await onConfirm();
  } catch (e) {
    console.error('runPendingDelete:', e);
    showToast('삭제 실패: ' + (e.message || e), { type: 'error' });
  }
}

// ─── Focus trap for modals (U13) ──────────────────────────────────────
// Traps Tab / Shift+Tab inside an element when it's visible. Used for
// projectModal, kbdHelp, commandPalette, planModal. The handler is
// delegated so we don't need per-modal setup.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  // Find the topmost visible modal that needs trapping
  const candidates = [
    document.getElementById('commandPalette'),
    document.getElementById('projectModal'),
    document.getElementById('planModal'),
    document.getElementById('kbdHelp'),
    document.getElementById('tagEditModal'),
    document.getElementById('deleteConfirmModal'),
  ].filter(m => m && !m.classList.contains('hidden') && getComputedStyle(m).display !== 'none');
  if (!candidates.length) return;
  const modal = candidates[candidates.length - 1];
  const focusable = modal.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

// ─── Cost forecasting + burn-rate + drill helpers ─────────────────────
// Moved to static/overview.js (loadForecast, drillToSessionsToday/Week).

// ─── Filter presets (B2) ─────────────────────────────────────────────  (moved)
// Moved to static/sessions.js.

// ─── Bulk operations (B1) ────────────────────────────────────────────  (moved)
// Moved to static/sessions.js.

// ─── Last-updated tracker (U5) ────────────────────────────────────────
// Each key (stats / charts / sessions etc.) records a timestamp on
// successful load; an interval rewrites rel-times in elements that
// carry `data-updated-for`.
function markUpdated(key) { state.lastUpdated[key] = Date.now(); refreshUpdatedLabels(); }
function refreshUpdatedLabels() {
  document.querySelectorAll('[data-updated-for]').forEach(el => {
    const key = el.dataset.updatedFor;
    const ts = state.lastUpdated[key];
    if (!ts) { el.textContent = ''; return; }
    const df = Date.now() - ts;
    let txt;
    if (df < 5_000) txt = '방금';
    else if (df < 60_000) txt = `${Math.floor(df / 1000)}초 전`;
    else if (df < 3_600_000) txt = `${Math.floor(df / 60_000)}분 전`;
    else txt = `${Math.floor(df / 3_600_000)}시간 전`;
    el.textContent = `업데이트 ${txt}`;
  });
}
setInterval(refreshUpdatedLabels, 15_000);

// ─── Chart download helper (U15) ─────────────────────────────────────
// Chart.js supports legend-click toggle out of the box. We add a small
// download button for each chart so users can export the current view
// as a PNG image (useful for reports).
function downloadChart(key, filename) {
  const chart = state.charts[key];
  if (!chart) return;
  try {
    const url = chart.toBase64Image();
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || `${key}-${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
  } catch (e) {
    console.error('downloadChart:', e);
    showToast('차트 내보내기 실패', { type: 'error' });
  }
}

// ─── Command palette (U7) ────────────────────────────────────────────
const cmdkState = {
  items: [],          // [{label, hint, icon, action}]
  filtered: [],
  cursor: 0,
  projects: null,     // lazy-cached from /api/projects
  projectsAt: 0,      // timestamp of last projects fetch
  subagents: null,
};
const _CMDK_CACHE_TTL = 30000; // 30 seconds

function _cmdkStaticItems() {
  return [
    { label: '개요',      hint: '대시보드', icon: 'solar:chart-square-linear', action: () => showView('overview') },
    { label: '비용',      hint: '토큰/비용 차트', icon: 'solar:graph-up-linear', action: () => showView('cost') },
    { label: '세션',      hint: '전체 세션 목록', icon: 'solar:list-check-linear', action: () => showView('sessions') },
    { label: '대화',      hint: '대화 뷰어', icon: 'solar:chat-round-line-linear', action: () => showView('conversations') },
    { label: '모델',      hint: '모델 분석', icon: 'solar:cpu-bolt-linear', action: () => showView('models') },
    { label: '프로젝트',   hint: '프로젝트 목록', icon: 'solar:folder-open-linear', action: () => showView('projects') },
    { label: 'Subagent',  hint: '히트맵 + 종료 매트릭스', icon: 'solar:widget-2-linear', action: () => showView('subagents') },
    { label: '검색',      hint: '전체 메시지 검색', icon: 'solar:magnifer-linear', action: () => showView('search') },
    { label: '타임라인',  hint: '작업 Gantt 차트', icon: 'solar:calendar-linear', action: () => showView('timeline') },
    { label: '관리',      hint: 'CSV / 백업 / 보존', icon: 'solar:database-linear', action: () => showView('export') },
    { label: '예산 설정',  hint: '플랜/예산 편집', icon: 'solar:settings-linear', action: () => openPlanSettings() },
    { label: '다크/라이트 전환', hint: '테마 토글', icon: 'solar:sun-linear', action: () => toggleTheme() },
    { label: '키보드 단축키', hint: '도움말 표시', icon: 'solar:keyboard-linear', action: () => showKbdHelp() },
  ];
}

async function _cmdkLoadProjects() {
  if (cmdkState.projects && (Date.now() - cmdkState.projectsAt) < _CMDK_CACHE_TTL) return cmdkState.projects;
  try {
    const d = await safeFetch('/api/projects?sort=last_active&order=desc');
    cmdkState.projects = (d.projects || []).map(p => ({
      label: p.project_name || '—',
      hint: p.project_path || '',
      icon: 'solar:folder-linear',
      action: () => showProjectDetail(p.project_name, p.project_path),
      _type: 'project',
    }));
    cmdkState.projectsAt = Date.now();
  } catch {
    cmdkState.projects = [];
    cmdkState.projectsAt = Date.now();
  }
  return cmdkState.projects;
}

function fuzzyScore(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return 10 - (t.indexOf(q) / (t.length || 1));
  // Simple subsequence scoring
  let qi = 0, score = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) { score++; qi++; }
  }
  return qi === q.length ? score / q.length : 0;
}

function renderCommandPalette(query = '') {
  const results = document.getElementById('cmdkResults');
  if (!results) return;
  const q = query.trim();
  const items = [
    ..._cmdkStaticItems(),
    ...(cmdkState.projects || []),
  ];
  const scored = items
    .map(it => ({ it, s: fuzzyScore(q, (it.label || '') + ' ' + (it.hint || '')) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 40)
    .map(x => x.it);
  cmdkState.filtered = scored;
  cmdkState.cursor = Math.min(cmdkState.cursor, Math.max(0, scored.length - 1));
  if (!scored.length) {
    results.innerHTML = '<div class="px-4 py-6 text-center text-white/30 text-[11px]">결과 없음</div>';
    return;
  }
  results.innerHTML = scored.map((it, i) => {
    const active = i === cmdkState.cursor;
    return `<button data-idx="${i}" class="w-full text-left px-4 py-2 flex items-center gap-3 ${active ? 'bg-accent/10' : 'hover:bg-white/[0.04]'} spring">
      <iconify-icon icon="${esc(it.icon || 'solar:play-linear')}" width="16" class="${active ? 'text-accent' : 'text-white/40'}"></iconify-icon>
      <div class="flex-1 min-w-0">
        <div class="text-[12px] font-semibold ${active ? 'text-accent' : 'text-white/80'} truncate">${esc(it.label)}</div>
        ${it.hint ? `<div class="text-[10px] text-white/35 truncate">${esc(it.hint)}</div>` : ''}
      </div>
    </button>`;
  }).join('');
  results.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const it = cmdkState.filtered[idx];
      if (it) { closeCommandPalette(); it.action(); }
    });
  });
}

async function openCommandPalette() {
  const modal = document.getElementById('commandPalette');
  if (!modal) return;
  modal.classList.remove('hidden');
  const input = document.getElementById('cmdkInput');
  if (input) { input.value = ''; setTimeout(() => input.focus(), 50); }
  cmdkState.cursor = 0;
  await _cmdkLoadProjects();
  renderCommandPalette('');
}

function closeCommandPalette() {
  const modal = document.getElementById('commandPalette');
  if (modal) modal.classList.add('hidden');
}

// Wire keyboard: Cmd/Ctrl+K opens, type to filter, ↑↓ to navigate, Enter to execute
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openCommandPalette();
    return;
  }
  const modal = document.getElementById('commandPalette');
  if (!modal || modal.classList.contains('hidden')) return;
  if (e.key === 'Escape') { e.preventDefault(); closeCommandPalette(); return; }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    cmdkState.cursor = Math.min(cmdkState.filtered.length - 1, cmdkState.cursor + 1);
    renderCommandPalette(document.getElementById('cmdkInput').value);
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    cmdkState.cursor = Math.max(0, cmdkState.cursor - 1);
    renderCommandPalette(document.getElementById('cmdkInput').value);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const it = cmdkState.filtered[cmdkState.cursor];
    if (it) { closeCommandPalette(); it.action(); }
    return;
  }
});
// Bind the input's live filter once DOM is ready (script runs at end of body)
{
  const input = document.getElementById('cmdkInput');
  if (input) {
    input.addEventListener('input', () => { cmdkState.cursor = 0; renderCommandPalette(input.value); });
  }
}

// ─── Auth: logout + session check ────────────────────────────────────
async function logoutDashboard() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}
async function checkAuth() {
  try {
    const d = await fetch('/api/auth/me').then(r => r.json());
    if (d.auth_required && !d.authenticated) {
      window.location.href = '/login';
      return;
    }
    const btn = document.getElementById('logoutBtn');
    if (btn && d.auth_required) btn.classList.remove('hidden');
  } catch (e) { /* no-op if auth endpoint unavailable */ }
}

// ─── Node list loader ────────────────────────────────────────────────
async function loadNodes() {
  try {
    const d = await safeFetch('/api/nodes');
    state.nodes = d.nodes || [];
    const sel = document.getElementById('advNodeFilter');
    if (sel) {
      const cur = sel.value;
      sel.textContent = '';
      const all = document.createElement('option'); all.value = ''; all.textContent = '\uC804\uCCB4 \uB178\uB4DC'; sel.appendChild(all);
      for (const n of state.nodes) {
        const o = document.createElement('option');
        o.value = n.node_id; o.textContent = n.label || n.node_id;
        if (n.session_count) o.textContent += ' (' + n.session_count + ')';
        sel.appendChild(o);
      }
      sel.value = cur;
    }
  } catch (e) { /* nodes API unavailable — single-node mode */ }
}

// ─── Error reporting helper (A5) ─────────────────────────────────────
// Tracks consecutive failures per-context. First failure shows a toast;
// 3+ consecutive failures for the same context show a persistent banner
// so the user knows something is systematically wrong.
const _errorConsecutive = {};
function reportError(ctx, e) {
  console.error(ctx + ':', e);
  const count = (_errorConsecutive[ctx] || 0) + 1;
  _errorConsecutive[ctx] = count;
  if (count >= 3) {
    // Persistent banner — stays until next success
    _showErrorBanner(ctx, e);
  } else {
    showToast(`${ctx} 실패: ${e?.message || e}`, { type: 'error', duration: 4000 });
  }
}
function reportSuccess(ctx) {
  if (_errorConsecutive[ctx]) {
    _errorConsecutive[ctx] = 0;
    _hideErrorBanner(ctx);
  }
}
function _showErrorBanner(ctx, e) {
  let banner = document.getElementById('persistentErrorBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'persistentErrorBanner';
    banner.className = 'fixed top-16 left-1/2 -translate-x-1/2 z-50 px-5 py-2.5 rounded-xl bg-red-500/15 ring-1 ring-red-500/30 backdrop-blur-xl text-[12px] text-red-300 font-semibold flex items-center gap-3 shadow-lg';
    document.body.appendChild(banner);
  }
  banner.textContent = '';
  const icon = document.createElement('span');
  icon.textContent = '⚠';
  const msg = document.createElement('span');
  msg.textContent = `${ctx} 연속 실패 — ${e?.message || '서버 연결을 확인하세요'}`;
  const btn = document.createElement('button');
  btn.className = 'ml-2 px-2 py-0.5 rounded-full bg-red-500/20 text-red-200 text-[10px] font-bold hover:bg-red-500/30 spring';
  btn.textContent = '닫기';
  btn.addEventListener('click', () => banner.remove());
  banner.append(icon, msg, btn);
  banner.style.display = 'flex';
}
function _hideErrorBanner(ctx) {
  const banner = document.getElementById('persistentErrorBanner');
  if (banner) banner.remove();
}

// ─── Empty / error state helpers (U6) ────────────────────────────────
function renderEmpty(container, { title='데이터 없음', hint='', icon='solar:database-linear' } = {}) {
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  if (!el) return;
  el.innerHTML = `
    <div class="flex flex-col items-center justify-center text-center py-10">
      <iconify-icon icon="${esc(icon)}" width="32" class="text-white/20 mb-2"></iconify-icon>
      <div class="text-sm font-semibold text-white/50">${esc(title)}</div>
      ${hint ? `<div class="text-[11px] text-white/30 mt-1">${esc(hint)}</div>` : ''}
    </div>`;
}
function renderError(container, err, retryFn) {
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  if (!el) return;
  const msg = err && err.message ? err.message : String(err || '알 수 없는 오류');
  const retryId = 'retry-' + Math.random().toString(36).slice(2);
  el.innerHTML = `
    <div class="flex flex-col items-center justify-center text-center py-10">
      <iconify-icon icon="solar:danger-triangle-linear" width="32" class="text-red-400/50 mb-2"></iconify-icon>
      <div class="text-sm font-semibold text-red-300/80">로딩 실패</div>
      <div class="text-[11px] text-white/40 mt-1 max-w-md">${esc(msg)}</div>
      ${retryFn ? `<button id="${retryId}" class="mt-3 px-3 py-1 rounded-full bg-accent/10 text-accent border border-accent/20 text-[10px] font-bold spring hover:scale-[1.02]">다시 시도</button>` : ''}
    </div>`;
  if (retryFn) {
    const btn = document.getElementById(retryId);
    if (btn) btn.addEventListener('click', retryFn);
  }
}

// ─── Theme (dark / light) ─────────────────────────────────────────────
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  document.body.classList.toggle('theme-light', theme === 'light');
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.textContent = theme === 'light' ? '🌙' : '☀';
    btn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
  }
}
function toggleTheme() {
  const next = state.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  savePrefs({ theme: next });
  // Flip Chart.js colors live — otherwise user has to nav away and back.
  refreshChartsForTheme();
}
applyTheme(state.theme);

// ─── WebSocket (infinite reconnect with backoff cap) ───────────────────
let wsRetryCount = 0;
let wsRetryTimer = null;
const WS_BASE = 2000, WS_MAX_DELAY = 30000;

function connectWS() {
  if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
  try {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    state.ws = new WebSocket(`${proto}//${location.host}/ws`);
  } catch (e) {
    console.warn('WS create failed:', e);
    scheduleWsReconnect();
    return;
  }
  state.ws.onopen = () => {
    wsRetryCount = 0;
    setWsStatus('connected', '연결됨');
    // Refresh scalar overview data on each (re)connect. Charts are
    // owned by onViewChange('overview') — loadCharts is NOT called here
    // to avoid duplicate destroy+recreate cycles during boot.
    loadStats();
    loadPeriods();
    loadPlanUsage();
    loadTopProjects();
    loadForecast();
  };
  state.ws.onmessage = (e) => {
    if (e.data === 'pong') return;
    try {
      const m = JSON.parse(e.data);
      if (m.type === 'ping') { state.ws.send('pong'); return; }
      handleWsMessage(m);
    } catch (er) { console.warn('WS parse:', er); }
  };
  state.ws.onclose = () => scheduleWsReconnect();
  state.ws.onerror = () => setWsStatus('error', '오류');
}

function scheduleWsReconnect() {
  // Exponential backoff up to WS_MAX_DELAY, then level. No give-up.
  const delay = Math.min(WS_BASE * Math.pow(2, wsRetryCount), WS_MAX_DELAY);
  wsRetryCount++;
  setWsStatus('', `재연결 #${wsRetryCount}…`);
  wsRetryTimer = setTimeout(connectWS, delay);
}

function forceReconnectWs() {
  try { if (state.ws) state.ws.close(); } catch {}
  wsRetryCount = 0;
  connectWS();
}

// Debounced refresh: WS broadcasts many batch_update events in short bursts
// during heavy scanning. Coalesce them to one full reload per ~800ms.
let _refreshTimer = null;
function debouncedRefresh() {
  if (_refreshTimer) return;
  _refreshTimer = setTimeout(() => {
    _refreshTimer = null;
    bus.emit('refresh');
  }, 800);
}

// Core module listens to its own event — other modules can also listen
bus.on('refresh', () => {
  loadStats(); loadPeriods(); loadPlanUsage(); loadTopProjects();
  if (location.hash.startsWith('#/cost')) loadCharts();
  if (typeof convRefreshTail === 'function') convRefreshTail();
});

// ─── Idle chime (Web Audio API) ───────────────────────────────────────
// Short two-note chime (C5 → G5 perfect fifth, ~300ms) played on end_turn
// detection so the user notices "Claude is idle" even without looking at the
// dashboard tab. Uses Web Audio API — no external MP3/OGG file, no network,
// no CORS issues. Respects _prefs.idleNotify (same toggle as the badge).
let _audioCtx = null;
function _ensureAudioCtx() {
  if (_audioCtx) return _audioCtx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) _audioCtx = new AC();
  } catch (e) { _audioCtx = null; }
  return _audioCtx;
}
// Browsers suspend AudioContext until a user gesture. Prime it on any click.
document.addEventListener('click', () => {
  const ctx = _ensureAudioCtx();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}, { once: true, capture: true });

// Chime queue — ensures rapid-fire end_turn events produce audibly distinct
// chimes instead of overlapping at the same ctx.currentTime (which sounds
// like one blob). Each chime is scheduled AFTER the previous one ends.
const CHIME_LEN = 0.37;   // total audible duration
const CHIME_GAP = 0.05;   // silence between back-to-back chimes
const CHIME_QUEUE_CAP = 2.0;  // don't queue more than 2s into the future
let _chimeNextStart = 0;

function _playIdleChime() {
  const ctx = _ensureAudioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  const now = ctx.currentTime;
  // Start either immediately, or right after the previously-queued chime
  // finishes (plus a small gap so consecutive chimes are audibly separate).
  let start = Math.max(now, _chimeNextStart + CHIME_GAP);
  // Cap the queue — if we're scheduling more than 2s in the future, drop
  // this chime entirely. Prevents a large burst from spamming audio forever.
  if (start > now + CHIME_QUEUE_CAP) return;
  _chimeNextStart = start + CHIME_LEN;

  const master = ctx.createGain();
  master.gain.value = 0.15;  // quiet
  master.connect(ctx.destination);

  // Two-note chime — slightly overlapping C5 and G5 (perfect fifth, pleasant)
  const notes = [
    { freq: 523.25, offset: 0.00, duration: 0.18 },
    { freq: 783.99, offset: 0.09, duration: 0.28 },
  ];
  notes.forEach(n => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = n.freq;
    osc.connect(gain);
    gain.connect(master);
    // Quick attack, exponential release
    gain.gain.setValueAtTime(0, start + n.offset);
    gain.gain.linearRampToValueAtTime(1, start + n.offset + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, start + n.offset + n.duration);
    osc.start(start + n.offset);
    osc.stop(start + n.offset + n.duration + 0.05);
  });
}

// ─── Idle indicator (작업 완료 → 입력 대기) ────────────────────────────
// When an assistant message with stop_reason === end_turn arrives, mark the
// project as "idle, awaiting user input". The TOP 5 renderer picks this up
// and prepends a small toast-style pill badge to the LEFT of the project
// name. When a subsequent non-end_turn message arrives (tool_use means Claude
// is working again, user means user replied), clear the badge.
//
// NO global toasts, OS notifications, or title flashes — the signal lives
// inline with the project row.
state.idleProjects = {};  // projectKey → { ts, preview, project_name, project_path }

function _idleKey(p) {
  return (p.project_name || '') + '|' + (p.project_path || '');
}

// Per-project timers for pending tool_use messages. When Claude calls a
// tool (especially Bash with command_substitution), Claude Code may show
// the user a "Do you want to proceed?" permission prompt. From the
// dashboard's view, all we see is an assistant message with stop_reason=
// 'tool_use' followed by silence — there's no explicit marker. We use a
// 5-second idle window: if no follow-up arrives for the *project*, treat
// it as "waiting for user input" (likely a permission prompt or
// confirmation).
//
// Keyed by project key (not session_id) so that subagent activity in the
// same project correctly cancels the parent session's pending timer.
const _pendingToolUseTimers = new Map();  // projectKey → setTimeout handle
const TOOL_USE_IDLE_DELAY_MS = 15000;

function _cancelPendingToolUse(projectKey) {
  const handle = _pendingToolUseTimers.get(projectKey);
  if (handle) {
    clearTimeout(handle);
    _pendingToolUseTimers.delete(projectKey);
  }
}

function notifyIdleFromBatch(records) {
  if (!Array.isArray(records) || !records.length) return;
  if (_prefs.idleNotify === false) return;  // opt-out via settings
  let changed = false;
  // Collect projects that became newly idle (chime-worthy) in THIS batch.
  // Chimes are deferred until after the entire batch is processed so that
  // an intermediate end_turn followed by more tool_use in the same batch
  // does NOT produce a spurious chime.
  const newlyIdle = new Set();
  for (const r of records) {
    if (!r || r.type !== 'new_message') continue;
    const key = _idleKey(r);
    if (!key) continue;

    // Any new message for this project cancels a previously-scheduled
    // tool_use idle timer — Claude (or a subagent) is still active.
    _cancelPendingToolUse(key);

    if (r.stop_reason === 'end_turn') {
      if (r.is_subagent) {
        // Subagent finished — parent will receive the result and continue.
        // Clear any active status (don't mark idle).
        if (state.idleProjects[key]) {
          delete state.idleProjects[key];
          changed = true;
        }
        newlyIdle.delete(key);
      } else {
        // Parent/main session finished its turn — flag as idle.
        state.idleProjects[key] = {
          ts: Date.now(),
          preview: (r.preview || '').slice(0, 160),
          project_name: r.project_name,
          project_path: r.project_path,
          reason: 'end_turn',
        };
        changed = true;
        newlyIdle.add(key);
      }
    } else if (r.stop_reason === 'tool_use') {
      if (r.is_subagent) {
        // Subagent called a tool — subagent is actively working.
        state.idleProjects[key] = {
          ts: Date.now(),
          preview: (r.preview || '').slice(0, 160),
          project_name: r.project_name,
          project_path: r.project_path,
          reason: 'active_subagent',
        };
        changed = true;
        newlyIdle.delete(key);
      } else {
        // Parent called a tool — mark as "active_tool" immediately,
        // then after 15s silence escalate to "idle_tool_use" (permission).
        state.idleProjects[key] = {
          ts: Date.now(),
          preview: (r.preview || '').slice(0, 160),
          project_name: r.project_name,
          project_path: r.project_path,
          reason: 'active_tool',
        };
        changed = true;
        newlyIdle.delete(key);
        const rec = {
          key,
          project_name: r.project_name,
          project_path: r.project_path,
          preview: r.preview || '[Tool] 권한 승인 대기 중',
        };
        const handle = setTimeout(() => {
          _pendingToolUseTimers.delete(rec.key);
          if (_prefs.idleNotify === false) return;
          state.idleProjects[rec.key] = {
            ts: Date.now(),
            preview: rec.preview.slice(0, 160),
            project_name: rec.project_name,
            project_path: rec.project_path,
            reason: 'tool_use',
          };
          _playIdleChime();
          if (typeof loadTopProjects === 'function') loadTopProjects();
        }, TOOL_USE_IDLE_DELAY_MS);
        _pendingToolUseTimers.set(key, handle);
      }
    } else if (r.stop_reason) {
      // Any other stop_reason (max_tokens, stop_sequence, refusal) — treat
      // as "done working", clear the idle flag if set.
      if (state.idleProjects[key]) {
        delete state.idleProjects[key];
        changed = true;
      }
      newlyIdle.delete(key);
    }
  }
  // Play chimes only for projects that are STILL idle after processing
  // the entire batch. This prevents spurious chimes when an intermediate
  // end_turn is immediately followed by more tool_use in the same batch.
  for (const key of newlyIdle) {
    if (state.idleProjects[key]) _playIdleChime();
  }
  if (changed) {
    if (typeof loadTopProjects === 'function') loadTopProjects();
  }
}

// Settings toggle — user can opt out entirely.
function toggleIdleNotify() {
  const current = _prefs.idleNotify !== false;
  const next = !current;
  _prefs.idleNotify = next;
  savePrefs({ idleNotify: next });
  _renderIdleNotifyToggle();
  if (!next) {
    // Turning off also clears existing badges
    state.idleProjects = {};
    if (typeof loadTopProjects === 'function') loadTopProjects();
  }
  showToast('입력 대기 뱃지: ' + (next ? '켬' : '끔'), { type: 'info' });
}
function _renderIdleNotifyToggle() {
  const btn = document.getElementById('idleNotifyToggle');
  if (!btn) return;
  const on = _prefs.idleNotify !== false;
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.textContent = on ? '켜짐' : '꺼짐';
  btn.className = 'rounded-full px-4 py-1.5 text-[11px] font-bold spring ' +
    (on
      ? 'bg-accent/15 text-accent border border-accent/30'
      : 'bg-white/5 text-white/45 border border-white/[0.07]');
}
window.addEventListener('load', _renderIdleNotifyToggle);

function handleWsMessage(msg) {
  if (msg.type === 'init') {
    state.stats = msg.data;
    renderStats(msg.data);
    markUpdated('stats');
  } else if (msg.type === 'batch_update') {
    // Track how many new records arrived since the user last viewed
    state.newDataCounts.sessions += (msg.records?.length || 1);
    renderNewDataBadge();
    // Detect assistant messages that reached end_turn — Claude is idle and
    // waiting for user input. Notify once per project per burst.
    notifyIdleFromBatch(msg.records || []);
    // Check if any record belongs to the currently open session
    if (state.currentSession && msg.records) {
      for (const r of msg.records) {
        if (r && r.session_id === state.currentSession) {
          state.convNeedsRefresh = true;
          break;
        }
      }
    }
    debouncedRefresh();
  } else if (msg.type === 'scan_progress') {
    showScan(`스캔 중: ${msg.processed}/${msg.total}`);
  } else if (msg.type === 'scan_complete') {
    showScan(`완료: ${msg.total} 파일`);
    setTimeout(hideScan, 3000);
    debouncedRefresh();
  }
}

// ─── New data badge (U16) ─────────────────────────────────────────────
function renderNewDataBadge() {
  let badge = document.getElementById('newDataBadge');
  if (!badge) {
    badge = document.createElement('button');
    badge.id = 'newDataBadge';
    badge.className = 'fixed top-16 left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded-full bg-accent/20 text-accent border border-accent/40 shadow-[0_8px_24px_rgba(52,211,153,.3)] new-data-pulse font-bold text-[11px] spring';
    badge.addEventListener('click', () => {
      state.newDataCounts = { sessions: 0, projects: 0 };
      const b = document.getElementById('newDataBadge');
      if (b) b.remove();
      // Force a refresh of the active view
      const active = document.querySelector('.nav-pill.active')?.dataset.view;
      if (active) onViewChange(active);
    });
    document.body.appendChild(badge);
  }
  badge.textContent = `↻ 새 데이터 ${fmtN(state.newDataCounts.sessions)}건`;
}
// Clear on view change — treating user as having caught up
function clearNewDataBadge() {
  state.newDataCounts = { sessions: 0, projects: 0 };
  const b = document.getElementById('newDataBadge');
  if (b) b.remove();
}

// Persistent connection banner: shown when WS has been non-connected for
// longer than CONN_BANNER_DELAY. Auto-hides on first reconnect.
let _connBannerTimer = null;
const CONN_BANNER_DELAY = 15000;
function showConnBanner(msg) {
  const el = document.getElementById('connBanner');
  if (!el) return;
  const m = document.getElementById('connBannerMsg');
  if (m && msg) m.textContent = msg;
  el.classList.remove('hidden');
}
function hideConnBanner() {
  const el = document.getElementById('connBanner');
  if (el) el.classList.add('hidden');
  if (_connBannerTimer) { clearTimeout(_connBannerTimer); _connBannerTimer = null; }
}

function setWsStatus(cls, label) {
  // Schedule/cancel the persistent banner based on connection state.
  if (cls === 'connected') {
    hideConnBanner();
  } else if (!_connBannerTimer) {
    _connBannerTimer = setTimeout(
      () => showConnBanner(`실시간 연결 중단 (${label || '재연결 중…'})`),
      CONN_BANNER_DELAY);
  }
  const d = document.getElementById('wsDot');
  if (!d) return;
  // Larger, status-coloured dot. Pulses red while disconnected so it's
  // impossible to miss in the corner of the nav.
  const base = 'w-2.5 h-2.5 rounded-full spring cursor-pointer ';
  let cls2;
  if (cls === 'connected') {
    cls2 = 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,.7)]';
  } else if (cls === 'error') {
    cls2 = 'bg-red-400 shadow-[0_0_10px_rgba(248,113,113,.8)] new-data-pulse';
  } else {
    cls2 = 'bg-amber-300 shadow-[0_0_6px_rgba(252,211,77,.6)] new-data-pulse';
  }
  d.className = base + cls2;
  d.title = cls === 'connected' ? '실시간 연결됨 (클릭해서 재연결)' : '클릭해서 즉시 재연결';
  d.onclick = forceReconnectWs;
  const lbl = document.getElementById('wsLabel');
  if (lbl) {
    lbl.textContent = label;
    lbl.classList.toggle('text-emerald-300/85', cls === 'connected');
    lbl.classList.toggle('text-red-300/85', cls === 'error');
    lbl.classList.toggle('text-amber-300/85', cls !== 'connected' && cls !== 'error');
  }
}
function showScan(t){const e=document.getElementById('scanProgress');document.getElementById('scanProgressText').textContent=t;e.classList.remove('hidden');}
function hideScan(){document.getElementById('scanProgress').classList.add('hidden');}

// ─── Stats (hero + secondary chips) ───────────────────────────────────
// Moved to static/overview.js (loadStats, renderStats).

// ─── Charts ─────────────────────────────────────────────────────────────
// Moved to static/charts.js. Load order (see index.html):
//   1. app.js    — defines state, safeFetch, utils, ws, routing
//   2. charts.js — defines themeColors, tck, grd, loadCharts, Chart.js wiring
// All chart functions become window.* globals via regular script loading.

// ─── Sessions ───────────────────────────────────────────────────────────  (moved)
// Moved to static/sessions.js.

// ─── Conversations ──────────────────────────────────────────────────────
function renderConvSortBar(){
  const opts=[['updated_at','최근'],['cost','비용'],['messages','메시지']];
  document.getElementById('convSortBar').innerHTML=opts.map(([k,l])=>{
    const s=sortState.conversations;
    const active=s.key===k;
    const arr=active?(s.order==='asc'?' ↑':' ↓'):'';
    return `<button onclick="toggleSort('conversations','${k}')" class="px-2 py-0.5 rounded-full border spring text-[9px] font-bold ${active?'bg-accent/15 text-accent border-accent/30':'text-white/40 border-white/[0.06] hover:text-white/70'}">${l}${arr}</button>`;
  }).join('');
}
function switchConvSource(src) {
  if (src !== 'claude-code' && src !== 'claude-ai') return;
  state.convSource = src;
  savePrefs({ convSource: src });
  document.querySelectorAll('.conv-source-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.convSource === src);
  });
  const hdr = document.getElementById('convViewerHeader');
  hdr.textContent = '';
  const hint = document.createElement('div');
  hint.className = 'text-xs text-white/20 text-center py-8';
  hint.textContent = '← 대화를 선택하세요';
  hdr.appendChild(hint);
  document.getElementById('convMessages').textContent = '';
  document.getElementById('convNavBar')?.classList.add('hidden');
  document.getElementById('convSearchResults').classList.add('hidden');
  document.getElementById('convSearch').value = '';
  state.currentSession = null;
  loadConvList();
}

async function loadConvList(){
  // Sync toggle active class on each entry (e.g. first view open)
  document.querySelectorAll('.conv-source-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.convSource === state.convSource);
  });
  if (state.convSource === 'claude-ai') return loadClaudeAiList();
  // Restore label for claude-code mode
  const lbl = document.getElementById('convListLabel');
  if (lbl) lbl.textContent = '세션 목록';
  try{
    renderConvSortBar();
    const ss=sortState.conversations;
    const d=await safeFetch(`/api/sessions?per_page=50&sort=${ss.key}&order=${ss.order}`);
    const b=document.getElementById('convListBody');b.innerHTML='';
    (d.sessions||[]).forEach(s=>{
      const div=document.createElement('div');
      div.className='px-4 py-3 border-b border-white/[0.04] cursor-pointer spring hover:bg-white/[0.04]';
      div.dataset.id=s.id;
      const tagList = (s.tags || '').split(',').map(t => t.trim()).filter(Boolean);
      const tagRow = tagList.length
        ? `<div class="mt-1 flex flex-wrap gap-1">${tagList.map(t => `<span class="tag-badge">#${esc(t)}</span>`).join('')}</div>`
        : '';
      div.innerHTML=`
        <div class="flex items-center justify-between gap-2">
          <div class="text-xs font-bold text-white/80 truncate">${esc(s.project_name||'—')}</div>
          ${s.pinned?'<span class="text-accent text-[11px] flex-shrink-0">★</span>':''}
        </div>
        <div class="text-[10px] text-white/40 mt-1 flex items-center gap-2 tabular-nums">
          <span>${fmtTok((s.total_input_tokens||0)+(s.total_output_tokens||0))}</span>
          <span class="text-amber-400/70">${fmt$(s.total_cost_usd)}</span>
          <span>${relTime(s.updated_at)}</span>
        </div>
        ${tagRow}`;
      div.onclick=()=>openConversation(s.id,s,div);b.appendChild(div);
    });
  }catch(e){reportError('loadConvList',e);}
}

function toggleCaiSort(key) {
  const ss = sortState.conversations;
  if (ss.key === key) ss.order = ss.order === 'asc' ? 'desc' : 'asc';
  else { ss.key = key; ss.order = 'desc'; }
  persistSort('conversations');
  loadClaudeAiList();
}

async function loadClaudeAiList() {
  try {
    const ss = sortState.conversations;
    const allowed = ['updated_at','created_at','message_count','name','text_bytes'];
    const caiKey = allowed.includes(ss.key) ? ss.key : 'updated_at';
    const opts = [['updated_at','최근'],['message_count','메시지'],['text_bytes','크기']];
    const sortBar = document.getElementById('convSortBar');
    sortBar.textContent = '';
    opts.forEach(([k, label]) => {
      const active = caiKey === k;
      const btn = document.createElement('button');
      btn.className = 'px-2 py-0.5 rounded-full border spring text-[9px] font-bold ' +
        (active
          ? 'bg-accent/15 text-accent border-accent/30'
          : 'text-white/40 border-white/[0.06] hover:text-white/70');
      btn.textContent = label + (active ? (ss.order === 'asc' ? ' ↑' : ' ↓') : '');
      btn.onclick = () => toggleCaiSort(k);
      sortBar.appendChild(btn);
    });
    const label = document.getElementById('convListLabel');
    label.textContent = '대화 목록 ';
    const badge = document.createElement('span');
    badge.className = 'cai-badge ml-1';
    badge.textContent = 'claude.ai';
    label.appendChild(badge);

    const d = await safeFetch(
      `/api/claude-ai/conversations?sort=${caiKey}&order=${ss.order}&per_page=200`);
    const body = document.getElementById('convListBody');
    body.textContent = '';
    const convs = d.conversations || [];
    if (!convs.length) {
      const empty = document.createElement('div');
      empty.className = 'px-4 py-8 text-center text-[11px] text-white/25';
      empty.textContent = 'claude.ai export 가 없습니다. ';
      const hint = document.createElement('div');
      hint.className = 'text-white/15 mt-1 block font-mono text-[10px]';
      hint.textContent = 'import_claude_ai.py --zip <path>';
      empty.appendChild(hint);
      body.appendChild(empty);
      return;
    }
    convs.forEach(c => {
      const div = document.createElement('div');
      div.className = 'px-4 py-3 border-b border-white/[0.04] cursor-pointer spring hover:bg-white/[0.04]';
      div.dataset.id = c.uuid;
      const nameDiv = document.createElement('div');
      nameDiv.className = 'text-xs font-bold text-white/80 truncate';
      nameDiv.textContent = c.name || '(unnamed)';
      const metaDiv = document.createElement('div');
      metaDiv.className = 'text-[10px] text-white/40 mt-1 flex items-center gap-2 tabular-nums';
      const msgSpan = document.createElement('span');
      msgSpan.textContent = fmtN(c.message_count || 0) + '건';
      metaDiv.appendChild(msgSpan);
      const bytesKB = Math.round((c.total_text_bytes || 0) / 1024);
      if (bytesKB) {
        const byteSpan = document.createElement('span');
        byteSpan.className = 'text-cyan-400/60';
        byteSpan.textContent = fmtN(bytesKB) + 'KB';
        metaDiv.appendChild(byteSpan);
      }
      const relSpan = document.createElement('span');
      relSpan.textContent = relTime(c.updated_at);
      metaDiv.appendChild(relSpan);
      div.appendChild(nameDiv);
      div.appendChild(metaDiv);
      div.onclick = () => openClaudeAiConversation(c.uuid, c, div);
      body.appendChild(div);
    });
  } catch (e) { reportError('loadClaudeAiList', e); }
}

async function openClaudeAiConversation(uuid, conv, listItem) {
  document.querySelectorAll('#convListBody > div').forEach(i =>
    i.classList.remove('bg-accent/5','border-l-2','border-accent'));
  if (listItem) listItem.classList.add('bg-accent/5','border-l-2','border-accent');
  state.currentSession = uuid;

  const header = document.getElementById('convViewerHeader');
  header.textContent = '';
  const wrap = document.createElement('div');
  const titleRow = document.createElement('div');
  titleRow.className = 'flex items-center gap-2 flex-wrap';
  const badge = document.createElement('span');
  badge.className = 'cai-badge';
  badge.textContent = 'claude.ai';
  const title = document.createElement('div');
  title.className = 'text-sm font-bold text-white/90 truncate';
  title.textContent = conv.name || '(unnamed)';
  titleRow.appendChild(badge);
  titleRow.appendChild(title);
  const metaRow = document.createElement('div');
  metaRow.className = 'text-[10px] text-white/40 mt-1';
  const kb = Math.round((conv.total_text_bytes || 0) / 1024);
  metaRow.textContent = `${fmtN(conv.message_count || 0)}건 · ${fmtN(kb)}KB · ` +
    `${(conv.created_at || '').slice(0,10)} ~ ${(conv.updated_at || '').slice(0,10)}`;
  wrap.appendChild(titleRow);
  wrap.appendChild(metaRow);
  header.appendChild(wrap);

  const c = document.getElementById('convMessages');
  c.textContent = '';
  const loading = document.createElement('div');
  loading.className = 'text-center text-white/25 text-xs py-10 dots';
  loading.textContent = '로딩 중';
  c.appendChild(loading);

  let d;
  try {
    d = await safeFetch(
      `/api/claude-ai/conversations/${encodeURIComponent(uuid)}/messages?limit=1000`);
  } catch (err) {
    c.textContent = '';
    const fail = document.createElement('div');
    fail.className = 'text-center text-white/25 text-xs py-10';
    fail.textContent = '로딩 실패';
    c.appendChild(fail);
    return;
  }

  const msgs = d.messages || [];
  c.textContent = '';
  if (!msgs.length) {
    const empty = document.createElement('div');
    empty.className = 'text-center text-white/25 text-xs py-10';
    empty.textContent = '빈 대화';
    c.appendChild(empty);
    return;
  }

  const navBar = document.getElementById('convNavBar');
  if (navBar) navBar.classList.remove('hidden');
  const countLabel = document.getElementById('convMsgCount');
  if (countLabel) {
    const u = msgs.filter(m => m.sender === 'human').length;
    const a = msgs.filter(m => m.sender === 'assistant').length;
    countLabel.textContent = `${fmtN(msgs.length)}건 (사용자 ${u} · 어시스턴트 ${a})`;
  }
  convSetRoleFilter('all');

  msgs.forEach(m => {
    const w = document.createElement('div');
    w.dataset.msgRole = m.sender === 'human' ? 'user' : 'assistant';
    w.className = 'flex flex-col ' + (m.sender === 'human' ? 'items-end' : 'items-start');
    const b = document.createElement('div');
    b.className = 'max-w-[92%] px-4 py-3 rounded-2xl text-[12px] leading-relaxed ' +
      (m.sender === 'human'
        ? 'bg-accent/10 ring-1 ring-accent/20 text-white/85'
        : 'bg-white/[0.04] ring-1 ring-white/[0.06] text-white/75');
    renderClaudeAiContent(b, m);
    const meta = document.createElement('div');
    meta.className = 'text-[9px] text-white/30 mt-1 flex gap-2 items-center px-1 flex-wrap';
    const roleS = document.createElement('span');
    roleS.textContent = m.sender === 'human' ? '사용자' : '어시스턴트';
    const timeS = document.createElement('span');
    timeS.textContent = fmtTime(m.created_at);
    meta.appendChild(roleS);
    meta.appendChild(document.createTextNode(' · '));
    meta.appendChild(timeS);
    if (m.has_thinking) {
      const t = document.createElement('span');
      t.className = 'text-purple-400/60';
      t.textContent = ' · thinking';
      meta.appendChild(t);
    }
    if (m.has_tool_use) {
      const t = document.createElement('span');
      t.className = 'text-cyan-400/60';
      t.textContent = ' · tool_use';
      meta.appendChild(t);
    }
    if (m.file_count) {
      const t = document.createElement('span');
      t.className = 'text-white/35';
      t.textContent = ` · 📎 ${m.file_count}`;
      meta.appendChild(t);
    }
    w.appendChild(b);
    w.appendChild(meta);
    c.appendChild(w);
  });
  if (d.total > msgs.length) {
    const h = document.createElement('div');
    h.className = 'text-center text-[10px] text-white/30 py-3';
    h.textContent = `${fmtN(msgs.length)} / ${fmtN(d.total)}건 표시 중`;
    c.appendChild(h);
  }
  c.scrollTop = 0;
}

function renderClaudeAiContent(container, msg) {
  let blocks = [];
  try { blocks = JSON.parse(msg.content_json || '[]'); }
  catch { blocks = []; }
  if (!Array.isArray(blocks) || !blocks.length) {
    const d = document.createElement('div');
    d.className = 'whitespace-pre-wrap';
    d.textContent = msg.text || '';
    container.appendChild(d);
    return;
  }
  const mkDetails = (summaryText, bodyText, klass) => {
    const det = document.createElement('details');
    det.className = 'my-2 rounded-lg ' + klass;
    const sum = document.createElement('summary');
    sum.className = 'cursor-pointer px-3 py-1 text-[10px] font-bold';
    sum.textContent = summaryText;
    det.appendChild(sum);
    const body = document.createElement('div');
    body.className = 'p-3 text-[11px] text-white/55 whitespace-pre-wrap max-h-80 overflow-y-auto';
    body.textContent = bodyText;
    det.appendChild(body);
    return det;
  };
  blocks.forEach(block => {
    if (!block || typeof block !== 'object') return;
    if (block.type === 'text') {
      const txt = block.text || '';
      if (!txt) return;
      const d = document.createElement('div');
      d.className = 'whitespace-pre-wrap';
      d.textContent = txt;
      container.appendChild(d);
    } else if (block.type === 'thinking') {
      const txt = block.thinking || '';
      if (!txt) return;
      const det = mkDetails(
        `thinking (${fmtN(txt.length)}자)`,
        txt,
        'bg-purple-500/[0.04] ring-1 ring-purple-500/15');
      det.querySelector('summary').classList.add('text-purple-300/75');
      container.appendChild(det);
    } else if (block.type === 'tool_use') {
      const name = block.name || '?';
      const message = block.message || '';
      const inp = block.input || {};
      const inputStr = typeof inp === 'object' ? JSON.stringify(inp, null, 2) : String(inp);
      const summary = `tool_use: ${name}` +
        (message ? ' — ' + message.slice(0, 120) : '');
      const det = mkDetails(
        summary,
        inputStr.slice(0, 4000),
        'bg-cyan-500/[0.04] ring-1 ring-cyan-500/15');
      det.querySelector('summary').classList.add('text-cyan-300/80');
      det.querySelector('div').classList.add('font-mono');
      container.appendChild(det);
    } else if (block.type === 'tool_result') {
      const content = block.content;
      let body = '';
      if (typeof content === 'string') body = content;
      else if (Array.isArray(content)) {
        body = content
          .map(sub => (sub && sub.type === 'text') ? (sub.text || '') : '')
          .join('\n');
      }
      if (!body) return;
      const det = mkDetails(
        `tool_result (${fmtN(body.length)}자)`,
        body.slice(0, 4000),
        'bg-white/[0.03] ring-1 ring-white/[0.07]');
      det.querySelector('summary').classList.add('text-white/55');
      container.appendChild(det);
    }
  });
}

// ─── Conversation viewer nav helpers (U8) ────────────────────────────
function convJumpTop() {
  const c = document.getElementById('convMessages');
  if (c) c.scrollTop = 0;
}
function convJumpBottom() {
  const c = document.getElementById('convMessages');
  if (c) c.scrollTop = c.scrollHeight;
}
function convCollapseAllTools() {
  document.querySelectorAll('#convMessages .tool-body.open').forEach(b => {
    b.classList.remove('open');
    b.previousElementSibling?.classList.remove('open');
  });
}
function convExpandAllTools() {
  document.querySelectorAll('#convMessages .tool-body').forEach(b => {
    b.classList.add('open');
    b.previousElementSibling?.classList.add('open');
  });
}
function convSetRoleFilter(role) {
  document.querySelectorAll('.conv-role-btn').forEach(btn => {
    const active = btn.dataset.roleFilter === role;
    btn.classList.toggle('bg-accent/15', active);
    btn.classList.toggle('text-accent', active);
    btn.classList.toggle('border-accent/40', active);
    btn.classList.toggle('text-white/50', !active);
    btn.classList.toggle('border-white/[0.07]', !active);
  });
  document.querySelectorAll('#convMessages [data-msg-role]').forEach(w => {
    const r = w.dataset.msgRole;
    w.style.display = (role === 'all' || r === role) ? '' : 'none';
  });
}
// Bind role filter buttons (delegated, survives re-renders)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.conv-role-btn');
  if (btn) convSetRoleFilter(btn.dataset.roleFilter);
});

// ─── Conversation viewer state ───────────────────────────────────────────
state.convMessages = null;   // messages array of the open session
state.convSession = null;    // session object of the open session
let _convLoading = false;    // guard against concurrent load more / WS tail
let _convFocusIdx = -1;      // keyboard-navigated message index

// Reasoning Trace Explorer state
state.convTraceMode = false;
state.convTraceSteps = [];   // DOM elements with [data-trace-step]
state.convTraceIdx = -1;
let _convTracePlayTimer = null;
let _convSearchMatches = []; // inline search match elements
let _convSearchIdx = -1;
let _convSearchTimer = null;

// Time gap divider between messages (>10 min gap)
const _TIME_GAP_MS = 600000; // 10 minutes
function _renderTimeGap(container, prevTs, curTs) {
  if (!prevTs || !curTs) return;
  const gap = new Date(curTs).getTime() - new Date(prevTs).getTime();
  if (gap < _TIME_GAP_MS || isNaN(gap)) return;
  const label = gap >= 86400000 ? Math.floor(gap / 86400000) + '\uC77C \uD6C4'
    : gap >= 3600000 ? Math.floor(gap / 3600000) + '\uC2DC\uAC04 \uD6C4'
    : Math.floor(gap / 60000) + '\uBD84 \uD6C4';
  const div = document.createElement('div');
  div.className = 'conv-time-gap';
  div.textContent = label;
  container.appendChild(div);
}

// Session statistics summary bar
function renderConvStats(msgs, session) {
  const el = document.getElementById('convStatsSummary');
  if (!el) return;
  if (!msgs || !msgs.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.textContent = '';
  const totalCost = msgs.reduce((s, m) => s + (m.cost_usd || 0), 0);
  const totalInput = msgs.reduce((s, m) => s + (m.input_tokens || 0), 0);
  const totalOutput = msgs.reduce((s, m) => s + (m.output_tokens || 0), 0);
  const totalCacheRead = msgs.reduce((s, m) => s + (m.cache_read_tokens || 0), 0);
  const totalCacheCreate = msgs.reduce((s, m) => s + (m.cache_creation_tokens || 0), 0);
  const turnMs = session.turn_duration_ms || 0;
  const perHr = turnMs > 0 && totalCost > 0 ? totalCost / (turnMs / 3600000) : 0;
  const models = new Set(msgs.filter(m => m.model).map(m => shortModel(m.model)));
  const chip = (label, value, cls) => {
    const s = document.createElement('span');
    s.className = 'flex items-center gap-1 ' + (cls || '');
    const l = document.createElement('span');
    l.className = 'text-white/30';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'font-bold tabular-nums';
    v.textContent = value;
    s.append(l, v);
    return s;
  };
  el.appendChild(chip('\uBE44\uC6A9', fmt$(totalCost), 'text-amber-400/80'));
  el.appendChild(chip('\uC785\uB825', fmtTok(totalInput), 'text-white/55'));
  el.appendChild(chip('\uCD9C\uB825', fmtTok(totalOutput), 'text-emerald-400/70'));
  el.appendChild(chip('\uCE90\uC2DC\u2193', fmtTok(totalCacheRead), 'text-cyan-400/70'));
  el.appendChild(chip('\uCE90\uC2DC\u2191', fmtTok(totalCacheCreate), 'text-purple-400/60'));
  if (perHr > 0) el.appendChild(chip('$/hr', fmt$(perHr), perHr > 50 ? 'text-red-400/70' : 'text-white/50'));
  if (models.size > 0) {
    const mSpan = document.createElement('span');
    mSpan.className = 'text-purple-300/60 text-[9px]';
    mSpan.textContent = [...models].join(', ');
    el.appendChild(mSpan);
  }
}

// ─── Reasoning Trace Explorer ────────────────────────────────────────────
function convToggleTrace() {
  state.convTraceMode = !state.convTraceMode;
  const bar = document.getElementById('convTraceBar');
  const btn = document.getElementById('convTraceToggle');
  if (!state.convTraceMode) {
    if (bar) bar.classList.add('hidden');
    if (btn) btn.classList.remove('bg-purple-500/20','text-purple-300','border-purple-400/50');
    _convTraceClearHighlight();
    return;
  }
  const c = document.getElementById('convMessages');
  state.convTraceSteps = c ? [...c.querySelectorAll('[data-trace-step]')] : [];
  if (!state.convTraceSteps.length) {
    showToast('Trace \uC2A4\uD15D \uC5C6\uC74C \u2014 tool_use \uBA54\uC2DC\uC9C0\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4');
    state.convTraceMode = false;
    return;
  }
  if (bar) bar.classList.remove('hidden');
  if (btn) btn.classList.add('bg-purple-500/20','text-purple-300','border-purple-400/50');
  convTraceStep(0);
}
function _convTraceClearHighlight() {
  if (_convTracePlayTimer) { clearInterval(_convTracePlayTimer); _convTracePlayTimer = null; }
  const playBtn = document.getElementById('convTracePlayBtn');
  if (playBtn) playBtn.textContent = '\u25B6';
  const c = document.getElementById('convMessages');
  if (c) c.querySelectorAll('[data-trace-step]').forEach(el => {
    el.classList.remove('trace-current','trace-dim');
  });
  state.convTraceIdx = -1;
  const counter = document.getElementById('convTraceCounter');
  if (counter) counter.textContent = '0 / 0';
}
function convTraceStep(n) {
  const steps = state.convTraceSteps;
  if (!steps.length) return;
  const idx = Math.max(0, Math.min(n, steps.length - 1));
  state.convTraceIdx = idx;
  steps.forEach((el, i) => {
    el.classList.toggle('trace-current', i === idx);
    el.classList.toggle('trace-dim', i !== idx);
  });
  steps[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
  const counter = document.getElementById('convTraceCounter');
  if (counter) {
    const isErr = steps[idx].hasAttribute('data-trace-error');
    counter.textContent = (isErr ? '\u25c7 ' : '') + `${idx + 1} / ${steps.length}`;
    counter.style.color = isErr ? 'rgba(248,113,113,.8)' : '';
  }
}
function convTracePrev() {
  if (!state.convTraceMode || !state.convTraceSteps.length) return;
  convTraceStep(state.convTraceIdx - 1);
}
function convTraceNext() {
  if (!state.convTraceMode || !state.convTraceSteps.length) return;
  convTraceStep(state.convTraceIdx + 1);
}
function convTracePlay() {
  if (!state.convTraceMode) return;
  const playBtn = document.getElementById('convTracePlayBtn');
  if (_convTracePlayTimer) {
    clearInterval(_convTracePlayTimer);
    _convTracePlayTimer = null;
    if (playBtn) playBtn.textContent = '\u25B6';
    return;
  }
  if (playBtn) playBtn.textContent = '\u23F8';
  _convTracePlayTimer = setInterval(() => {
    const next = state.convTraceIdx + 1;
    if (next >= state.convTraceSteps.length) {
      clearInterval(_convTracePlayTimer);
      _convTracePlayTimer = null;
      if (playBtn) playBtn.textContent = '\u25B6';
      return;
    }
    convTraceStep(next);
  }, 800);
}

// Render a single conversation message bubble into the container.
// Used by both the initial load and "load more" pagination. All dynamic
// values are fed through esc()/fmtTok()/fmt$() — no raw user input in
// the HTML fragments.
function _renderSingleMessage(container, m, allMsgs, prevBr) {
  const w = document.createElement('div');
  w.dataset.msgRole = m.role;
  w.className = 'flex flex-col ' + (m.role === 'user' ? 'items-end' : 'items-start');
  // Mark assistant messages with tool_use blocks as trace steps
  if (m.role === 'assistant') {
    try {
      const parsed = JSON.parse(m.content || 'null');
      if (Array.isArray(parsed) && parsed.some(b => b.type === 'tool_use')) {
        w.setAttribute('data-trace-step', '');
        if (m._hasTraceError) w.setAttribute('data-trace-error', '');
      }
    } catch(e) {}
  }
  const b = document.createElement('div');
  b.className = 'max-w-[92%] px-4 py-3 rounded-2xl text-[12px] leading-relaxed ' + (m.role === 'user' ? 'bg-accent/10 ring-1 ring-accent/20 text-white/85' : 'bg-white/[0.04] ring-1 ring-white/[0.06] text-white/75');
  b.innerHTML = renderContent(m);  // renderContent returns sanitised HTML
  const meta = document.createElement('div');
  meta.className = 'text-[9px] text-white/30 mt-1 flex gap-2 items-center px-1 flex-wrap';
  const parts = [`<span>${m.role === 'user' ? '사용자' : '어시스턴트'}</span>`, `<span>${fmtTime(m.timestamp)}</span>`];
  if (m.role === 'assistant') {
    if (m.input_tokens || m.output_tokens) parts.push(`<span class="text-cyan-400/60">↑${fmtTok(m.input_tokens)} ↓${fmtTok(m.output_tokens)}</span>`);
    if (m.cache_read_tokens || m.cache_creation_tokens) parts.push(`<span class="text-purple-400/55" title="cache_read/cache_creation">cache ↓${fmtTok(m.cache_read_tokens || 0)}·↑${fmtTok(m.cache_creation_tokens || 0)}</span>`);
    if (m.cost_usd) parts.push(`<span class="text-amber-400/75">${fmt$(m.cost_usd)}</span>`);
    if (m.model) parts.push(`<span class="text-purple-400/60">${esc(shortModel(m.model))}</span>`);
    if (m.stop_reason) parts.push(stopReasonBadge(m.stop_reason));
  }
  if (m.parent_uuid) {
    const parentIdx = allMsgs.findIndex(x => x.uuid === m.parent_uuid || x.message_uuid === m.parent_uuid);
    const myIdx = allMsgs.indexOf(m);
    if (parentIdx >= 0 && parentIdx !== myIdx - 1) {
      parts.push(`<span class="text-amber-400/55 font-mono" title="parent ${m.parent_uuid.slice(0, 8)} — ${myIdx - parentIdx}단계 차이">↳ ${(m.parent_uuid || '').slice(0, 8)}</span>`);
    }
  }
  if (m.git_branch && m.git_branch !== prevBr) {
    parts.push(`<span class="text-cyan-400/55 font-mono">⎇ ${esc(m.git_branch)}</span>`);
  }
  meta.innerHTML = parts.join(' · ');  // all values pre-escaped
  w.appendChild(b); w.appendChild(meta); container.appendChild(w);
}

async function openConversation(sid,session,listItem){
  document.querySelectorAll('#convListBody > div').forEach(i=>i.classList.remove('bg-accent/5','border-l-2','border-accent'));
  if(listItem){listItem.classList.add('bg-accent/5','border-l-2','border-accent');}
  // Reset trace mode on new session open
  if (state.convTraceMode) {
    state.convTraceMode = false;
    const _tb = document.getElementById('convTraceBar');
    const _tt = document.getElementById('convTraceToggle');
    if (_tb) _tb.classList.add('hidden');
    if (_tt) _tt.classList.remove('bg-purple-500/20','text-purple-300','border-purple-400/50');
    if (_convTracePlayTimer) { clearInterval(_convTracePlayTimer); _convTracePlayTimer = null; }
  }
  state.convTraceSteps = [];
  state.convTraceIdx = -1;
  state.currentSession=sid;
  const isSub = !!session.is_subagent;
  // Subagent sessions: show their lineage (parent tool_use id + task prompt)
  // in a dedicated header block. Parent sessions: show spawned-subagent slot.
  let lineageBlock = '';
  if (isSub) {
    const atype = esc(session.agent_type || '—');
    const adesc = esc(session.agent_description || '');
    const stop = stopReasonBadge(session.final_stop_reason);
    const tuid = session.parent_tool_use_id
      ? `<span class="text-purple-300/60 font-mono">${esc(session.parent_tool_use_id)}</span>`
      : '<span class="inline-block text-[9px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400/75 border border-amber-500/25 font-semibold">orphan</span>';
    const parent = session.parent_session_id
      ? `<button onclick="openParentFromSubagent('${esc(session.parent_session_id)}')" class="text-accent/80 hover:text-accent underline font-mono">${esc(session.parent_session_id.slice(0,8))}</button>`
      : '—';
    const promptExcerpt = session.task_prompt
      ? `<details class="mt-2 bg-purple-500/[0.04] ring-1 ring-purple-500/15 rounded-lg">
           <summary class="cursor-pointer px-3 py-1.5 text-[10px] font-bold text-purple-300/85">
             Task prompt (${fmtN((session.task_prompt||'').length)}자)
           </summary>
           <div class="p-3 text-[11px] text-white/65 whitespace-pre-wrap max-h-60 overflow-y-auto">${esc(session.task_prompt)}</div>
         </details>`
      : '';
    lineageBlock = `
      <div class="mt-2 p-2 rounded-lg bg-purple-500/[0.05] ring-1 ring-purple-500/15 text-[10px]">
        <div class="flex items-center gap-2 flex-wrap">
          <iconify-icon icon="solar:cpu-bolt-linear" width="13" class="text-purple-300/85"></iconify-icon>
          <span class="font-bold text-purple-300/90">Subagent</span>
          ${stop}
          <span class="text-white/40">·</span>
          <span class="text-white/60">${atype}</span>
          <span class="text-white/40">·</span>
          <span class="text-white/65 truncate max-w-md" title="${adesc}">${adesc}</span>
        </div>
        <div class="mt-1 flex items-center gap-2">
          <span class="text-white/35">parent:</span>${parent}
          <span class="text-white/35">tool_use:</span>${tuid}
        </div>
        ${promptExcerpt}
      </div>`;
  }
  let aiTagsBlock = '';
  if (session.ai_tags) {
    try {
      const _atp = JSON.parse(session.ai_tags);
      const _atags = _atp.tags || [];
      if (_atags.length) {
        const _AT_CLS = {
          permission_loop: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
          cost_spike:      'bg-red-500/15 text-red-300 border-red-500/30',
          agent_loop:      'bg-orange-500/15 text-orange-300 border-orange-500/30',
          task_complete:   'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
          task_abandoned:  'bg-white/10 text-white/40 border-white/10',
          error_recovery:  'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
        };
        const _badges = _atags.map(t => {
          const _cls = _AT_CLS[t] || 'bg-white/10 text-white/40 border-white/10';
          return `<span class="inline-block text-[9px] px-1.5 py-0.5 rounded-full border font-semibold ${_cls}">\u2746 ${esc(t.replace(/_/g,' '))}</span>`;
        }).join(' ');
        const _conf = _atp.confidence ? `<span class="text-white/25">${Math.round(_atp.confidence * 100)}%</span>` : '';
        const _sum = _atp.summary ? `<div class="mt-1 text-white/40">${esc(_atp.summary)}</div>` : '';
        aiTagsBlock = `<div class="mt-2 p-2 rounded-lg bg-purple-500/[0.04] ring-1 ring-purple-500/10 text-[10px]"><div class="flex items-center gap-2 flex-wrap"><iconify-icon icon="solar:tag-linear" width="12" class="text-purple-300/60"></iconify-icon><span class="font-bold text-purple-300/70">AI Analysis</span>${_badges}${_conf}</div>${_sum}</div>`;
      }
    } catch(e) {}
  }
  document.getElementById('convViewerHeader').innerHTML=`
    <div>
      <div class="text-sm font-bold text-white/90">${esc(session.project_name||'—')}</div>
      <div class="text-[10px] text-white/40 mt-0.5 truncate">${esc(session.cwd||'')} · ${esc(session.model||'')}${session.version?' · v'+esc(session.version):''}</div>
      <div class="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[10px]">
        <span class="text-white/35">입력 <span class="text-white/60 font-bold tabular-nums">${fmtTok(session.total_input_tokens||0)}</span></span>
        <span class="text-white/35">출력 <span class="text-emerald-400/75 font-bold tabular-nums">${fmtTok(session.total_output_tokens||0)}</span></span>
        <span class="text-white/35" title="cache_read / cache_creation">캐시 <span class="text-cyan-400/75 font-bold tabular-nums">↓${fmtTok(session.total_cache_read_tokens||0)}</span> <span class="text-white/30">+</span> <span class="text-purple-400/75 font-bold tabular-nums">↑${fmtTok(session.total_cache_creation_tokens||0)}</span></span>
        <span class="text-white/35">비용 <span class="text-amber-400/85 font-bold tabular-nums">${fmt$(session.total_cost_usd)}</span></span>
      </div>
      ${lineageBlock}
      ${aiTagsBlock}
      <div id="convSubagentsSlot" class="mt-3"></div>
    </div>`;
  // Parent sessions get their spawned-subagents list; subagent sessions
  // don't spawn more (we've never observed >1 level in the data).
  if (!isSub) loadSessionSubagents(sid);
  // Always allow chain inspection — works on parent and on compact subagents
  // that themselves dispatch other subagents.
  setTimeout(() => {
    const slot = document.getElementById('convSubagentsSlot');
    if (!slot) return;
    const btn = document.createElement('button');
    btn.className = 'mt-2 px-3 py-1 rounded-full bg-purple-500/10 text-purple-300/85 border border-purple-500/25 text-[10px] font-bold spring hover:scale-[1.02]';
    btn.textContent = '🔗 디스패치 체인 보기';
    btn.onclick = () => loadSessionChain(sid);
    slot.appendChild(btn);
  }, 60);
  const c=document.getElementById('convMessages');
  c.innerHTML=`<div class="text-center text-white/25 text-xs py-10 dots">로딩 중</div>`;
  let data,msgs;
  try{data=await safeFetch(`/api/sessions/${sid}/messages?limit=200`);msgs=data.messages||[];}
  catch(err){c.innerHTML=`<div class="text-center text-white/25 text-xs py-10">로딩 실패</div>`;return;}
  c.innerHTML='';
  if(!msgs.length){c.innerHTML=`<div class="text-center text-white/25 text-xs py-10">메시지 없음</div>`;return;}
  // Pre-pass: build _errIds set for ◇ error branch markers
  const _errIds = new Set();
  msgs.forEach(m => {
    if (m.role !== 'user') return;
    try {
      const _c = JSON.parse(m.content || 'null');
      if (!Array.isArray(_c)) return;
      _c.forEach(b => { if (b.type === 'tool_result' && b.is_error && b.tool_use_id) _errIds.add(b.tool_use_id); });
    } catch(e) {}
  });
  msgs.forEach(m => {
    if (m.role !== 'assistant') return;
    try {
      const _c = JSON.parse(m.content || 'null');
      if (!Array.isArray(_c)) return;
      m._hasTraceError = _c.filter(b => b.type === 'tool_use').some(b => _errIds.has(b.id));
    } catch(e) {}
  });
  // Collect branch transitions so we only label a message when branch changes
  const branches = new Set();
  msgs.forEach(m => { if (m.git_branch) branches.add(m.git_branch); });
  if (branches.size > 1) {
    const hdr = document.createElement('div');
    hdr.className = 'text-center text-[10px] text-cyan-400/60 pb-2 flex items-center justify-center gap-2';
    hdr.innerHTML = `<iconify-icon icon="solar:code-linear" width="12"></iconify-icon>
      <span>${fmtN(branches.size)}개 git branch 터치: ${[...branches].slice(0,4).map(b => `<span class="text-white/55 font-mono">${esc(b)}</span>`).join(', ')}${branches.size > 4 ? ', …' : ''}</span>`;
    c.appendChild(hdr);
  }
  // Model transition timeline — collapse consecutive same-model runs
  const modelRuns = [];
  msgs.forEach(m => {
    if (m.role !== 'assistant' || !m.model) return;
    const short = shortModel(m.model);
    const last = modelRuns[modelRuns.length - 1];
    if (last && last.model === short) last.count++;
    else modelRuns.push({ model: short, count: 1 });
  });
  if (modelRuns.length > 1) {
    const hdr2 = document.createElement('div');
    hdr2.className = 'text-center text-[10px] text-purple-300/70 pb-2 flex items-center justify-center gap-2 flex-wrap';
    const inner = modelRuns.map((r, i) => {
      const arrow = i > 0 ? '<span class="text-white/25 mx-1">→</span>' : '';
      return `${arrow}<span class="text-purple-300/90 font-semibold">${esc(r.model)}</span><span class="text-white/40">×${r.count}</span>`;
    }).join('');
    hdr2.innerHTML = `<iconify-icon icon="solar:cpu-bolt-linear" width="12"></iconify-icon><span class="flex items-center gap-0.5 flex-wrap justify-center">${inner}</span>`;
    c.appendChild(hdr2);
  }
  // Show nav bar + message count
  const navBar = document.getElementById('convNavBar');
  if (navBar) navBar.classList.remove('hidden');
  const countLabel = document.getElementById('convMsgCount');
  if (countLabel) {
    const u = msgs.filter(m => m.role === 'user').length;
    const a = msgs.filter(m => m.role === 'assistant').length;
    countLabel.textContent = `${fmtN(msgs.length)}건 (사용자 ${u} · 어시스턴트 ${a})`;
  }
  // Store messages for export/stats
  state.convMessages = msgs;
  state.convSession = session;
  // Reset role filter to "all" on each session open
  convSetRoleFilter('all');
  _convFocusIdx = -1;
  let prevBranch = null;
  let prevTs = null;
  msgs.forEach(m=>{
    _renderTimeGap(c, prevTs, m.timestamp);
    _renderSingleMessage(c, m, msgs, prevBranch);
    if (m.git_branch) prevBranch = m.git_branch;
    prevTs = m.timestamp;
  });
  renderConvStats(msgs, session);
  if(data.total>msgs.length){
    const loadMoreWrap=document.createElement('div');
    loadMoreWrap.className='text-center py-4';
    const remaining=data.total-msgs.length;
    const info=document.createElement('div');
    info.className='text-[10px] text-white/30 mb-2';
    info.textContent=`${fmtN(msgs.length)} / ${fmtN(data.total)}건 표시 중`;
    const btn=document.createElement('button');
    btn.className='px-4 py-1.5 rounded-full bg-accent/10 text-accent border border-accent/30 text-[11px] font-bold spring hover:scale-[1.02]';
    btn.textContent=`다음 ${fmtN(Math.min(remaining,200))}건 로드`;
    btn.addEventListener('click',async()=>{
      if(_convLoading) return;
      _convLoading=true;
      btn.disabled=true;btn.textContent='로딩 중…';
      try{
        const next=await safeFetch(`/api/sessions/${sid}/messages?limit=200&offset=${msgs.length}`);
        const more=next.messages||[];
        if(!more.length){loadMoreWrap.remove();return;}
        loadMoreWrap.remove();
        let prevBr=prevBranch;
        let prevT=msgs.length?msgs[msgs.length-1].timestamp:null;
        more.forEach(m=>{
          _renderTimeGap(c,prevT,m.timestamp);
          _renderSingleMessage(c,m,msgs,prevBr);
          if(m.git_branch) prevBr=m.git_branch;
          prevT=m.timestamp;
          msgs.push(m);
        });
        prevBranch=prevBr;
        renderConvStats(msgs, session);
        if(data.total>msgs.length){
          const r2=data.total-msgs.length;
          info.textContent=`${fmtN(msgs.length)} / ${fmtN(data.total)}건 표시 중`;
          btn.textContent=`다음 ${fmtN(Math.min(r2,200))}건 로드`;
          btn.disabled=false;
          c.appendChild(loadMoreWrap);
        }
      }catch(e){btn.textContent='로드 실패 — 재시도';btn.disabled=false;}
      finally{_convLoading=false;}
    });
    loadMoreWrap.appendChild(info);
    loadMoreWrap.appendChild(btn);
    c.appendChild(loadMoreWrap);
  }
  c.scrollTop=c.scrollHeight;
  const cn=document.querySelector('[data-view="conversations"]');
  if(cn&&!cn.classList.contains('active'))cn.click();
}
// Map keyed by Agent-tool `description` → subagent summary. Populated when
// a parent conversation is opened; consumed by `renderBlock` when rendering
// `tool_use` blocks so each dispatch gets an inline card.
state.subagentsByDescription = {};
state.subagentsById = {};

// ─── Subagent chain visualisation (B6) ───────────────────────────────
async function loadSessionChain(sid) {
  try {
    const d = await safeFetch(`/api/sessions/${encodeURIComponent(sid)}/chain?depth=4`);
    const nodes = d.nodes || [];
    if (nodes.length <= 1) {
      showToast('체인 깊이 1 — 더 깊은 디스패치 없음', { type: 'info', duration: 2000 });
      return;
    }
    // Render a tree-style modal in the toast tray area (using a temporary
    // overlay rather than a fixed modal — chain is read-only).
    const ov = document.createElement('div');
    ov.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4';
    ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
    const lines = nodes.map(n => {
      const indent = '  '.repeat(n.level);
      const arrow = n.level === 0 ? '◉' : '└▶';
      const desc = (n.agent_description || '').slice(0, 60);
      return `<div class="font-mono text-[11px] py-1">
        <span class="text-white/30">${indent}${arrow}</span>
        <span class="text-purple-300/85 font-bold">${esc(n.agent_type || 'parent')}</span>
        <span class="text-white/40">·</span>
        <span class="text-white/70">${esc(desc)}</span>
        <span class="ml-2 text-amber-400/85 font-bold">${fmt$(n.cost_usd)}</span>
        <span class="ml-1 text-white/30">(${n.message_count}msg)</span>
      </div>`;
    }).join('');
    ov.innerHTML = `
      <div class="bg-[#0f0f0f] ring-1 ring-purple-500/25 rounded-2xl w-[700px] max-w-[94vw] max-h-[80vh] overflow-y-auto shadow-[0_20px_60px_rgba(0,0,0,.6)] anim-in">
        <div class="px-5 py-3 border-b border-purple-500/20 flex items-center justify-between">
          <span class="text-sm font-bold text-purple-200">디스패치 체인 (${nodes.length} 노드)</span>
          <button onclick="this.closest('.fixed').remove()" class="text-white/30 hover:text-white/70 spring text-2xl leading-none">&times;</button>
        </div>
        <div class="p-4">${lines}</div>
      </div>`;
    document.body.appendChild(ov);
  } catch (e) {
    reportError('loadSessionChain', e);
  }
}

async function loadSessionSubagents(sid) {
  const slot = document.getElementById('convSubagentsSlot');
  if (!slot) return;
  try {
    const d = await safeFetch(`/api/sessions/${encodeURIComponent(sid)}/subagents`);
    const subs = d.subagents || [];
    // Rebuild lookup maps for the currently-open parent session
    state.subagentsByDescription = {};
    state.subagentsById = {};
    subs.forEach(s => {
      if (s.agent_description) state.subagentsByDescription[s.agent_description] = s;
      if (s.id) state.subagentsById[s.id] = s;
    });
    if (!subs.length) { slot.innerHTML = ''; return; }
    const totalCost = subs.reduce((a, s) => a + (s.cost_usd || 0), 0);
    const byType = {};
    subs.forEach(s => {
      const t = s.agent_type || '(unknown)';
      byType[t] = (byType[t] || 0) + 1;
    });
    const typePills = Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `<span class="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-300/85 font-semibold">${esc(t)} × ${n}</span>`)
      .join(' ');
    const topList = subs
      .slice(0, 8)
      .map(s => {
        const desc = esc((s.agent_description || '').slice(0, 60));
        const type = esc(s.agent_type || '—');
        const dur = s.duration_seconds || 0;
        const slow = dur >= 300;
        const durBadge = dur > 0
          ? `<span class="shrink-0 ${slow?'text-red-400/85 font-bold':'text-white/30'}">${fmtDurationSec(dur)}</span>`
          : '';
        const stop = stopReasonBadge(s.final_stop_reason);
        return `<li class="flex items-center gap-2 py-0.5 text-[10px]">
          <span class="shrink-0 w-4 text-center">${stop}</span>
          <span class="text-purple-300/70 font-mono shrink-0">${esc((s.id || '').slice(0, 16))}</span>
          <span class="text-white/50 shrink-0">${type}</span>
          <span class="text-white/65 truncate flex-1" title="${desc}">${desc}</span>
          ${durBadge}
          <span class="text-amber-400/70 font-bold tabular-nums shrink-0">${fmt$(s.cost_usd)}</span>
        </li>`;
      })
      .join('');
    slot.innerHTML = `
      <details class="bg-purple-500/[0.04] ring-1 ring-purple-500/15 rounded-xl overflow-hidden">
        <summary class="cursor-pointer px-3 py-2 text-[11px] font-bold text-purple-300/85 flex items-center gap-2">
          <iconify-icon icon="solar:cpu-bolt-linear" width="14"></iconify-icon>
          <span>Spawned subagents: ${fmtN(subs.length)}</span>
          <span class="text-amber-400/80 font-bold tabular-nums">${fmt$(totalCost)}</span>
          <span class="ml-auto text-white/30 text-[10px]">클릭해 펼치기</span>
        </summary>
        <div class="p-3 pt-0 space-y-2">
          <div class="flex flex-wrap gap-1 mt-1">${typePills}</div>
          <ul class="space-y-0.5 mt-2">${topList}</ul>
          ${subs.length > 5 ? `<div class="text-[9px] text-white/30 pt-1">… and ${subs.length - 5} more</div>` : ''}
        </div>
      </details>`;
  } catch (e) {
    console.error('loadSessionSubagents:', e);
  }
}

function renderContent(m){try{const c=JSON.parse(m.content||'null');if(!c)return esc(m.content_preview||'');if(Array.isArray(c))return c.map(renderBlock).join('');return esc(m.content_preview||String(c));}catch{return esc(m.content_preview||m.content||'');}}
function fmtDurationSec(s) {
  if (!s || s < 0) return '—';
  if (s < 60) return `${Math.round(s)}초`;
  if (s < 3600) return `${Math.floor(s/60)}분 ${Math.round(s%60)}초`;
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
  return `${h}시간 ${m}분`;
}

// Subagent termination state badge. Maps a raw stop_reason string to a
// glyph + colour + human tooltip.
function stopReasonBadge(reason) {
  if (!reason) return '';
  const map = {
    end_turn:      { icon: '✓', label: '완료',   cls: 'text-emerald-400/85', title: '정상 완료 (end_turn)' },
    tool_use:      { icon: '🔧', label: '도구',   cls: 'text-cyan-400/85',    title: 'tool_use 중 종료' },
    stop_sequence: { icon: '⏹', label: '시퀀스', cls: 'text-white/60',        title: 'stop_sequence 일치' },
    max_tokens:    { icon: '⚠', label: '초과',   cls: 'text-amber-400/85',    title: 'max_tokens 한계 도달' },
    refusal:       { icon: '⛔', label: '거절',   cls: 'text-red-400/85',      title: '거절됨' },
  };
  const m = map[reason] || { icon: '?', label: reason, cls: 'text-white/40', title: reason };
  return `<span class="${m.cls} text-[11px] font-bold" title="${esc(m.title)}">${m.icon}<span class="sr-only">${esc(m.label)}</span></span>`;
}

function renderSubagentCard(block) {
  // Special render for `tool_use` blocks where the tool is Agent/Task.
  // We cross-link the call to the matching subagent row via description.
  const inp = block.input || {};
  const description = inp.description || '';
  const subType = inp.subagent_type || '';
  const sub = state.subagentsByDescription[description];
  const linked = !!sub;
  const bg = linked ? 'bg-purple-500/10 ring-1 ring-purple-500/25' : 'bg-purple-500/[0.04] ring-1 ring-purple-500/10';
  const headline = linked
    ? `${esc(sub.agent_type || subType || '—')} · ${fmtN(sub.message_count || 0)}msg · ${fmt$(sub.cost_usd)}`
    : `${esc(subType || '—')} · (not found in DB)`;
  const duration = linked ? fmtDurationSec(sub.duration_seconds) : '—';
  const slow = linked && sub.duration_seconds >= 300;
  const durBadge = linked
    ? `<span class="text-[9px] ${slow?'text-red-400/80 font-bold':'text-white/40'}">${duration}</span>`
    : '';
  const stopBadge = linked ? stopReasonBadge(sub.final_stop_reason) : '';
  const clickAttr = linked
    ? `onclick="openSubagentFromDescription('${esc(description).replace(/'/g,"\\'")}')"`
    : '';
  const cursor = linked ? 'cursor-pointer hover:bg-purple-500/15' : '';
  return `<div class="mt-2 ${bg} rounded-xl px-3 py-2 ${cursor} spring" ${clickAttr}>
    <div class="flex items-center gap-2 text-[11px]">
      <iconify-icon icon="solar:cpu-bolt-linear" width="13" class="text-purple-300/85"></iconify-icon>
      <span class="font-bold text-purple-300/90">Agent</span>
      ${stopBadge}
      <span class="text-white/40">·</span>
      <span class="text-white/65 truncate flex-1" title="${esc(description)}">${esc(description.slice(0, 80))}</span>
      ${durBadge}
    </div>
    <div class="text-[10px] text-white/40 mt-1">${headline}</div>
  </div>`;
}

// ─── Minimal markdown renderer (U10) ──────────────────────────────────
// Returns safe HTML: escapes content first, then re-inserts known inline/
// block patterns. Supports code fences, inline code, bold, italic, links,
// bullet/ordered lists, headings.
function renderMarkdown(raw) {
  if (!raw) return '';
  const lines = String(raw).split('\n');
  const out = [];
  let inCode = null;   // language
  let codeBuf = [];
  let listType = null; // 'ul' | 'ol' | null
  let listBuf = [];

  const flushList = () => {
    if (!listType) return;
    out.push(`<${listType} class="list-${listType === 'ul' ? 'disc' : 'decimal'} pl-5 my-1 space-y-0.5">${listBuf.map(li => `<li>${li}</li>`).join('')}</${listType}>`);
    listType = null;
    listBuf = [];
  };

  const inline = (s) => {
    // Escape first
    let x = esc(s);
    // Inline code
    x = x.replace(/`([^`\n]+)`/g, '<code class="px-1 py-0.5 rounded bg-white/10 text-cyan-300/90 font-mono text-[11px]">$1</code>');
    // Bold
    x = x.replace(/\*\*([^*\n]+)\*\*/g, '<strong class="text-white/95">$1</strong>');
    // Italic — only single asterisk not preceded/followed by another
    x = x.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em class="text-white/85">$2</em>');
    // Links — esc'd URLs have `&amp;` etc, still navigable. Block javascript: scheme.
    x = x.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const safe = /^(https?:\/\/|\/|#)/i.test(url) ? url : '#';
      return `<a href="${safe}" target="_blank" rel="noopener" class="text-accent underline decoration-accent/40 hover:decoration-accent">${label}</a>`;
    });
    return x;
  };

  for (const line of lines) {
    // Code fence start/end
    const fence = line.match(/^```(\w*)$/);
    if (fence) {
      if (inCode === null) {
        flushList();
        inCode = fence[1] || '';
        codeBuf = [];
      } else {
        out.push(`<pre class="my-2 p-3 rounded-lg bg-black/40 ring-1 ring-white/[0.06] text-[11px] text-cyan-200/90 font-mono overflow-x-auto"><code>${esc(codeBuf.join('\n'))}</code></pre>`);
        inCode = null;
        codeBuf = [];
      }
      continue;
    }
    if (inCode !== null) { codeBuf.push(line); continue; }

    // Bullet list
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (listType !== 'ul') { flushList(); listType = 'ul'; }
      listBuf.push(inline(bullet[1]));
      continue;
    }
    // Ordered list
    const ord = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ord) {
      if (listType !== 'ol') { flushList(); listType = 'ol'; }
      listBuf.push(inline(ord[1]));
      continue;
    }
    // Heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushList();
      const n = h[1].length;
      const cls = ['text-base font-bold', 'text-sm font-bold', 'text-[13px] font-bold', 'text-[12px] font-bold'][n - 1];
      out.push(`<div class="${cls} text-white/90 mt-2 mb-1">${inline(h[2])}</div>`);
      continue;
    }
    // Blank line
    if (!line.trim()) {
      flushList();
      out.push('');
      continue;
    }
    // Regular paragraph — keep whitespace preserving
    flushList();
    out.push(`<div class="whitespace-pre-wrap">${inline(line)}</div>`);
  }
  flushList();
  if (inCode !== null) {
    out.push(`<pre class="my-2 p-3 rounded-lg bg-black/40 ring-1 ring-white/[0.06] text-[11px] text-cyan-200/90 font-mono overflow-x-auto"><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  }
  return out.join('\n');
}

function renderBlock(block){if(!block||typeof block!=='object')return esc(String(block||''));const t=block.type||'';
  if(t==='text')return `<div>${renderMarkdown(block.text||'')}</div>`;
  if(t==='thinking'){const th=block.thinking||'';if(!th)return `<div class="text-[10px] text-white/15 italic">[Extended Thinking]</div>`;const id='th-'+Math.random().toString(36).slice(2);return `<div class="mt-2 bg-white/[0.03] ring-1 ring-white/[0.05] rounded-xl overflow-hidden"><div class="tool-hdr px-3 py-1.5 text-[10px] font-semibold text-cyan-400/40 flex items-center gap-1.5" onclick="toggleTool('${id}')"><span class="arr">▶</span> Extended Thinking</div><div class="tool-body p-3 text-[10px] text-white/25 leading-relaxed whitespace-pre-wrap max-h-60 overflow-y-auto" id="${id}">${esc(th)}</div></div>`;}
  if(t==='tool_use'){
    const name = block.name || '';
    if (name === 'Agent' || name === 'Task') return renderSubagentCard(block);
    const id='tu-'+Math.random().toString(36).slice(2);
    return `<div class="mt-2 bg-white/[0.03] ring-1 ring-white/[0.05] rounded-xl overflow-hidden"><div class="tool-hdr px-3 py-1.5 text-[10px] font-semibold text-purple-400/50 flex items-center gap-1.5" onclick="toggleTool('${id}')"><span class="arr">▶</span> ${esc(name||'tool')}</div><div class="tool-body p-3 text-[10px] text-white/25 font-mono whitespace-pre-wrap max-h-60 overflow-y-auto" id="${id}">${esc(JSON.stringify(block.input||{},null,2))}</div></div>`;
  }
  if(t==='tool_result'){const id='tr-'+Math.random().toString(36).slice(2);let rc='';if(Array.isArray(block.content))rc=block.content.map(c=>c.text||'').join('\n');else rc=String(block.content||'');return `<div class="mt-2 bg-white/[0.03] ring-1 ring-white/[0.05] rounded-xl overflow-hidden"><div class="tool-hdr px-3 py-1.5 text-[10px] font-semibold text-emerald-400/50 flex items-center gap-1.5" onclick="toggleTool('${id}')"><span class="arr">▶</span> Tool Result</div><div class="tool-body p-3 text-[10px] text-white/25 font-mono whitespace-pre-wrap max-h-60 overflow-y-auto" id="${id}">${esc(rc.slice(0,5000))}</div></div>`;}
  return `<div class="text-[10px] text-white/10">[${esc(t)}]</div>`;
}

async function openSubagentFromDescription(description) {
  const sub = state.subagentsByDescription[description];
  if (!sub) return;
  try {
    const detail = await safeFetch(`/api/sessions/${encodeURIComponent(sub.id)}`);
    openConversation(sub.id, detail);
  } catch (e) { console.error('openSubagentFromDescription:', e); }
}

async function openParentFromSubagent(parentId) {
  try {
    const detail = await safeFetch(`/api/sessions/${encodeURIComponent(parentId)}`);
    openConversation(parentId, detail);
  } catch (e) { console.error('openParentFromSubagent:', e); }
}
function toggleTool(id){const b=document.getElementById(id);const h=b.previousElementSibling;b.classList.toggle('open');h.classList.toggle('open');}

// ─── Models ─────────────────────────────────────────────────────────────
function renderModelsSortBar(){
  const opts=[['messages','메시지'],['cost','비용'],['input','입력'],['output','출력'],['cache','캐시'],['model','이름']];
  document.getElementById('modelsSortBar').innerHTML=
    '<span class="text-white/35 uppercase font-bold tracking-widest mr-2 text-[10px]">정렬</span>'+
    opts.map(([k,l])=>sortPillHtml('models',k,l,'text-[10px]')).join('');
}
async function loadModels(){
  try{
    renderModelsSortBar();
    const ss=sortState.models;
    const data=await safeFetch(`/api/models?sort=${ss.key}&order=${ss.order}`);
    const rows=data.models||[];
    const grid=document.getElementById('modelsGrid');grid.innerHTML='';
    if(!rows.length){grid.innerHTML='<div class="col-span-full text-center text-white/25 text-xs py-16">데이터 없음</div>';return;}
    const mx=Math.max(...rows.map(r=>r.message_count||0),1);
    rows.forEach(r=>{
      const pct=Math.round((r.message_count||0)/mx*100);
      const card=document.createElement('div');
      card.className='bg-white/5 ring-1 ring-white/[0.07] p-1 rounded-bezel';
      card.innerHTML=`
        <div class="bg-white/[0.02] rounded-bezel-inner shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] p-5">
          <div class="text-sm font-bold text-white/85 mb-4">${esc(r.model||'—')}</div>
          <div class="space-y-1.5 text-[11px]">
            <div class="flex justify-between"><span class="text-white/35">메시지</span><span class="text-white/80 font-bold tabular-nums">${fmtN(r.message_count||0)}</span></div>
            <div class="flex justify-between"><span class="text-white/35">입력</span><span class="text-white/60 tabular-nums">${fmtTok(r.input_tokens||0)}</span></div>
            <div class="flex justify-between"><span class="text-white/35">출력</span><span class="text-emerald-400/75 tabular-nums">${fmtTok(r.output_tokens||0)}</span></div>
            <div class="flex justify-between"><span class="text-white/35">캐시 읽기</span><span class="text-cyan-400/75 tabular-nums">${fmtTok(r.cache_read_tokens||0)}</span></div>
            <div class="flex justify-between"><span class="text-white/35">비용</span><span class="text-amber-400/85 font-bold tabular-nums">${fmt$(r.cost_usd)}</span></div>
          </div>
          <div class="mt-4">
            <div class="flex justify-between text-[9px] text-white/30 mb-1 uppercase font-bold tracking-widest"><span>사용 비중</span><span>${pct}%</span></div>
            <div class="h-1 bg-white/5 rounded-full overflow-hidden"><div class="h-full rounded-full bg-accent" style="width:${pct}%"></div></div>
          </div>
        </div>`;
      grid.appendChild(card);
    });
  }catch(e){reportError('loadModels',e);}
}

// ─── Projects ───────────────────────────────────────────────────────────
function renderProjectsThead(){
  document.getElementById('projectsThead').innerHTML=`
    <tr class="text-[10px] text-white/35 uppercase tracking-widest border-b border-white/[0.05]">
      ${sortThHtml('projects','name','프로젝트','text-left','px-5')}
      ${sortThHtml('projects','sessions','세션','text-right')}
      ${sortThHtml('projects','tokens','토큰','text-right')}
      ${sortThHtml('projects','cost','비용','text-right')}
      ${sortThHtml('projects','last_active','활동','text-right')}
      <th class="text-center px-3 py-2.5 font-bold text-white/35 w-20">관리</th>
    </tr>`;
}
async function loadProjects(){
  const tb=document.getElementById('projectsBody');
  tb.innerHTML='<tr><td colspan="8" class="text-center py-8 text-white/15 text-xs dots">로딩 중</td></tr>';
  try{
    const ss=sortState.projects;
    const data=await safeFetch(`/api/projects?sort=${ss.key}&order=${ss.order}`);
    renderProjectsThead();
    tb.innerHTML='';
    if(!data.projects?.length){tb.innerHTML='<tr><td colspan="8" class="text-center py-12 text-white/25 text-xs">데이터 없음</td></tr>';return;}
    (data.projects||[]).forEach(p=>{
      const tr=document.createElement('tr');
      tr.className='border-b border-white/[0.03] hover:bg-white/[0.05] cursor-pointer spring';
      tr.onclick=()=>showProjectDetail(p.project_name,p.project_path);
      const pTagList = (p.tags || '').split(',').map(t => t.trim()).filter(Boolean);
      const pTagRow = pTagList.length
        ? `<div class="mt-1 flex flex-wrap gap-1">${pTagList.map(t => `<span class="tag-badge">#${esc(t)}</span>`).join('')}</div>`
        : '';
      tr.innerHTML=`
        <td class="px-5 py-3">
          <div class="font-bold text-white/90 truncate">${esc(p.project_name||'—')}</div>
          <div class="text-[10px] text-white/30 mt-0.5 truncate max-w-md" title="${esc(p.project_path||'')}">${esc(p.project_path||'')}</div>
          ${pTagRow}
        </td>
        <td class="px-3 py-3 text-right tabular-nums text-white/75 font-semibold">${fmtN(p.session_count||0)}</td>
        <td class="px-3 py-3 text-right"><span class="text-[11px] px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400/80 font-semibold tabular-nums">${fmtTok(p.total_tokens||0)}</span></td>
        <td class="px-3 py-3 text-right"><span class="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400/85 font-bold tabular-nums">${fmt$(p.total_cost)}</span></td>
        <td class="px-3 py-3 text-right text-white/40">${relTime(p.last_active)}</td>
        <td class="px-3 py-3 text-center whitespace-nowrap"></td>`;
      // Attach delete button via DOM API (safe against path/name HTML injection)
      const delBtn = document.createElement('button');
      delBtn.className = 'text-white/20 hover:text-red-400 spring text-sm';
      delBtn.title = '삭제';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteProject(p.project_name, p.project_path);
      });
      tr.lastElementChild.appendChild(delBtn);
      tb.appendChild(tr);
    });
  }catch(e){reportError('loadProjects',e);}
}

// ─── Export / Admin ─────────────────────────────────────────────────────
async function createBackup() {
  const label = document.getElementById('backupResult');
  if (label) label.textContent = '백업 중…';
  showToast('백업 생성 중…', { type: 'info', duration: 2000 });
  try {
    const r = await fetch('/api/admin/backup', { method: 'POST' }).then(r => r.json());
    if (r.ok) {
      const mb = (r.size_bytes / 1048576).toFixed(1);
      if (label) label.textContent = `완료: ${mb} MB`;
      showToast(`백업 완료 — ${mb} MB`, { type: 'success' });
    } else {
      if (label) label.textContent = `오류: ${r.error}`;
      showToast('백업 실패: ' + (r.error || '알 수 없는 오류'), { type: 'error' });
    }
  } catch (e) {
    if (label) label.textContent = '실패';
    showToast('백업 실패: ' + (e.message || e), { type: 'error' });
  }
}

async function runRetention() {
  const days = parseInt(document.getElementById('retentionDays').value) || 90;
  const el = document.getElementById('retentionResult');
  try {
    const pv = await safeFetch(`/api/admin/retention?older_than_days=${days}`);
    if (pv.sessions_to_delete === 0) {
      if (el) el.textContent = '삭제할 데이터 없음';
      showToast('삭제할 데이터 없음', { type: 'info' });
      return;
    }
    // S2: enforce the same name-match safety on retention deletes.
    // Target string is the literal day-count so the user cannot delete by
    // clicking through without reading.
    openDeleteConfirm({
      target: `${days}일 이상`,
      message: `${days}일보다 오래된 ${fmtN(pv.sessions_to_delete)}개 세션이 영구 삭제됩니다. 복구할 수 없습니다.`,
      onConfirm: async () => {
        try {
          const r = await fetch(
            `/api/admin/retention?older_than_days=${days}&confirm=true`,
            { method: 'DELETE' }
          ).then(r => r.json());
          if (el) el.textContent = `삭제: ${r.deleted_sessions}개 세션, ${r.deleted_messages}건 메시지`;
          showToast(
            `보존 삭제 완료 — ${fmtN(r.deleted_sessions)}세션 / ${fmtN(r.deleted_messages)}메시지`,
            { type: 'success' }
          );
          loadStats();
          loadDbSize();
        } catch (e) {
          if (el) el.textContent = `오류: ${e.message}`;
          showToast('보존 삭제 실패: ' + (e.message || e), { type: 'error' });
        }
      },
    });
  } catch (e) {
    if (el) el.textContent = `오류: ${e.message}`;
    showToast('미리보기 실패: ' + (e.message || e), { type: 'error' });
  }
}

async function loadDbSize() {
  try {
    const r = await safeFetch('/api/admin/db-size');
    document.getElementById('dbSizeLabel').textContent = `${r.size_mb} MB`;
  } catch (e) { /* silent */ }
}

// ─── Dashboard status ───────────────────────────────────────────────────────
function _fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function _fmtUptime(s) {
  if (s < 60) return s + '초';
  if (s < 3600) return Math.floor(s / 60) + '분 ' + (s % 60) + '초';
  if (s < 86400) return Math.floor(s / 3600) + '시간 ' + Math.floor((s % 3600) / 60) + '분';
  return Math.floor(s / 86400) + '일 ' + Math.floor((s % 86400) / 3600) + '시간';
}

async function loadAdminStatus() {
  const body = document.getElementById('adminStatusBody');
  if (!body) return;
  try {
    const d = await safeFetch('/api/admin/status');
    body.textContent = '';
    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-2 gap-2';
    const card = (label, value, cls) => {
      const c = document.createElement('div');
      c.className = 'bg-white/[0.03] rounded-lg p-2';
      const l = document.createElement('div');
      l.className = 'text-[9px] text-white/30 uppercase tracking-widest';
      l.textContent = label;
      const v = document.createElement('div');
      v.className = 'text-xs font-bold tabular-nums mt-0.5 ' + (cls || 'text-white/80');
      v.textContent = value;
      c.append(l, v); return c;
    };
    const c = d.counts || {};
    const w = d.watcher || {};
    grid.append(
      card('가동 시간', _fmtUptime(d.uptime_seconds || 0), 'text-emerald-400/80'),
      card('스키마', 'v' + (d.schema_version || 0), 'text-cyan-400/80'),
      card('DB 크기', _fmtBytes(d.db?.size_bytes || 0)),
      card('WAL 크기', _fmtBytes(d.db?.wal_size_bytes || 0), (d.db?.wal_size_bytes > 52428800 ? 'text-amber-400/80' : 'text-white/80')),
      card('세션', fmtN(c.sessions || 0)),
      card('메시지', fmtN(c.messages || 0)),
      card('Subagent', fmtN(c.subagents || 0), 'text-blue-400/80'),
      card('원격 노드', fmtN(c.remote_nodes || 0)),
      card('Watcher', w.running ? '실행 중' : '정지', w.running ? 'text-emerald-400/80' : 'text-rose-400/80'),
      card('추적 파일', fmtN(w.files_tracked || 0) + (w.queue_size ? ` (q:${w.queue_size})` : '')),
    );
    body.appendChild(grid);
  } catch (e) {
    body.textContent = '';
    const err = document.createElement('div');
    err.className = 'text-center text-red-400/60 text-xs py-3';
    err.textContent = '상태 로드 실패';
    body.appendChild(err);
  }
}
function refreshAdminStatus() { loadAdminStatus(); }

// ─── Retention schedule ────────────────────────────────────────────────────
async function loadSchedule() {
  try {
    const d = await safeFetch('/api/admin/retention/schedule');
    const cb = document.getElementById('schedEnabled');
    const iv = document.getElementById('schedInterval');
    const dy = document.getElementById('schedDays');
    const lbl = document.getElementById('schedEnabledLabel');
    const meta = document.getElementById('schedMeta');
    if (cb) cb.checked = !!d.enabled;
    if (iv) iv.value = d.interval_hours || 24;
    if (dy) dy.value = d.older_than_days || 90;
    if (lbl) { lbl.textContent = d.enabled ? '활성' : '비활성'; lbl.className = 'text-[10px] ' + (d.enabled ? 'text-emerald-400/80' : 'text-white/60'); }
    if (meta) {
      meta.textContent = '';
      const mkLine = (k, v, cls) => {
        const r = document.createElement('div');
        const kk = document.createElement('span'); kk.className = 'text-white/25 mr-2'; kk.textContent = k;
        const vv = document.createElement('span'); vv.className = cls || 'text-white/60 tabular-nums'; vv.textContent = v;
        r.append(kk, vv); return r;
      };
      if (d.enabled && d.next_run_at) meta.appendChild(mkLine('다음 실행', d.next_run_at.replace('T', ' ').replace('Z', ' UTC'), 'text-accent/70'));
      if (d.last_run_at) {
        meta.appendChild(mkLine('마지막 실행', d.last_run_at.replace('T', ' ').replace('Z', ' UTC')));
        if (d.last_result) {
          meta.appendChild(mkLine('마지막 결과', `세션 ${fmtN(d.last_result.sessions || 0)} · 메시지 ${fmtN(d.last_result.messages || 0)} 삭제`));
        }
      } else {
        meta.appendChild(mkLine('마지막 실행', '없음', 'text-white/30'));
      }
    }
  } catch (e) {
    reportError('loadSchedule', e);
  }
}

async function saveSchedule() {
  const payload = {
    enabled: document.getElementById('schedEnabled')?.checked || false,
    interval_hours: parseInt(document.getElementById('schedInterval')?.value || '24', 10),
    older_than_days: parseInt(document.getElementById('schedDays')?.value || '90', 10),
  };
  try {
    await safeFetch('/api/admin/retention/schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    showToast('스케줄 저장됨', { type: 'success', duration: 2000 });
    loadSchedule();
  } catch (e) { reportError('saveSchedule', e); }
}

// ─── Audit log ─────────────────────────────────────────────────────────────
async function loadAuditLog() {
  const body = document.getElementById('auditLogBody');
  if (!body) return;
  const action = document.getElementById('auditAction')?.value || '';
  const url = '/api/admin/audit?limit=100' + (action ? '&action=' + encodeURIComponent(action) : '');
  try {
    const d = await safeFetch(url);
    const entries = d.entries || [];
    body.textContent = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'text-center text-white/15 text-xs py-4';
      empty.textContent = '기록 없음';
      body.appendChild(empty); return;
    }
    const table = document.createElement('table');
    table.className = 'w-full text-[10px]';
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    htr.className = 'text-[9px] text-white/30 uppercase tracking-widest border-b border-white/[0.05]';
    ['시각', '액션', 'IP', '상태', '상세'].forEach((t, i) => {
      const th = document.createElement('th');
      th.className = (i < 4 ? 'text-left' : 'text-left') + ' px-2 py-1.5 font-bold';
      th.textContent = t;
      htr.appendChild(th);
    });
    thead.appendChild(htr); table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const e of entries) {
      const tr = document.createElement('tr');
      tr.className = 'border-b border-white/[0.03] hover:bg-white/[0.02] spring';
      const mk = (txt, cls) => { const td = document.createElement('td'); td.className = 'px-2 py-1 ' + (cls || 'text-white/55'); td.textContent = txt; return td; };
      tr.appendChild(mk((e.ts || '').replace('T', ' ').replace('Z', '').slice(0, 19), 'px-2 py-1 text-white/40 tabular-nums'));
      const actionCls = e.action === 'retention' || e.action === 'retention_scheduled' ? 'text-amber-400/80 font-bold'
                      : e.action === 'backup' ? 'text-emerald-400/80 font-bold'
                      : e.action?.startsWith('node_') ? 'text-cyan-400/80 font-bold'
                      : 'text-white/70 font-bold';
      tr.appendChild(mk(e.action || '', 'px-2 py-1 ' + actionCls));
      tr.appendChild(mk(e.actor_ip || '', 'px-2 py-1 text-white/30 tabular-nums'));
      const statusCls = e.status === 'ok' ? 'text-emerald-400/70' : 'text-rose-400/70';
      tr.appendChild(mk(e.status || '', 'px-2 py-1 ' + statusCls));
      const detailTd = document.createElement('td');
      detailTd.className = 'px-2 py-1 text-white/40 font-mono truncate max-w-[400px]';
      detailTd.textContent = e.detail ? (typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail)) : '';
      if (e.detail) detailTd.title = detailTd.textContent;
      tr.appendChild(detailTd);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);
  } catch (e) {
    body.textContent = '';
    const err = document.createElement('div');
    err.className = 'text-center text-red-400/60 text-xs py-3';
    err.textContent = '로그 로드 실패';
    body.appendChild(err);
  }
}
function refreshAudit() { loadAuditLog(); }

async function exportCSV() {
  const a = document.createElement('a');
  a.href = '/api/export/csv';
  a.download = 'claude-usage.csv';
  a.click();
  showToast('CSV 다운로드 시작됨', { type: 'success', duration: 2000 });
}

async function exportJSON() {
  try {
    const [s, m] = await Promise.all([
      safeFetch('/api/sessions?per_page=100'),
      safeFetch('/api/models'),
    ]);
    const payload = JSON.stringify({ sessions: s.sessions, models: m.models }, null, 2);
    await navigator.clipboard.writeText(payload);
    showToast('JSON 클립보드 복사됨', { type: 'success' });
  } catch (e) {
    showToast('JSON 복사 실패: ' + (e.message || e), { type: 'error' });
  }
}

// ─── Remote node management ──────────────────────────────────────────

async function renderNodeList() {
  const el = document.getElementById('nodeList');
  if (!el) return;
  try {
    const d = await safeFetch('/api/nodes');
    state.nodes = d.nodes || [];
    el.textContent = '';
    if (!state.nodes.length) {
      const empty = document.createElement('div');
      empty.className = 'text-center text-white/15 text-xs py-4';
      empty.textContent = '\uB4F1\uB85D\uB41C \uB178\uB4DC \uC5C6\uC74C';
      el.appendChild(empty); return;
    }
    const table = document.createElement('table');
    table.className = 'w-full';
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    htr.className = 'text-[9px] text-white/25 uppercase tracking-widest border-b border-white/[0.05]';
    ['\uB178\uB4DC', '\uB77C\uBCA8', '\uC138\uC158', '\uBA54\uC2DC\uC9C0', '\uB9C8\uC9C0\uB9C9 \uC811\uC18D', ''].forEach(t => {
      const th = document.createElement('th');
      th.className = 'px-2 py-1.5 text-left font-bold';
      th.textContent = t; htr.appendChild(th);
    });
    thead.appendChild(htr); table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const n of state.nodes) {
      const tr = document.createElement('tr');
      tr.className = 'border-b border-white/[0.03] hover:bg-white/[0.02]';
      const mkTd = (text, cls) => {
        const td = document.createElement('td');
        td.className = 'px-2 py-2 ' + (cls || 'text-white/50');
        td.textContent = text; return td;
      };
      const isLocal = n.node_id === 'local';
      tr.appendChild(mkTd(n.node_id, 'font-bold ' + (isLocal ? 'text-accent/70' : 'text-white/70')));
      tr.appendChild(mkTd(n.label || '\u2014', 'text-white/40'));
      tr.appendChild(mkTd(fmtN(n.session_count || 0), 'tabular-nums text-white/40'));
      tr.appendChild(mkTd(fmtN(n.message_count || 0), 'tabular-nums text-white/40'));
      tr.appendChild(mkTd(n.last_seen ? fmtTime(n.last_seen) : (isLocal ? '\u2014' : '\uBBF8\uC811\uC18D'), 'text-white/30'));
      const actionTd = document.createElement('td');
      actionTd.className = 'px-2 py-2';
      if (!isLocal) {
        const rotateBtn = document.createElement('button');
        rotateBtn.className = 'text-[9px] text-white/25 hover:text-accent spring mr-2';
        rotateBtn.textContent = '\uD0A4 \uC7AC\uBC1C\uAE09';
        rotateBtn.addEventListener('click', () => rotateNodeKey(n.node_id));
        const delBtn = document.createElement('button');
        delBtn.className = 'text-[9px] text-white/25 hover:text-red-400 spring';
        delBtn.textContent = '\uC0AD\uC81C';
        delBtn.addEventListener('click', () => deleteNode(n.node_id));
        actionTd.append(rotateBtn, delBtn);
      }
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody); el.appendChild(table);
    // Also refresh the filter dropdown
    loadNodes();
  } catch (e) {
    el.textContent = '';
    const err = document.createElement('div');
    err.className = 'text-center text-red-400/60 text-xs py-3';
    err.textContent = '\uB178\uB4DC \uBAA9\uB85D \uB85C\uB4DC \uC2E4\uD328';
    el.appendChild(err);
  }
}

function openNodeRegister() {
  const form = document.getElementById('nodeRegisterForm');
  if (form) { form.classList.remove('hidden'); document.getElementById('nodeIdInput')?.focus(); }
}

async function submitNodeRegister() {
  const nodeId = document.getElementById('nodeIdInput')?.value?.trim();
  const label = document.getElementById('nodeLabelInput')?.value?.trim();
  const resultEl = document.getElementById('nodeRegisterResult');
  if (!nodeId) { if (resultEl) resultEl.textContent = '\uB178\uB4DC ID\uB97C \uC785\uB825\uD558\uC138\uC694'; return; }
  try {
    const resp = await fetch('/api/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_id: nodeId, label: label || null }),
    });
    const d = await resp.json();
    if (!resp.ok) {
      if (resultEl) resultEl.textContent = d.error || '\uB4F1\uB85D \uC2E4\uD328';
      return;
    }
    if (resultEl) {
      resultEl.textContent = '';
      const msg = document.createElement('div');
      msg.className = 'text-accent/80 font-bold';
      msg.textContent = '\u2713 \uB4F1\uB85D \uC644\uB8CC! \uC544\uB798 Ingest Key\uB97C \uBCF5\uC0AC\uD558\uC138\uC694 (\uC7AC\uD45C\uC2DC \uBD88\uAC00):';
      const keyBox = document.createElement('div');
      keyBox.className = 'mt-1 p-2 bg-black/30 rounded-lg font-mono text-[10px] text-amber-400/90 break-all select-all cursor-pointer';
      keyBox.textContent = d.ingest_key;
      keyBox.title = '\uD074\uB9AD\uD558\uC5EC \uBCF5\uC0AC';
      keyBox.addEventListener('click', () => {
        navigator.clipboard.writeText(d.ingest_key);
        showToast('Ingest Key \uBCF5\uC0AC\uB428', { type: 'success', duration: 1500 });
      });
      const steps = document.createElement('div');
      steps.className = 'mt-2 space-y-1.5';
      const step1 = document.createElement('div');
      step1.className = 'p-2 bg-black/20 rounded-lg text-[9px] text-white/40 font-mono break-all';
      step1.textContent = '# 1. \uC6D0\uACA9 \uC11C\uBC84\uC5D0\uC11C collector \uB2E4\uC6B4\uB85C\uB4DC';
      const dl = document.createElement('div');
      dl.className = 'p-2 bg-black/20 rounded-lg text-[9px] text-white/40 font-mono break-all';
      dl.textContent = 'curl -o collector.py ' + location.origin + '/api/collector.py';
      const step2 = document.createElement('div');
      step2.className = 'p-2 bg-black/20 rounded-lg text-[9px] text-white/40 font-mono break-all';
      step2.textContent = '# 2. \uC2E4\uD589';
      const cmd = document.createElement('div');
      cmd.className = 'p-2 bg-black/20 rounded-lg text-[9px] text-accent/60 font-mono break-all';
      cmd.textContent = 'python3 collector.py --url ' + location.origin + ' --node-id ' + nodeId + ' --ingest-key ' + d.ingest_key;
      steps.append(step1, dl, step2, cmd);
      resultEl.append(msg, keyBox, steps);
    }
    document.getElementById('nodeIdInput').value = '';
    document.getElementById('nodeLabelInput').value = '';
    renderNodeList();
  } catch (e) {
    if (resultEl) resultEl.textContent = '\uB124\uD2B8\uC6CC\uD06C \uC624\uB958';
  }
}

async function rotateNodeKey(nodeId) {
  if (!confirm(nodeId + ' \uB178\uB4DC\uC758 Ingest Key\uB97C \uC7AC\uBC1C\uAE09\uD569\uB2C8\uB2E4. \uAE30\uC874 \uD0A4\uB294 \uBB34\uD6A8\uD654\uB429\uB2C8\uB2E4.')) return;
  try {
    const resp = await fetch('/api/nodes/' + encodeURIComponent(nodeId) + '/rotate-key', { method: 'POST' });
    const d = await resp.json();
    if (resp.ok) {
      prompt('\uC0C8 Ingest Key (\uBCF5\uC0AC\uD558\uC138\uC694):', d.ingest_key);
      showToast('\uD0A4 \uC7AC\uBC1C\uAE09 \uC644\uB8CC', { type: 'success' });
    } else {
      showToast(d.error || '\uC2E4\uD328', { type: 'error' });
    }
  } catch (e) { showToast('\uB124\uD2B8\uC6CC\uD06C \uC624\uB958', { type: 'error' }); }
}

async function deleteNode(nodeId) {
  if (!confirm(nodeId + ' \uB178\uB4DC\uB97C \uC0AD\uC81C\uD569\uB2C8\uB2E4. \uC218\uC9D1\uB41C \uB370\uC774\uD130\uB294 \uC720\uC9C0\uB429\uB2C8\uB2E4.')) return;
  try {
    const resp = await fetch('/api/nodes/' + encodeURIComponent(nodeId), { method: 'DELETE' });
    if (resp.ok) {
      showToast(nodeId + ' \uC0AD\uC81C\uB428', { type: 'success' });
      renderNodeList();
    } else {
      const d = await resp.json();
      showToast(d.error || '\uC2E4\uD328', { type: 'error' });
    }
  } catch (e) { showToast('\uB124\uD2B8\uC6CC\uD06C \uC624\uB958', { type: 'error' }); }
}

// ─── Period usage (day/week/month) ────────────────────────────────────
// Moved to static/overview.js (loadPeriods, renderPeriod).

// ─── Plan usage / settings ──────────────────────────────────────────────
// Moved to static/plan.js. Exposes: loadPlanUsage, renderPlanBlock,
// planBarColor, fmtDuration, fmtResetTime, openPlanSettings,
// closePlanSettings, savePlanConfig, applyPlanPreset, setSettingsTab.

// ─── Session Management ─────────────────────────────────────────────────  (moved)
// Moved to static/sessions.js.

// ─── Conversation Search ────────────────────────────────────────────────
let convSearchTimer = null;

// Highlight every search token (case-insensitive) inside an already-escaped
// preview snippet. The output is HTML-safe because we esc() first, then
// inject only `<mark>` tags which we trust.
function highlightTokens(escaped, query) {
  if (!query) return escaped;
  const tokens = query.match(/[\w가-힣]+/gu) || [];
  if (!tokens.length) return escaped;
  // Sort longest first so 'queryparser' beats 'query' on overlap
  tokens.sort((a, b) => b.length - a.length);
  // Build a single regex with all tokens, escaping regex specials
  const pattern = tokens
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const re = new RegExp(`(${pattern})`, 'giu');
  return escaped.replace(re, '<mark class="bg-amber-400/30 text-amber-200 rounded px-0.5">$1</mark>');
}

function searchConversations(q) {
  clearTimeout(convSearchTimer);
  const box = document.getElementById('convSearchResults');
  if (!q || q.length < 2) { box.classList.add('hidden'); box.textContent=''; return; }
  convSearchTimer = setTimeout(async () => {
    try {
      if (state.convSource === 'claude-ai') {
        const d = await safeFetch(`/api/claude-ai/search?q=${encodeURIComponent(q)}&limit=20&_t=${Date.now()}`);
        box.textContent = '';
        if (!d.results?.length) {
          const empty = document.createElement('div');
          empty.className = 'px-3 py-2 text-[10px] text-white/15';
          empty.textContent = '결과 없음';
          box.appendChild(empty);
          box.classList.remove('hidden');
          return;
        }
        d.results.forEach(r => {
          const row = document.createElement('div');
          row.className = 'px-3 py-2 border-b border-white/[0.03] cursor-pointer spring hover:bg-white/[0.03]';
          const top = document.createElement('div');
          top.className = 'flex justify-between items-center';
          const name = document.createElement('span');
          name.className = 'text-[10px] font-semibold text-accent/60 truncate';
          name.textContent = r.conversation_name || '(unnamed)';
          const when = document.createElement('span');
          when.className = 'text-[9px] text-white/15 flex-shrink-0 ml-2';
          when.textContent = (r.sender === 'human' ? '사용자' : 'AI') + ' · ' + fmtTime(r.created_at);
          top.appendChild(name);
          top.appendChild(when);
          const preview = document.createElement('div');
          preview.className = 'text-[10px] text-white/35 mt-0.5 line-clamp-2';
          preview.textContent = (r.snippet || '').slice(0, 200);
          row.appendChild(top);
          row.appendChild(preview);
          row.onclick = () => openCaiConvFromSearch(r.conversation_uuid);
          box.appendChild(row);
        });
        box.classList.remove('hidden');
        return;
      }
      const d = await safeFetch(`/api/sessions/search?q=${encodeURIComponent(q)}&limit=20&_t=${Date.now()}`);
      if (!d.results?.length) { box.innerHTML='<div class="px-3 py-2 text-[10px] text-white/15">결과 없음</div>'; box.classList.remove('hidden'); return; }
      box.innerHTML = d.results.map(r => {
        const safeName = highlightTokens(esc(r.project_name || ''), q);
        const safePreview = highlightTokens(esc((r.content_preview || '').slice(0, 200)), q);
        return `<div class="px-3 py-2 border-b border-white/[0.03] cursor-pointer spring hover:bg-white/[0.03]" onclick="openConvFromSearch('${esc(r.session_id)}',${r.id})">
          <div class="flex justify-between items-center">
            <span class="text-[10px] font-semibold text-accent/60">${safeName}</span>
            <span class="text-[9px] text-white/15">${r.role==='user'?'사용자':'AI'} · ${fmtTime(r.timestamp)}</span>
          </div>
          <div class="text-[10px] text-white/35 mt-0.5 line-clamp-2">${safePreview}</div>
        </div>`;
      }).join('');
      box.classList.remove('hidden');
    } catch(e) {
      console.error('searchConv:', e);
      showToast('검색 실패: ' + (e.message || e), { type: 'error' });
    }
  }, 400);
}

async function openCaiConvFromSearch(uuid) {
  document.getElementById('convSearchResults').classList.add('hidden');
  try {
    const conv = await safeFetch(`/api/claude-ai/conversations/${encodeURIComponent(uuid)}`);
    openClaudeAiConversation(uuid, conv);
  } catch (e) { reportError('openCaiConvFromSearch', e); }
}
async function openConvFromSearch(sid, messageId) {
  const searchInput = document.getElementById('convSearch');
  const keyword = searchInput?.value || '';
  document.getElementById('convSearchResults').classList.add('hidden');
  try {
    const s = await safeFetch(`/api/sessions/${sid}`);
    if (messageId) {
      // Find the position of the target message, then load a window around it
      const pos = await safeFetch(`/api/sessions/${encodeURIComponent(sid)}/message-position?message_id=${messageId}`);
      const targetOffset = Math.max(0, pos.position - 50); // load 50 before target
      const data = await safeFetch(`/api/sessions/${encodeURIComponent(sid)}/messages?limit=500&offset=${targetOffset}`);
      const msgs = data.messages || [];
      // Render directly (bypass openConversation's default 200-limit load)
      await openConversation(sid, s);
      // If we loaded from a non-zero offset, the viewer already has the first 200.
      // We need to reload with the correct window. Clear and re-render.
      if (targetOffset > 0) {
        const c = document.getElementById('convMessages');
        c.textContent = '';
        state.convMessages = msgs;
        let prevBranch = null;
        let prevTs = null;
        msgs.forEach(m => {
          _renderTimeGap(c, prevTs, m.timestamp);
          _renderSingleMessage(c, m, msgs, prevBranch);
          if (m.git_branch) prevBranch = m.git_branch;
          prevTs = m.timestamp;
        });
        renderConvStats(msgs, s);
        const countLabel = document.getElementById('convMsgCount');
        if (countLabel) {
          const u = msgs.filter(m => m.role === 'user').length;
          const a = msgs.filter(m => m.role === 'assistant').length;
          countLabel.textContent = `${fmtN(msgs.length)}\uAC74 (\uC0AC\uC6A9\uC790 ${u} \u00b7 \uC5B4\uC2DC\uC2A4\uD134\uD2B8 ${a}) \u2014 \uC624\uD504\uC14B ${fmtN(targetOffset)}`;
        }
      }
      // Scroll to the target message
      const targetEl = document.querySelector(`#convMessages [data-msg-role]`);
      const allEls = document.querySelectorAll('#convMessages [data-msg-role]');
      const targetLocalIdx = pos.position - targetOffset;
      if (allEls[targetLocalIdx]) {
        allEls[targetLocalIdx].classList.add('conv-msg-focused');
        allEls[targetLocalIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
        _convFocusIdx = targetLocalIdx;
      }
    } else {
      await openConversation(sid, s);
    }
    // Auto-trigger inline search with the keyword
    if (keyword) {
      const inlineInput = document.getElementById('convInlineSearch');
      if (inlineInput) {
        inlineInput.value = keyword;
        _convInlineSearch(keyword);
      }
    }
  } catch(e) { console.error('openConvFromSearch:', e); }
}

// ─── Project Management ─────────────────────────────────────────────────
async function deleteProject(name, path) {
  try {
    const qs = path ? `?path=${encodeURIComponent(path)}` : '';
    const pv = await fetch(
      `/api/projects/${encodeURIComponent(name)}${qs}`,
      { method: 'DELETE' }
    ).then(r => r.json());
    openDeleteConfirm({
      target: name,
      message: `이 프로젝트의 ${fmtN(pv.sessions)}개 세션, ${fmtN(pv.messages)}건 메시지, ${fmt$(pv.cost)} 비용이 영구 삭제됩니다.`,
      onConfirm: async () => {
        try {
          const confirmQs = path
            ? `?path=${encodeURIComponent(path)}&confirm=true`
            : '?confirm=true';
          await fetch(
            `/api/projects/${encodeURIComponent(name)}${confirmQs}`,
            { method: 'DELETE' }
          );
          loadProjects(); loadStats(); loadPeriods(); loadTopProjects();
          showToast(`"${name}" 삭제 완료`, { type: 'success', duration: 2000 });
        } catch (e) {
          showToast('삭제 실패: ' + (e.message || e), { type: 'error' });
        }
      },
    });
  } catch (e) {
    console.error('deleteProject:', e);
    showToast('미리보기 실패: ' + (e.message || e), { type: 'error' });
  }
}
// Project modal state
let projectData = null;
let projectConvData = null;
let projectConvOrder = 'asc';
let projectSessSort = { key:'updated_at', order:'desc' };

function _projQs(path) {
  return path ? `?path=${encodeURIComponent(path)}` : '';
}

async function showProjectDetail(name, path) {
  const modal = document.getElementById('projectModal');
  document.getElementById('projModalTitle').textContent = name || '—';
  document.getElementById('projModalPath').textContent = path || '';
  modal.dataset.project = name;
  modal.dataset.projectPath = path || '';
  modal.style.display = 'flex';
  setTimeout(() => modal.querySelector('[role="tab"]')?.focus(), 100);
  projectData = null;
  projectConvData = null;
  projectSessSort = { key:'updated_at', order:'desc' };
  // Deep-link into this project via URL hash
  const hashPath = path ? `?path=${encodeURIComponent(path)}` : '';
  history.replaceState(null, '', `#/project/${encodeURIComponent(name)}${hashPath}`);
  setProjectTab('overview', false);
  document.getElementById('projTabContent').innerHTML = '<div class="text-center text-white/25 text-xs py-12 dots">로딩 중</div>';
  try {
    projectData = await safeFetch(
      `/api/projects/${encodeURIComponent(name)}/stats${_projQs(path)}`);
    renderProjectOverview();
  } catch (e) {
    document.getElementById('projTabContent').innerHTML =
      `<div class="text-center text-red-400/60 text-xs py-12">로딩 실패: ${esc(e.message)}</div>`;
  }
}

// Closing the modal should also clear the hash so refresh lands back on list
function closeProjectModal() {
  document.getElementById('projectModal').style.display = 'none';
  if (location.hash.startsWith('#/project/')) {
    history.replaceState(null, '', '#/projects');
  }
}

function setProjectTab(tab, reload = true) {
  document.querySelectorAll('#projectModal .proj-tab').forEach(t => {
    const active = t.dataset.tab === tab;
    t.classList.toggle('text-accent', active);
    t.classList.toggle('border-accent', active);
    t.classList.toggle('text-white/35', !active);
    t.classList.toggle('border-transparent', !active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  if (!reload) return;
  if (tab === 'overview') renderProjectOverview();
  else if (tab === 'sessions') renderProjectSessionsTab();
  else if (tab === 'conversations') loadProjectMessages();
}

// Bind tab clicks once (script runs at end of body, DOM is ready)
document.querySelectorAll('#projectModal .proj-tab').forEach(btn => {
  btn.addEventListener('click', () => setProjectTab(btn.dataset.tab));
});
// Arrow key navigation for project modal tab strip (LOW-2)
document.querySelectorAll('#projectModal [role="tab"]').forEach((tab, i, tabs) => {
  tab.addEventListener('keydown', (e) => {
    let target;
    if (e.key === 'ArrowRight') target = tabs[(i + 1) % tabs.length];
    else if (e.key === 'ArrowLeft') target = tabs[(i - 1 + tabs.length) % tabs.length];
    if (target) { e.preventDefault(); target.focus(); target.click(); }
  });
});

function renderProjectOverview() {
  if (!projectData) return;
  const s = projectData.summary;
  document.getElementById('projTabContent').innerHTML = `
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div class="bg-white/5 ring-1 ring-white/[0.07] rounded-xl p-4">
        <div class="text-[10px] text-white/35 uppercase font-bold tracking-widest">세션</div>
        <div class="text-2xl font-extrabold text-white/90 mt-1 tabular-nums">${fmtN(s.sessions)}</div>
      </div>
      <div class="bg-white/5 ring-1 ring-white/[0.07] rounded-xl p-4">
        <div class="text-[10px] text-white/35 uppercase font-bold tracking-widest">메시지</div>
        <div class="text-2xl font-extrabold text-white/90 mt-1 tabular-nums">${fmtN(s.messages)}</div>
      </div>
      <div class="bg-white/5 ring-1 ring-white/[0.07] rounded-xl p-4">
        <div class="text-[10px] text-white/35 uppercase font-bold tracking-widest">비용</div>
        <div class="text-2xl font-extrabold text-amber-400/90 mt-1 tabular-nums">${fmt$(s.cost)}</div>
      </div>
      <div class="bg-white/5 ring-1 ring-white/[0.07] rounded-xl p-4">
        <div class="text-[10px] text-white/35 uppercase font-bold tracking-widest">캐시 읽기</div>
        <div class="text-2xl font-extrabold text-cyan-400/85 mt-1 tabular-nums">${fmtTok(s.cache_read_tokens)}</div>
      </div>
    </div>
    <div class="mt-5 text-[11px] text-white/45 flex flex-wrap gap-x-6 gap-y-1.5 px-1">
      <span>첫 활동: <span class="text-white/65">${fmtTime(s.first_active)}</span></span>
      <span>마지막 활동: <span class="text-white/65">${fmtTime(s.last_active)}</span></span>
      <span>입력: <span class="text-white/65 tabular-nums">${fmtTok(s.input_tokens)}</span></span>
      <span>출력: <span class="text-emerald-400/75 tabular-nums">${fmtTok(s.output_tokens)}</span></span>
    </div>
    ${projectData.models && projectData.models.length ? `
    <div class="mt-6">
      <div class="text-[10px] font-bold text-white/45 uppercase tracking-widest mb-2">모델별 사용량</div>
      <div class="space-y-1.5">
        ${projectData.models.map(m => `
          <div class="flex items-center justify-between text-[11px] bg-white/[0.03] ring-1 ring-white/[0.05] rounded-lg px-3 py-2">
            <span class="text-white/75 font-semibold">${esc(m.model)}</span>
            <div class="flex items-center gap-5">
              <span class="text-white/45 tabular-nums">${m.cnt}건</span>
              <span class="text-amber-400/85 font-bold tabular-nums">${fmt$(m.cost)}</span>
            </div>
          </div>
        `).join('')}
      </div>
    </div>` : ''}
    ${projectData.daily && projectData.daily.length ? `
    <div class="mt-6">
      <div class="text-[10px] font-bold text-white/45 uppercase tracking-widest mb-2">최근 일별 비용</div>
      <div class="bg-white/[0.02] ring-1 ring-white/[0.06] rounded-xl p-3">
        <div style="height:200px;position:relative"><canvas id="projDailyChart"></canvas></div>
      </div>
    </div>` : ''}
  `;
  // Draw the daily cost chart after the container is in the DOM.
  if (projectData.daily && projectData.daily.length) {
    renderProjectDailyChart(projectData.daily);
  }
}

function renderProjectDailyChart(daily) {
  const canvas = document.getElementById('projDailyChart');
  if (!canvas || typeof Chart === 'undefined') return;
  // daily comes in DESC order — reverse to show oldest → newest on the X axis
  const sorted = [...daily].reverse();
  const labels = sorted.map(d => d.date ? d.date.slice(5) : '');
  const costs = sorted.map(d => Number(d.cost) || 0);
  const msgs = sorted.map(d => Number(d.messages) || 0);
  // Destroy any prior instance on the same canvas (modal reopened)
  if (state.charts.projDaily) { try { state.charts.projDaily.destroy(); } catch {} state.charts.projDaily = null; }
  state.charts.projDaily = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          type: 'bar',
          label: '비용',
          data: costs,
          backgroundColor: 'rgba(251,191,36,0.35)',
          borderColor: '#fbbf24',
          borderWidth: 1,
          borderRadius: 3,
          yAxisID: 'y',
        },
        {
          type: 'line',
          label: '메시지',
          data: msgs,
          borderColor: 'rgba(96,165,250,0.85)',
          backgroundColor: 'rgba(96,165,250,0.10)',
          borderWidth: 1.5,
          tension: 0.3,
          pointRadius: 1.5,
          yAxisID: 'y1',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 350 },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'end',
          labels: legendLabels({ boxWidth: 10, font: { size: 10, family: 'Pretendard' } }),
        },
        tooltip: tooltipOpts({
          callbacks: {
            label: ctx => ctx.dataset.label === '비용'
              ? ` ${fmt$(ctx.raw)}`
              : ` ${fmtN(ctx.raw)}건`,
          },
        }),
      },
      scales: {
        x: {
          grid: grd(),
          ticks: { ...tck(), font: { size: 9, family: 'Pretendard' }, maxTicksLimit: 10, maxRotation: 0 },
        },
        y: {
          position: 'left',
          grid: grd(),
          ticks: {
            color: 'rgba(251,191,36,.75)', font: { size: 9, family: 'Pretendard' },
            callback: v => '$' + v,
          },
        },
        y1: {
          position: 'right',
          grid: { display: false },
          ticks: {
            color: 'rgba(96,165,250,.75)', font: { size: 9, family: 'Pretendard' },
            callback: v => fmtTok(v),
          },
        },
      },
    },
  });
}

function renderProjectSessionsTab() {
  if (!projectData) { document.getElementById('projTabContent').innerHTML = '<div class="text-center text-white/25 text-xs py-12">데이터 없음</div>'; return; }
  const rows = [...(projectData.sessions || [])];
  const { key, order } = projectSessSort;
  const getVal = (s, k) => {
    if (k === 'updated_at' || k === 'created_at') return s[k] || '';
    if (k === 'cost')     return s.cost_usd || 0;
    if (k === 'messages') return s.message_count || 0;
    if (k === 'model')    return s.model || '';
    if (k === 'input')    return s.total_input_tokens || 0;
    if (k === 'output')   return s.total_output_tokens || 0;
    if (k === 'cache')    return s.total_cache_read_tokens || 0;
    return s[k] || 0;
  };
  rows.sort((a, b) => {
    const av = getVal(a, key), bv = getVal(b, key);
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return order === 'asc' ? cmp : -cmp;
  });
  const th = (col, label, cls='text-left') => {
    const active = projectSessSort.key === col;
    const arr = active
      ? (projectSessSort.order === 'asc' ? '<span class="text-accent ml-1">↑</span>' : '<span class="text-accent ml-1">↓</span>')
      : '<span class="text-white/15 ml-1">↕</span>';
    return `<th class="${cls} px-3 py-2.5 font-bold cursor-pointer select-none hover:text-white/70 spring" onclick="sortProjectSessions('${col}')">${label}${arr}</th>`;
  };
  document.getElementById('projTabContent').innerHTML = `
    <div class="overflow-x-auto bg-white/[0.02] ring-1 ring-white/[0.06] rounded-xl">
      <table class="w-full text-[12px]">
        <thead>
          <tr class="text-[10px] text-white/35 uppercase tracking-widest border-b border-white/[0.06]">
            ${th('updated_at', '시각', 'text-left')}
            ${th('model', '모델', 'text-left')}
            ${th('messages', '메시지', 'text-right')}
            ${th('input', '입력', 'text-right')}
            ${th('output', '출력', 'text-right')}
            ${th('cache', '캐시', 'text-right')}
            ${th('cost', '비용', 'text-right')}
            <th class="text-center px-3 py-2.5 font-bold text-white/35 w-20">대화</th>
          </tr>
        </thead>
        <tbody class="text-white/70">
          ${rows.length === 0 ? `<tr><td colspan="8" class="text-center py-10 text-white/25">세션 없음</td></tr>` : rows.map(s => {
            const sTagList = (s.tags || '').split(',').map(t => t.trim()).filter(Boolean);
            const sTagRow = sTagList.length
              ? `<div class="mt-1 flex flex-wrap gap-1">${sTagList.map(t => `<span class="tag-badge">#${esc(t)}</span>`).join('')}</div>`
              : '';
            return `
            <tr class="border-b border-white/[0.03] hover:bg-white/[0.04] spring">
              <td class="px-3 py-3">
                <div class="text-[11px] font-semibold text-white/80">${fmtTime(s.updated_at)}</div>
                <div class="text-[9px] text-white/30 font-mono mt-0.5">${esc((s.id||'').slice(0,8))}${s.pinned ? ' <span class="text-accent">★</span>' : ''}</div>
                ${sTagRow}
              </td>
              <td class="px-3 py-3"><span class="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/50 whitespace-nowrap">${esc(shortModel(s.model||''))}</span></td>
              <td class="px-3 py-3 text-right tabular-nums">${fmtN(s.message_count||0)}</td>
              <td class="px-3 py-3 text-right text-white/55 tabular-nums">${fmtTok(s.total_input_tokens||0)}</td>
              <td class="px-3 py-3 text-right text-emerald-400/75 tabular-nums">${fmtTok(s.total_output_tokens||0)}</td>
              <td class="px-3 py-3 text-right text-cyan-400/75 tabular-nums">${fmtTok(s.total_cache_read_tokens||0)}</td>
              <td class="px-3 py-3 text-right"><span class="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400/85 font-bold tabular-nums">${fmt$(s.cost_usd)}</span></td>
              <td class="px-3 py-3 text-center">
                <button onclick="openConvFromProject('${s.id}')" title="대화 보기" class="text-white/30 hover:text-accent spring"><iconify-icon icon="solar:arrow-right-linear" width="14"></iconify-icon></button>
              </td>
            </tr>
          `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function sortProjectSessions(col) {
  if (projectSessSort.key === col) projectSessSort.order = projectSessSort.order === 'asc' ? 'desc' : 'asc';
  else { projectSessSort.key = col; projectSessSort.order = 'desc'; }
  renderProjectSessionsTab();
}

async function openConvFromProject(sid) {
  document.getElementById('projectModal').style.display = 'none';
  const cn = document.querySelector('[data-view="conversations"]');
  if (cn && !cn.classList.contains('active')) cn.click();
  try {
    const s = await safeFetch(`/api/sessions/${sid}`);
    openConversation(sid, s);
  } catch (e) { console.error('openConvFromProject:', e); }
}

const PROJ_MSG_PAGE = 300;
let projectConvOffset = 0;

async function loadProjectMessages(reset = true) {
  const modal = document.getElementById('projectModal');
  const name = modal.dataset.project;
  const path = modal.dataset.projectPath || '';
  if (!name) return;
  const content = document.getElementById('projTabContent');
  if (reset) {
    projectConvOffset = 0;
    projectConvData = null;
    content.innerHTML = '<div class="text-center text-white/25 text-xs py-12 dots">대화 불러오는 중</div>';
  }
  const pathQs = path ? `&path=${encodeURIComponent(path)}` : '';
  try {
    const data = await safeFetch(
      `/api/projects/${encodeURIComponent(name)}/messages` +
      `?limit=${PROJ_MSG_PAGE}&offset=${projectConvOffset}&order=${projectConvOrder}${pathQs}`);
    if (reset || !projectConvData) {
      projectConvData = data;
    } else {
      // append
      projectConvData.messages = (projectConvData.messages || []).concat(data.messages || []);
      projectConvData.total = data.total;
    }
    projectConvOffset += (data.messages || []).length;
    renderProjectMessages();
  } catch (e) {
    content.innerHTML = `<div class="text-center text-red-400/60 text-xs py-12">로딩 실패: ${esc(e.message)}</div>`;
  }
}

function setProjConvOrder(o) {
  if (projectConvOrder === o) return;
  projectConvOrder = o;
  loadProjectMessages(true);
}

function loadMoreProjectMessages() {
  loadProjectMessages(false);
}

function renderProjectMessages() {
  const content = document.getElementById('projTabContent');
  if (!projectConvData) { content.innerHTML = '<div class="text-center text-white/25 text-xs py-12">데이터 없음</div>'; return; }
  const msgs = projectConvData.messages || [];
  const total = projectConvData.total || 0;
  const header = `
    <div class="sticky top-0 bg-[#0f0f0f]/95 backdrop-blur-sm -mx-6 -mt-6 px-6 pt-4 pb-3 mb-4 border-b border-white/[0.05] flex items-center justify-between z-10">
      <div class="text-[11px] text-white/55">
        <span class="font-bold tabular-nums text-white/80">${fmtN(msgs.length)}</span>
        <span class="text-white/30"> / ${fmtN(total)}</span>
        <span class="ml-1">건 표시</span>
      </div>
      <div class="flex items-center gap-1.5">
        <span class="text-[9px] text-white/30 uppercase font-bold tracking-widest mr-1">정렬</span>
        <button onclick="setProjConvOrder('asc')" class="px-3 py-1 rounded-full border spring text-[10px] font-bold ${projectConvOrder==='asc'?'bg-accent/15 text-accent border-accent/30':'text-white/45 border-white/[0.07] hover:text-white/70'}">오래된 순</button>
        <button onclick="setProjConvOrder('desc')" class="px-3 py-1 rounded-full border spring text-[10px] font-bold ${projectConvOrder==='desc'?'bg-accent/15 text-accent border-accent/30':'text-white/45 border-white/[0.07] hover:text-white/70'}">최신 순</button>
      </div>
    </div>`;
  if (!msgs.length) { content.innerHTML = header + '<div class="text-center text-white/25 text-xs py-12">메시지 없음</div>'; return; }
  let html = header + '<div class="space-y-3">';
  let lastSid = null;
  msgs.forEach(m => {
    if (m.session_id !== lastSid) {
      html += `
        <div class="flex items-center gap-3 pt-4 pb-2">
          <div class="h-px bg-white/[0.08] flex-1"></div>
          <span class="text-[9px] font-mono text-white/45 px-2.5 py-1 rounded-full bg-white/[0.04] ring-1 ring-white/[0.06] whitespace-nowrap">세션 ${esc((m.session_id||'').slice(0,8))} · ${fmtTime(m.timestamp)}</span>
          <div class="h-px bg-white/[0.08] flex-1"></div>
        </div>`;
      lastSid = m.session_id;
    }
    const align = m.role === 'user' ? 'items-end' : 'items-start';
    const bg = m.role === 'user'
      ? 'bg-accent/10 ring-1 ring-accent/20 text-white/85'
      : 'bg-white/[0.04] ring-1 ring-white/[0.06] text-white/75';
    const body = renderContent(m);
    const parts = [`<span>${m.role === 'user' ? '사용자' : '어시스턴트'}</span>`, `<span>${fmtTime(m.timestamp)}</span>`];
    if (m.role === 'assistant') {
      if (m.input_tokens || m.output_tokens) parts.push(`<span class="text-cyan-400/60">↑${fmtTok(m.input_tokens)} ↓${fmtTok(m.output_tokens)}</span>`);
      if (m.cost_usd) parts.push(`<span class="text-amber-400/75">${fmt$(m.cost_usd)}</span>`);
      if (m.model) parts.push(`<span class="text-purple-400/60">${esc(shortModel(m.model))}</span>`);
    }
    html += `
      <div class="flex flex-col ${align}">
        <div class="max-w-[92%] px-4 py-3 rounded-2xl text-[12px] leading-relaxed ${bg}">${body}</div>
        <div class="text-[9px] text-white/30 mt-1 flex gap-2 items-center px-1">${parts.join(' · ')}</div>
      </div>`;
  });
  html += '</div>';
  if (total > msgs.length) {
    html += `
      <div class="text-center py-4">
        <button onclick="loadMoreProjectMessages()"
                class="px-4 py-1.5 rounded-full text-[11px] font-bold bg-accent/10 text-accent border border-accent/25 hover:scale-[1.02] active:scale-[0.98] spring">
          더 보기 (${fmtN(msgs.length)} / ${fmtN(total)})
        </button>
      </div>`;
  } else if (total > 0) {
    html += `<div class="text-center text-[10px] text-white/25 py-4">전체 ${fmtN(total)}건 모두 표시됨</div>`;
  }
  content.innerHTML = html;
}

// ─── Subagent analysis ─────────────────────────────────────────────────
// Moved to static/subagents.js. Exposes: loadSubagentHeatmap,
// loadSubagentSuccessMatrix (both called from #/subagents view).

// ─── TOP 5 projects ───────────────────────────────────────────────────
// Moved to static/overview.js (loadTopProjects).

// ─── Utilities ──────────────────────────────────────────────────────────
// set() auto-clears the .skeleton class on first write so placeholder
// shimmer blocks disappear as soon as real data arrives.
function set(id,val){
  const el=document.getElementById(id);
  if(!el)return;
  el.textContent=val;
  if(el.classList.contains('skeleton'))el.classList.remove('skeleton');
}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

// ─── Safe DOM builder ───────────────────────────────────────────────
// XSS-safe replacement for innerHTML template-literal building. Prefer
// this in all NEW code. Existing innerHTML sites are being migrated
// incrementally.
//
// Signature:
//   h(tag, attrs, children)
//   h('div', {class: 'foo', onClick: fn}, ['text', h('span', {}, 'child')])
//
// attrs special keys:
//   class     → className (string or array)
//   style     → inline style (string or object)
//   onClick / onInput / on<Event> → addEventListener(event.lower, handler)
//   dataset   → dataset assignment (object)
//   html      → DANGEROUS: set innerHTML directly. Avoid; use children.
// children:
//   string    → textContent node
//   Node      → appendChild
//   array     → each item recursively
//   null/undefined → skipped
function h(tag, attrs, children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') {
        el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v);
      } else if (k === 'style') {
        if (typeof v === 'string') el.style.cssText = v;
        else Object.assign(el.style, v);
      } else if (k === 'dataset') {
        Object.assign(el.dataset, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'html') {
        // intentionally allowed escape hatch — use only with trusted literals
        el.innerHTML = v;
      } else if (v === true) {
        el.setAttribute(k, '');
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  const append = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(append); return; }
    if (c instanceof Node) { el.appendChild(c); return; }
    el.appendChild(document.createTextNode(String(c)));
  };
  append(children);
  return el;
}
function fmtN(n){return(Number(n)||0).toLocaleString('ko-KR');}
function fmtTok(n){n=Number(n)||0;if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return String(n);}
function fmt$(n){
  n = Number(n);
  if (!isFinite(n)) return '$—';   // NaN/Infinity guard
  if (n === 0) return '$0';
  if (Math.abs(n) < 0.01) return '<$0.01';
  // Thousands separator for readability at $1,000+; 2 decimals ≥$1, 4 below.
  const frac = Math.abs(n) >= 1 ? 2 : 4;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: frac, maximumFractionDigits: frac });
}
function shortModel(m){if(!m)return'—';return m.replace('claude-','').replace(/-\d{8}$/,'');}
function trimPath(p){if(!p)return'';return p.split('/').filter(Boolean).slice(-2).join('/');}
function relTime(ts){if(!ts)return'—';const d=new Date(ts);if(isNaN(d))return ts;const df=Date.now()-d.getTime();if(df<6e4)return'방금';if(df<36e5)return Math.floor(df/6e4)+'분 전';if(df<864e5)return Math.floor(df/36e5)+'시간 전';if(df<6048e5)return Math.floor(df/864e5)+'일 전';return d.toLocaleDateString('ko-KR');}
function fmtTime(ts){if(!ts)return'—';const d=new Date(ts);if(isNaN(d))return ts;return d.toLocaleString('ko-KR',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});}

// ─── Keyboard shortcuts ────────────────────────────────────────────────
// Combos:
//   /           → focus session search (sessions view) or conv search
//   Esc         → close modal, clear search, unfocus input
//   g o/s/c/m/p/e → jump to view
//   ?           → show help overlay
const NAV_KEY_MAP = {
  o: 'overview', b: 'cost', s: 'sessions', c: 'conversations',
  m: 'models', p: 'projects', u: 'subagents', t: 'timeline', e: 'export',
};
let _gPending = false;

function _inEditable(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

function _closeModals() {
  document.querySelectorAll('.fixed[id$="Modal"]').forEach(m => {
    if (m.style.display !== 'none' && m.id === 'projectModal') closeProjectModal();
    else if (m.style.display !== 'none') m.style.display = 'none';
  });
  const help = document.getElementById('kbdHelp');
  if (help) help.classList.add('hidden');
}

function showKbdHelp() {
  const help = document.getElementById('kbdHelp');
  if (help) help.classList.toggle('hidden');
}

document.addEventListener('keydown', (e) => {
  // Plain Esc: universal close
  if (e.key === 'Escape') {
    if (_inEditable(document.activeElement)) {
      document.activeElement.blur();
      return;
    }
    // Close preview drawer on Esc
    if (typeof topPreviewClose === 'function') {
      const panel = document.getElementById('topPreviewPanel');
      if (panel && panel.getAttribute('aria-hidden') !== 'true') {
        topPreviewClose();
        return;
      }
    }
    _closeModals();
    return;
  }
  if (_inEditable(document.activeElement)) return;

  // g <key> two-stroke combo
  if (_gPending) {
    _gPending = false;
    const target = NAV_KEY_MAP[e.key.toLowerCase()];
    if (target) { e.preventDefault(); showView(target); }
    return;
  }
  if (e.key === 'g') { _gPending = true; setTimeout(() => _gPending = false, 900); return; }

  // Conversation viewer: j/k message navigation, Ctrl+F inline search
  if (location.hash.startsWith('#/conversations') && state.currentSession) {
    // Trace mode: ← → navigate tool_use steps
    if (state.convTraceMode) {
      if (e.key === 'ArrowLeft')  { e.preventDefault(); convTracePrev(); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); convTraceNext(); return; }
    }
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault(); convFocusMessage(_convFocusIdx + 1); return;
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault(); convFocusMessage(_convFocusIdx - 1); return;
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f' && location.hash.startsWith('#/conversations')) {
    e.preventDefault();
    const inp = document.getElementById('convInlineSearch');
    if (inp) { inp.focus(); inp.select(); }
    return;
  }

  // Single-key shortcuts
  if (e.key === '/') {
    e.preventDefault();
    const focusables = [
      document.getElementById('sessionSearch'),
      document.getElementById('convSearch'),
    ].filter(Boolean);
    // Prefer the one visible in the current view
    const current = document.querySelector('.view:not(.hidden)');
    const first = focusables.find(f => current && current.contains(f)) || focusables[0];
    if (first) first.focus();
    return;
  }
  if (e.key === '?' && e.shiftKey) {
    e.preventDefault();
    showKbdHelp();
    return;
  }
});

// ─── Conversation inline search ──────────────────────────────────────────
document.getElementById('convInlineSearch')?.addEventListener('input', (e) => {
  clearTimeout(_convSearchTimer);
  _convSearchTimer = setTimeout(() => _convInlineSearch(e.target.value), 200);
});
document.getElementById('convInlineSearch')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? convSearchPrev() : convSearchNext(); }
  if (e.key === 'Escape') { e.preventDefault(); e.target.value = ''; _convInlineSearch(''); e.target.blur(); }
});

function _convInlineSearch(q) {
  const container = document.getElementById('convMessages');
  if (!container) return;
  const all = container.querySelectorAll('[data-msg-role]');
  // Clear previous
  all.forEach(el => el.classList.remove('conv-search-hit', 'conv-search-current', 'conv-search-dim'));
  _convSearchMatches = [];
  _convSearchIdx = -1;
  const info = document.getElementById('convSearchMatchInfo');

  if (!q.trim()) {
    if (info) info.textContent = '';
    return;
  }
  const lq = q.toLowerCase();
  // Search both DOM textContent AND the raw content_preview from message data
  const msgs = state.convMessages || [];
  all.forEach((el, i) => {
    const domMatch = el.textContent.toLowerCase().includes(lq);
    const dataMatch = i < msgs.length && (msgs[i].content_preview || '').toLowerCase().includes(lq);
    if (domMatch || dataMatch) {
      el.classList.add('conv-search-hit');
      _convSearchMatches.push(el);
    } else {
      el.classList.add('conv-search-dim');
    }
  });
  if (info) info.textContent = _convSearchMatches.length ? `0/${_convSearchMatches.length}` : '\uACB0\uACFC \uC5C6\uC74C';
  if (_convSearchMatches.length) convSearchNext();
}

function convSearchNext() {
  if (!_convSearchMatches.length) return;
  if (_convSearchIdx >= 0) _convSearchMatches[_convSearchIdx].classList.remove('conv-search-current');
  _convSearchIdx = (_convSearchIdx + 1) % _convSearchMatches.length;
  _convSearchMatches[_convSearchIdx].classList.add('conv-search-current');
  _convSearchMatches[_convSearchIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
  const info = document.getElementById('convSearchMatchInfo');
  if (info) info.textContent = `${_convSearchIdx + 1}/${_convSearchMatches.length}`;
}

function convSearchPrev() {
  if (!_convSearchMatches.length) return;
  if (_convSearchIdx >= 0) _convSearchMatches[_convSearchIdx].classList.remove('conv-search-current');
  _convSearchIdx = (_convSearchIdx - 1 + _convSearchMatches.length) % _convSearchMatches.length;
  _convSearchMatches[_convSearchIdx].classList.add('conv-search-current');
  _convSearchMatches[_convSearchIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
  const info = document.getElementById('convSearchMatchInfo');
  if (info) info.textContent = `${_convSearchIdx + 1}/${_convSearchMatches.length}`;
}

// ─── Conversation keyboard navigation ───────────────────────────────────
function convFocusMessage(idx) {
  const container = document.getElementById('convMessages');
  if (!container) return;
  const all = container.querySelectorAll('[data-msg-role]');
  if (!all.length) return;
  // Remove previous focus
  if (_convFocusIdx >= 0 && _convFocusIdx < all.length) all[_convFocusIdx].classList.remove('conv-msg-focused');
  _convFocusIdx = Math.max(0, Math.min(idx, all.length - 1));
  all[_convFocusIdx].classList.add('conv-msg-focused');
  all[_convFocusIdx].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ─── Markdown export ─────────────────────────────────────────────────────
function _buildConvMarkdown() {
  const msgs = state.convMessages;
  const session = state.convSession;
  if (!msgs || !session) return '';
  const lines = [];
  lines.push('# ' + (session.project_name || 'Conversation'));
  lines.push('');
  lines.push('**Model**: ' + (session.model || '\u2014'));
  lines.push('**Date**: ' + fmtTime(session.created_at) + ' ~ ' + fmtTime(session.updated_at));
  lines.push('**Cost**: ' + fmt$(session.total_cost_usd));
  lines.push('**Messages**: ' + fmtN(msgs.length));
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const m of msgs) {
    const role = m.role === 'user' ? '\uD83D\uDC64 User' : '\uD83E\uDD16 Assistant';
    lines.push('## ' + role);
    if (m.role === 'assistant' && m.model) lines.push('*' + shortModel(m.model) + (m.cost_usd ? ' \u00b7 ' + fmt$(m.cost_usd) : '') + '*');
    lines.push('');
    // Extract text content
    let text = '';
    try {
      const content = typeof m.content === 'string' ? JSON.parse(m.content) : m.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') text += (block.text || '') + '\n\n';
          else if (block.type === 'thinking') text += '<details><summary>Thinking</summary>\n\n' + (block.thinking || '') + '\n\n</details>\n\n';
          else if (block.type === 'tool_use') text += '```json\n// Tool: ' + (block.name || '') + '\n' + JSON.stringify(block.input || {}, null, 2) + '\n```\n\n';
          else if (block.type === 'tool_result') {
            const rc = Array.isArray(block.content) ? block.content.map(c => c.text || '').join('\n') : (block.content || '');
            text += '> **Tool Result**\n> ' + rc.split('\n').join('\n> ') + '\n\n';
          }
        }
      } else {
        text = m.content_preview || '';
      }
    } catch {
      text = m.content_preview || '';
    }
    lines.push(text.trim());
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  return lines.join('\n');
}

function convCopyMarkdown() {
  const md = _buildConvMarkdown();
  if (!md) { showToast('\uB300\uD654\uB97C \uBA3C\uC800 \uC5F4\uC5B4\uC8FC\uC138\uC694', { type: 'warning' }); return; }
  navigator.clipboard.writeText(md).then(
    () => showToast('\uD074\uB9BD\uBCF4\uB4DC\uC5D0 \uBCF5\uC0AC\uB428', { type: 'success', duration: 1500 }),
    () => showToast('\uBCF5\uC0AC \uC2E4\uD328', { type: 'error' })
  );
}

function convDownloadMarkdown() {
  const md = _buildConvMarkdown();
  if (!md) { showToast('\uB300\uD654\uB97C \uBA3C\uC800 \uC5F4\uC5B4\uC8FC\uC138\uC694', { type: 'warning' }); return; }
  const session = state.convSession;
  const name = (session.project_name || 'conversation').replace(/[^a-zA-Z0-9가-힣_-]/g, '_');
  const filename = name + '_' + (session.id || '').slice(0, 8) + '.md';
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  showToast(filename + ' \uB2E4\uC6B4\uB85C\uB4DC', { type: 'success', duration: 2000 });
}

// ─── WebSocket: auto-append new messages for open session ────────────────
state.convNeedsRefresh = false;

function convRefreshTail() {
  if (_convLoading) return;
  if (!state.convNeedsRefresh || !state.currentSession || !state.convMessages) return;
  _convLoading = true;
  state.convNeedsRefresh = false;
  const sid = state.currentSession;
  const currentCount = state.convMessages.length;
  safeFetch('/api/sessions/' + encodeURIComponent(sid) + '/messages?limit=50&offset=' + currentCount)
    .then(data => {
      const more = data.messages || [];
      if (!more.length) return;
      const c = document.getElementById('convMessages');
      if (!c) return;
      const msgs = state.convMessages;
      const nearBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 100;
      let prevT = msgs.length ? msgs[msgs.length - 1].timestamp : null;
      let prevBr = null;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].git_branch) { prevBr = msgs[i].git_branch; break; }
      }
      more.forEach(m => {
        _renderTimeGap(c, prevT, m.timestamp);
        _renderSingleMessage(c, m, msgs, prevBr);
        if (m.git_branch) prevBr = m.git_branch;
        prevT = m.timestamp;
        msgs.push(m);
      });
      renderConvStats(msgs, state.convSession);
      // Update message count
      const countLabel = document.getElementById('convMsgCount');
      if (countLabel) {
        const u = msgs.filter(m => m.role === 'user').length;
        const a = msgs.filter(m => m.role === 'assistant').length;
        countLabel.textContent = fmtN(msgs.length) + '\uAC74 (\uC0AC\uC6A9\uC790 ' + u + ' \u00b7 \uC5B4\uC2DC\uC2A4\uD134\uD2B8 ' + a + ')';
      }
      if (nearBottom) c.scrollTop = c.scrollHeight;
    })
    .catch(() => {}) // silent — next WS batch will retry
    .finally(() => { _convLoading = false; });
}

// ─── Scroll reveal (Supanova) ────────────────────────────────────────────
// IntersectionObserver-based staggered reveal for .reveal elements.
// Called once on load and re-called each time a view becomes visible.
// Uses --i CSS variable on each element for stagger delay (0–n * 80ms).
// Elements already marked .visible are skipped (idempotent).
const _revealObs = typeof IntersectionObserver !== 'undefined'
  ? new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        const idx = +(getComputedStyle(el).getPropertyValue('--i').trim() || el.dataset.revealI || 0);
        setTimeout(() => el.classList.add('visible'), idx * 80);
        _revealObs.unobserve(el);
      });
    }, { threshold: 0.06, rootMargin: '0px 0px -32px 0px' })
  : null;

function scrollRevealView(container) {
  if (!_revealObs) return;
  (container || document).querySelectorAll('.reveal:not(.visible)').forEach(el => {
    _revealObs.observe(el);
  });
}

// ─── Init ───────────────────────────────────────────────────────────────
// Single source of truth for initial state: the URL hash decides the view
// (and triggers `onViewChange` → chart loading for overview). The WS onopen
// handler refreshes scalar data on every (re)connect. No other boot calls.
// Defer applyHash to 'load' so that all deferred modules (sessions.js,
// timeline.js, etc.) are parsed before the first view is activated.
window.addEventListener('load', () => {
  checkAuth();
  applyHash();
  if (typeof renderPresetSelect === 'function') renderPresetSelect();
  loadNodes();
  // Initial scroll reveal for whatever view is active at load
  requestAnimationFrame(() => scrollRevealView(document));
});
connectWS();
setInterval(()=>{if(state.ws&&state.ws.readyState===WebSocket.OPEN)state.ws.send('ping');},25000);

// Clean up timers and resources on page unload
window.addEventListener('beforeunload', () => {
  if (_refreshTimer) clearTimeout(_refreshTimer);
  if (_connBannerTimer) clearTimeout(_connBannerTimer);
  if (typeof clearPlanTimer === 'function') clearPlanTimer();
  if (_audioCtx) { try { _audioCtx.close(); } catch {} }
  if (state.ws) { try { state.ws.close(); } catch {} }
});
