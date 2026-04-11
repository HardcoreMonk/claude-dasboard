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
const VALID_VIEWS = new Set(['overview','sessions','conversations','models','projects','export']);

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
  if (view !== 'overview') {
    Object.keys(state.charts).forEach(k => {
      if (state.charts[k]) { state.charts[k].destroy(); state.charts[k] = null; }
    });
  } else {
    loadCharts();
  }
  if (view === 'sessions') loadSessions();
  if (view === 'conversations') loadConvList();
  if (view === 'models') loadModels();
  if (view === 'projects') loadProjects();
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

// ─── Cost forecasting + burn-rate (B3 + B4) ─────────────────────────
async function loadForecast() {
  try {
    const d = await safeFetch('/api/forecast?days=14');
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('forecastEOM', fmt$(d.projected_eom_cost));
    set('forecastEOMDetail',
      `MTD ${fmt$(d.mtd_cost)} · ${d.days_left_in_month}일 남음`);
    set('forecastAvg', fmt$(d.avg_cost_per_day));
    set('forecastAvgDetail', `${fmtN(d.avg_msgs_per_day || 0)} 메시지/일`);

    // Burn-rate trajectory: humanise the seconds-until-budget-burnout into
    // "약 N시간" / "약 N일" with colour coded urgency.
    const fmtBurnout = (sec, limit, used) => {
      if (sec === null || sec === undefined) return `<span class="text-white/30">예산 미설정</span>`;
      if (used >= limit) {
        return `<span class="text-red-400 font-bold">초과 (${fmt$(used)}/${fmt$(limit)})</span>`;
      }
      const days = Math.floor(sec / 86400);
      const hours = Math.floor((sec % 86400) / 3600);
      let label;
      if (days >= 1) label = `${days}일 ${hours}시간 후`;
      else if (hours >= 1) label = `${hours}시간 후`;
      else label = `${Math.floor(sec / 60)}분 후`;
      const cls = sec < 3600 ? 'text-red-400' : sec < 86400 ? 'text-amber-400' : 'text-emerald-400/85';
      return `<span class="${cls} font-bold">${label}</span>`;
    };
    const dEl = document.getElementById('forecastBurnoutDaily');
    const wEl = document.getElementById('forecastBurnoutWeekly');
    if (dEl) dEl.innerHTML = `일간 ${fmtBurnout(d.daily_budget_burnout_seconds, d.daily_limit, d.daily_used)}`;
    if (wEl) wEl.innerHTML = `주간 ${fmtBurnout(d.weekly_budget_burnout_seconds, d.weekly_limit, d.weekly_used)}`;
  } catch (e) {
    reportError('loadForecast', e);
  }
}

// ─── Filter presets (B2) ─────────────────────────────────────────────
// Each preset captures the sessions view's sort + advanced filters under
// a user-supplied name, persisted via savePrefs().
function getPresets() {
  return _prefs.presets || loadPrefs().presets || {};
}
function saveCurrentPreset() {
  const name = (prompt('이 필터 조합의 이름:', '') || '').trim();
  if (!name) return;
  const presets = getPresets();
  presets[name] = {
    sort: { ...sortState.sessions },
    advFilters: { ...(state.advFilters || {}) },
  };
  savePrefs({ presets });
  Object.assign(_prefs, { presets });
  renderPresetSelect();
  showToast(`"${name}" 저장됨`, { type: 'success', duration: 1800 });
}
function applyPreset(name) {
  if (!name) return;
  const presets = getPresets();
  const p = presets[name];
  if (!p) return;
  Object.assign(sortState.sessions, p.sort || {});
  state.advFilters = { ...(p.advFilters || {}) };
  savePrefs({
    [`sort_sessions`]: sortState.sessions,
    advFilters: state.advFilters,
  });
  state.currentPage = 1;
  loadSessions();
  showToast(`"${name}" 적용`, { type: 'info', duration: 1500 });
}
function deletePreset(name) {
  const presets = getPresets();
  if (!presets[name]) return;
  delete presets[name];
  savePrefs({ presets });
  Object.assign(_prefs, { presets });
  renderPresetSelect();
  showToast(`"${name}" 삭제`, { type: 'info', duration: 1500 });
}
function renderPresetSelect() {
  const sel = document.getElementById('presetSelect');
  if (!sel) return;
  const presets = getPresets();
  const names = Object.keys(presets).sort();
  sel.innerHTML = '<option value="">프리셋 선택…</option>'
    + names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
}

// ─── Bulk operations (B1) ────────────────────────────────────────────
function bulkToggleOne(sid, on) {
  if (on) state.bulkSelected.add(sid);
  else state.bulkSelected.delete(sid);
  renderBulkBar();
}
function bulkToggleAll(on) {
  document.querySelectorAll('[data-bulk-sid]').forEach(cb => {
    cb.checked = on;
    const sid = cb.dataset.bulkSid;
    if (on) state.bulkSelected.add(sid); else state.bulkSelected.delete(sid);
  });
  renderBulkBar();
}
function bulkClear() {
  state.bulkSelected.clear();
  document.querySelectorAll('[data-bulk-sid]').forEach(cb => { cb.checked = false; });
  const all = document.getElementById('bulkSelectAll');
  if (all) all.checked = false;
  renderBulkBar();
}
function renderBulkBar() {
  const bar = document.getElementById('bulkActionBar');
  const count = state.bulkSelected.size;
  if (!bar) return;
  if (count === 0) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const label = bar.querySelector('[data-bulk-count]');
  if (label) label.textContent = `${fmtN(count)}개 선택됨`;
}

async function bulkPin(pin) {
  if (state.bulkSelected.size === 0) return;
  const ids = [...state.bulkSelected];
  let ok = 0, fail = 0;
  for (const sid of ids) {
    try {
      await fetch(`/api/sessions/${encodeURIComponent(sid)}/pin`,
        { method: pin ? 'POST' : 'DELETE' });
      ok++;
    } catch { fail++; }
  }
  showToast(`${pin ? '핀' : '핀 해제'}: ${ok}건 성공${fail ? `, ${fail}건 실패` : ''}`,
    { type: fail ? 'warning' : 'success' });
  bulkClear();
  loadSessions();
}

async function bulkTag() {
  if (state.bulkSelected.size === 0) return;
  // Reuse the existing tag edit modal but route the submit through a bulk path.
  const ids = [...state.bulkSelected];
  _tagEditPending = { sid: null, bulkIds: ids };
  document.getElementById('tagEditTarget').textContent = `${ids.length}개 세션 일괄 태그`;
  const input = document.getElementById('tagEditInput');
  input.value = '';
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitTagEdit(); }
    if (e.key === 'Escape') { e.preventDefault(); closeTagEdit(); }
  };
  document.getElementById('tagEditModal').classList.remove('hidden');
  setTimeout(() => input.focus(), 50);
}

async function bulkCompare() {
  if (state.bulkSelected.size !== 2) {
    showToast('정확히 2개의 세션을 선택하세요', { type: 'warning' });
    return;
  }
  const [a, b] = [...state.bulkSelected];
  try {
    const [sa, sb] = await Promise.all([
      safeFetch(`/api/sessions/${encodeURIComponent(a)}`),
      safeFetch(`/api/sessions/${encodeURIComponent(b)}`),
    ]);
    renderCompareModal(sa, sb);
  } catch (e) {
    reportError('bulkCompare', e);
  }
}

function renderCompareModal(a, b) {
  // Build a side-by-side row for every comparable metric. Tints highlight
  // the larger of each pair so the diff is glanceable.
  const rows = [
    ['프로젝트', a.project_name, b.project_name, 'string'],
    ['모델', a.model, b.model, 'string'],
    ['생성', fmtTime(a.created_at), fmtTime(b.created_at), 'string'],
    ['최근 활동', fmtTime(a.updated_at), fmtTime(b.updated_at), 'string'],
    ['메시지 수', a.message_count, b.message_count, 'num'],
    ['사용자 메시지', a.user_message_count, b.user_message_count, 'num'],
    ['입력 토큰', a.total_input_tokens, b.total_input_tokens, 'num'],
    ['출력 토큰', a.total_output_tokens, b.total_output_tokens, 'num'],
    ['캐시 읽기', a.total_cache_read_tokens, b.total_cache_read_tokens, 'num'],
    ['캐시 생성', a.total_cache_creation_tokens, b.total_cache_creation_tokens, 'num'],
    ['총 비용', a.cost_micro * 1.0 / 1000000, b.cost_micro * 1.0 / 1000000, 'cost'],
    ['종료 사유', a.final_stop_reason || '—', b.final_stop_reason || '—', 'string'],
    ['핀', a.pinned ? '★' : '—', b.pinned ? '★' : '—', 'string'],
    ['Subagent', a.is_subagent ? 'YES' : 'NO', b.is_subagent ? 'YES' : 'NO', 'string'],
  ];
  const cell = (val, isMax, type) => {
    let display = val ?? '—';
    if (type === 'num' && typeof val === 'number') display = fmtN(val);
    if (type === 'cost' && typeof val === 'number') display = fmt$(val);
    const cls = isMax ? 'text-emerald-300/90 font-bold' : 'text-white/65';
    return `<td class="px-4 py-2 ${cls} tabular-nums">${esc(String(display))}</td>`;
  };
  const html = rows.map(([label, av, bv, type]) => {
    let aMax = false, bMax = false;
    if (type === 'num' || type === 'cost') {
      const an = Number(av) || 0, bn = Number(bv) || 0;
      if (an > bn) aMax = true;
      else if (bn > an) bMax = true;
    }
    return `<tr class="border-b border-white/[0.04]">
      <td class="px-4 py-2 text-[10px] text-white/40 uppercase tracking-widest font-bold">${esc(label)}</td>
      ${cell(av, aMax, type)}
      ${cell(bv, bMax, type)}
    </tr>`;
  }).join('');

  const ov = document.createElement('div');
  ov.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4';
  ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
  ov.innerHTML = `
    <div class="bg-[#0f0f0f] ring-1 ring-white/[0.08] rounded-2xl w-[820px] max-w-[96vw] max-h-[90vh] overflow-y-auto shadow-[0_20px_60px_rgba(0,0,0,.6)] anim-in">
      <div class="px-5 py-3 border-b border-white/[0.06] flex items-center justify-between sticky top-0 bg-[#0f0f0f]">
        <span class="text-sm font-bold text-white/85">세션 비교</span>
        <button onclick="this.closest('.fixed').remove()" class="text-white/30 hover:text-white/70 spring text-2xl leading-none">&times;</button>
      </div>
      <table class="w-full text-[12px]">
        <thead>
          <tr class="text-[10px] text-white/35 uppercase tracking-widest border-b border-white/[0.06]">
            <th class="px-4 py-2 text-left font-bold w-32">항목</th>
            <th class="px-4 py-2 text-left font-bold">A · ${esc(a.id.slice(0,8))}</th>
            <th class="px-4 py-2 text-left font-bold">B · ${esc(b.id.slice(0,8))}</th>
          </tr>
        </thead>
        <tbody>${html}</tbody>
      </table>
    </div>`;
  document.body.appendChild(ov);
}

function bulkDelete() {
  if (state.bulkSelected.size === 0) return;
  const ids = [...state.bulkSelected];
  openDeleteConfirm({
    target: `DELETE ${ids.length}`,
    message: `선택한 ${fmtN(ids.length)}개 세션이 영구 삭제됩니다. 복구할 수 없습니다.`,
    onConfirm: async () => {
      let ok = 0, fail = 0;
      for (const sid of ids) {
        try {
          await fetch(`/api/sessions/${encodeURIComponent(sid)}?confirm=true`, { method: 'DELETE' });
          ok++;
        } catch { fail++; }
      }
      showToast(`삭제 완료: ${ok}건${fail ? `, ${fail}건 실패` : ''}`,
        { type: fail ? 'warning' : 'success' });
      bulkClear();
      loadSessions(); loadStats(); loadPeriods();
    },
  });
}

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
    { label: '세션',      hint: '전체 세션 목록', icon: 'solar:list-check-linear', action: () => showView('sessions') },
    { label: '대화',      hint: '대화 뷰어', icon: 'solar:chat-round-line-linear', action: () => showView('conversations') },
    { label: '모델',      hint: '모델 분석', icon: 'solar:cpu-bolt-linear', action: () => showView('models') },
    { label: '프로젝트',   hint: '프로젝트 목록', icon: 'solar:folder-open-linear', action: () => showView('projects') },
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
    loadSubagentHeatmap();
    loadSubagentSuccessMatrix();
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
    loadStats(); loadCharts(); loadPeriods(); loadPlanUsage(); loadTopProjects();
  }, 800);
}

function handleWsMessage(msg) {
  if (msg.type === 'init') {
    state.stats = msg.data;
    renderStats(msg.data);
    markUpdated('stats');
  } else if (msg.type === 'batch_update') {
    // Track how many new records arrived since the user last viewed
    state.newDataCounts.sessions += (msg.records?.length || 1);
    renderNewDataBadge();
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

function setWsStatus(cls, label) {
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

// ─── Stats ──────────────────────────────────────────────────────────────
async function loadStats(){try{const d=await safeFetch('/api/stats');state.stats=d;renderStats(d);markUpdated('stats');}catch(e){reportError('loadStats',e);}}
function renderStats(data){
  const t=data.today||{},a=data.all_time||{};
  set('statTodayCost',fmt$(t.cost_usd));set('statTodayMsg',`${fmtN(t.messages||0)} 메시지`);
  set('statTodayTokens',fmtTok((t.input_tokens||0)+(t.output_tokens||0)));set('statTodaySessions',`${fmtN(t.sessions||0)} 세션`);
  set('statAllCost',fmt$(a.cost_usd));set('statAllSessions',`${fmtN(a.total_sessions||0)} 세션`);
  set('statAllTokens',fmtTok((a.input_tokens||0)+(a.output_tokens||0)));set('statAllMessages',`${fmtN(a.messages||0)} 메시지`);
  const rIn=(a.input_tokens||0)+(a.cache_read_tokens||0);
  const cEff=rIn>0?((a.cache_read_tokens||0)/rIn*100):0;
  set('statCacheEff',cEff.toFixed(1)+'%');
  set('statCacheSaved',`절약 ≈ ${fmt$((a.cache_read_tokens||0)*13.125/1e6)}`);
  set('hdrToday',`오늘: ${fmt$(t.cost_usd)}`);set('hdrTotal',`전체: ${fmt$(a.cost_usd)}`);
}

// ─── Charts ─────────────────────────────────────────────────────────────
const CC={emerald:'#34d399',blue:'#60a5fa',amber:'#fbbf24',rose:'#fb7185',cyan:'#22d3ee',purple:'#a78bfa',white10:'rgba(255,255,255,.06)',white5:'rgba(255,255,255,.03)'};
const CHART_D={responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},animation:{duration:400}};
function grd(){return{color:CC.white5,drawBorder:false};}
function tck(){return{color:'rgba(255,255,255,.15)',font:{size:11,family:'Pretendard'}};}
async function loadCharts(){await Promise.allSettled([loadUsageChart().catch(e=>console.error(e)),loadModelChart().catch(e=>console.error(e)),loadDailyCostChart().catch(e=>console.error(e)),loadCacheChart().catch(e=>console.error(e))]);}

async function loadUsageChart(){
  const h=state.usageRange==='24h'?24:state.usageRange==='7d'?168:720;
  const ep=h<=168?`/api/usage/hourly?hours=${h}`:`/api/usage/daily?days=30`;
  const data=await safeFetch(ep);const rows=data.data||[];
  const labels=rows.map(r=>r.hour||r.date||''),inp=rows.map(r=>r.input_tokens||0),out=rows.map(r=>r.output_tokens||0),cr=rows.map(r=>r.cache_read_tokens||0);
  if(state.charts.usage)state.charts.usage.destroy();
  state.charts.usage=new Chart(document.getElementById('chartUsage'),{type:'line',data:{labels,datasets:[
    {label:'입력',data:inp,borderColor:CC.blue,backgroundColor:'rgba(96,165,250,.08)',fill:true,tension:.3,pointRadius:1.5,borderWidth:1.5},
    {label:'출력',data:out,borderColor:CC.emerald,backgroundColor:'rgba(52,211,153,.06)',fill:true,tension:.3,pointRadius:1.5,borderWidth:1.5},
    {label:'캐시',data:cr,borderColor:CC.cyan,backgroundColor:'rgba(34,211,238,.04)',fill:true,tension:.3,pointRadius:1,borderWidth:1,borderDash:[4,2]},
  ]},options:{...CHART_D,plugins:{legend:{display:true,position:'top',align:'end',labels:{color:'rgba(255,255,255,.25)',boxWidth:10,font:{size:11,family:'Pretendard'}}},tooltip:{backgroundColor:'#111',borderColor:'rgba(255,255,255,.08)',borderWidth:1,titleColor:'rgba(255,255,255,.6)',bodyColor:'rgba(255,255,255,.4)',callbacks:{label:c=>`${c.dataset.label}: ${fmtTok(c.raw)}`}}},scales:{x:{grid:grd(),ticks:{...tck(),maxTicksLimit:8,maxRotation:0}},y:{grid:grd(),ticks:{...tck(),callback:v=>fmtTok(v)}}}}});
}
async function loadModelChart(){
  const data=await safeFetch('/api/models');const rows=data.models||[];
  const labels=rows.map(r=>shortModel(r.model)),vals=rows.map(r=>r.message_count||0);
  const pal=[CC.emerald,CC.blue,CC.amber,CC.rose,CC.cyan,CC.purple];
  if(state.charts.models)state.charts.models.destroy();
  state.charts.models=new Chart(document.getElementById('chartModels'),{type:'doughnut',data:{labels,datasets:[{data:vals,backgroundColor:pal.map(c=>c+'66'),borderColor:pal,borderWidth:1,hoverOffset:4}]},options:{...CHART_D,cutout:'65%',plugins:{legend:{display:true,position:'right',labels:{color:'rgba(255,255,255,.25)',boxWidth:8,font:{size:11,family:'Pretendard'},padding:6}},tooltip:{backgroundColor:'#111',borderColor:'rgba(255,255,255,.08)',borderWidth:1,titleColor:'rgba(255,255,255,.6)',bodyColor:'rgba(255,255,255,.4)'}}}});
}
async function loadDailyCostChart(){
  const data=await safeFetch('/api/usage/daily?days=30');const rows=data.data||[];
  const labels=rows.map(r=>r.date?r.date.slice(5):''),costs=rows.map(r=>parseFloat((r.cost_usd||0).toFixed(4)));
  if(state.charts.dailyCost)state.charts.dailyCost.destroy();
  state.charts.dailyCost=new Chart(document.getElementById('chartDailyCost'),{type:'bar',data:{labels,datasets:[{label:'비용',data:costs,backgroundColor:'rgba(52,211,153,.25)',borderColor:CC.emerald,borderWidth:1,borderRadius:3}]},options:{...CHART_D,plugins:{tooltip:{backgroundColor:'#111',borderColor:'rgba(255,255,255,.08)',borderWidth:1,titleColor:'rgba(255,255,255,.6)',bodyColor:'rgba(255,255,255,.4)',callbacks:{label:c=>` $${c.raw.toFixed(4)}`}}},scales:{x:{grid:grd(),ticks:{...tck(),maxTicksLimit:10}},y:{grid:grd(),ticks:{...tck(),callback:v=>'$'+v}}}}});
}
async function loadCacheChart(){
  const data=await safeFetch('/api/stats');const a=data.all_time||{};
  const d=[a.input_tokens||0,a.cache_creation_tokens||0,a.cache_read_tokens||0,a.output_tokens||0];
  if(state.charts.cache)state.charts.cache.destroy();
  state.charts.cache=new Chart(document.getElementById('chartCache'),{type:'doughnut',data:{labels:['입력','캐시 생성','캐시 읽기','출력'],datasets:[{data:d,backgroundColor:[CC.blue+'66',CC.purple+'66',CC.cyan+'66',CC.emerald+'66'],borderColor:[CC.blue,CC.purple,CC.cyan,CC.emerald],borderWidth:1,hoverOffset:4}]},options:{...CHART_D,cutout:'60%',plugins:{legend:{display:true,position:'right',labels:{color:'rgba(255,255,255,.25)',boxWidth:8,font:{size:11,family:'Pretendard'},padding:5}},tooltip:{backgroundColor:'#111',borderColor:'rgba(255,255,255,.08)',borderWidth:1,titleColor:'rgba(255,255,255,.6)',bodyColor:'rgba(255,255,255,.4)',callbacks:{label:c=>` ${c.label}: ${fmtTok(c.raw)}`}}}}});
}
function setUsageRange(btn,range){
  document.querySelectorAll('.chart-range').forEach(b=>{b.classList.remove('active');b.classList.add('text-white/20');b.classList.remove('text-white/40');});
  btn.classList.add('active','text-white/40');btn.classList.remove('text-white/20');
  state.usageRange=range;
  savePrefs({ usageRange: range });
  loadUsageChart();
}

// ─── Sessions ───────────────────────────────────────────────────────────
let searchTimer=null;
function searchSessions(q){clearTimeout(searchTimer);state.searchQuery=q;searchTimer=setTimeout(()=>{state.currentPage=1;loadSessions();},300);}
async function loadSessions(page=state.currentPage){
  try{
    state.currentPage=page;
    const ss=sortState.sessions;
    const p=new URLSearchParams({page,per_page:25,sort:ss.key,order:ss.order});
    if(state.searchQuery)p.set('search',state.searchQuery);
    if(ss.pinned_only)p.set('pinned_only','true');
    const af = state.advFilters || {};
    if(af.date_from)p.set('date_from',af.date_from);
    if(af.date_to)p.set('date_to',af.date_to);
    if(af.cost_min)p.set('cost_min',af.cost_min);
    if(af.cost_max)p.set('cost_max',af.cost_max);
    const d=await safeFetch('/api/sessions?'+p);
    state.totalPages=d.pages||1;
    renderSessionsThead();
    renderSessions(d);
    const pinToggle=document.getElementById('sessionsPinToggle');
    if(pinToggle){
      pinToggle.classList.toggle('bg-accent/20', ss.pinned_only);
      pinToggle.classList.toggle('text-accent', ss.pinned_only);
      pinToggle.classList.toggle('text-white/30', !ss.pinned_only);
    }
    renderAdvFiltersSummary();
  }catch(e){
    console.error('loadSessions:',e);
    renderError('sessionsBody', e, () => loadSessions(page));
  }
}

// ─── Advanced filter UI helpers (U11 + U12) ──────────────────────────
function toggleAdvFilters() {
  const panel = document.getElementById('advFiltersPanel');
  if (!panel) return;
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    // Restore persisted values on open
    const af = state.advFilters || {};
    const g = id => document.getElementById(id);
    if (g('advDateFrom')) g('advDateFrom').value = af.date_from || '';
    if (g('advDateTo'))   g('advDateTo').value   = af.date_to || '';
    if (g('advCostMin'))  g('advCostMin').value  = af.cost_min || '';
    if (g('advCostMax'))  g('advCostMax').value  = af.cost_max || '';
  }
}
function applyAdvFilters() {
  const g = id => document.getElementById(id);
  state.advFilters = {
    date_from: g('advDateFrom')?.value || '',
    date_to:   g('advDateTo')?.value || '',
    cost_min:  g('advCostMin')?.value || '',
    cost_max:  g('advCostMax')?.value || '',
  };
  savePrefs({ advFilters: state.advFilters });
  state.currentPage = 1;
  loadSessions();
}
function clearAdvFilters() {
  state.advFilters = {};
  savePrefs({ advFilters: {} });
  ['advDateFrom','advDateTo','advCostMin','advCostMax'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  state.currentPage = 1;
  loadSessions();
}
function renderAdvFiltersSummary() {
  const af = state.advFilters || {};
  const has = Object.values(af).some(Boolean);
  const btn = document.getElementById('advFiltersToggle');
  if (btn) {
    btn.classList.toggle('text-accent', has);
    btn.classList.toggle('border-accent/40', has);
  }
  const sum = document.getElementById('advFiltersSummary');
  if (sum) {
    if (!has) { sum.textContent = ''; return; }
    const parts = [];
    if (af.date_from || af.date_to) parts.push(`기간: ${af.date_from || '∞'} ~ ${af.date_to || '∞'}`);
    if (af.cost_min || af.cost_max)  parts.push(`비용: $${af.cost_min || 0} ~ $${af.cost_max || '∞'}`);
    sum.textContent = parts.join(' · ');
  }
}
function renderSessionsThead(){
  document.getElementById('sessionsThead').innerHTML=`
    <tr class="text-[10px] text-white/35 uppercase tracking-widest border-b border-white/[0.05]">
      <th class="text-center px-3 py-2.5 font-bold w-8">
        <input type="checkbox" id="bulkSelectAll" onclick="bulkToggleAll(this.checked)"
               aria-label="전체 선택" class="cursor-pointer">
      </th>
      ${sortThHtml('sessions','project','프로젝트','text-left','px-5')}
      ${sortThHtml('sessions','model','모델','text-left')}
      ${sortThHtml('sessions','input','입력','text-right')}
      ${sortThHtml('sessions','output','출력','text-right')}
      ${sortThHtml('sessions','cache','캐시','text-right')}
      ${sortThHtml('sessions','cost','비용','text-right')}
      ${sortThHtml('sessions','messages','메시지','text-right')}
      ${sortThHtml('sessions','updated_at','활동','text-right')}
      <th class="text-center px-3 py-2.5 font-bold text-white/35 w-16">관리</th>
    </tr>`;
}
function renderSessions(data){
  const tb=document.getElementById('sessionsBody');tb.innerHTML='';
  if(!data.sessions?.length){tb.innerHTML=`<tr><td colspan="9" class="text-center py-12 text-white/25 text-xs">데이터 없음</td></tr>`;return;}
  data.sessions.forEach(s=>{
    const tr=document.createElement('tr');
    tr.className='cursor-pointer border-b border-white/[0.03] hover:bg-white/[0.04] spring';
    tr.onclick=()=>openConversation(s.id,s);
    const subCount = s.subagent_count || 0;
    const subCost = s.subagent_cost || 0;
    const subBadge = subCount > 0
      ? `<span class="inline-block mt-1 text-[10px] px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300/85 font-bold" title="${fmtN(subCount)}개 subagent (${fmt$(subCost)})">🤖 ${fmtN(subCount)} · ${fmt$(subCost)}</span>`
      : '';
    // Interactivity ratio — how much of the session was user-driven
    const mc = s.message_count || 0;
    const umc = s.user_message_count || 0;
    const ratio = mc > 0 ? Math.round((umc / (mc + umc)) * 100) : 0;
    const msgSubtext = mc > 0
      ? `<div class="text-[9px] text-white/30 tabular-nums" title="${umc}건 user / ${mc}건 assistant">${umc} user · ${ratio}%</div>`
      : '';
    // Session duration badge (parents — subagents already had this elsewhere)
    const dur = s.duration_seconds || 0;
    const durLabel = dur > 0 ? fmtDurationSec(dur) : '';
    const stopBadge = stopReasonBadge(s.final_stop_reason);
    const tagList = (s.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    const tagBadges = tagList.length
      ? tagList.map(t => `<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-300/80 font-medium">#${esc(t)}</span>`).join(' ')
      : '';
    tr.setAttribute('data-sid', s.id);
    const checked = state.bulkSelected && state.bulkSelected.has(s.id) ? 'checked' : '';
    tr.innerHTML=`
      <td class="px-3 py-3 text-center" onclick="event.stopPropagation()">
        <input type="checkbox" data-bulk-sid="${esc(s.id)}" ${checked}
               onclick="event.stopPropagation();bulkToggleOne('${esc(s.id)}',this.checked)"
               aria-label="선택" class="cursor-pointer">
      </td>
      <td class="px-5 py-3">
        <div class="font-semibold text-white/85 truncate max-w-xs flex items-center gap-1.5">${s.pinned?'<span class="text-accent text-[11px]">★</span>':''}${esc(s.project_name||'—')}${stopBadge?'<span class="ml-1">'+stopBadge+'</span>':''}</div>
        <div class="text-[10px] text-white/30 mt-0.5 truncate max-w-xs">${esc(trimPath(s.cwd||''))}</div>
        <div class="mt-1 flex flex-wrap gap-1 items-center">
          ${s.is_subagent?'<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-500/10 text-purple-400/70">subagent</span>':''}
          ${tagBadges}
          ${subBadge}
        </div>
      </td>
      <td class="px-3 py-3"><span class="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/45 whitespace-nowrap">${esc(shortModel(s.model||''))}</span></td>
      <td class="px-3 py-3 text-right text-white/55 tabular-nums">${fmtTok(s.total_input_tokens||0)}</td>
      <td class="px-3 py-3 text-right text-emerald-400/75 tabular-nums">${fmtTok(s.total_output_tokens||0)}</td>
      <td class="px-3 py-3 text-right text-cyan-400/75 tabular-nums" title="읽기 ${fmtN(s.total_cache_read_tokens||0)} / 생성 ${fmtN(s.total_cache_creation_tokens||0)}">${fmtTok(s.total_cache_read_tokens||0)}</td>
      <td class="px-3 py-3 text-right"><span class="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400/85 font-bold tabular-nums">${fmt$(s.total_cost_usd)}</span></td>
      <td class="px-3 py-3 text-right">
        <div class="tabular-nums text-white/70">${fmtN(mc)}</div>
        ${msgSubtext}
      </td>
      <td class="px-3 py-3 text-right">
        <div class="text-white/35">${relTime(s.updated_at)}</div>
        ${durLabel?`<div class="text-[9px] text-white/25 tabular-nums">${durLabel}</div>`:''}
      </td>
      <td class="px-3 py-3 text-center whitespace-nowrap"></td>`;
    // Action buttons via DOM API — safe against name/id injection
    const actionTd = tr.lastElementChild;
    const pinBtn = document.createElement('button');
    pinBtn.className = (s.pinned ? 'text-accent' : 'text-white/20') + ' hover:text-accent spring text-sm mr-1';
    pinBtn.title = s.pinned ? '핀 해제' : '핀 고정';
    pinBtn.textContent = s.pinned ? '★' : '☆';
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pinSession(s.id, s.pinned ? 0 : 1);
    });
    const tagBtn = document.createElement('button');
    tagBtn.className = 'text-white/20 hover:text-cyan-300 spring text-sm mr-1';
    tagBtn.title = '태그 편집';
    tagBtn.textContent = '🏷';
    tagBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      editSessionTags(s.id, s.tags || '');
    });
    const delBtn = document.createElement('button');
    delBtn.className = 'text-white/20 hover:text-red-400 spring text-sm';
    delBtn.title = '삭제';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSession(s.id, s.project_name);
    });
    actionTd.appendChild(pinBtn);
    actionTd.appendChild(tagBtn);
    actionTd.appendChild(delBtn);
    tb.appendChild(tr);
  });
  renderPagination(data.page,data.pages,data.total);
}
function renderPagination(page,pages,total){
  const el=document.getElementById('sessionsPagination');el.innerHTML='';
  if(pages<=1){el.innerHTML=`<span class="text-[10px] text-white/15 ml-auto">${fmtN(total)} 세션</span>`;return;}
  const mk=(t,p,dis)=>{const b=document.createElement('button');b.className='px-2 py-0.5 rounded text-[10px] font-semibold spring '+(p===page?'bg-accent/15 text-accent':'text-white/20 hover:text-white/40');b.textContent=t;b.disabled=dis;b.onclick=()=>loadSessions(p);return b;};
  el.appendChild(mk('‹',page-1,page<=1));
  for(let i=1;i<=pages;i++){if(pages>7&&i>2&&i<pages-1&&Math.abs(i-page)>1){if(i===3||i===pages-2){const s=document.createElement('span');s.textContent='…';s.className='text-white/10 text-[10px] px-1';el.appendChild(s);}continue;}el.appendChild(mk(i,i,false));}
  el.appendChild(mk('›',page+1,page>=pages));
  const info=document.createElement('span');info.className='text-[10px] text-white/15 ml-auto';info.textContent=`${fmtN(total)} 세션`;el.appendChild(info);
}

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
async function loadConvList(){
  try{
    renderConvSortBar();
    const ss=sortState.conversations;
    const d=await safeFetch(`/api/sessions?per_page=50&sort=${ss.key}&order=${ss.order}`);
    const b=document.getElementById('convListBody');b.innerHTML='';
    (d.sessions||[]).forEach(s=>{
      const div=document.createElement('div');
      div.className='px-4 py-3 border-b border-white/[0.04] cursor-pointer spring hover:bg-white/[0.04]';
      div.dataset.id=s.id;
      div.innerHTML=`
        <div class="flex items-center justify-between gap-2">
          <div class="text-xs font-bold text-white/80 truncate">${esc(s.project_name||'—')}</div>
          ${s.pinned?'<span class="text-accent text-[11px] flex-shrink-0">★</span>':''}
        </div>
        <div class="text-[10px] text-white/40 mt-1 flex items-center gap-2 tabular-nums">
          <span>${fmtTok((s.total_input_tokens||0)+(s.total_output_tokens||0))}</span>
          <span class="text-amber-400/70">${fmt$(s.total_cost_usd)}</span>
          <span>${relTime(s.updated_at)}</span>
        </div>`;
      div.onclick=()=>openConversation(s.id,s,div);b.appendChild(div);
    });
  }catch(e){reportError('loadConvList',e);}
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
      tr.innerHTML=`
        <td class="px-5 py-3">
          <div class="font-bold text-white/90 truncate">${esc(p.project_name||'—')}</div>
          <div class="text-[10px] text-white/30 mt-0.5 truncate max-w-md" title="${esc(p.project_path||'')}">${esc(p.project_path||'')}</div>
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

// ─── Period Usage ───────────────────────────────────────────────────────
async function loadPeriods(){try{const d=await safeFetch('/api/usage/periods');renderPeriod('Day',d.day);renderPeriod('Week',d.week);renderPeriod('Month',d.month);}catch(e){reportError('loadPeriods',e);}}
function renderPeriod(key,p){set(`pd${key}Cost`,fmt$(p.cost));const tok=(p.input_tokens||0)+(p.output_tokens||0);
  set(`pd${key}Detail`,`${fmtTok(tok)} tok · ${fmtN(p.messages)}건 · 캐시 ${fmtTok(p.cache_read_tokens||0)}`);
  const el=document.getElementById(`pd${key}Delta`);if(!el)return;
  if(p.prev_cost>0){const s=p.delta_pct>=0?'▲':'▼';el.textContent=`${s} ${Math.abs(p.delta_pct).toFixed(0)}% vs 이전 (${fmt$(p.prev_cost)})`;el.className='text-[10px] font-semibold mt-1 '+(p.delta_pct>=0?'text-emerald-400/60':'text-red-400/60');}
  else{el.textContent=p.cost>0?'신규':'';el.className='text-[10px] font-semibold mt-1 text-white/15';}}

// ─── Plan Usage ─────────────────────────────────────────────────────────
let planTimer=null,planData=null;
async function loadPlanUsage(){try{const resp=await fetch('/api/plan/usage');if(!resp.ok)throw new Error(`HTTP ${resp.status}`);planData=await resp.json();renderPlanBlock('Daily',planData.daily);renderPlanBlock('Weekly',planData.weekly);if(planData.plan?.label){const t=document.querySelector('.plan-section-title');/* not used */}checkPlanAlerts(planData);if(planTimer)clearInterval(planTimer);planTimer=setInterval(tickPlanCountdown,1000);}catch(e){reportError('loadPlanUsage',e);}}
function renderPlanBlock(key,b){if(!b)return;const el=id=>document.getElementById(`plan${key}${id}`);
  const pctEl=el('Pct'),barEl=el('Bar'),usedEl=el('Used'),tokEl=el('Tokens'),msgEl=el('Msgs'),remainEl=el('Remain'),resetEl=el('Reset');
  const pct=b.percentage||0,bw=Math.min(pct,100),color=planBarColor(pct);
  if(pctEl){pctEl.textContent=pct.toFixed(1)+'%';pctEl.style.color=color;}
  if(barEl){barEl.style.width=bw+'%';barEl.style.background=color;}
  if(usedEl)usedEl.textContent=`${fmt$(b.used_cost)} / ${fmt$(b.limit_cost)}`;
  if(tokEl)tokEl.textContent=fmtTok(b.used_tokens)+(b.cache_tokens?` (캐시 ${fmtTok(b.cache_tokens)})`:'');
  if(msgEl)msgEl.textContent=fmtN(b.messages)+'건';if(remainEl)remainEl.textContent=fmtDuration(b.remaining_seconds);if(resetEl)resetEl.textContent=fmtResetTime(b.reset_at);}
const PLAN_C={green:'#34d399',yellow:'#fbbf24',orange:'#fb923c',red:'#f87171'};
function planBarColor(p){if(p>=90)return PLAN_C.red;if(p>=75)return PLAN_C.orange;if(p>=50)return PLAN_C.yellow;return PLAN_C.green;}
function checkPlanAlerts(d){if(!d)return;['daily','weekly'].forEach(p=>{const pct=d[p]?.percentage||0;if(pct>=90&&Notification.permission==='granted'&&!state['_a_'+p]){new Notification('Claude 사용량 경고',{body:`${p==='daily'?'일일':'주간'} ${pct.toFixed(0)}% (${fmt$(d[p].used_cost)} / ${fmt$(d[p].limit_cost)})`});state['_a_'+p]=true;}});}
function tickPlanCountdown(){if(!planData)return;planData.daily.remaining_seconds=Math.max(0,planData.daily.remaining_seconds-1);planData.weekly.remaining_seconds=Math.max(0,planData.weekly.remaining_seconds-1);const dr=document.getElementById('planDailyRemain'),wr=document.getElementById('planWeeklyRemain');if(dr)dr.textContent=fmtDuration(planData.daily.remaining_seconds);if(wr)wr.textContent=fmtDuration(planData.weekly.remaining_seconds);}
function fmtDuration(s){if(s<=0)return'만료';const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);if(d>0)return`${d}일 ${h}시간`;if(h>0)return`${h}시간 ${m}분`;return`${m}분`;}
function fmtResetTime(iso){if(!iso)return'—';const d=new Date(iso);if(isNaN(d))return iso;const days=['일','월','화','수','목','금','토'];return d.toLocaleDateString('ko-KR',{month:'short',day:'numeric'})+` (${days[d.getDay()]}) `+d.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});}

// ─── Plan Settings ──────────────────────────────────────────────────────
function openPlanSettings(){fetch('/api/plan/config').then(r=>r.json()).then(cfg=>{document.getElementById('cfgDailyLimit').value=cfg.daily_cost_limit||50;document.getElementById('cfgWeeklyLimit').value=cfg.weekly_cost_limit||300;document.getElementById('cfgResetHour').value=cfg.reset_hour||0;document.getElementById('cfgResetWeekday').value=cfg.reset_weekday||0;const tz=cfg.timezone_offset??Math.round(-new Date().getTimezoneOffset()/60);document.getElementById('cfgTimezone').value=tz;if(cfg.detected?.label){const h=document.getElementById('planDetectedHint');if(h)h.textContent=`감지: ${cfg.detected.label}`;}setSettingsTab('plan');document.getElementById('planModal').style.display='flex';});}

function setSettingsTab(tab) {
  document.querySelectorAll('.settings-tab').forEach(btn => {
    const active = btn.dataset.settingsTab === tab;
    btn.classList.toggle('text-accent', active);
    btn.classList.toggle('border-accent', active);
    btn.classList.toggle('text-white/35', !active);
    btn.classList.toggle('border-transparent', !active);
  });
  const planTab = document.getElementById('settingsTabPlan');
  const dispTab = document.getElementById('settingsTabDisplay');
  if (planTab) planTab.classList.toggle('hidden', tab !== 'plan');
  if (dispTab) dispTab.classList.toggle('hidden', tab !== 'display');
}
document.querySelectorAll('.settings-tab').forEach(btn => {
  btn.addEventListener('click', () => setSettingsTab(btn.dataset.settingsTab));
});
function closePlanSettings(){document.getElementById('planModal').style.display='none';}
async function savePlanConfig() {
  const body = {
    daily_cost_limit:  parseFloat(document.getElementById('cfgDailyLimit').value) || 50,
    weekly_cost_limit: parseFloat(document.getElementById('cfgWeeklyLimit').value) || 300,
    reset_hour:        parseInt(document.getElementById('cfgResetHour').value) || 0,
    reset_weekday:     parseInt(document.getElementById('cfgResetWeekday').value) || 0,
    timezone_offset:   parseInt(document.getElementById('cfgTimezone').value) || 9,
    timezone_name:     'Asia/Seoul',
  };
  try {
    const r = await fetch('/api/plan/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || r.statusText);
    }
    closePlanSettings();
    loadPlanUsage();
    showToast('설정이 저장되었습니다', { type: 'success' });
  } catch (e) {
    showToast('저장 실패: ' + (e.message || e), { type: 'error' });
  }
}
function applyPlanPreset(t){const p={pro:{d:15,w:80},max5x:{d:80,w:400},max20x:{d:300,w:1500}};const v=p[t];if(v){document.getElementById('cfgDailyLimit').value=v.d;document.getElementById('cfgWeeklyLimit').value=v.w;}}
(function(){const s=document.getElementById('cfgResetHour');for(let h=0;h<24;h++){const o=document.createElement('option');o.value=h;o.textContent=String(h).padStart(2,'0')+':00';s.appendChild(o);}})();

// ─── Session Management ─────────────────────────────────────────────────
// S1/S2: require the user to retype the session's project name before the
// delete executes. The preview DELETE call (without confirm) surfaces the
// message count so the user sees the blast radius.
async function deleteSession(sid, name) {
  const displayName = name || sid;
  try {
    const pv = await fetch(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' }).then(r => r.json());
    openDeleteConfirm({
      target: displayName,
      message: `이 세션과 ${fmtN(pv.message_count || 0)}건 메시지가 영구 삭제됩니다. 복구할 수 없습니다.`,
      onConfirm: async () => {
        try {
          await fetch(`/api/sessions/${encodeURIComponent(sid)}?confirm=true`, { method: 'DELETE' });
          loadSessions(); loadPeriods(); loadStats();
          showToast(`"${displayName}" 삭제 완료`, { type: 'success', duration: 2000 });
        } catch (e) {
          showToast('삭제 실패: ' + (e.message || e), { type: 'error' });
        }
      },
    });
  } catch (e) {
    console.error('deleteSession:', e);
    showToast('미리보기 실패: ' + (e.message || e), { type: 'error' });
  }
}
async function pinSession(sid, pin) {
  try {
    if (pin) await fetch(`/api/sessions/${sid}/pin`, {method:'POST'});
    else await fetch(`/api/sessions/${sid}/pin`, {method:'DELETE'});
    loadSessions();
    showToast(pin ? '핀 고정됨' : '핀 해제됨', { type: 'success', duration: 1500 });
  } catch(e) { console.error('pinSession:', e); showToast('핀 토글 실패', { type: 'error' }); }
}

// Inline tag-edit modal (replaces window.prompt). Native prompt() blocks
// the JS thread and on some browsers swallows the immediate post-prompt
// toast render — using a real DOM modal makes the toast pipeline reliable.
let _tagEditPending = null;

function editSessionTags(sid, current) {
  _tagEditPending = { sid };
  const target = document.getElementById('tagEditTarget');
  const input  = document.getElementById('tagEditInput');
  const modal  = document.getElementById('tagEditModal');
  if (target) target.textContent = `세션 ${sid.slice(0, 12)}`;
  if (input) {
    input.value = current || '';
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitTagEdit(); }
      if (e.key === 'Escape') { e.preventDefault(); closeTagEdit(); }
    };
  }
  if (modal) modal.classList.remove('hidden');
  setTimeout(() => input && input.focus(), 50);
}

function closeTagEdit() {
  document.getElementById('tagEditModal')?.classList.add('hidden');
  _tagEditPending = null;
}

async function submitTagEdit() {
  if (!_tagEditPending) return;
  const { sid, bulkIds } = _tagEditPending;
  const raw = document.getElementById('tagEditInput')?.value || '';
  const clean = raw.split(',').map(t => t.trim()).filter(Boolean).join(',');
  closeTagEdit();
  try {
    if (bulkIds && bulkIds.length) {
      // Bulk mode — apply the same tag string to every selected session
      let ok = 0, fail = 0;
      for (const id of bulkIds) {
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/tags`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags: clean }),
          });
          if (r.ok) ok++; else fail++;
        } catch { fail++; }
      }
      showToast(
        `일괄 태그: ${ok}건 적용${fail ? `, ${fail}건 실패` : ''}${clean ? ' → ' + clean : ' (비움)'}`,
        { type: fail ? 'warning' : 'success', duration: 2800 }
      );
      bulkClear();
      loadSessions();
    } else {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: clean }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      showToast(clean ? `태그 저장됨: ${clean}` : '태그 비움', { type: 'success', duration: 2400 });
      loadSessions();
    }
  } catch (e) {
    console.error('submitTagEdit:', e);
    showToast('태그 저장 실패: ' + (e.message || e), { type: 'error' });
  }
}

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
  if (!q || q.length < 2) { box.classList.add('hidden'); box.innerHTML=''; return; }
  convSearchTimer = setTimeout(async () => {
    try {
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
          labels: { color: 'rgba(255,255,255,.4)', boxWidth: 10, font: { size: 10, family: 'Pretendard' } },
        },
        tooltip: {
          backgroundColor: '#111',
          borderColor: 'rgba(255,255,255,.08)',
          borderWidth: 1,
          titleColor: 'rgba(255,255,255,.6)',
          bodyColor: 'rgba(255,255,255,.4)',
          callbacks: {
            label: ctx => ctx.dataset.label === '비용'
              ? ` ${fmt$(ctx.raw)}`
              : ` ${fmtN(ctx.raw)}건`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,.03)' },
          ticks: { color: 'rgba(255,255,255,.30)', font: { size: 9 }, maxTicksLimit: 10, maxRotation: 0 },
        },
        y: {
          position: 'left',
          grid: { color: 'rgba(255,255,255,.03)' },
          ticks: {
            color: 'rgba(251,191,36,.55)', font: { size: 9 },
            callback: v => '$' + v,
          },
        },
        y1: {
          position: 'right',
          grid: { display: false },
          ticks: {
            color: 'rgba(96,165,250,.55)', font: { size: 9 },
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
          ${rows.length === 0 ? `<tr><td colspan="8" class="text-center py-10 text-white/25">세션 없음</td></tr>` : rows.map(s => `
            <tr class="border-b border-white/[0.03] hover:bg-white/[0.04] spring">
              <td class="px-3 py-3">
                <div class="text-[11px] font-semibold text-white/80">${fmtTime(s.updated_at)}</div>
                <div class="text-[9px] text-white/30 font-mono mt-0.5">${esc((s.id||'').slice(0,8))}${s.pinned ? ' <span class="text-accent">★</span>' : ''}</div>
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
          `).join('')}
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

// ─── Subagent success matrix (agentType × stop_reason) ─────────────────
async function loadSubagentSuccessMatrix() {
  const wrap = document.getElementById('subagentSuccessMatrix');
  if (!wrap) return;
  try {
    const d = await safeFetch('/api/subagents/stats');
    const rows = d.by_type_and_stop_reason || [];
    if (!rows.length) {
      wrap.innerHTML = '<div class="text-center text-white/20 text-xs py-6">데이터 없음</div>';
      return;
    }
    // Collect unique agent_types (rows) and stop_reasons (columns)
    const types = [];
    const seenT = new Set();
    const reasons = [];
    const seenR = new Set();
    const cells = {};  // `${t}|${r}` → {count, cost}
    const rowTotals = {};
    for (const r of rows) {
      if (!seenT.has(r.agent_type)) { seenT.add(r.agent_type); types.push(r.agent_type); }
      if (!seenR.has(r.stop_reason)) { seenR.add(r.stop_reason); reasons.push(r.stop_reason); }
      cells[`${r.agent_type}|${r.stop_reason}`] = { count: r.count, cost: r.cost };
      rowTotals[r.agent_type] = (rowTotals[r.agent_type] || 0) + r.count;
    }
    // Sort columns: end_turn first (success), then others by count desc
    const preferred = ['end_turn', 'tool_use', 'stop_sequence', 'max_tokens', 'refusal', '(missing)'];
    reasons.sort((a, b) => {
      const ia = preferred.indexOf(a), ib = preferred.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b);
    });

    let html = '<table class="text-[10px] min-w-full"><thead><tr>';
    html += '<th class="text-left px-2 py-1 text-white/35 font-bold sticky left-0 bg-base">agentType \\ stop_reason</th>';
    reasons.forEach(r => {
      const badge = stopReasonBadge(r);
      html += `<th class="px-2 py-1 text-white/35 font-bold whitespace-nowrap">${badge} ${esc(r)}</th>`;
    });
    html += '<th class="px-2 py-1 text-white/50 font-bold whitespace-nowrap">success %</th>';
    html += '</tr></thead><tbody>';
    types.forEach(t => {
      const total = rowTotals[t] || 0;
      const successCount = cells[`${t}|end_turn`]?.count || 0;
      const successPct = total > 0 ? Math.round((successCount / total) * 100) : 0;
      const successCls = successPct >= 90 ? 'text-emerald-400/90'
        : successPct >= 70 ? 'text-amber-400/85'
        : 'text-red-400/80';
      html += `<tr><td class="px-2 py-1 font-bold text-white/60 sticky left-0 bg-base whitespace-nowrap">${esc(t)}</td>`;
      reasons.forEach(r => {
        const cell = cells[`${t}|${r}`];
        if (!cell) {
          html += '<td class="px-2 py-1 text-center text-white/10">·</td>';
        } else {
          const title = `${t} · ${r}: ${cell.count}건, ${fmt$(cell.cost)}`;
          html += `<td class="px-2 py-1 text-center tabular-nums text-white/75" title="${esc(title)}">${fmtN(cell.count)}</td>`;
        }
      });
      html += `<td class="px-2 py-1 text-center tabular-nums font-bold ${successCls}">${successPct}% <span class="text-white/35">(${total})</span></td>`;
      html += '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
  } catch (e) {
    console.error('loadSubagentSuccessMatrix:', e);
    wrap.innerHTML = '<div class="text-center text-red-400/40 text-xs py-6">로딩 실패</div>';
  }
}

// ─── Subagent heatmap (overview) ────────────────────────────────────────
async function loadSubagentHeatmap() {
  const wrap = document.getElementById('subagentHeatmap');
  if (!wrap) return;
  try {
    const d = await safeFetch('/api/subagents/heatmap');
    const projects = d.projects || [];
    const types = d.agent_types || [];
    const cells = d.cells || {};
    if (!projects.length || !types.length) {
      wrap.innerHTML = '<div class="text-center text-white/20 text-xs py-6">데이터 없음</div>';
      return;
    }
    let total = 0, totalCost = 0;
    Object.values(cells).forEach(v => { total += v.count || 0; totalCost += v.cost || 0; });
    const maxCost = Math.max(...Object.values(cells).map(v => v.cost || 0), 1);

    // Build grid: rows=agent_types, cols=projects
    let html = '<table class="text-[10px] min-w-full"><thead><tr>';
    html += '<th class="text-left px-2 py-1 text-white/35 font-bold sticky left-0 bg-base">agentType \\ project</th>';
    projects.forEach(p => {
      html += `<th class="px-2 py-1 text-white/35 font-bold whitespace-nowrap" title="${esc(p)}">${esc(p.length > 14 ? p.slice(0, 12) + '…' : p)}</th>`;
    });
    html += '</tr></thead><tbody>';
    types.forEach(t => {
      html += `<tr><td class="px-2 py-1 font-bold text-white/60 sticky left-0 bg-base whitespace-nowrap">${esc(t)}</td>`;
      projects.forEach(p => {
        const cell = cells[`${t}|${p}`];
        if (!cell) {
          html += '<td class="px-2 py-1 text-center text-white/10">·</td>';
        } else {
          const intensity = Math.min(1, (cell.cost || 0) / maxCost);
          // Color: emerald → amber → red based on intensity
          const bg = intensity > 0.66
            ? `rgba(251,113,133,${0.20 + intensity*0.35})`
            : intensity > 0.33
              ? `rgba(251,191,36,${0.15 + intensity*0.35})`
              : `rgba(52,211,153,${0.12 + intensity*0.25})`;
          const title = `${t} × ${p}: ${cell.count} subagents, ${fmt$(cell.cost)}`;
          html += `<td class="px-2 py-1 text-center font-bold tabular-nums text-white/80 cursor-default" style="background:${bg}" title="${esc(title)}">${fmtN(cell.count)}</td>`;
        }
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
    const totalEl = document.getElementById('subagentHeatmapTotal');
    if (totalEl) totalEl.textContent = `${fmtN(total)} subagents · ${fmt$(totalCost)} 누적`;
  } catch (e) {
    console.error('loadSubagentHeatmap:', e);
    wrap.innerHTML = '<div class="text-center text-red-400/40 text-xs py-6">로딩 실패</div>';
  }
}

// ─── Top 10 ─────────────────────────────────────────────────────────────
async function loadTopProjects(){try{const data=await safeFetch('/api/projects/top?limit=10');const projects=data.projects||[];const c=document.getElementById('topProjectsList');
  if(!projects.length){c.innerHTML='<div class="text-center text-white/10 text-xs py-8">데이터 없음</div>';return;}
  const mx=Math.max(...projects.map(p=>p.total_cost||0),1);
  const cols=['#34d399','#60a5fa','#fbbf24','#22d3ee','#a78bfa','#fb7185','#34d399','#60a5fa','#fbbf24','#22d3ee'];
  c.innerHTML=projects.map((p,i)=>{const pct=((p.total_cost||0)/mx*100).toFixed(1);const rc=i<3?['text-amber-400','text-white/40','text-orange-400'][i]:'text-white/15';
    return `<div class="grid grid-cols-[28px_1fr_auto_auto] items-center gap-3 py-1.5 border-b border-white/[0.03] last:border-b-0"><span class="text-xs font-extrabold text-center ${rc}">#${i+1}</span><div class="min-w-0"><div class="text-xs font-semibold text-white/50 truncate" title="${esc(p.project_path||'')}">${esc(p.project_name||'—')}</div><div class="h-1 bg-white/5 rounded-full mt-1 overflow-hidden"><div class="h-full rounded-full" style="width:${pct}%;background:${cols[i%cols.length]}"></div></div></div><span class="text-xs font-bold text-amber-400/70 whitespace-nowrap">${fmt$(p.total_cost)}</span><span class="text-[10px] text-white/20 whitespace-nowrap w-16 text-right">${fmtTok(p.total_tokens||0)}</span></div>`;}).join('');}catch(e){console.error('loadTopProjects:',e);}}

// ─── Utilities ──────────────────────────────────────────────────────────
function set(id,val){const el=document.getElementById(id);if(el)el.textContent=val;}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function fmtN(n){return(Number(n)||0).toLocaleString('ko-KR');}
function fmtTok(n){n=Number(n)||0;if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return String(n);}
function fmt$(n){n=Number(n)||0;if(n===0)return'$0';if(n<0.01)return'<$0.01';return'$'+n.toFixed(n>=1?2:4);}
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
  o: 'overview', s: 'sessions', c: 'conversations',
  m: 'models', p: 'projects', e: 'export',
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
renderPresetSelect();
connectWS();
setInterval(()=>{if(state.ws&&state.ws.readyState===WebSocket.OPEN)state.ws.send('ping');},25000);
if('Notification' in window && Notification.permission==='default')Notification.requestPermission();
