// Codex Dashboard — overview module.
// Owns the overview ops-console shell and the renderers that populate it.
// Dependencies from app.js: state, safeFetch, reportError, reportSuccess,
// markUpdated, set, esc, fmt$, fmtN, fmtTok, savePrefs, showView,
// showProjectDetail, loadPlanUsage (for the cost view only).

function overviewRegion(id) {
  return document.getElementById(id);
}

function overviewSetHtml(id, html) {
  const el = overviewRegion(id);
  if (el) el.innerHTML = html;
  return el;
}

function overviewPct(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return `${value.toFixed(1)}%`;
}

function overviewDurationLabel(seconds) {
  if (!seconds || seconds <= 0) return '만료';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}일 ${h}시간`;
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분`;
}

function overviewResetLabel(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

function overviewRelativeTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const delta = Date.now() - d.getTime();
  if (delta < 5_000) return '방금';
  if (delta < 60_000) return `${Math.floor(delta / 1_000)}초 전`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}분 전`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}시간 전`;
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function renderOverviewShell() {
  overviewSetHtml('overviewAxisBody', `
    <div class="overview-skeleton-grid">
      <div class="overview-skeleton-card"></div>
      <div class="overview-skeleton-card"></div>
    </div>`);
  overviewSetHtml('overviewActionBody', `
    <div class="overview-skeleton-grid">
      <div class="overview-skeleton-card"></div>
      <div class="overview-skeleton-card"></div>
    </div>`);
  overviewSetHtml('overviewOpsSummaryBody', `
    <div class="overview-skeleton-grid">
      <div class="overview-skeleton-card"></div>
      <div class="overview-skeleton-card"></div>
      <div class="overview-skeleton-card"></div>
    </div>
    <div class="overview-skeleton-strip">
      <div class="overview-skeleton-pill"></div>
      <div class="overview-skeleton-pill"></div>
      <div class="overview-skeleton-pill"></div>
      <div class="overview-skeleton-pill"></div>
    </div>`);
  overviewSetHtml('overviewProductivitySummaryBody', `
    <div class="overview-skeleton-grid overview-skeleton-grid--compact">
      <div class="overview-skeleton-card overview-skeleton-card--tall"></div>
      <div class="overview-skeleton-card overview-skeleton-card--tall"></div>
    </div>`);
  overviewSetHtml('overviewReportingSummaryBody', `
    <div class="overview-skeleton-grid overview-skeleton-grid--compact">
      <div class="overview-skeleton-card overview-skeleton-card--tall"></div>
      <div class="overview-skeleton-card overview-skeleton-card--tall"></div>
    </div>`);
  overviewSetHtml('overviewOpsPreviewBody', `
    <div class="overview-entry-shell">
      <div class="overview-entry-shell__head">
        <div>
          <div class="overview-entry-shell__title">Top projects</div>
          <div class="overview-entry-shell__sub">행 클릭 → 프로젝트 상세, 눈 버튼 → 마지막 대화 미리보기</div>
        </div>
        <button data-action="openCommandPalette" class="overview-entry-shell__action">명령 팔레트</button>
      </div>
      <div id="topProjectsList" class="overview-project-list">
        <div class="overview-project-empty dots">로딩 중</div>
      </div>
    </div>`);
  overviewSetHtml('overviewProductivityPreviewBody', `
    <div class="overview-skeleton-grid overview-skeleton-grid--compact">
      <div class="overview-skeleton-card overview-skeleton-card--tall"></div>
      <div class="overview-skeleton-card overview-skeleton-card--tall"></div>
    </div>`);
  overviewSetHtml('overviewReportingPreviewBody', `
    <div class="overview-skeleton-grid overview-skeleton-grid--compact">
      <div class="overview-skeleton-card overview-skeleton-card--tall"></div>
      <div class="overview-skeleton-card overview-skeleton-card--tall"></div>
    </div>`);
}

const overviewState = {
  stats: null,
  periods: null,
  forecast: null,
  plan: null,
  usage: null,
  projects: [],
};

function overviewStatValue(path, fallback = null) {
  const parts = path.split('.');
  let cur = overviewState;
  for (const part of parts) {
    cur = cur?.[part];
    if (cur == null) return fallback;
  }
  return cur;
}

function overviewPlanPct(block) {
  return block ? overviewPct(block.percentage || 0) : '—';
}

function overviewStatusTone(pct) {
  if (!Number.isFinite(pct)) return 'muted';
  if (pct >= 90) return 'danger';
  if (pct >= 75) return 'warning';
  if (pct >= 50) return 'notice';
  return 'ok';
}

function overviewToneClass(tone) {
  if (tone === 'danger') return 'overview-tone overview-tone--danger';
  if (tone === 'warning') return 'overview-tone overview-tone--warning';
  if (tone === 'notice') return 'overview-tone overview-tone--notice';
  return 'overview-tone overview-tone--ok';
}

function overviewStatRows() {
  const stats = overviewState.stats || {};
  const today = stats.today || {};
  const all = stats.all_time || {};
  const periods = overviewState.periods || {};
  const forecast = overviewState.forecast || {};
  const plan = overviewState.plan || {};
  const usage = overviewState.usage || {};
  const daily = plan.daily || {};
  const weekly = plan.weekly || {};
  const rows = [
    { label: '오늘 비용', value: fmt$(today.cost_usd), detail: `${fmtN(today.sessions || 0)}세션 · ${fmtTok((today.input_tokens || 0) + (today.output_tokens || 0))}` },
    { label: '일일 예산', value: overviewPlanPct(daily), detail: `${fmt$(daily.used_cost || 0)} / ${fmt$(daily.limit_cost || 0)} · 남은 ${overviewDurationLabel(daily.remaining_seconds)}` },
    { label: '주간 예산', value: overviewPlanPct(weekly), detail: `${fmt$(weekly.used_cost || 0)} / ${fmt$(weekly.limit_cost || 0)} · 재설정 ${overviewResetLabel(weekly.reset_at)}` },
    { label: '월말 예측', value: fmt$(forecast.projected_eom_cost), detail: `14일 평균 ${fmt$(forecast.avg_cost_per_day || 0)} · ${forecast.days_left_in_month || 0}일 남음` },
    { label: '전체 비용', value: fmt$(all.cost_usd), detail: `${fmtN(all.total_sessions || 0)}세션 · ${fmtN(all.messages || 0)}메시지` },
    { label: '캐시 효율', value: `${((all.input_tokens || 0) + (all.cache_read_tokens || 0)) > 0 ? (((all.cache_read_tokens || 0) / ((all.input_tokens || 0) + (all.cache_read_tokens || 0))) * 100).toFixed(1) : '0.0'}%`, detail: `${fmtTok(all.cache_read_tokens || 0)} 읽기 · ${fmtTok(all.cache_creation_tokens || 0)} 생성` },
  ];
  if (usage.sessions != null) {
    rows.push({ label: '사용량', value: `${fmtN(usage.sessions || 0)}세션`, detail: `${fmtN(usage.messages || 0)}메시지 · ${overviewRelativeTime(usage.latest_activity_at)}` });
  } else if (periods.day) {
    rows.push({ label: '오늘 요약', value: fmt$(periods.day.cost), detail: `${fmtN(periods.day.messages || 0)}메시지 · 캐시 ${fmtTok(periods.day.cache_read_tokens || 0)}` });
  }
  return rows.slice(0, 6);
}

function renderOverviewAxisGrid() {
  const rows = overviewStatRows().slice(0, 3);
  const usage = overviewState.usage || {};
  const topSession = (usage.top_sessions || [])[0];
  overviewSetHtml('overviewAxisBody', `
    <div class="grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
      <div class="rounded-[28px] border border-white/[0.07] bg-white/[0.03] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <div class="text-[10px] font-bold uppercase tracking-[0.18em] text-white/35">Portal axis</div>
        <div class="mt-2 text-xl font-extrabold tracking-tight text-white/92">Ops, productivity, reporting를 같은 축에 놓습니다.</div>
        <p class="mt-2 text-[13px] leading-6 text-white/56">기존 KPI, alert, flow, top-projects 데이터를 유지한 채 배치를 다시 잡았습니다. 상단 그룹 네비게이션과 이 영역의 빠른 동작 버튼으로 같은 데이터 위를 오가게 합니다.</p>
        <div class="mt-4 flex flex-wrap gap-2">
          <button data-action="showView" data-arg="overview" class="overview-flow-path__pill overview-flow-path__pill--active">overview</button>
          <button data-action="showView" data-arg="explore" class="overview-flow-path__pill">explore</button>
          <button data-action="showView" data-arg="analysis" class="overview-flow-path__pill">analysis</button>
          <button data-action="showView" data-arg="admin" class="overview-flow-path__pill">admin</button>
        </div>
      </div>
      <div class="grid gap-3 sm:grid-cols-3">
        ${rows.map((row) => `
          <article class="rounded-[24px] border border-white/[0.06] bg-white/[0.025] p-4">
            <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-white/34">${esc(row.label)}</div>
            <div class="mt-2 text-2xl font-extrabold tracking-tight text-white/92">${row.value}</div>
            <div class="mt-1 text-[11px] leading-5 text-white/45">${esc(row.detail)}</div>
          </article>
        `).join('')}
      </div>
      <div class="rounded-[24px] border border-white/[0.06] bg-white/[0.025] p-4 lg:col-span-2">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-white/34">Latest active</div>
            <div class="mt-1 text-sm font-bold text-white/90">${esc(topSession?.session_title || topSession?.session_id || '—')}</div>
          </div>
          <span class="overview-region-chip overview-region-chip--cyan">live</span>
        </div>
        <div class="mt-2 text-[11px] leading-5 text-white/45">${esc(topSession ? `${topSession.project_name || '—'} · ${fmtN(topSession.message_count || 0)} messages` : 'usage summary unavailable')}</div>
      </div>
    </div>`);
}

function renderOverviewOpsSummary() {
  const stats = overviewState.stats || {};
  const today = stats.today || {};
  const all = stats.all_time || {};
  const forecast = overviewState.forecast || {};
  const plan = overviewState.plan || {};
  const daily = plan.daily || {};
  const weekly = plan.weekly || {};
  const usage = overviewState.usage || {};
  const rows = overviewStatRows();
  const topSession = (usage.top_sessions || [])[0];
  const severity = overviewStatusTone(daily.percentage || 0);
  const forecastSeverity = overviewStatusTone(
    forecast.projected_eom_cost && daily.limit_cost ? ((forecast.projected_eom_cost / daily.limit_cost) * 100) : 0,
  );
  const burnoutLabel = forecast.daily_budget_burnout_seconds != null
    ? `${overviewDurationLabel(forecast.daily_budget_burnout_seconds)} 후`
    : '예산 미설정';
  overviewSetHtml('overviewOpsSummaryBody', `
    <div class="overview-kpi-grid">
      <article class="overview-kpi-card overview-kpi-card--primary">
        <div class="overview-kpi-head">
          <div>
            <div class="overview-kpi-label">Today</div>
            <div class="overview-kpi-value">${fmt$(today.cost_usd)}</div>
          </div>
          <span class="overview-chip">live</span>
        </div>
        <div class="overview-kpi-meta">${fmtN(today.sessions || 0)}세션 · ${fmtTok((today.input_tokens || 0) + (today.output_tokens || 0))}</div>
        <div class="overview-kpi-sub">${fmtN(today.messages || 0)}메시지 · ${overviewRelativeTime(usage.latest_activity_at || today.last_activity_at)}</div>
      </article>

      <article class="overview-kpi-card ${overviewToneClass(severity)}">
        <div class="overview-kpi-head">
          <div>
            <div class="overview-kpi-label">Daily budget</div>
            <div class="overview-kpi-value">${overviewPlanPct(daily)}</div>
          </div>
          <span class="overview-chip overview-chip--amber">budget</span>
        </div>
        <div class="overview-meter">
          <div class="overview-meter__fill" style="width:${Math.min(daily.percentage || 0, 100)}%;"></div>
        </div>
        <div class="overview-kpi-meta">${fmt$(daily.used_cost || 0)} / ${fmt$(daily.limit_cost || 0)}</div>
        <div class="overview-kpi-sub">남은 ${overviewDurationLabel(daily.remaining_seconds)} · 재설정 ${overviewResetLabel(daily.reset_at)}</div>
      </article>

      <article class="overview-kpi-card ${overviewToneClass(forecastSeverity)}">
        <div class="overview-kpi-head">
          <div>
            <div class="overview-kpi-label">Forecast</div>
            <div class="overview-kpi-value">${fmt$(forecast.projected_eom_cost)}</div>
          </div>
          <span class="overview-chip overview-chip--cyan">14d</span>
        </div>
        <div class="overview-kpi-meta">일평균 ${fmt$(forecast.avg_cost_per_day || 0)}</div>
        <div class="overview-kpi-sub">남은 ${forecast.days_left_in_month || 0}일 · burn-out ${burnoutLabel}</div>
      </article>
    </div>
    <div class="overview-kpi-strip">
      ${rows.map((row) => `
        <div class="overview-stat-chip">
          <div class="overview-stat-chip__label">${esc(row.label)}</div>
          <div class="overview-stat-chip__value">${row.value}</div>
          <div class="overview-stat-chip__detail">${esc(row.detail)}</div>
        </div>
      `).join('')}
      <div class="overview-stat-chip overview-stat-chip--wide">
        <div class="overview-stat-chip__label">Top session</div>
        <div class="overview-stat-chip__value">${esc(topSession?.session_title || topSession?.session_id || '—')}</div>
        <div class="overview-stat-chip__detail">${esc(topSession ? `${topSession.project_name || '—'} · ${fmtN(topSession.message_count || 0)} messages` : 'usage summary unavailable')}</div>
      </div>
    </div>`);
}

function renderOverviewProductivitySummary() {
  const plan = overviewState.plan || {};
  const usage = overviewState.usage || {};
  const forecast = overviewState.forecast || {};
  const daily = plan.daily || {};
  const weekly = plan.weekly || {};
  const byRole = usage.by_role || {};
  const topSession = (usage.top_sessions || [])[0];
  const dailyTone = overviewStatusTone(daily.percentage || 0);
  const weeklyTone = overviewStatusTone(weekly.percentage || 0);
  const forecastTone = overviewStatusTone(
    forecast.projected_eom_cost && weekly.limit_cost ? ((forecast.projected_eom_cost / weekly.limit_cost) * 100) : 0,
  );
  const alertRows = [
    { label: 'Daily spend', tone: dailyTone, value: overviewPlanPct(daily), detail: `${fmt$(daily.used_cost || 0)} / ${fmt$(daily.limit_cost || 0)} · 남은 ${overviewDurationLabel(daily.remaining_seconds)}` },
    { label: 'Weekly spend', tone: weeklyTone, value: overviewPlanPct(weekly), detail: `${fmt$(weekly.used_cost || 0)} / ${fmt$(weekly.limit_cost || 0)} · 재설정 ${overviewResetLabel(weekly.reset_at)}` },
    { label: 'Forecast risk', tone: forecastTone, value: fmt$(forecast.projected_eom_cost), detail: `${forecast.days_left_in_month || 0}일 남음 · ${fmt$(forecast.avg_cost_per_day || 0)}/day` },
  ];
  overviewSetHtml('overviewProductivitySummaryBody', `
    <div class="overview-alert-grid">
      <article class="overview-alert-card ${overviewToneClass(dailyTone)}">
        <div class="overview-alert-card__head">
          <span class="overview-alert-card__label">Budget watch</span>
          <span class="overview-chip overview-chip--amber">${overviewPlanPct(daily)}</span>
        </div>
        <div class="overview-alert-card__value">${fmt$(daily.used_cost || 0)} / ${fmt$(daily.limit_cost || 0)}</div>
        <div class="overview-alert-card__detail">남은 ${overviewDurationLabel(daily.remaining_seconds)} · ${fmtN(daily.messages || 0)}건</div>
      </article>

      <article class="overview-alert-card ${overviewToneClass(weeklyTone)}">
        <div class="overview-alert-card__head">
          <span class="overview-alert-card__label">Weekly watch</span>
          <span class="overview-chip overview-chip--cyan">${overviewPlanPct(weekly)}</span>
        </div>
        <div class="overview-alert-card__value">${fmt$(weekly.used_cost || 0)} / ${fmt$(weekly.limit_cost || 0)}</div>
        <div class="overview-alert-card__detail">재설정 ${overviewResetLabel(weekly.reset_at)} · ${fmtN(weekly.messages || 0)}건</div>
      </article>
    </div>
    <div class="overview-alert-feed">
      ${alertRows.map((row) => `
        <div class="overview-alert-feed__row ${overviewToneClass(row.tone)}">
          <div class="overview-alert-feed__label">${esc(row.label)}</div>
          <div class="overview-alert-feed__value">${row.value}</div>
          <div class="overview-alert-feed__detail">${esc(row.detail)}</div>
        </div>
      `).join('')}
      <div class="overview-alert-feed__row">
        <div class="overview-alert-feed__label">Role mix</div>
        <div class="overview-alert-feed__value">${fmtN(usage.sessions || 0)}세션</div>
        <div class="overview-alert-feed__detail">user ${fmtN(byRole.user || 0)} · assistant ${fmtN(byRole.assistant || 0)} · tool ${fmtN(byRole.tool || 0)} · agent ${fmtN(byRole.agent || 0)}</div>
      </div>
      <div class="overview-alert-feed__row">
        <div class="overview-alert-feed__label">Latest active</div>
        <div class="overview-alert-feed__value">${esc(topSession?.session_title || topSession?.session_id || '—')}</div>
        <div class="overview-alert-feed__detail">${esc(topSession ? `${topSession.project_name || '—'} · ${fmtN(topSession.message_count || 0)} messages` : 'no recent sessions')}</div>
      </div>
    </div>`);
}

function renderOverviewReportingSummary() {
  const stats = overviewState.stats || {};
  const forecast = overviewState.forecast || {};
  const plan = overviewState.plan || {};
  const usage = overviewState.usage || {};
  const lastUpdated = state.lastUpdated || {};
  overviewSetHtml('overviewReportingSummaryBody', `
    <div class="overview-flow-grid">
      <article class="overview-flow-card">
        <div class="overview-flow-card__head">
          <span class="overview-flow-card__label">Navigation path</span>
          <span class="overview-chip overview-chip--emerald">default</span>
        </div>
        <div class="overview-flow-path">
          <button data-action="showView" data-arg="overview" class="overview-flow-path__pill overview-flow-path__pill--active">overview</button>
          <span>→</span>
          <button data-action="showView" data-arg="explore" class="overview-flow-path__pill">explore</button>
          <span>→</span>
          <button data-action="showView" data-arg="analysis" class="overview-flow-path__pill">analysis</button>
          <span>→</span>
          <button data-action="showView" data-arg="admin" class="overview-flow-path__pill">admin</button>
        </div>
        <div class="overview-flow-card__detail">개요가 기본 진입점이고 하위 화면은 같은 데이터 소스 위에서 분화됩니다.</div>
      </article>

      <article class="overview-flow-card">
        <div class="overview-flow-card__head">
          <span class="overview-flow-card__label">Refresh sources</span>
          <span class="overview-chip overview-chip--cyan">${overviewRelativeTime(new Date(lastUpdated.stats || Date.now()).toISOString())}</span>
        </div>
        <div class="overview-flow-source-list">
          <div class="overview-flow-source">stats <span>${overviewRelativeTime(lastUpdated.stats ? new Date(lastUpdated.stats).toISOString() : null)}</span></div>
          <div class="overview-flow-source">periods <span>${overviewRelativeTime(lastUpdated.periods ? new Date(lastUpdated.periods).toISOString() : null)}</span></div>
          <div class="overview-flow-source">forecast <span>${overviewRelativeTime(lastUpdated.forecast ? new Date(lastUpdated.forecast).toISOString() : null)}</span></div>
          <div class="overview-flow-source">projects <span>${overviewRelativeTime(lastUpdated.topProjects ? new Date(lastUpdated.topProjects).toISOString() : null)}</span></div>
        </div>
        <div class="overview-flow-card__detail">API: /api/codex/stats, /api/codex/usage/periods, /api/codex/forecast, /api/codex/projects/top</div>
      </article>
    </div>
    <div class="overview-flow-band">
      <div class="overview-flow-band__cell">
        <span class="overview-flow-band__label">Forecast</span>
        <span class="overview-flow-band__value">${fmt$(forecast.projected_eom_cost || 0)}</span>
      </div>
      <div class="overview-flow-band__cell">
        <span class="overview-flow-band__label">Daily</span>
        <span class="overview-flow-band__value">${fmt$(plan.daily?.used_cost || 0)} / ${fmt$(plan.daily?.limit_cost || 0)}</span>
      </div>
      <div class="overview-flow-band__cell">
        <span class="overview-flow-band__label">Usage</span>
        <span class="overview-flow-band__value">${fmtN(usage.sessions || 0)}세션</span>
      </div>
      <div class="overview-flow-band__cell">
        <span class="overview-flow-band__label">Today</span>
        <span class="overview-flow-band__value">${fmt$(stats.today?.cost_usd || 0)}</span>
      </div>
    </div>`);
}

function renderOverviewActionGrid() {
  overviewSetHtml('overviewActionBody', `
    <div class="grid gap-3 sm:grid-cols-2">
      <button data-action="openCommandPalette" class="rounded-[22px] border border-white/[0.07] bg-white/[0.03] p-4 text-left transition hover:border-accent/30 hover:bg-accent/10">
        <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-white/34">Command</div>
        <div class="mt-2 text-sm font-bold text-white/90">명령 팔레트</div>
        <div class="mt-1 text-[11px] leading-5 text-white/46">검색, 점프, 모달을 한 번에 여는 빠른 진입점입니다.</div>
      </button>
      <button data-action="drillToSessionsToday" class="rounded-[22px] border border-white/[0.07] bg-white/[0.03] p-4 text-left transition hover:border-accent/30 hover:bg-accent/10">
        <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-white/34">Today</div>
        <div class="mt-2 text-sm font-bold text-white/90">오늘 세션</div>
        <div class="mt-1 text-[11px] leading-5 text-white/46">오늘 날짜로 세션 탐색을 바로 맞춥니다.</div>
      </button>
      <button data-action="drillToSessionsWeek" class="rounded-[22px] border border-white/[0.07] bg-white/[0.03] p-4 text-left transition hover:border-accent/30 hover:bg-accent/10">
        <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-white/34">Week</div>
        <div class="mt-2 text-sm font-bold text-white/90">이번 주 세션</div>
        <div class="mt-1 text-[11px] leading-5 text-white/46">이번 주 범위로 요약된 세션 흐름을 봅니다.</div>
      </button>
      <button data-action="showView" data-arg="explore" class="rounded-[22px] border border-white/[0.07] bg-white/[0.03] p-4 text-left transition hover:border-accent/30 hover:bg-accent/10">
        <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-white/34">Navigate</div>
        <div class="mt-2 text-sm font-bold text-white/90">탐색으로 이동</div>
        <div class="mt-1 text-[11px] leading-5 text-white/46">검색 중심 워크스페이스로 전환합니다.</div>
      </button>
      <button data-action="showView" data-arg="analysis" class="rounded-[22px] border border-white/[0.07] bg-white/[0.03] p-4 text-left transition hover:border-accent/30 hover:bg-accent/10">
        <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-white/34">Navigate</div>
        <div class="mt-2 text-sm font-bold text-white/90">분석으로 이동</div>
        <div class="mt-1 text-[11px] leading-5 text-white/46">비용과 시계열 분석 화면으로 전환합니다.</div>
      </button>
      <button data-action="showView" data-arg="admin" class="rounded-[22px] border border-white/[0.07] bg-white/[0.03] p-4 text-left transition hover:border-accent/30 hover:bg-accent/10">
        <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-white/34">Navigate</div>
        <div class="mt-2 text-sm font-bold text-white/90">관리로 이동</div>
        <div class="mt-1 text-[11px] leading-5 text-white/46">백업, 로그, 운영 도구를 여는 포털입니다.</div>
      </button>
    </div>`);
}

function renderOverviewOpsPreview() {
  overviewSetHtml('overviewOpsPreviewBody', `
    <div class="overview-entry-shell">
      <div class="overview-entry-shell__head">
        <div>
          <div class="overview-entry-shell__title">Top projects</div>
          <div class="overview-entry-shell__sub">행 클릭 → 프로젝트 상세, 눈 버튼 → 마지막 대화 미리보기</div>
        </div>
        <button data-action="openCommandPalette" class="overview-entry-shell__action">명령 팔레트</button>
      </div>
      <div id="topProjectsList" class="overview-project-list">
        <div class="overview-project-empty dots">로딩 중</div>
      </div>
    </div>`);
}

function renderOverviewProductivityPreview() {
  const periods = overviewState.periods || {};
  const day = periods.day || {};
  const week = periods.week || {};
  const month = periods.month || {};
  const forecast = overviewState.forecast || {};
  const dailyTone = overviewStatusTone(overviewState.plan?.daily?.percentage || 0);
  const weeklyTone = overviewStatusTone(overviewState.plan?.weekly?.percentage || 0);
  overviewSetHtml('overviewProductivityPreviewBody', `
    <div class="grid gap-3">
      <article class="rounded-[24px] border border-white/[0.07] bg-white/[0.03] p-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-white/34">Period usage</div>
            <div class="mt-1 text-sm font-bold text-white/90">오늘 · 이번 주 · 이번 달</div>
          </div>
          <span class="overview-region-chip overview-region-chip--amber">periods</span>
        </div>
        <div class="mt-4 grid gap-2 sm:grid-cols-3">
          <div class="rounded-[20px] border border-white/[0.06] bg-white/[0.02] p-3">
            <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-white/34">Day</div>
            <div class="mt-1 text-lg font-extrabold text-white/92">${fmt$(day.cost || 0)}</div>
            <div class="mt-1 text-[11px] text-white/45">${fmtN(day.messages || 0)}건 · 캐시 ${fmtTok(day.cache_read_tokens || 0)}</div>
          </div>
          <div class="rounded-[20px] border border-white/[0.06] bg-white/[0.02] p-3">
            <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-white/34">Week</div>
            <div class="mt-1 text-lg font-extrabold text-white/92">${fmt$(week.cost || 0)}</div>
            <div class="mt-1 text-[11px] text-white/45">${fmtN(week.messages || 0)}건 · ${overviewResetLabel(week.reset_at)}</div>
          </div>
          <div class="rounded-[20px] border border-white/[0.06] bg-white/[0.02] p-3">
            <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-white/34">Month</div>
            <div class="mt-1 text-lg font-extrabold text-white/92">${fmt$(month.cost || 0)}</div>
            <div class="mt-1 text-[11px] text-white/45">${fmtN(month.messages || 0)}건 · 캐시 ${fmtTok(month.cache_read_tokens || 0)}</div>
          </div>
        </div>
      </article>
      <article class="rounded-[24px] border border-white/[0.07] bg-white/[0.03] p-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-white/34">Forecast burn-out</div>
            <div class="mt-1 text-sm font-bold text-white/90">예측과 남은 시간</div>
          </div>
          <span class="overview-region-chip overview-region-chip--cyan">forecast</span>
        </div>
        <div class="mt-4 grid gap-2">
          <div class="flex items-center justify-between rounded-[18px] border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px]">
            <span class="text-white/45">월말 예측</span>
            <span class="font-bold text-white/90">${fmt$(forecast.projected_eom_cost || 0)}</span>
          </div>
          <div class="flex items-center justify-between rounded-[18px] border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px]">
            <span class="text-white/45">일평균</span>
            <span class="font-bold text-white/90">${fmt$(forecast.avg_cost_per_day || 0)}</span>
          </div>
          <div class="flex items-center justify-between rounded-[18px] border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px]">
            <span class="text-white/45">Burn-out</span>
            <span class="font-bold ${dailyTone === 'danger' ? 'text-red-400/90' : dailyTone === 'warning' ? 'text-amber-300/90' : 'text-emerald-300/90'}">${overviewDurationLabel(forecast.daily_budget_burnout_seconds)}</span>
          </div>
          <div class="flex items-center justify-between rounded-[18px] border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px]">
            <span class="text-white/45">주간 Burn-out</span>
            <span class="font-bold ${weeklyTone === 'danger' ? 'text-red-400/90' : weeklyTone === 'warning' ? 'text-amber-300/90' : 'text-emerald-300/90'}">${overviewDurationLabel(forecast.weekly_budget_burnout_seconds)}</span>
          </div>
        </div>
      </article>
    </div>`);
}

function renderOverviewReportingPreview() {
  const lastUpdated = state.lastUpdated || {};
  const usage = overviewState.usage || {};
  const byRole = usage.by_role || {};
  const topSession = (usage.top_sessions || [])[0];
  overviewSetHtml('overviewReportingPreviewBody', `
    <div class="grid gap-3">
      <article class="rounded-[24px] border border-white/[0.07] bg-white/[0.03] p-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-white/34">Source freshness</div>
            <div class="mt-1 text-sm font-bold text-white/90">업데이트 타임라인</div>
          </div>
          <span class="overview-region-chip overview-region-chip--cyan">fresh</span>
        </div>
        <div class="mt-4 grid gap-2">
          <div class="flex items-center justify-between rounded-[18px] border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px]">
            <span class="text-white/45">stats</span>
            <span class="font-bold text-white/90">${esc(overviewRelativeTime(lastUpdated.stats ? new Date(lastUpdated.stats).toISOString() : null))}</span>
          </div>
          <div class="flex items-center justify-between rounded-[18px] border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px]">
            <span class="text-white/45">periods</span>
            <span class="font-bold text-white/90">${esc(overviewRelativeTime(lastUpdated.periods ? new Date(lastUpdated.periods).toISOString() : null))}</span>
          </div>
          <div class="flex items-center justify-between rounded-[18px] border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px]">
            <span class="text-white/45">forecast</span>
            <span class="font-bold text-white/90">${esc(overviewRelativeTime(lastUpdated.forecast ? new Date(lastUpdated.forecast).toISOString() : null))}</span>
          </div>
          <div class="flex items-center justify-between rounded-[18px] border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px]">
            <span class="text-white/45">projects</span>
            <span class="font-bold text-white/90">${esc(overviewRelativeTime(lastUpdated.topProjects ? new Date(lastUpdated.topProjects).toISOString() : null))}</span>
          </div>
        </div>
      </article>
      <article class="rounded-[24px] border border-white/[0.07] bg-white/[0.03] p-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-white/34">Usage mix</div>
            <div class="mt-1 text-sm font-bold text-white/90">최근 활동 요약</div>
          </div>
          <span class="overview-region-chip overview-region-chip--emerald">mix</span>
        </div>
        <div class="mt-4 grid gap-2">
          <div class="flex items-center justify-between rounded-[18px] border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px]">
            <span class="text-white/45">sessions</span>
            <span class="font-bold text-white/90">${fmtN(usage.sessions || 0)}세션</span>
          </div>
          <div class="flex items-center justify-between rounded-[18px] border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px]">
            <span class="text-white/45">role mix</span>
            <span class="font-bold text-white/90">user ${fmtN(byRole.user || 0)} · assistant ${fmtN(byRole.assistant || 0)} · tool ${fmtN(byRole.tool || 0)} · agent ${fmtN(byRole.agent || 0)}</span>
          </div>
          <div class="rounded-[18px] border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px]">
            <div class="text-white/45">latest active</div>
            <div class="mt-1 font-bold text-white/90">${esc(topSession?.session_title || topSession?.session_id || '—')}</div>
            <div class="mt-1 text-white/45">${esc(topSession ? `${topSession.project_name || '—'} · ${fmtN(topSession.message_count || 0)} messages` : 'no recent sessions')}</div>
          </div>
        </div>
      </article>
    </div>`);
}

function renderTopProjects(projects) {
  const c = document.getElementById('topProjectsList');
  if (!c) return;
  if (!projects.length) {
    c.innerHTML = '<div class="overview-project-empty">데이터 없음</div>';
    return;
  }
  const mx = Math.max(...projects.map(p => p.total_cost || 0), 1);
  c.textContent = '';
  projects.forEach((p, i) => {
    const row = document.createElement('article');
    const pct = ((p.total_cost || 0) / mx * 100).toFixed(1);
    const tone = i === 0 ? 'overview-project-row--first' : i === 1 ? 'overview-project-row--second' : i === 2 ? 'overview-project-row--third' : '';
    row.className = `overview-project-row ${tone}`;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.title = '클릭하여 프로젝트 상세 보기';
    row.dataset.projectName = p.project_name || '';
    row.dataset.projectPath = p.project_path || '';
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        row.click();
      }
    });
    const lm = p.last_message;
    const cleaned = lm ? (lm.summary_line || lm.preview || '') : '';
    const idleKey = (p.project_name || '') + '|' + (p.project_path || '');
    const idleEntry = (state.idleProjects && state.idleProjects[idleKey]) || null;
    const idleBadge = idleEntry ? `<span class="overview-project-badge">${esc(idleEntry.preview || idleEntry.reason || 'idle')}</span>` : '';
    const liveBadge = p.is_active ? '<span class="overview-project-live">LIVE</span>' : '';
    row.innerHTML = `
      <div class="overview-project-rank">#${i + 1}</div>
      <div class="overview-project-main">
        <div class="overview-project-main__head">
          <div class="overview-project-name">${idleBadge}${esc(p.project_name || '—')}${liveBadge}</div>
          <div class="overview-project-cost">${fmt$(p.total_cost)}</div>
        </div>
        <div class="overview-project-bar"><span style="width:${pct}%;"></span></div>
        <div class="overview-project-meta">${fmtTok(p.total_tokens || 0)} · ${fmtN(p.session_count || 0)}세션 · ${overviewRelativeTime(p.last_activity_at)}</div>
        ${cleaned ? `<div class="overview-project-preview" title="${esc(lm?.preview || '')}">${esc(cleaned)}</div>` : '<div class="overview-project-preview overview-project-preview--empty">assistant 메시지 없음</div>'}
      </div>
      <button data-peek-btn type="button" class="overview-project-peek" title="마지막 대화 미리보기" aria-label="마지막 대화 미리보기">미리보기</button>
    `;
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-peek-btn]')) return;
      showProjectDetail(p.project_name, p.project_path);
    });
    const peekBtn = row.querySelector('[data-peek-btn]');
    if (peekBtn) {
      peekBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        topPreviewOpen(p);
      });
    }
    c.appendChild(row);
  });
  if (typeof topPreviewMaybeRefresh === 'function') topPreviewMaybeRefresh(projects);
}

function renderOverviewConsole() {
  renderOverviewAxisGrid();
  renderOverviewActionGrid();
  renderOverviewOpsSummary();
  renderOverviewProductivitySummary();
  renderOverviewReportingSummary();
  renderOverviewOpsPreview();
  renderOverviewProductivityPreview();
  renderOverviewReportingPreview();
}

function loadOverviewDashboard() {
  Object.assign(overviewState, {
    stats: null,
    periods: null,
    forecast: null,
    plan: null,
    usage: null,
    projects: [],
  });
  renderOverviewShell();
  renderOverviewConsole();
  void loadStats();
  void loadPeriods();
  void loadForecast();
  void loadOverviewPlanUsage();
  void loadTopProjects();
}

async function loadOverviewPlanUsage() {
  try {
    const resp = await safeFetch('/api/codex/plan/usage');
    overviewState.plan = resp;
    renderOverviewConsole();
  } catch (e) {
    reportError('loadOverviewPlanUsage', e);
  }
}

//
// Loaded as a regular script after app.js. All functions become window.*
// globals. Depends on app.js globals: state, safeFetch, reportError,
// markUpdated, set, esc, fmt$, fmtN, fmtTok, savePrefs, showView,
// showProjectDetail.

// ─── Stats (hero cost totals + secondary chips) ────────────────────────
async function loadStats() {
  try {
    const d = await safeFetch('/api/codex/stats');
    state.stats = d;
    overviewState.stats = d;
    renderStats(d);
    loadCodexUsageSummary();
    markUpdated('stats');
    renderOverviewConsole();
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

async function loadCodexUsageSummary() {
  try {
    const summary = await safeFetch('/api/usage/summary');
    overviewState.usage = summary;
    const byRole = summary.by_role || {};
    const codexLine = `Codex ${fmtN(summary.sessions || 0)}세션 · ${fmtN(summary.messages || 0)}메시지`;
    set('statAllMessages', `${fmtN((state.stats?.all_time?.messages) || 0)} 메시지 · ${codexLine}`);
    set('hdrTotal', `전체: ${fmt$(state.stats?.all_time?.cost_usd || 0)} · ${codexLine}`);
    const dayDetail = document.getElementById('pdDayDetail');
    if (dayDetail) {
      dayDetail.title = `user ${fmtN(byRole.user || 0)} · assistant ${fmtN(byRole.assistant || 0)} · tool ${fmtN(byRole.tool || 0)} · agent ${fmtN(byRole.agent || 0)}`;
    }
    renderOverviewConsole();
  } catch (e) {
    reportError('loadCodexUsageSummary', e);
  }
}

// ─── Period usage (day / week / month) ────────────────────────────────
async function loadPeriods() {
  try {
    const d = await safeFetch('/api/codex/usage/periods');
    overviewState.periods = d;
    renderPeriod('Day', d.day);
    renderPeriod('Week', d.week);
    renderPeriod('Month', d.month);
    renderOverviewConsole();
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
    const d = await safeFetch('/api/codex/forecast?days=14');
    overviewState.forecast = d;
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
    renderOverviewConsole();
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
    const data = await safeFetch('/api/codex/projects/top?limit=5&with_last_message=true');
    const projects = data.projects || [];
    overviewState.projects = projects;
    const c = document.getElementById('topProjectsList');
    renderTopProjects(projects);
    renderOverviewConsole();
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
