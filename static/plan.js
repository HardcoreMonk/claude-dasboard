// Claude Dashboard — plan/budget module.
// Extracted from app.js. Loaded as a regular (non-module) script after app.js;
// all functions become window.* globals so inline onclick="openPlanSettings()"
// handlers in index.html continue to resolve.
//
// Dependencies from app.js: state, fetch, reportError, showToast, fmt$,
// fmtTok, fmtN.

// ─── Plan Usage ─────────────────────────────────────────────────────────
let planTimer = null, planData = null;

function clearPlanTimer() {
  if (planTimer) { clearInterval(planTimer); planTimer = null; }
}

async function loadPlanUsage() {
  try {
    const resp = await fetch('/api/plan/usage');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    planData = await resp.json();
    renderPlanBlock('Daily', planData.daily);
    renderPlanBlock('Weekly', planData.weekly);
    loadCodexPlanSummary();
    if (planTimer) clearInterval(planTimer);
    planTimer = setInterval(tickPlanCountdown, 1000);
  } catch (e) { reportError('loadPlanUsage', e); }
}

function ensureCodexPlanPanel() {
  const view = document.getElementById('view-cost');
  if (!view) return null;
  let panel = document.getElementById('codexPlanPanel');
  if (panel) return panel;
  panel = document.createElement('div');
  panel.id = 'codexPlanPanel';
  panel.className = 'bg-white/5 ring-1 ring-white/[0.07] p-1 rounded-bezel mb-4 anim-in';
  panel.innerHTML = `
    <div class="bg-white/[0.02] rounded-bezel-inner shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] px-5 py-3">
      <div class="text-[10px] font-bold text-white/35 uppercase tracking-widest">Codex Session Usage</div>
      <div class="text-center text-white/15 text-xs py-6 dots">로딩 중</div>
    </div>`;
  const chartsRow = view.querySelector('.grid.grid-cols-1.lg\\:grid-cols-3');
  if (chartsRow) view.insertBefore(panel, chartsRow);
  else view.appendChild(panel);
  return panel;
}

async function loadCodexPlanSummary() {
  try {
    const summary = await safeFetch('/api/usage/summary');
    const dailyMsgs = document.getElementById('planDailyMsgs');
    const weeklyMsgs = document.getElementById('planWeeklyMsgs');
    const hint = `Codex ${fmtN(summary.sessions || 0)}세션 · ${fmtN(summary.messages || 0)}메시지`;
    if (dailyMsgs) dailyMsgs.title = hint;
    if (weeklyMsgs) {
      const base = weeklyMsgs.dataset.baseText || weeklyMsgs.textContent || '';
      weeklyMsgs.dataset.baseText = base;
      weeklyMsgs.textContent = `${base} · ${hint}`;
    }
    const panel = ensureCodexPlanPanel();
    if (panel) {
      panel.firstElementChild.innerHTML = `
        <div class="text-[10px] font-bold text-white/35 uppercase tracking-widest">Codex Session Usage</div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
          <div class="rounded-xl border border-white/[0.05] bg-black/20 px-3 py-3">
            <div class="text-[11px] text-white/60">총 세션 ${fmtN(summary.sessions || 0)} · 총 메시지 ${fmtN(summary.messages || 0)}</div>
            <div class="text-[10px] text-white/35 mt-1">최근 활동 ${esc(summary.latest_activity_at || '—')}</div>
          </div>
          <div class="rounded-xl border border-white/[0.05] bg-black/20 px-3 py-3 text-[10px] text-white/50">
            user ${fmtN(summary.by_role?.user || 0)} · assistant ${fmtN(summary.by_role?.assistant || 0)} · tool ${fmtN(summary.by_role?.tool || 0)} · agent ${fmtN(summary.by_role?.agent || 0)}
          </div>
        </div>
        <div class="mt-3 grid gap-2">
          ${(summary.top_sessions || []).slice(0, 3).map((row) => `
            <div class="rounded-xl border border-white/[0.05] bg-black/20 px-3 py-2 flex items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="text-[11px] font-semibold text-white/75 truncate">${esc(row.session_title || row.session_id)}</div>
                <div class="text-[10px] text-white/35 mt-1">${fmtN(row.message_count || 0)} messages · ${esc(row.last_activity_at || '')}</div>
              </div>
              <button class="shrink-0 px-3 py-1 rounded-full bg-purple-500/15 text-purple-200 border border-purple-500/25 text-[10px] font-bold"
                      data-action="openSessionReplay" data-arg0="${esc(row.session_id)}" data-arg1="${esc(row.session_title || row.session_id)}">Replay</button>
            </div>
          `).join('')}
        </div>`;
    }
  } catch (e) {
    reportError('loadCodexPlanSummary', e);
  }
}

// Small write helper that also clears the .skeleton loader class once real
// data arrives. Only used by the plan module — kept local.
function _writeText(el, txt) {
  if (!el) return;
  el.textContent = txt;
  if (el.classList.contains('skeleton')) el.classList.remove('skeleton');
}

function renderPlanBlock(key, b) {
  if (!b) return;
  const el = id => document.getElementById(`plan${key}${id}`);
  const pctEl = el('Pct'), barEl = el('Bar'), usedEl = el('Used'),
        tokEl = el('Tokens'), msgEl = el('Msgs'),
        remainEl = el('Remain'), resetEl = el('Reset');
  const pct = b.percentage || 0;
  const bw = Math.min(pct, 100);
  const color = planBarColor(pct);
  if (pctEl) { _writeText(pctEl, pct.toFixed(1) + '%'); pctEl.style.color = color; }
  if (barEl) { barEl.style.width = bw + '%'; barEl.style.background = color; }
  _writeText(usedEl,   `${fmt$(b.used_cost)} / ${fmt$(b.limit_cost)}`);
  _writeText(tokEl,    fmtTok(b.used_tokens) + (b.cache_tokens ? ` (캐시 ${fmtTok(b.cache_tokens)})` : ''));
  _writeText(msgEl,    fmtN(b.messages) + '건');
  _writeText(remainEl, fmtDuration(b.remaining_seconds));
  _writeText(resetEl,  fmtResetTime(b.reset_at));
}

const PLAN_C = { green: '#34d399', yellow: '#fbbf24', orange: '#fb923c', red: '#f87171' };
function planBarColor(p) {
  if (p >= 90) return PLAN_C.red;
  if (p >= 75) return PLAN_C.orange;
  if (p >= 50) return PLAN_C.yellow;
  return PLAN_C.green;
}

// checkPlanAlerts — disabled: usage warning popup removed per user request.

function tickPlanCountdown() {
  if (!planData) return;
  planData.daily.remaining_seconds = Math.max(0, planData.daily.remaining_seconds - 1);
  planData.weekly.remaining_seconds = Math.max(0, planData.weekly.remaining_seconds - 1);
  const dr = document.getElementById('planDailyRemain');
  const wr = document.getElementById('planWeeklyRemain');
  if (dr) dr.textContent = fmtDuration(planData.daily.remaining_seconds);
  if (wr) wr.textContent = fmtDuration(planData.weekly.remaining_seconds);
}

function fmtDuration(s) {
  if (s <= 0) return '만료';
  const d = Math.floor(s / 86400);
  const h = Math.floor(s % 86400 / 3600);
  const m = Math.floor(s % 3600 / 60);
  if (d > 0) return `${d}일 ${h}시간`;
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분`;
}

function fmtResetTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' }) +
         ` (${days[d.getDay()]}) ` +
         d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

// ─── Plan Settings modal ───────────────────────────────────────────────
function openPlanSettings() {
  fetch('/api/plan/config').then(r => r.json()).then(cfg => {
    document.getElementById('cfgDailyLimit').value    = cfg.daily_cost_limit  || 50;
    document.getElementById('cfgWeeklyLimit').value   = cfg.weekly_cost_limit || 300;
    document.getElementById('cfgResetHour').value     = cfg.reset_hour         || 0;
    document.getElementById('cfgResetWeekday').value  = cfg.reset_weekday      || 0;
    const tz = cfg.timezone_offset ?? Math.round(-new Date().getTimezoneOffset() / 60);
    document.getElementById('cfgTimezone').value = tz;
    if (cfg.detected?.label) {
      const h = document.getElementById('planDetectedHint');
      if (h) h.textContent = `감지: ${cfg.detected.label}`;
    }
    setSettingsTab('plan');
    document.getElementById('planModal').style.display = 'flex';
  });
}

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

// Bind settings tab clicks once on load
document.querySelectorAll('.settings-tab').forEach(btn => {
  btn.addEventListener('click', () => setSettingsTab(btn.dataset.settingsTab));
});

function closePlanSettings() {
  document.getElementById('planModal').style.display = 'none';
}

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

function applyPlanPreset(t) {
  const p = { pro: { d: 15, w: 80 }, max5x: { d: 80, w: 400 }, max20x: { d: 300, w: 1500 } };
  const v = p[t];
  if (v) {
    document.getElementById('cfgDailyLimit').value = v.d;
    document.getElementById('cfgWeeklyLimit').value = v.w;
  }
}

// Populate the reset-hour dropdown once on load
(function () {
  const s = document.getElementById('cfgResetHour');
  if (!s) return;
  for (let h = 0; h < 24; h++) {
    const o = document.createElement('option');
    o.value = h;
    o.textContent = String(h).padStart(2, '0') + ':00';
    s.appendChild(o);
  }
})();
