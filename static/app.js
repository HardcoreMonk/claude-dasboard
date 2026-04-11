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
};

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
const VALID_VIEWS = new Set(['overview','cost','sessions','conversations','models','projects','subagents','export']);

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
  // Destroy overview/cost chart instances when leaving a chart-bearing view
  // to avoid Chart.js re-init conflicts on return. Project modal chart
  // (projDaily) has its own lifecycle and is left alone.
  if (view !== 'cost') {
    ['usage','models','dailyCost','cache'].forEach(k => {
      if (state.charts[k]) { state.charts[k].destroy(); state.charts[k] = null; }
    });
  } else {
    loadCharts();
  }
  if (view === 'sessions') loadSessions();
  if (view === 'conversations') loadConvList();
  if (view === 'models') loadModels();
  if (view === 'projects') loadProjects();
  if (view === 'subagents') { loadSubagentHeatmap(); loadSubagentSuccessMatrix(); }
  if (view === 'export') loadDbSize();
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

// ─── Safe Fetch ─────────────────────────────────────────────────────────
async function safeFetch(url){const r=await fetch(url);if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();}

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
  subagents: null,
};

function _cmdkStaticItems() {
  return [
    { label: '개요',      hint: '대시보드', icon: 'solar:chart-square-linear', action: () => showView('overview') },
    { label: '비용',      hint: '토큰/비용 차트', icon: 'solar:graph-up-linear', action: () => showView('cost') },
    { label: '세션',      hint: '전체 세션 목록', icon: 'solar:list-check-linear', action: () => showView('sessions') },
    { label: '대화',      hint: '대화 뷰어', icon: 'solar:chat-round-line-linear', action: () => showView('conversations') },
    { label: '모델',      hint: '모델 분석', icon: 'solar:cpu-bolt-linear', action: () => showView('models') },
    { label: '프로젝트',   hint: '프로젝트 목록', icon: 'solar:folder-open-linear', action: () => showView('projects') },
    { label: 'Subagent',  hint: '히트맵 + 종료 매트릭스', icon: 'solar:widget-2-linear', action: () => showView('subagents') },
    { label: '관리',      hint: 'CSV / 백업 / 보존', icon: 'solar:database-linear', action: () => showView('export') },
    { label: '예산 설정',  hint: '플랜/예산 편집', icon: 'solar:settings-linear', action: () => openPlanSettings() },
    { label: '다크/라이트 전환', hint: '테마 토글', icon: 'solar:sun-linear', action: () => toggleTheme() },
    { label: '키보드 단축키', hint: '도움말 표시', icon: 'solar:keyboard-linear', action: () => showKbdHelp() },
  ];
}

async function _cmdkLoadProjects() {
  if (cmdkState.projects) return cmdkState.projects;
  try {
    const d = await safeFetch('/api/projects?sort=last_active&order=desc');
    cmdkState.projects = (d.projects || []).map(p => ({
      label: p.project_name || '—',
      hint: p.project_path || '',
      icon: 'solar:folder-linear',
      action: () => showProjectDetail(p.project_name, p.project_path),
      _type: 'project',
    }));
  } catch {
    cmdkState.projects = [];
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

// ─── Error reporting helper (A5) ─────────────────────────────────────
// Wraps console.error with a toast, rate-limited per-context so a flurry
// of failing loads doesn't bury the screen in identical toasts.
const _errorReportCooldown = {};
function reportError(ctx, e) {
  console.error(ctx + ':', e);
  const now = Date.now();
  if (_errorReportCooldown[ctx] && now - _errorReportCooldown[ctx] < 5000) return;
  _errorReportCooldown[ctx] = now;
  showToast(`${ctx} 실패: ${e?.message || e}`, { type: 'error', duration: 4000 });
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
  if (btn) btn.textContent = theme === 'light' ? '🌙' : '☀';
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
    loadStats(); loadPeriods(); loadPlanUsage(); loadTopProjects();
    // Only refresh Chart.js instances when actually visible — otherwise we
    // waste cycles creating/destroying offscreen chart objects.
    if (location.hash.startsWith('#/cost')) loadCharts();
  }, 800);
}

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

function _playIdleChime() {
  const ctx = _ensureAudioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  const now = ctx.currentTime;
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
    gain.gain.setValueAtTime(0, now + n.offset);
    gain.gain.linearRampToValueAtTime(1, now + n.offset + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, now + n.offset + n.duration);
    osc.start(now + n.offset);
    osc.stop(now + n.offset + n.duration + 0.05);
  });
}

// ─── Idle indicator (작업 완료 → 입력 대기) ────────────────────────────
// When an assistant message with stop_reason === end_turn arrives, mark the
// project as "idle, awaiting user input". The TOP 10 renderer picks this up
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

function notifyIdleFromBatch(records) {
  if (!Array.isArray(records) || !records.length) return;
  if (_prefs.idleNotify === false) return;  // opt-out via settings
  let changed = false;
  let playedChime = false;
  for (const r of records) {
    if (!r || r.type !== 'new_message') continue;
    const key = _idleKey(r);
    if (!key) continue;
    if (r.stop_reason === 'end_turn') {
      // Flag as idle
      state.idleProjects[key] = {
        ts: Date.now(),
        preview: (r.preview || '').slice(0, 160),
        project_name: r.project_name,
        project_path: r.project_path,
      };
      changed = true;
      // Play chime once per batch — even if multiple projects transition
      // simultaneously, one sound is enough (the badge shows all of them).
      if (!playedChime) {
        _playIdleChime();
        playedChime = true;
      }
    } else if (r.stop_reason) {
      // Any non-end_turn activity: Claude is working OR user has replied.
      // Clear the idle flag so the badge disappears.
      if (state.idleProjects[key]) {
        delete state.idleProjects[key];
        changed = true;
      }
    }
  }
  if (changed) {
    // Force TOP 10 to re-render with updated badges — debouncedRefresh will
    // also call loadTopProjects via WS flow, but that's 800ms delayed. We
    // want the visual update to land immediately.
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

async function openConversation(sid,session,listItem){
  document.querySelectorAll('#convListBody > div').forEach(i=>i.classList.remove('bg-accent/5','border-l-2','border-accent'));
  if(listItem){listItem.classList.add('bg-accent/5','border-l-2','border-accent');}
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
      : '<span class="text-white/25">(not linked)</span>';
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
  // Reset role filter to "all" on each session open
  convSetRoleFilter('all');
  let prevBranch = null;
  msgs.forEach(m=>{
    const w=document.createElement('div');
    w.dataset.msgRole = m.role;
    w.className='flex flex-col '+(m.role==='user'?'items-end':'items-start');
    const b=document.createElement('div');
    b.className='max-w-[92%] px-4 py-3 rounded-2xl text-[12px] leading-relaxed '+(m.role==='user'?'bg-accent/10 ring-1 ring-accent/20 text-white/85':'bg-white/[0.04] ring-1 ring-white/[0.06] text-white/75');
    b.innerHTML=renderContent(m);
    const meta=document.createElement('div');
    meta.className='text-[9px] text-white/30 mt-1 flex gap-2 items-center px-1 flex-wrap';
    const parts=[`<span>${m.role==='user'?'사용자':'어시스턴트'}</span>`,`<span>${fmtTime(m.timestamp)}</span>`];
    if(m.role==='assistant'){
      if(m.input_tokens||m.output_tokens)parts.push(`<span class="text-cyan-400/60">↑${fmtTok(m.input_tokens)} ↓${fmtTok(m.output_tokens)}</span>`);
      if(m.cache_read_tokens||m.cache_creation_tokens)parts.push(`<span class="text-purple-400/55" title="cache_read/cache_creation">cache ↓${fmtTok(m.cache_read_tokens||0)}·↑${fmtTok(m.cache_creation_tokens||0)}</span>`);
      if(m.cost_usd)parts.push(`<span class="text-amber-400/75">${fmt$(m.cost_usd)}</span>`);
      if(m.model)parts.push(`<span class="text-purple-400/60">${esc(shortModel(m.model))}</span>`);
      if(m.stop_reason)parts.push(stopReasonBadge(m.stop_reason));
    }
    // B5: parent_uuid indicator when the chain forks or skips messages.
    // Linear conversations are uninteresting (each parent points at the
    // immediate predecessor) so we only show the link when the parent is
    // NOT the previous message in the rendered list.
    if (m.parent_uuid) {
      const parentIdx = msgs.findIndex(x => x.uuid === m.parent_uuid || x.message_uuid === m.parent_uuid);
      const myIdx = msgs.indexOf(m);
      if (parentIdx >= 0 && parentIdx !== myIdx - 1) {
        parts.push(`<span class="text-amber-400/55 font-mono" title="parent ${m.parent_uuid.slice(0,8)} — ${myIdx - parentIdx}단계 차이">↳ ${(m.parent_uuid||'').slice(0,8)}</span>`);
      }
    }
    // Show branch label only when it changes — avoids clutter when whole
    // session stays on one branch.
    if (m.git_branch && m.git_branch !== prevBranch) {
      parts.push(`<span class="text-cyan-400/55 font-mono">⎇ ${esc(m.git_branch)}</span>`);
      prevBranch = m.git_branch;
    }
    meta.innerHTML=parts.join(' · ');
    w.appendChild(b);w.appendChild(meta);c.appendChild(w);
  });
  if(data.total>msgs.length){
    const h=document.createElement('div');
    h.className='text-center text-[10px] text-white/30 py-3';
    h.textContent=`${fmtN(msgs.length)} / ${fmtN(data.total)}건 표시 중`;
    c.appendChild(h);
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
    end_turn:      { icon: '✓', cls: 'text-emerald-400/85', title: '정상 완료 (end_turn)' },
    tool_use:      { icon: '🔧', cls: 'text-cyan-400/85',    title: 'tool_use 중 종료' },
    stop_sequence: { icon: '⏹', cls: 'text-white/60',        title: 'stop_sequence 일치' },
    max_tokens:    { icon: '⚠', cls: 'text-amber-400/85',    title: 'max_tokens 한계 도달' },
    refusal:       { icon: '⛔', cls: 'text-red-400/85',      title: '거절됨' },
  };
  const m = map[reason] || { icon: '?', cls: 'text-white/40', title: reason };
  return `<span class="${m.cls} text-[11px] font-bold" title="${esc(m.title)}">${m.icon}</span>`;
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
  try{
    const ss=sortState.projects;
    const data=await safeFetch(`/api/projects?sort=${ss.key}&order=${ss.order}`);
    renderProjectsThead();
    const tb=document.getElementById('projectsBody');tb.innerHTML='';
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
        const d = await safeFetch(`/api/claude-ai/search?q=${encodeURIComponent(q)}&limit=20`);
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
      const d = await safeFetch(`/api/sessions/search?q=${encodeURIComponent(q)}&limit=20`);
      if (!d.results?.length) { box.innerHTML='<div class="px-3 py-2 text-[10px] text-white/15">결과 없음</div>'; box.classList.remove('hidden'); return; }
      box.innerHTML = d.results.map(r => {
        const safeName = highlightTokens(esc(r.project_name || ''), q);
        const safePreview = highlightTokens(esc((r.content_preview || '').slice(0, 200)), q);
        return `<div class="px-3 py-2 border-b border-white/[0.03] cursor-pointer spring hover:bg-white/[0.03]" onclick="openConvFromSearch('${esc(r.session_id)}')">
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
async function openConvFromSearch(sid) {
  document.getElementById('convSearchResults').classList.add('hidden');
  try {
    const s = await safeFetch(`/api/sessions/${sid}`);
    openConversation(sid, s);
  } catch(e) { console.error(e); }
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
  projectData = null;
  projectConvData = null;
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

// ─── TOP 10 projects ──────────────────────────────────────────────────
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
  m: 'models', p: 'projects', u: 'subagents', e: 'export',
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

// ─── Init ───────────────────────────────────────────────────────────────
// Single source of truth for initial state: the URL hash decides the view
// (and triggers `onViewChange` → chart loading for overview). The WS onopen
// handler refreshes scalar data on every (re)connect. No other boot calls.
applyHash();
// renderPresetSelect lives in sessions.js which is loaded AFTER this file.
// Defer the call to window 'load' so every module is parsed first.
window.addEventListener('load', () => {
  if (typeof renderPresetSelect === 'function') renderPresetSelect();
});
connectWS();
setInterval(()=>{if(state.ws&&state.ws.readyState===WebSocket.OPEN)state.ws.send('ping');},25000);
if('Notification' in window && Notification.permission==='default')Notification.requestPermission();
