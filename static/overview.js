// Claude Dashboard — overview module.
// Extracted from app.js. Contains:
//   1. loadStats + renderStats (hero + secondary cost chips)
//   2. loadPeriods + renderPeriod (day/week/month cards)
//   3. loadForecast + burn-rate (hero 3 + secondary burn-out)
//   4. loadTopProjects (TOP 10 list with drill-down)
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
    markUpdated('stats');
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
  set('statCacheSaved', `절약 ≈ ${fmt$((a.cache_read_tokens || 0) * 13.125 / 1e6)}`);
  set('hdrToday', `오늘: ${fmt$(t.cost_usd)}`);
  set('hdrTotal', `전체: ${fmt$(a.cost_usd)}`);
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
  state.advFilters = { date_from: today, date_to: today, cost_min: '', cost_max: '' };
  savePrefs({ advFilters: state.advFilters });
  state.currentPage = 1;
  showView('sessions');
  const g = id => document.getElementById(id);
  if (g('advDateFrom')) g('advDateFrom').value = today;
  if (g('advDateTo'))   g('advDateTo').value   = today;
}
function drillToSessionsWeek() {
  const to = _todayISO(), from = _isoDaysAgo(6);
  state.advFilters = { date_from: from, date_to: to, cost_min: '', cost_max: '' };
  savePrefs({ advFilters: state.advFilters });
  state.currentPage = 1;
  showView('sessions');
  const g = id => document.getElementById(id);
  if (g('advDateFrom')) g('advDateFrom').value = from;
  if (g('advDateTo'))   g('advDateTo').value   = to;
}

// ─── TOP 10 projects ──────────────────────────────────────────────────
// Collapse markdown/table/code-fence noise so the one-line preview shows
// the first meaningful sentence instead of a ``` or `| col |` fragment.
function _cleanTopPreview(txt) {
  if (!txt) return '';
  let s = String(txt);
  s = s.replace(/```[\s\S]*?```/g, ' ');    // strip code blocks
  s = s.replace(/^\s*\|.*$/gm, ' ');         // strip markdown table rows
  s = s.replace(/^[#>\-*\s]+/, '');          // leading markers
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

async function loadTopProjects() {
  try {
    const data = await safeFetch('/api/projects/top?limit=10&with_last_message=true');
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
      const cleaned = lm ? _cleanTopPreview(lm.preview) : '';
      const previewLine = cleaned
        ? `<div class="text-[10px] text-white/35 mt-1 truncate" title="${esc(lm.preview || '')}"><iconify-icon icon="solar:chat-round-line-linear" width="10" class="inline text-white/25 mr-0.5 align-[-1px]"></iconify-icon>${esc(cleaned)}</div>`
        : '';
      const row = document.createElement('div');
      row.className = 'grid grid-cols-[28px_1fr_auto_auto] items-start gap-3 py-2 border-b border-white/[0.03] last:border-b-0 cursor-pointer hover:bg-white/[0.03] rounded-md px-1 spring';
      row.title = '프로젝트 상세 보기';
      row.innerHTML = `<span class="text-xs font-extrabold text-center pt-0.5 ${rc}">#${i+1}</span><div class="min-w-0"><div class="text-xs font-semibold text-white/60 truncate">${esc(p.project_name||'—')}</div><div class="h-1 bg-white/5 rounded-full mt-1 overflow-hidden"><div class="h-full rounded-full" style="width:${pct}%;background:${cols[i%cols.length]}"></div></div>${previewLine}</div><span class="text-xs font-bold text-amber-400/70 whitespace-nowrap pt-0.5">${fmt$(p.total_cost)}</span><span class="text-[10px] text-white/20 whitespace-nowrap w-16 text-right pt-0.5">${fmtTok(p.total_tokens||0)}</span>`;
      row.addEventListener('click', () => showProjectDetail(p.project_name, p.project_path));
      c.appendChild(row);
    });
  } catch (e) { console.error('loadTopProjects:', e); }
}
