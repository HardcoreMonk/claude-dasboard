// Claude Dashboard — overview module.
// Extracted from app.js. Contains:
//   1. loadStats + renderStats (hero + secondary cost chips)
//   2. loadPeriods + renderPeriod (day/week/month cards)
//   3. loadForecast + burn-rate (hero 3 + secondary burn-out)
//   4. loadTopProjects (TOP 5 list with drill-down)
//   5. drill helpers (drillToSessionsToday/Week)
//
// Loaded as a regular script after app.js. All functions become window.*
// globals. Depends on app.js globals: state, safeFetch, reportError,
// markUpdated, set, esc, fmt$, fmtN, fmtTok, savePrefs, showView,
// showProjectDetail.

// ─── Stats (hero cost totals + secondary chips) ────────────────────────
async function loadStats() {
  try {
    const d = await safeFetch('/api/stats');
    state.stats = d;
    renderStats(d);
    loadCodexUsageSummary();
    markUpdated('stats');
    reportSuccess('loadStats');
  } catch (e) { reportError('loadStats', e); }
}
function renderStats(data) {
  const t = data.today || {}, a = data.all_time || {};
  set('statTodayCost', fmt$(t.cost_usd));
  set('statTodayMsg', `${fmtN(t.messages || 0)} 메시지`);
  set('statTodayTokens', fmtTok((t.input_tokens || 0) + (t.output_tokens || 0)));
  set('statTodaySessions', `${fmtN(t.sessions || 0)} 세션`);
  set('statAllCost', fmt$(a.cost_usd));
  set('statAllSessions', `${fmtN(a.total_sessions || 0)} 세션`);
  set('statAllTokens', fmtTok((a.input_tokens || 0) + (a.output_tokens || 0)));
  set('statAllMessages', `${fmtN(a.messages || 0)} 메시지`);
  const rIn = (a.input_tokens || 0) + (a.cache_read_tokens || 0);
  const cEff = rIn > 0 ? ((a.cache_read_tokens || 0) / rIn * 100) : 0;
  set('statCacheEff', cEff.toFixed(1) + '%');
  set('statCacheSaved', `${fmtTok(a.cache_read_tokens || 0)} 읽기 · ${fmtTok(a.cache_creation_tokens || 0)} 생성`);
  set('hdrToday', `오늘: ${fmt$(t.cost_usd)}`);
  set('hdrTotal', `전체: ${fmt$(a.cost_usd)}`);
}

function ensureCodexUsagePanel() {
  const view = document.getElementById('view-overview');
  if (!view) return null;
  let panel = document.getElementById('codexUsagePanel');
  if (panel) return panel;
  panel = document.createElement('div');
  panel.id = 'codexUsagePanel';
  panel.className = 'bg-white/5 ring-1 ring-white/[0.07] p-1 rounded-bezel anim-in mt-3';
  panel.innerHTML = `
    <div class="bg-white/[0.02] rounded-bezel-inner shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] p-4">
      <div class="text-xs font-bold text-white/40">CODEX 사용량</div>
      <div class="text-center text-white/15 text-xs py-8 dots">로딩 중</div>
    </div>`;
  view.appendChild(panel);
  return panel;
}

async function loadCodexUsageSummary() {
  try {
    const summary = await safeFetch('/api/usage/summary');
    const byRole = summary.by_role || {};
    const codexLine = `Codex ${fmtN(summary.sessions || 0)}세션 · ${fmtN(summary.messages || 0)}메시지`;
    set('statAllMessages', `${fmtN((state.stats?.all_time?.messages) || 0)} 메시지 · ${codexLine}`);
    set('hdrTotal', `전체: ${fmt$(state.stats?.all_time?.cost_usd || 0)} · ${codexLine}`);
    const dayDetail = document.getElementById('pdDayDetail');
    if (dayDetail) {
      dayDetail.title = `user ${fmtN(byRole.user || 0)} · assistant ${fmtN(byRole.assistant || 0)} · tool ${fmtN(byRole.tool || 0)} · agent ${fmtN(byRole.agent || 0)}`;
    }
    const panel = ensureCodexUsagePanel();
    if (panel) {
      panel.firstElementChild.innerHTML = `
        <div class="text-xs font-bold text-white/40">CODEX 사용량</div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
          <div class="rounded-xl border border-white/[0.05] bg-black/20 px-3 py-3">
            <div class="text-[10px] uppercase tracking-widest text-white/35">세션</div>
            <div class="mt-2 text-xl font-bold text-white/85 tabular-nums">${fmtN(summary.sessions || 0)}</div>
            <div class="text-[10px] text-white/35 mt-1">${fmtN(summary.messages || 0)} messages</div>
          </div>
          <div class="rounded-xl border border-white/[0.05] bg-black/20 px-3 py-3">
            <div class="text-[10px] uppercase tracking-widest text-white/35">역할 분포</div>
            <div class="mt-2 text-[11px] text-white/60 leading-relaxed">user ${fmtN(byRole.user || 0)} · assistant ${fmtN(byRole.assistant || 0)} · tool ${fmtN(byRole.tool || 0)} · agent ${fmtN(byRole.agent || 0)}</div>
          </div>
          <div class="rounded-xl border border-white/[0.05] bg-black/20 px-3 py-3">
            <div class="text-[10px] uppercase tracking-widest text-white/35">최근 활동</div>
            <div class="mt-2 text-[11px] text-white/60">${esc(summary.latest_activity_at || '—')}</div>
          </div>
        </div>
        <div class="mt-3 grid gap-2">
          ${(summary.top_sessions || []).slice(0, 4).map((row) => `
            <div class="rounded-xl border border-white/[0.05] bg-black/20 px-3 py-2 flex items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="text-[11px] font-semibold text-white/75 truncate">${esc(row.session_title || row.session_id)}</div>
                <div class="text-[10px] text-white/35 mt-1">${esc(row.project_name || '—')} · ${fmtN(row.message_count || 0)} messages</div>
              </div>
              <button class="shrink-0 px-3 py-1 rounded-full bg-purple-500/15 text-purple-200 border border-purple-500/25 text-[10px] font-bold"
                      data-action="openSessionReplay" data-arg0="${esc(row.session_id)}" data-arg1="${esc(row.session_title || row.session_id)}">Replay</button>
            </div>
          `).join('')}
        </div>`;
    }
  } catch (e) {
    reportError('loadCodexUsageSummary', e);
  }
}

// ─── Period usage (day / week / month) ────────────────────────────────
async function loadPeriods() {
  try {
    const d = await safeFetch('/api/usage/periods');
    renderPeriod('Day', d.day);
    renderPeriod('Week', d.week);
    renderPeriod('Month', d.month);
  } catch (e) { reportError('loadPeriods', e); }
}
function renderPeriod(key, p) {
  set(`pd${key}Cost`, fmt$(p.cost));
  const tok = (p.input_tokens || 0) + (p.output_tokens || 0);
  set(`pd${key}Detail`,
    `${fmtTok(tok)} tok · ${fmtN(p.messages)}건 · 캐시 ${fmtTok(p.cache_read_tokens || 0)}`);
  const el = document.getElementById(`pd${key}Delta`);
  if (!el) return;
  if (p.prev_cost > 0) {
    const s = p.delta_pct >= 0 ? '▲' : '▼';
    el.textContent = `${s} ${Math.abs(p.delta_pct).toFixed(0)}% vs 이전 (${fmt$(p.prev_cost)})`;
    el.className = 'text-[10px] font-semibold mt-1 ' +
      (p.delta_pct >= 0 ? 'text-emerald-400/60' : 'text-red-400/60');
  } else {
    el.textContent = p.cost > 0 ? '신규' : '';
    el.className = 'text-[10px] font-semibold mt-1 text-white/15';
  }
}

// ─── Cost forecasting + burn-rate ─────────────────────────────────────
async function loadForecast() {
  try {
    const d = await safeFetch('/api/forecast?days=14');
    // IMPORTANT: use the global set() from app.js (which also removes the
    // .skeleton class on write). A local setEl helper that only touches
    // textContent leaves the shimmer animation running OVER the real text —
    // looks identical to a loading failure.
    set('forecastEOM', fmt$(d.projected_eom_cost));
    set('forecastEOMDetail',
      `MTD ${fmt$(d.mtd_cost)} · ${d.days_left_in_month}일 남음`);
    set('forecastAvg', fmt$(d.avg_cost_per_day));
    set('forecastAvgDetail', `${fmtN(d.avg_msgs_per_day || 0)} 메시지/일`);

    // Humanise seconds-until-burn-out as "N일 N시간 후" / "N시간 후" / "N분 후"
    // with urgency color coding. DOM-builder form (no innerHTML templates) so
    // upstream values can't leak markup.
    const buildBurnoutSpan = (sec, limit, used) => {
      const span = document.createElement('span');
      if (sec === null || sec === undefined) {
        span.className = 'text-white/30';
        span.textContent = '예산 미설정';
        return span;
      }
      if (used >= limit) {
        span.className = 'text-red-400 font-bold';
        span.textContent = `초과 (${fmt$(used)}/${fmt$(limit)})`;
        return span;
      }
      const days = Math.floor(sec / 86400);
      const hours = Math.floor((sec % 86400) / 3600);
      const label = days >= 1 ? `${days}일 ${hours}시간 후`
        : hours >= 1 ? `${hours}시간 후`
        : `${Math.floor(sec / 60)}분 후`;
      span.className = 'font-bold ' + (sec < 3600 ? 'text-red-400'
        : sec < 86400 ? 'text-amber-400'
        : 'text-emerald-400/85');
      span.textContent = label;
      return span;
    };
    const setBurnout = (elId, prefix, sec, limit, used) => {
      const el = document.getElementById(elId);
      if (!el) return;
      el.textContent = prefix + ' ';
      el.appendChild(buildBurnoutSpan(sec, limit, used));
      el.classList.remove('skeleton');
    };
    setBurnout('forecastBurnoutDaily', '일간',
      d.daily_budget_burnout_seconds, d.daily_limit, d.daily_used);
    setBurnout('forecastBurnoutWeekly', '주간',
      d.weekly_budget_burnout_seconds, d.weekly_limit, d.weekly_used);
  } catch (e) {
    reportError('loadForecast', e);
  }
}

// ─── Overview drill-down helpers ──────────────────────────────────────
function _todayISO() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}
function _isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}
function drillToSessionsToday() {
  const today = _todayISO();
  setAdvFilters({ date_from: today, date_to: today, cost_min: '', cost_max: '' });
  savePrefs({ advFilters: getAdvFilters() });
  setPage(1);
  showView('sessions');
  const g = id => document.getElementById(id);
  if (g('advDateFrom')) g('advDateFrom').value = today;
  if (g('advDateTo'))   g('advDateTo').value   = today;
}
function drillToSessionsWeek() {
  const to = _todayISO(), from = _isoDaysAgo(6);
  setAdvFilters({ date_from: from, date_to: to, cost_min: '', cost_max: '' });
  savePrefs({ advFilters: getAdvFilters() });
  setPage(1);
  showView('sessions');
  const g = id => document.getElementById(id);
  if (g('advDateFrom')) g('advDateFrom').value = from;
  if (g('advDateTo'))   g('advDateTo').value   = to;
}

// ─── TOP 5 projects ───────────────────────────────────────────────────
// Preview cleanup is now done server-side (main.py:summarize_preview) and
// delivered as last_message.summary_line. The frontend just renders it.
async function loadTopProjects() {
  try {
    const data = await safeFetch('/api/projects/top?limit=5&with_last_message=true');
    const projects = data.projects || [];
    const c = document.getElementById('topProjectsList');
    if (!projects.length) {
      c.innerHTML = '<div class="text-center text-white/10 text-xs py-8">데이터 없음</div>';
      return;
    }
    const mx = Math.max(...projects.map(p => p.total_cost || 0), 1);
    const cols = ['#34d399', '#60a5fa', '#fbbf24', '#22d3ee', '#a78bfa', '#fb7185', '#34d399', '#60a5fa', '#fbbf24', '#22d3ee'];
    c.textContent = '';
    projects.forEach((p, i) => {
      const pct = ((p.total_cost || 0) / mx * 100).toFixed(1);
      const rc = i < 3 ? ['text-amber-400', 'text-white/40', 'text-orange-400'][i] : 'text-white/15';
      const lm = p.last_message;
      const cleaned = lm ? (lm.summary_line || lm.preview || '') : '';
      const previewLine = cleaned
        ? `<div class="text-[11px] text-white/35 mt-2 leading-relaxed whitespace-normal" style="display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden" title="${esc(lm.preview || '')}"><iconify-icon icon="solar:chat-round-line-linear" width="10" class="inline text-white/25 mr-0.5 align-[-1px]"></iconify-icon>${esc(cleaned)}</div>`
        : '';
      const liveBadge = p.is_active
        ? `<span class="ml-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300/90 ring-1 ring-emerald-500/40 text-[9px] font-bold uppercase tracking-wider align-middle" title="최근 30분 이내 활동"><span class="w-1 h-1 rounded-full bg-emerald-400 animate-pulse"></span>LIVE</span>`
        : '';
      // Status badge — shown to the LEFT of the project name. Different
      // styles for different states: idle (amber), active tool (cyan),
      // active subagent (blue).
      const idleKey = (p.project_name || '') + '|' + (p.project_path || '');
      const idleEntry = (state.idleProjects && state.idleProjects[idleKey]) || null;
      let idleBadge = '';
      if (idleEntry) {
        const STATUS_BADGE = {
          'end_turn':        { label: '입력 대기',       icon: 'solar:hourglass-line-linear',    bg: 'bg-amber-500/15', text: 'text-amber-300/95', ring: 'ring-amber-500/40',   pulse: true  },
          'tool_use':        { label: '권한 승인 대기',  icon: 'solar:shield-check-linear',      bg: 'bg-amber-500/15', text: 'text-amber-300/95', ring: 'ring-amber-500/40',   pulse: true  },
          'active_subagent': { label: '에이전트 작업 중', icon: 'solar:cpu-bolt-linear',          bg: 'bg-blue-500/15',  text: 'text-blue-300/90',  ring: 'ring-blue-500/40',    pulse: true  },
          'active_tool':     { label: '도구 실행 중',    icon: 'solar:settings-minimalistic-linear', bg: 'bg-cyan-500/15',  text: 'text-cyan-300/90',  ring: 'ring-cyan-500/30',    pulse: false },
        };
        const cfg = STATUS_BADGE[idleEntry.reason] || STATUS_BADGE['end_turn'];
        const title = esc(idleEntry.preview || cfg.label);
        idleBadge = `<span class="mr-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full ${cfg.bg} ${cfg.text} ring-1 ${cfg.ring} text-[9px] font-bold uppercase tracking-wider align-middle${cfg.pulse ? ' animate-pulse' : ''}" title="${title}"><iconify-icon icon="${cfg.icon}" width="10" class="inline"></iconify-icon>${cfg.label}</span>`;
      }
      const row = document.createElement('div');
      row.className = 'grid grid-cols-[28px_1fr_auto_auto_auto] items-start gap-2 py-4 border-b border-white/[0.03] last:border-b-0 cursor-pointer hover:bg-white/[0.03] rounded-md px-2 spring' + (p.is_active ? ' bg-emerald-500/[0.02]' : '');
      row.title = '클릭하여 프로젝트 상세 보기';
      row.setAttribute('tabindex', '0');
      row.setAttribute('role', 'button');
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); } });
      // NOTE: innerHTML here is safe — all dynamic values pass through esc() or
// are numeric (pct, i, cols[i], fmt$, fmtTok). No raw user input.
row.innerHTML = `<span class="text-sm font-extrabold text-center pt-0.5 ${rc}">#${i+1}</span><div class="min-w-0"><div class="text-sm font-semibold text-white/60 truncate">${idleBadge}${esc(p.project_name||'—')}${liveBadge}</div><div class="h-1.5 bg-white/5 rounded-full mt-2 overflow-hidden"><div class="h-full rounded-full" style="width:${pct}%;background:${cols[i%cols.length]}"></div></div>${previewLine}</div><button data-peek-btn type="button" title="마지막 대화 미리보기" aria-label="마지막 대화 미리보기" class="flex items-center gap-1 self-start mt-0.5 px-2 py-1 rounded-full bg-accent/10 hover:bg-accent/25 text-accent/80 hover:text-accent ring-1 ring-accent/30 hover:ring-accent/60 text-[10px] font-bold spring"><iconify-icon icon="solar:eye-linear" width="13" style="pointer-events:none"></iconify-icon><span style="pointer-events:none">미리보기</span></button><span class="text-sm font-bold text-amber-400/70 whitespace-nowrap pt-0.5">${fmt$(p.total_cost)}</span><span class="text-[11px] text-white/20 whitespace-nowrap w-16 text-right pt-0.5">${fmtTok(p.total_tokens||0)}</span>`;
      row.dataset.projectName = p.project_name || '';
      row.dataset.projectPath = p.project_path || '';
      // 행 본체: 기존 프로젝트 상세 모달로 드릴
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-peek-btn]')) return;  // peek 버튼은 패스
        showProjectDetail(p.project_name, p.project_path);
      });
      // 눈 아이콘 버튼: 우측 drawer 슬라이드 in
      const peekBtn = row.querySelector('[data-peek-btn]');
      if (peekBtn) {
        peekBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          topPreviewOpen(p);
        });
      }
      c.appendChild(row);
    });
    // Real-time refresh: if the preview panel is currently showing one of
    // these projects, rebuild it with the fresh last_message.
    if (typeof topPreviewMaybeRefresh === 'function') topPreviewMaybeRefresh(projects);
  } catch (e) { reportError('loadTopProjects', e); }
}


// ─── TOP 5 preview panel (right slide-in) ──────────────────────────────
// State: which project is currently shown. When loadTopProjects runs via
// debouncedRefresh, we re-populate the panel if its project is still in
// the new list (so the content reflects the latest assistant message).
let topPreviewState = { projectName: null, projectPath: null };

function topPreviewOpen(project) {
  if (!project) return;
  topPreviewState = {
    projectName: project.project_name || '',
    projectPath: project.project_path || '',
  };
  const panel    = document.getElementById('topPreviewPanel');
  const backdrop = document.getElementById('topPreviewBackdrop');
  const title    = document.getElementById('topPreviewProject');
  const meta     = document.getElementById('topPreviewMeta');
  const body     = document.getElementById('topPreviewBody');
  const updAt    = document.getElementById('topPreviewUpdatedAt');
  if (!panel) return;

  // Title row
  if (title) title.textContent = project.project_name || '—';
  if (meta) {
    const parts = [];
    if (project.total_cost != null) parts.push(fmt$(project.total_cost));
    if (project.total_tokens != null) parts.push(fmtTok(project.total_tokens) + ' tok');
    if (project.is_active) parts.push('LIVE');
    parts.push(project.project_path || '');
    meta.textContent = parts.join(' · ');
  }

  // Body
  const lm = project.last_message;
  body.textContent = '';
  if (lm && lm.preview) {
    const summary = document.createElement('div');
    summary.className = 'text-white/90 font-semibold mb-3 leading-snug';
    summary.textContent = (lm.summary_line || lm.preview).slice(0, 200);

    const divider = document.createElement('div');
    divider.className = 'text-[9px] uppercase tracking-widest text-white/30 mb-2';
    divider.textContent = '원문 (' + (lm.timestamp ? fmtTime(lm.timestamp) : '—') + ' · ' + (lm.model || '—') + ')';

    const full = document.createElement('div');
    full.className = 'text-white/70 leading-relaxed';
    full.textContent = lm.preview;

    body.append(summary, divider, full);
  } else {
    const empty = document.createElement('div');
    empty.className = 'text-white/30 text-center py-8';
    empty.textContent = '이 프로젝트에는 아직 assistant 메시지가 없습니다';
    body.appendChild(empty);
  }
  if (updAt) updAt.textContent = fmtTime(new Date().toISOString());

  // Slide in drawer (inline style for transform to bypass JIT class availability)
  panel.setAttribute('aria-hidden', 'false');
  panel.style.transform = 'translateX(0)';
  panel.style.opacity = '1';
  panel.style.pointerEvents = 'auto';
  if (backdrop) {
    backdrop.style.opacity = '1';
    backdrop.style.pointerEvents = 'auto';
  }

  // Focus the first interactive element in the panel
  setTimeout(() => { panel.querySelector('button')?.focus(); }, 100);

  // Highlight active row
  document.querySelectorAll('#topProjectsList > div').forEach(r => {
    const match = r.dataset.projectName === topPreviewState.projectName
               && r.dataset.projectPath === topPreviewState.projectPath;
    r.classList.toggle('ring-1', match);
    r.classList.toggle('ring-accent/30', match);
  });
}

function topPreviewClose() {
  topPreviewState = { projectName: null, projectPath: null };
  const panel    = document.getElementById('topPreviewPanel');
  const backdrop = document.getElementById('topPreviewBackdrop');
  if (!panel) return;
  panel.setAttribute('aria-hidden', 'true');
  panel.style.transform = 'translateX(100%)';
  panel.style.opacity = '0';
  panel.style.pointerEvents = 'none';
  if (backdrop) {
    backdrop.style.opacity = '0';
    backdrop.style.pointerEvents = 'none';
  }
  document.querySelectorAll('#topProjectsList > div').forEach(r => {
    r.classList.remove('ring-1', 'ring-accent/30');
  });
}

// Drill into the full project modal from the preview panel footer button
function topPreviewOpenProjectModal() {
  if (topPreviewState.projectName) {
    showProjectDetail(topPreviewState.projectName, topPreviewState.projectPath);
  }
}

// Called from loadTopProjects AFTER the new list is rendered. If the panel
// is showing a project that's still in the list, refresh its content with
// the newly fetched last_message (realtime update from WS batch refresh).
function topPreviewMaybeRefresh(projects) {
  if (!topPreviewState.projectName) return;
  const match = projects.find(p =>
    p.project_name === topPreviewState.projectName &&
    p.project_path === topPreviewState.projectPath
  );
  if (match) {
    topPreviewOpen(match);
  }
}
