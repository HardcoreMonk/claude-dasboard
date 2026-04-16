// Claude Dashboard — work timeline (Gantt) module (v2).
// Loaded as a plain script after app.js + charts.js.
// Depends on: state, safeFetch, reportError, reportSuccess, fmt$, fmtN,
//   fmtDurationSec, fmtTime, shortModel, showView, openConversation,
//   themeColors, grd, tck, tooltipOpts, CC, CHART_D, _prefersReducedMotion,
//   h, esc, savePrefs, _prefs, renderCompareModal.

// ─── Constants ───────────────────────────────────────────────────────────
const MODEL_COLORS = {
  opus:   { bg: 'rgba(167,139,250,A)', border: 'rgba(167,139,250,0.9)' },
  sonnet: { bg: 'rgba(52,211,153,A)',  border: 'rgba(52,211,153,0.9)'  },
  haiku:  { bg: 'rgba(34,211,238,A)',  border: 'rgba(34,211,238,0.9)'  },
  _sub:   { bg: 'rgba(96,165,250,A)',  border: 'rgba(96,165,250,0.9)'  },
  _default:{ bg:'rgba(251,191,36,A)',  border: 'rgba(251,191,36,0.9)'  },
};
const DOW_LABELS = ['\uC77C', '\uC6D4', '\uD654', '\uC218', '\uBAA9', '\uAE08', '\uD1A0'];

// ─── Range state ─────────────────────────────────────────────────────────
let _tlRange = _prefs.tlRange || '7d';
let _tlLastData = null;
let _tlCollapsed = new Set(_prefs.tlCollapsed || []);
let _tlOutlierIds = new Set();   // session ids flagged as $/hr outliers
let _tlOutlierProjs = new Set(); // project names flagged as outliers
let codexTimelineMode = _prefs.codexTimelineMode || 'auto';

function _ensureTimelineModeControls(hasCodexData) {
  const controls = document.getElementById('timelineControls');
  if (!controls) return;
  let wrap = document.getElementById('codexTimelineMode');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'codexTimelineMode';
    wrap.className = 'flex items-center gap-1.5 ml-2';
    wrap.innerHTML = `
      <button data-mode="auto" class="px-2 py-1 rounded-full text-[10px] font-semibold spring border border-white/[0.07]">Auto</button>
      <button data-mode="codex" class="px-2 py-1 rounded-full text-[10px] font-semibold spring border border-white/[0.07]">Codex</button>
      <button data-mode="legacy" class="px-2 py-1 rounded-full text-[10px] font-semibold spring border border-white/[0.07]">Claude</button>
    `;
    wrap.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        codexTimelineMode = btn.dataset.mode || 'auto';
        savePrefs({ codexTimelineMode });
        loadTimeline();
      });
    });
    controls.appendChild(wrap);
  }
  wrap.querySelectorAll('button').forEach((btn) => {
    const active = btn.dataset.mode === codexTimelineMode;
    btn.classList.toggle('bg-accent/15', active);
    btn.classList.toggle('text-accent', active);
    btn.classList.toggle('text-white/45', !active);
    btn.disabled = !hasCodexData && btn.dataset.mode === 'codex';
  });
}

function renderCodexTimelineMode(summary) {
  const wrap = document.getElementById('timelineChartWrap');
  const legend = document.getElementById('timelineLegend');
  destroyChart('timeline');
  if (!wrap || !legend) return;
  wrap.style.height = 'auto';
  const sessions = summary.session_summaries || [];
  const items = summary.items || [];
  wrap.innerHTML = `
    <div class="space-y-3">
      <div class="rounded-xl border border-purple-500/20 bg-purple-500/[0.05] px-4 py-3">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-[10px] uppercase tracking-widest text-purple-200/70 font-bold">Codex Timeline Mode</div>
            <div class="text-[11px] text-white/45 mt-1">${fmtN(summary.sessions || 0)}세션 · ${fmtN(summary.total || 0)}이벤트</div>
          </div>
        </div>
      </div>
      <div class="grid gap-3 lg:grid-cols-[280px_1fr]">
        <div class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
          <div class="text-[10px] uppercase tracking-widest text-white/35 font-bold">세션</div>
          <div class="mt-3 space-y-2">
            ${sessions.map((row) => `
              <button class="w-full text-left rounded-xl border border-white/[0.05] bg-black/20 px-3 py-2 spring hover:border-purple-500/25"
                      data-action="openSessionReplay" data-arg0="${esc(row.session_id)}" data-arg1="${esc(row.session_title || row.session_id)}">
                <div class="text-[11px] font-semibold text-white/75 truncate">${esc(row.session_title || row.session_id)}</div>
                <div class="text-[10px] text-white/35 mt-1">${esc(row.project_name || '—')} · ${fmtN(row.event_count || 0)} events</div>
              </button>
            `).join('')}
          </div>
        </div>
        <div class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
          <div class="text-[10px] uppercase tracking-widest text-white/35 font-bold">이벤트 스트림</div>
          <div class="mt-3 space-y-2">
            ${items.map((item) => `
              <article class="rounded-xl border border-white/[0.05] bg-black/20 px-3 py-3">
                <div class="flex items-center justify-between gap-3 text-[10px] text-white/35">
                  <span class="font-bold uppercase tracking-widest">${esc(item.kind || 'event')}</span>
                  <span>${esc(item.timestamp || '')}</span>
                </div>
                <div class="mt-1 text-sm text-white/80 font-semibold">${esc(item.label || item.session_title || item.session_id || 'event')}</div>
                <div class="mt-1 text-[11px] text-white/45">${esc(item.project_name || '')} · ${esc(item.session_title || item.session_id || '')}</div>
                <p class="mt-2 text-[12px] leading-relaxed text-white/65 whitespace-pre-wrap">${esc(item.body_text || '')}</p>
              </article>
            `).join('')}
          </div>
        </div>
      </div>
    </div>`;
  legend.innerHTML = '<span class="text-purple-200/70">Codex mode active</span>';
}

async function _loadCodexTimelineSummary() {
  const legend = document.getElementById('timelineLegend');
  if (!legend) return;
  try {
    const summary = await safeFetch('/api/timeline/summary?limit=12');
    const items = summary.items || [];
    if (!items.length) return;
    const strip = document.createElement('div');
    strip.className = 'mb-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2';
    strip.dataset.codexTimelineSummary = 'true';
    strip.innerHTML = `
      <div class="flex items-center justify-between gap-3 text-[10px] uppercase tracking-widest text-white/35">
        <span>Codex Timeline</span>
        <span>${fmtN(summary.sessions || 0)} sessions · ${fmtN(summary.total || 0)} events</span>
      </div>
      <div class="mt-2 grid gap-2">
        ${items.slice(0, 4).map((item) => `
          <div class="flex items-start justify-between gap-3 text-[11px]">
            <div class="min-w-0">
              <div class="font-semibold text-white/70">${esc(item.label || item.kind || 'event')}</div>
              <div class="text-white/40 truncate">${esc(item.body_text || item.session_title || item.session_id || '')}</div>
            </div>
            <div class="shrink-0 text-white/25">${esc(item.kind || '')}</div>
          </div>
        `).join('')}
      </div>
    `;
    legend.prepend(strip);
  } catch (e) {
    reportError('loadCodexTimelineSummary', e);
  }
}

function _daysAgo(base, n) {
  const d = new Date(base);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function _tlDates() {
  const customFrom = document.getElementById('tlDateFrom')?.value;
  const customTo = document.getElementById('tlDateTo')?.value;
  if (customFrom && customTo) return { dateFrom: customFrom, dateTo: customTo };
  const now = new Date();
  const dateTo = now.toISOString().slice(0, 10);
  let dateFrom;
  if (_tlRange === 'today') dateFrom = dateTo;
  else if (_tlRange === '14d') dateFrom = _daysAgo(now, 14);
  else if (_tlRange === '30d') dateFrom = _daysAgo(now, 30);
  else dateFrom = _daysAgo(now, 7);
  return { dateFrom, dateTo };
}

// Compute $/hr outliers (projects where cost_per_hour > mean + 2σ).
// Also flags individual sessions within those projects whose cost > project mean.
function _computeOutliers(data) {
  _tlOutlierIds = new Set();
  _tlOutlierProjs = new Set();
  const sessions = data.sessions || [];
  if (sessions.length < 3) return;
  const byProj = new Map();
  for (const s of sessions) {
    const k = s.project_name || '(unknown)';
    if (!byProj.has(k)) byProj.set(k, []);
    byProj.get(k).push(s);
  }
  const perHrVals = [];
  const projStats = [];
  for (const [name, list] of byProj) {
    const totalCost = list.reduce((a, x) => a + (x.cost_usd || 0), 0);
    const totalDur = list.reduce((a, x) => a + (x.duration_seconds || 0), 0);
    if (totalDur < 300) continue; // skip near-zero-duration projects
    const perHr = totalCost / (totalDur / 3600);
    perHrVals.push(perHr);
    projStats.push({ name, perHr, list });
  }
  if (perHrVals.length < 3) return;
  const mean = perHrVals.reduce((a, b) => a + b, 0) / perHrVals.length;
  const variance = perHrVals.reduce((a, v) => a + (v - mean) ** 2, 0) / perHrVals.length;
  const std = Math.sqrt(variance);
  const threshold = mean + 2 * std;
  for (const p of projStats) {
    if (p.perHr > threshold && p.perHr > 5) { // need meaningful absolute $/hr too
      _tlOutlierProjs.add(p.name);
      // within project, flag top-cost sessions that drove the excess
      const projMean = p.list.reduce((a, x) => a + (x.cost_usd || 0), 0) / p.list.length;
      for (const s of p.list) {
        if ((s.cost_usd || 0) > projMean * 1.5 && (s.cost_usd || 0) > 0.5) _tlOutlierIds.add(s.id);
      }
    }
  }
}

function _modelFamily(model) {
  if (!model) return '_default';
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return '_default';
}

// ─── Main loader ─────────────────────────────────────────────────────────
async function loadTimeline() {
  const summary = await safeFetch('/api/timeline/summary?limit=40').catch((e) => {
    reportError('loadCodexTimelineSummary', e);
    return { items: [], total: 0, sessions: 0, session_summaries: [] };
  });
  const hasCodexData = (summary.items || []).length > 0;
  _ensureTimelineModeControls(hasCodexData);
  const resolvedMode = codexTimelineMode === 'auto'
    ? (hasCodexData ? 'codex' : 'legacy')
    : codexTimelineMode;
  if (resolvedMode === 'codex' && hasCodexData) {
    _tlLastData = { codex: summary };
    renderCodexTimelineMode(summary);
    reportSuccess('loadTimeline');
    return;
  }
  const legend = document.getElementById('timelineLegend');
  if (legend) {
    legend.querySelectorAll('[data-codex-timeline-summary]').forEach((el) => el.remove());
  }
  await _loadCodexTimelineSummary();
  const { dateFrom, dateTo } = _tlDates();
  const showSubs = document.getElementById('tlShowSubagents')?.checked || false;
  const nodeVal = document.getElementById('tlNodeFilter')?.value || '';
  let url = `/api/timeline?date_from=${encodeURIComponent(dateFrom)}&date_to=${encodeURIComponent(dateTo)}&include_subagents=${showSubs}`;
  if (nodeVal) url += '&node=' + encodeURIComponent(nodeVal);
  _populateTlNodeFilter();
  try {
    const data = await safeFetch(url);
    _tlLastData = { data, dateFrom, dateTo };
    _computeOutliers(data);
    _renderTimelineChart(data, dateFrom, dateTo);
    _renderEfficiency(data);
    reportSuccess('loadTimeline');
  } catch (e) {
    _tlLastData = null;
    reportError('loadTimeline', e);
  }
  _loadHeatmap();
  _loadTrend();
  _loadHourlyStacked();
  _loadDelta();
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. GANTT CHART
// ═══════════════════════════════════════════════════════════════════════════

function _renderTimelineChart(data, dateFrom, dateTo) {
  const sessions = data.sessions || [];
  const tzOffsetMs = (data.timezone_offset || 0) * 3600000;

  const projectMap = new Map();
  for (const s of sessions) {
    const key = s.project_name || '(unknown)';
    if (!projectMap.has(key)) projectMap.set(key, []);
    projectMap.get(key).push(s);
  }

  const projects = [...projectMap.entries()]
    .sort((a, b) => {
      const costA = a[1].reduce((sum, x) => sum + (x.cost_usd || 0), 0);
      const costB = b[1].reduce((sum, x) => sum + (x.cost_usd || 0), 0);
      return costB - costA;
    })
    .map(([name]) => name);

  if (!projects.length) { _renderEmptyTimeline(); return; }

  const visibleProjects = projects.filter(p => !_tlCollapsed.has(p));
  const collapsedCount = projects.length - visibleProjects.length;

  const barData = [], barMeta = [], barBg = [], barBorder = [], barBorderW = [];
  const costTimeline = [];
  let cumulCost = 0;

  const allSorted = [...sessions]
    .filter(s => !_tlCollapsed.has(s.project_name || '(unknown)'))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  for (const s of allSorted) {
    cumulCost += (s.cost_usd || 0);
    costTimeline.push({ x: new Date(s.created_at).getTime() + tzOffsetMs, y: cumulCost });
  }

  const maxCost = Math.max(...sessions.map(s => s.cost_usd || 0), 0.01);

  for (const proj of visibleProjects) {
    const sorted = [...(projectMap.get(proj) || [])].sort((a, b) =>
      new Date(a.created_at) - new Date(b.created_at));
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i];
      const start = new Date(s.created_at).getTime() + tzOffsetMs;
      const end = new Date(s.updated_at).getTime() + tzOffsetMs;
      if (isNaN(start) || isNaN(end) || end <= start) continue;
      const adjustedEnd = Math.max(end, start + 120000);

      if (i > 0) {
        const prevEnd = new Date(sorted[i - 1].updated_at).getTime() + tzOffsetMs;
        const gapMs = start - prevEnd;
        if (gapMs > 1800000) {
          barData.push({ x: [prevEnd, start], y: proj });
          barMeta.push({ _isGap: true, gapMs });
          barBg.push('rgba(255,255,255,0.03)');
          barBorder.push('rgba(255,255,255,0.06)');
          barBorderW.push(1);
        }
      }

      barData.push({ x: [start, adjustedEnd], y: proj });
      barMeta.push(s);
      const family = s.is_subagent ? '_sub' : _modelFamily(s.model);
      const palette = MODEL_COLORS[family] || MODEL_COLORS._default;
      const intensity = Math.min(1, (s.cost_usd || 0) / maxCost);
      const alpha = (0.3 + intensity * 0.5).toFixed(2);
      barBg.push(palette.bg.replace('A', alpha));
      const showOutliers = document.getElementById('tlShowOutliers')?.checked;
      if (showOutliers && _tlOutlierIds.has(s.id)) {
        barBorder.push('rgba(251,113,133,0.95)'); // rose-400 — outlier
        barBorderW.push(2.5);
      } else {
        barBorder.push(palette.border);
        barBorderW.push(1);
      }
    }
  }

  const canvas = document.getElementById('chartTimeline');
  const wrap = document.getElementById('timelineChartWrap');
  wrap.style.height = Math.max(200, visibleProjects.length * 36 + 80) + 'px';
  wrap.querySelectorAll('.tl-empty-msg').forEach(n => n.remove());

  const rangeMin = new Date(dateFrom + 'T00:00:00').getTime() + tzOffsetMs;
  const rangeMax = new Date(dateTo + 'T23:59:59').getTime() + tzOffsetMs;
  const rangeDays = (rangeMax - rangeMin) / 86400000;
  const timeUnit = rangeDays <= 1 ? 'hour' : rangeDays <= 14 ? 'day' : 'week';

  const concurrentZones = _findConcurrentZones(sessions, tzOffsetMs, visibleProjects, projectMap);

  destroyChart('timeline');

  const tc = themeColors();
  const resetBtn = document.getElementById('tlResetZoom');

  const datasets = [{
    type: 'bar', label: 'Sessions', data: barData,
    backgroundColor: barBg, borderColor: barBorder,
    borderWidth: barBorderW, borderRadius: 3, borderSkipped: false,
    barPercentage: 0.7, categoryPercentage: 0.85, yAxisID: 'y', xAxisID: 'x',
  }];

  if (costTimeline.length > 1) {
    datasets.push({
      type: 'line', label: '\uB204\uC801 \uBE44\uC6A9', data: costTimeline,
      borderColor: 'rgba(251,191,36,0.5)', backgroundColor: 'rgba(251,191,36,0.05)',
      fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5, borderDash: [4, 2],
      yAxisID: 'yCost', xAxisID: 'x',
    });
  }

  setChart('timeline', new Chart(canvas, {
    data: { labels: visibleProjects, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: _prefersReducedMotion ? 0 : 350 },
      indexAxis: 'y',
      scales: {
        x: {
          type: 'time', min: rangeMin, max: rangeMax,
          time: { unit: timeUnit, displayFormats: { hour: 'HH:mm', day: 'MM/dd', week: 'MM/dd' } },
          grid: { color: tc.gridColor, drawBorder: false },
          ticks: { color: tc.tickColor, font: { size: 11, family: 'Pretendard' }, maxTicksLimit: 12, maxRotation: 0 },
        },
        y: {
          type: 'category', labels: visibleProjects,
          grid: { color: tc.gridColor, drawBorder: false },
          ticks: {
            color: (ctx) => _projColorByName(ctx.tick?.label || visibleProjects[ctx.index] || '', 0.95),
            font: { size: 11, family: 'Pretendard', weight: 'bold' }, autoSkip: false,
          },
        },
        yCost: {
          type: 'linear', position: 'right', display: costTimeline.length > 1,
          grid: { drawOnChartArea: false },
          ticks: { color: 'rgba(251,191,36,0.5)', font: { size: 10, family: 'Pretendard' }, callback: v => '$' + v.toFixed(2) },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipOpts(),
          filter: (item) => item.datasetIndex === 0 && barMeta[item.dataIndex] && !barMeta[item.dataIndex]._isGap,
          callbacks: {
            title: (items) => { const m = barMeta[items[0]?.dataIndex]; return m ? (m.project_name || '') : ''; },
            label: (ctx) => {
              const s = barMeta[ctx.dataIndex];
              if (!s || s._isGap) return '';
              const node = s.source_node && s.source_node !== 'local' ? ` [${s.source_node}]` : '';
              return ` ${fmtDurationSec(s.duration_seconds||0)} \u00b7 ${fmt$(s.cost_usd)} \u00b7 ${s.model?shortModel(s.model):'\u2014'}${s.is_subagent?' [sub]':''}${node}`;
            },
            afterLabel: (ctx) => { const s = barMeta[ctx.dataIndex]; return s && !s._isGap ? ` ${fmtTime(s.created_at)} ~ ${fmtTime(s.updated_at)}` : ''; },
          },
        },
        zoom: {
          pan: { enabled: true, mode: 'x', onPanComplete: () => { if (resetBtn) resetBtn.classList.remove('hidden'); } },
          zoom: {
            wheel: { enabled: true, modifierKey: 'ctrl' },
            pinch: { enabled: true },
            drag: { enabled: true, backgroundColor: 'rgba(52,211,153,0.08)', borderColor: 'rgba(52,211,153,0.3)', borderWidth: 1 },
            mode: 'x',
            onZoomComplete: () => { if (resetBtn) resetBtn.classList.remove('hidden'); },
          },
        },
      },
      onClick: (_evt, elements) => {
        if (!elements.length || elements[0].datasetIndex !== 0) return;
        const s = barMeta[elements[0].index];
        if (s && !s._isGap) openConversation(s.id, s);
      },
      onHover: (evt, elements) => _handleHoverCard(evt, elements, barMeta),
    },
    plugins: [{
      id: 'concurrentZones',
      beforeDraw: (chart) => {
        if (!concurrentZones.length) return;
        const { ctx } = chart;
        const xScale = chart.scales.x;
        const area = chart.chartArea;
        ctx.save();
        ctx.fillStyle = 'rgba(251,191,36,0.04)';
        for (const z of concurrentZones) {
          const x1 = xScale.getPixelForValue(z.start);
          const x2 = xScale.getPixelForValue(z.end);
          if (x2 < area.left || x1 > area.right) continue;
          ctx.fillRect(Math.max(x1, area.left), area.top, Math.min(x2, area.right) - Math.max(x1, area.left), area.bottom - area.top);
        }
        ctx.restore();
      },
    }, {
      id: 'parentChildLinks',
      afterDatasetsDraw: (chart) => _drawParentLinks(chart, barMeta),
    }],
  }));

  _renderTimelineLegend(sessions, data.truncated, projects.length, collapsedCount, concurrentZones.length);
}

// ─── Hover detail card ───────────────────────────────────────────────────
function _handleHoverCard(evt, elements, barMeta) {
  const card = document.getElementById('tlHoverCard');
  if (!card) return;
  if (!elements.length || elements[0].datasetIndex !== 0) { card.classList.add('hidden'); return; }
  const s = barMeta[elements[0].index];
  if (!s || s._isGap) { card.classList.add('hidden'); return; }

  card.textContent = '';
  const title = document.createElement('div');
  title.className = 'font-bold text-white/90 mb-1 truncate';
  title.textContent = s.project_name || '';
  const details = document.createElement('div');
  details.className = 'text-white/60 space-y-0.5';
  [
    fmtTime(s.created_at) + ' ~ ' + fmtTime(s.updated_at),
    '\uC18C\uC694: ' + fmtDurationSec(s.duration_seconds || 0),
    '\uBE44\uC6A9: ' + fmt$(s.cost_usd) + ' \u00b7 \uBAA8\uB378: ' + (s.model ? shortModel(s.model) : '\u2014'),
  ].forEach(l => { const r = document.createElement('div'); r.textContent = l; details.appendChild(r); });
  if (s.is_subagent) { const sb = document.createElement('div'); sb.textContent = 'Subagent'; sb.className = 'text-blue-300/70'; details.appendChild(sb); }
  if (s.source_node && s.source_node !== 'local') { const nd = document.createElement('div'); nd.textContent = '\uB178\uB4DC: ' + s.source_node; nd.className = 'text-cyan-300/70'; details.appendChild(nd); }
  const hint = document.createElement('div');
  hint.className = 'text-white/25 mt-1.5 text-[9px]';
  hint.textContent = '\uD074\uB9AD\uD558\uC5EC \uB300\uD654 \uC5F4\uAE30';
  card.append(title, details, hint);

  const rect = evt.chart.canvas.getBoundingClientRect();
  let left = rect.left + evt.x + 16;
  let top = rect.top + evt.y - 20;
  if (left + 288 > window.innerWidth) left = rect.left + evt.x - 300;
  if (top + 140 > window.innerHeight) top = window.innerHeight - 150;
  card.style.left = Math.max(0, left) + 'px';
  card.style.top = Math.max(0, top) + 'px';
  card.classList.remove('hidden');
}

// ─── Parent → child (subagent) link arrows ───────────────────────────────
// Draws a subtle curved line from each subagent bar's left edge back to its
// parent session's right edge. Parent must also be visible in the current
// projection (same range, same project not collapsed).
function _drawParentLinks(chart, barMeta) {
  const enabled = document.getElementById('tlShowLinks')?.checked;
  if (!enabled) return;
  const dsMeta = chart.getDatasetMeta(0);
  if (!dsMeta || !dsMeta.data) return;

  // Build lookup: session_id → datapoint index (only real sessions, not gaps)
  const idToIdx = new Map();
  for (let i = 0; i < barMeta.length; i++) {
    const m = barMeta[i];
    if (m && !m._isGap && m.id) idToIdx.set(m.id, i);
  }

  const { ctx, chartArea } = chart;
  ctx.save();
  ctx.strokeStyle = 'rgba(96,165,250,0.45)';  // sky-ish blue
  ctx.fillStyle = 'rgba(96,165,250,0.55)';
  ctx.lineWidth = 1;

  let drawn = 0;
  for (let i = 0; i < barMeta.length; i++) {
    const child = barMeta[i];
    if (!child || child._isGap || !child.is_subagent || !child.parent_session_id) continue;
    const pIdx = idToIdx.get(child.parent_session_id);
    if (pIdx === undefined) continue;

    const parentEl = dsMeta.data[pIdx];
    const childEl = dsMeta.data[i];
    if (!parentEl || !childEl) continue;

    // Parent bar right edge, child bar left edge (horizontal bars)
    const pr = parentEl.getProps(['x', 'y', 'width', 'height', 'base'], false);
    const cr = childEl.getProps(['x', 'y', 'width', 'height', 'base'], false);
    // For horizontal bars: x is the *end* (right edge), base is the *start*
    const px = pr.x;  // parent right edge
    const py = pr.y;
    const cx = cr.base; // child left edge
    const cy = cr.y;

    // Clip to chart area
    if (px < chartArea.left || cx > chartArea.right) continue;
    if (Math.abs(cx - px) < 2 && Math.abs(cy - py) < 2) continue;

    // Curved connector: horizontal offset controls curvature
    const dx = Math.max(18, Math.min(80, Math.abs(cx - px) * 0.4));
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.bezierCurveTo(px + dx, py, cx - dx, cy, cx, cy);
    ctx.stroke();

    // Small arrowhead at child side
    const ah = 4;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx - ah, cy - ah * 0.6);
    ctx.lineTo(cx - ah, cy + ah * 0.6);
    ctx.closePath();
    ctx.fill();
    drawn++;
    if (drawn > 300) break; // safety cap
  }
  ctx.restore();
}

// ─── Concurrent work detection ───────────────────────────────────────────
function _findConcurrentZones(sessions, tzOffsetMs, visibleProjects, projectMap) {
  const intervals = [];
  for (const proj of visibleProjects) {
    for (const s of (projectMap.get(proj) || [])) {
      const start = new Date(s.created_at).getTime() + tzOffsetMs;
      const end = new Date(s.updated_at).getTime() + tzOffsetMs;
      if (!isNaN(start) && !isNaN(end) && end > start) intervals.push({ start, end, project: proj });
    }
  }
  intervals.sort((a, b) => a.start - b.start);
  const zones = [];
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length; j++) {
      if (intervals[j].start >= intervals[i].end) break;
      if (intervals[j].project === intervals[i].project) continue;
      const os = intervals[j].start, oe = Math.min(intervals[i].end, intervals[j].end);
      const last = zones[zones.length - 1];
      if (last && os <= last.end) last.end = Math.max(last.end, oe);
      else zones.push({ start: os, end: oe });
    }
  }
  return zones;
}

// ─── Project collapse/expand ─────────────────────────────────────────────
function _toggleProjectCollapse(projectName) {
  if (_tlCollapsed.has(projectName)) _tlCollapsed.delete(projectName);
  else _tlCollapsed.add(projectName);
  savePrefs({ tlCollapsed: [..._tlCollapsed] });
  if (_tlLastData) {
    _computeOutliers(_tlLastData.data);
    _renderTimelineChart(_tlLastData.data, _tlLastData.dateFrom, _tlLastData.dateTo);
    _renderEfficiency(_tlLastData.data);
  }
}
function _expandAll() {
  _tlCollapsed.clear();
  savePrefs({ tlCollapsed: [] });
  if (_tlLastData) {
    _computeOutliers(_tlLastData.data);
    _renderTimelineChart(_tlLastData.data, _tlLastData.dateFrom, _tlLastData.dateTo);
    _renderEfficiency(_tlLastData.data);
  }
}

// ─── Empty state ─────────────────────────────────────────────────────────
function _renderEmptyTimeline() {
  destroyChart('timeline');
  const wrap = document.getElementById('timelineChartWrap');
  wrap.style.height = '200px';
  document.getElementById('timelineLegend').textContent = '';
  const canvas = document.getElementById('chartTimeline');
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  wrap.querySelectorAll('.tl-empty-msg').forEach(n => n.remove());
  const info = document.createElement('div');
  info.className = 'tl-empty-msg absolute inset-0 flex items-center justify-center text-white/25 text-xs';
  info.textContent = '\uC120\uD0DD\uD55C \uAE30\uAC04\uC5D0 \uC138\uC158 \uB370\uC774\uD130\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4';
  wrap.appendChild(info);
}

// ─── Legend ──────────────────────────────────────────────────────────────
function _renderTimelineLegend(sessions, truncated, totalProjects, collapsedCount, concurrentCount) {
  const el = document.getElementById('timelineLegend');
  if (!el) return;
  el.textContent = '';
  const totalCost = sessions.reduce((s, x) => s + (x.cost_usd || 0), 0);
  const subs = sessions.filter(s => s.is_subagent).length;

  const span = (text, cls) => { const s = document.createElement('span'); s.className = cls || ''; s.textContent = text; return s; };
  el.appendChild(span(fmtN(sessions.length) + '\uAC1C \uC138\uC158 \u00b7 ' + fmtN(totalProjects) + '\uAC1C \uD504\uB85C\uC81D\uD2B8 \u00b7 ' + fmt$(totalCost)));
  if (subs > 0) el.appendChild(span('(subagent ' + fmtN(subs) + ')', 'text-blue-300/60'));
  if (concurrentCount > 0) el.appendChild(span('\u26A1 \uB3D9\uC2DC\uC791\uC5C5 ' + fmtN(concurrentCount) + '\uAD6C\uAC04', 'text-amber-300/60'));
  const showOutliers = document.getElementById('tlShowOutliers')?.checked;
  if (showOutliers && _tlOutlierProjs.size > 0) {
    el.appendChild(span('\u26A0 \uC774\uC0C1\uCE58 \uD504\uB85C\uC81D\uD2B8 ' + fmtN(_tlOutlierProjs.size) + '\uAC1C', 'text-rose-300/70 font-bold'));
  }
  if (truncated) el.appendChild(span('(\uBC94\uC704 \uCD08\uACFC \u2014 \uC77C\uBD80\uB9CC \uD45C\uC2DC)', 'text-amber-400/60 font-bold'));
  if (collapsedCount > 0) {
    const btn = document.createElement('button');
    btn.className = 'text-accent/70 hover:text-accent spring font-bold';
    btn.textContent = fmtN(collapsedCount) + '\uAC1C \uC811\uD798 \u2014 \uBAA8\uB450 \uD3BC\uCE58\uAE30';
    btn.addEventListener('click', _expandAll);
    el.appendChild(btn);
  }
  const mkLeg = (color, label) => {
    const w = document.createElement('span'); w.className = 'flex items-center gap-1';
    const dot = document.createElement('span'); dot.className = 'w-2.5 h-2.5 rounded-sm'; dot.style.background = color;
    const txt = document.createElement('span'); txt.textContent = label;
    w.append(dot, txt); return w;
  };
  el.append(mkLeg('rgba(167,139,250,.6)','Opus'), mkLeg('rgba(52,211,153,.6)','Sonnet'), mkLeg('rgba(34,211,238,.6)','Haiku'),
    mkLeg('rgba(96,165,250,.6)','Subagent'), mkLeg('rgba(255,255,255,.06)','\uD734\uC2DD'), mkLeg('rgba(251,191,36,.15)','\uB3D9\uC2DC\uC791\uC5C5'));
  el.appendChild(span('Ctrl+\uD718\uC77C=\uC90C \u00b7 \uB4DC\uB798\uADF8=\uBC94\uC704 \u00b7 \uD074\uB9AD=\uB300\uD654', 'text-white/20 ml-auto'));
}


// ═══════════════════════════════════════════════════════════════════════════
// 2. DAY x HOUR HEATMAP
// ═══════════════════════════════════════════════════════════════════════════

async function _loadHeatmap() {
  const wrap = document.getElementById('tlHeatmapWrap');
  if (!wrap) return;
  try {
    const d = await safeFetch('/api/timeline/heatmap?days=90');
    _renderHeatmap(d, wrap);
  } catch (e) {
    wrap.textContent = '';
    const err = document.createElement('div'); err.className = 'text-center text-red-400/60 text-xs py-4';
    err.textContent = '\uD788\uD2B8\uB9F5 \uB85C\uB4DC \uC2E4\uD328'; wrap.appendChild(err);
  }
}

function _renderHeatmap(data, wrap) {
  const cells = data.cells || {};
  let maxCount = 1;
  for (const v of Object.values(cells)) { if (v.count > maxCount) maxCount = v.count; }

  wrap.textContent = '';
  const table = document.createElement('table');
  table.className = 'w-full text-[10px] border-collapse';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  const corner = document.createElement('th'); corner.className = 'px-1 py-1'; htr.appendChild(corner);
  for (let hr = 0; hr < 24; hr++) {
    const th = document.createElement('th');
    th.className = 'px-0.5 py-1 text-white/25 font-normal text-center';
    th.textContent = String(hr).padStart(2, '0');
    htr.appendChild(th);
  }
  thead.appendChild(htr); table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (let dow = 0; dow < 7; dow++) {
    const tr = document.createElement('tr');
    const th = document.createElement('th'); th.className = 'px-1 py-1 text-white/40 font-bold text-right'; th.textContent = DOW_LABELS[dow]; tr.appendChild(th);
    for (let hr = 0; hr < 24; hr++) {
      const td = document.createElement('td'); td.className = 'p-0.5';
      const cell = cells[dow + '_' + hr];
      const count = cell ? cell.count : 0;
      const cost = cell ? cell.cost : 0;
      const inner = document.createElement('div');
      inner.className = 'w-full rounded-sm'; inner.style.height = '18px'; inner.style.minWidth = '14px';
      if (count > 0) {
        inner.style.background = 'rgba(52,211,153,' + (0.1 + (count / maxCount) * 0.7).toFixed(2) + ')';
        inner.title = DOW_LABELS[dow] + ' ' + hr + '\uC2DC: ' + fmtN(count) + '\uAC74, ' + fmt$(cost);
        inner.style.cursor = 'pointer';
        inner.addEventListener('click', ((d, h) => () => _heatmapDrillDown(d, h))(dow, hr));
        inner.setAttribute('tabindex', '0');
        inner.setAttribute('role', 'button');
        inner.addEventListener('keydown', ((d, h) => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _heatmapDrillDown(d, h); } })(dow, hr));
      } else {
        inner.style.background = 'rgba(255,255,255,0.02)';
      }
      td.appendChild(inner); tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody); wrap.appendChild(table);
}


// ═══════════════════════════════════════════════════════════════════════════
// 3. EFFICIENCY ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

function _renderEfficiency(data) {
  const el = document.getElementById('tlEfficiency');
  if (!el) return;
  const sessions = data.sessions || [];
  if (!sessions.length) {
    el.textContent = '';
    const empty = document.createElement('div'); empty.className = 'text-center text-white/15 text-xs py-6'; empty.textContent = '\uB370\uC774\uD130 \uC5C6\uC74C'; el.appendChild(empty); return;
  }
  const projectMap = new Map();
  for (const s of sessions) { const k = s.project_name || '(unknown)'; if (!projectMap.has(k)) projectMap.set(k, []); projectMap.get(k).push(s); }

  const rows = [...projectMap.entries()].map(([name, list]) => {
    const totalCost = list.reduce((s, x) => s + (x.cost_usd || 0), 0);
    const totalDur = list.reduce((s, x) => s + (x.duration_seconds || 0), 0);
    const durHr = totalDur / 3600;
    const perHr = durHr > 0 ? totalCost / durHr : 0;
    const earliest = Math.min(...list.map(s => new Date(s.created_at).getTime()));
    const latest = Math.max(...list.map(s => new Date(s.updated_at).getTime()));
    const spanSec = (latest - earliest) / 1000;
    const activeRatio = spanSec > 0 ? Math.min(1, totalDur / spanSec) : 0;
    return { name, totalCost, totalDur, perHr, sessionCount: list.length, activeRatio };
  }).sort((a, b) => b.totalCost - a.totalCost);

  el.textContent = '';
  const table = document.createElement('table'); table.className = 'w-full text-[11px]';

  // Build thead with DOM API (no innerHTML)
  const thead = document.createElement('thead');
  const headTr = document.createElement('tr');
  headTr.className = 'text-[9px] text-white/30 uppercase tracking-widest border-b border-white/[0.05]';
  ['\uD504\uB85C\uC81D\uD2B8', '\uC138\uC158', '\uBE44\uC6A9', '$/hr', '\uD65C\uC131\uBE44', ''].forEach((label, i) => {
    const th = document.createElement('th');
    th.className = (i === 0 ? 'text-left' : i < 5 ? 'text-right' : 'text-center') + ' px-2 py-1.5 font-bold' + (i === 5 ? ' w-8' : '');
    th.textContent = label;
    headTr.appendChild(th);
  });
  thead.appendChild(headTr); table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const r of rows.slice(0, 15)) {
    const tr = document.createElement('tr'); tr.className = 'border-b border-white/[0.03] hover:bg-white/[0.03] spring';
    const mkTd = (text, cls) => { const td = document.createElement('td'); td.className = cls; td.textContent = text; return td; };
    const nameCell = document.createElement('td');
    nameCell.className = 'px-2 py-1.5 font-semibold text-white/70 truncate max-w-[180px]';
    nameCell.title = r.name;
    nameCell.appendChild(_projDot(r.name));
    const isOutlier = _tlOutlierProjs.has(r.name) && document.getElementById('tlShowOutliers')?.checked;
    if (isOutlier) {
      const badge = document.createElement('span');
      badge.className = 'inline-block mr-1 px-1 rounded text-[9px] font-bold bg-rose-400/15 text-rose-300 align-middle';
      badge.textContent = '\u26A0';
      badge.title = '$/hr 평균 + 2σ 초과';
      nameCell.appendChild(badge);
    }
    const nameText = document.createElement('span'); nameText.textContent = r.name;
    nameCell.appendChild(nameText);
    tr.appendChild(nameCell);
    tr.appendChild(mkTd(fmtN(r.sessionCount), 'px-2 py-1.5 text-right text-white/50 tabular-nums'));
    tr.appendChild(mkTd(fmt$(r.totalCost), 'px-2 py-1.5 text-right text-amber-400/80 font-bold tabular-nums'));
    const perHrCls = 'px-2 py-1.5 text-right tabular-nums ' + (r.perHr > 50 ? 'text-red-400/80 font-bold' : r.perHr > 20 ? 'text-amber-400/70' : 'text-emerald-400/70');
    tr.appendChild(mkTd(r.totalDur > 0 ? fmt$(r.perHr) : '\u2014', perHrCls));

    // Active ratio bar
    const ratioTd = document.createElement('td'); ratioTd.className = 'px-2 py-1.5 text-right';
    const pct = Math.round(r.activeRatio * 100);
    const barWrap = document.createElement('div'); barWrap.className = 'flex items-center gap-1 justify-end';
    const barBg = document.createElement('div'); barBg.className = 'w-12 h-1.5 bg-white/5 rounded-full overflow-hidden';
    const barFill = document.createElement('div'); barFill.className = 'h-full rounded-full';
    barFill.style.width = pct + '%';
    barFill.style.background = pct > 60 ? '#34d399' : pct > 30 ? '#fbbf24' : '#fb7185';
    barBg.appendChild(barFill);
    const pctLabel = document.createElement('span'); pctLabel.className = 'text-[9px] text-white/40 tabular-nums w-7 text-right'; pctLabel.textContent = pct + '%';
    barWrap.append(barBg, pctLabel); ratioTd.appendChild(barWrap); tr.appendChild(ratioTd);

    const colTd = document.createElement('td'); colTd.className = 'px-1 py-1.5 text-center';
    const colBtn = document.createElement('button'); colBtn.className = 'text-white/20 hover:text-white/50 spring text-[10px]';
    colBtn.textContent = _tlCollapsed.has(r.name) ? '\u25B6' : '\u25BC';
    colBtn.title = _tlCollapsed.has(r.name) ? '\uD3BC\uCE58\uAE30' : '\uC811\uAE30';
    colBtn.addEventListener('click', () => _toggleProjectCollapse(r.name));
    colTd.appendChild(colBtn); tr.appendChild(colTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody); el.appendChild(table);
}


// ═══════════════════════════════════════════════════════════════════════════
// 4. DAILY REPORT  +  (A) HOURLY ACCORDION
// ═══════════════════════════════════════════════════════════════════════════

// Shared project colour palette for stacked chart & accordion
const _PROJ_PALETTE = [
  'rgba(52,211,153,A)',  'rgba(167,139,250,A)', 'rgba(34,211,238,A)',
  'rgba(251,191,36,A)',  'rgba(244,114,182,A)', 'rgba(96,165,250,A)',
  'rgba(248,113,113,A)', 'rgba(163,230,53,A)',  'rgba(232,121,249,A)',
  'rgba(45,212,191,A)',  'rgba(253,186,116,A)', 'rgba(129,140,248,A)',
];
function _projColor(idx, alpha) { return (_PROJ_PALETTE[idx % _PROJ_PALETTE.length]).replace('A', String(alpha ?? 0.6)); }
// Deterministic project → palette color. Same name always maps to same slot
// regardless of current sort order, so users learn the color=project association
// once and it stays stable across views (Gantt y-axis, efficiency, delta, hourly).
function _projColorByName(name, alpha) {
  let h = 0;
  const s = name || '';
  for (let i = 0; i < s.length; i++) h = (h * 131 + s.charCodeAt(i)) >>> 0;
  return _PROJ_PALETTE[h % _PROJ_PALETTE.length].replace('A', String(alpha ?? 0.85));
}
// Small colored dot element for table labels.
function _projDot(name, size) {
  const d = document.createElement('span');
  d.className = 'inline-block rounded-sm align-middle mr-1.5 flex-shrink-0';
  const px = size || 8;
  d.style.width = px + 'px';
  d.style.height = px + 'px';
  d.style.background = _projColorByName(name, 0.9);
  return d;
}
let _hourlyCache = {};
const _HOURLY_CACHE_MAX = 10;

async function _fetchHourly(dateStr) {
  if (_hourlyCache[dateStr]) return _hourlyCache[dateStr];
  const d = await safeFetch('/api/timeline/hourly?date=' + encodeURIComponent(dateStr));
  // LRU eviction: drop oldest entries when cache exceeds max
  const keys = Object.keys(_hourlyCache);
  while (keys.length >= _HOURLY_CACHE_MAX) {
    delete _hourlyCache[keys.shift()];
  }
  _hourlyCache[dateStr] = d;
  return d;
}

async function _loadDailyReport(dateStr) {
  const el = document.getElementById('tlDailyReport');
  if (!el || !dateStr) return;
  el.textContent = '';
  const loading = document.createElement('div'); loading.className = 'text-center text-white/15 text-xs py-4 dots'; loading.textContent = '\uB85C\uB529 \uC911'; el.appendChild(loading);
  try {
    const [d, hourlyData] = await Promise.all([
      safeFetch('/api/timeline?date_from=' + dateStr + '&date_to=' + dateStr),
      _fetchHourly(dateStr),
    ]);
    const sessions = d.sessions || [];
    el.textContent = '';
    if (!sessions.length) {
      const empty = document.createElement('div'); empty.className = 'text-center text-white/20 text-xs py-6'; empty.textContent = '\uD574\uB2F9 \uB0A0\uC9DC\uC5D0 \uC138\uC158\uC774 \uC5C6\uC2B5\uB2C8\uB2E4'; el.appendChild(empty); return;
    }
    const totalCost = sessions.reduce((s, x) => s + (x.cost_usd || 0), 0);
    const totalDur = sessions.reduce((s, x) => s + (x.duration_seconds || 0), 0);
    const projects = new Set(sessions.map(s => s.project_name));
    const grid = document.createElement('div'); grid.className = 'grid grid-cols-4 gap-2 mb-3';
    const mkCard = (label, value, cls) => {
      const c = document.createElement('div'); c.className = 'bg-white/[0.03] rounded-lg p-2 text-center';
      const v = document.createElement('div'); v.className = 'text-sm font-bold ' + (cls || 'text-white/80'); v.textContent = value;
      const l = document.createElement('div'); l.className = 'text-[9px] text-white/30 mt-0.5'; l.textContent = label;
      c.append(v, l); return c;
    };
    grid.append(mkCard('\uC138\uC158', fmtN(sessions.length)), mkCard('\uD504\uB85C\uC81D\uD2B8', fmtN(projects.size), 'text-cyan-400/80'),
      mkCard('\uBE44\uC6A9', fmt$(totalCost), 'text-amber-400/80'), mkCard('\uC18C\uC694\uC2DC\uAC04', fmtDurationSec(totalDur), 'text-emerald-400/80'));
    el.appendChild(grid);

    const projMap = new Map();
    for (const s of sessions) { const k = s.project_name || '(unknown)'; if (!projMap.has(k)) projMap.set(k, []); projMap.get(k).push(s); }
    const list = [...projMap.entries()].sort((a, b) => b[1].reduce((s, x) => s + (x.cost_usd||0), 0) - a[1].reduce((s, x) => s + (x.cost_usd||0), 0));
    for (const [name, ss] of list) {
      const cost = ss.reduce((s, x) => s + (x.cost_usd || 0), 0);
      const dur = ss.reduce((s, x) => s + (x.duration_seconds || 0), 0);
      const row = document.createElement('div'); row.className = 'flex items-center justify-between py-1.5 border-b border-white/[0.03] text-[11px]';
      const left = document.createElement('span'); left.className = 'text-white/65 font-semibold truncate flex items-center';
      left.appendChild(_projDot(name));
      const leftTxt = document.createElement('span'); leftTxt.textContent = name; left.appendChild(leftTxt);
      const right = document.createElement('span'); right.className = 'text-white/40 tabular-nums flex gap-3';
      const s1 = document.createElement('span'); s1.textContent = fmtN(ss.length) + '\uAC74';
      const s2 = document.createElement('span'); s2.className = 'text-amber-400/70'; s2.textContent = fmt$(cost);
      const s3 = document.createElement('span'); s3.textContent = fmtDurationSec(dur);
      right.append(s1, s2, s3);
      row.append(left, right); el.appendChild(row);
    }
    // ── (A) Hourly accordion ──
    _renderHourlyAccordion(el, hourlyData);
  } catch (e) {
    el.textContent = '';
    const err = document.createElement('div'); err.className = 'text-center text-red-400/60 text-xs py-4'; err.textContent = '\uB9AC\uD3EC\uD2B8 \uB85C\uB4DC \uC2E4\uD328'; el.appendChild(err);
  }
}

function _renderHourlyAccordion(container, hourlyData) {
  const hours = (hourlyData.hours || []).filter(h => h.message_count > 0);
  if (!hours.length) return;

  const section = document.createElement('div');
  section.className = 'mt-4 border-t border-white/[0.05] pt-3';
  const title = document.createElement('div');
  title.className = 'text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2';
  title.textContent = '\uC2DC\uAC04\uBCC4 \uC0C1\uC138 (' + hours.length + '\uAC1C \uC2DC\uAC04\uB300)';
  section.appendChild(title);

  for (const slot of hours) {
    const wrap = document.createElement('div');
    wrap.className = 'border-b border-white/[0.03]';
    const header = document.createElement('button');
    header.className = 'w-full flex items-center justify-between py-2 px-1 text-[11px] hover:bg-white/[0.02] spring group';
    const left = document.createElement('div');
    left.className = 'flex items-center gap-2';
    const arrow = document.createElement('span');
    arrow.className = 'text-white/20 text-[9px] spring group-hover:text-white/40';
    arrow.textContent = '\u25B6';
    const hourLabel = document.createElement('span');
    hourLabel.className = 'font-bold text-white/60 tabular-nums';
    hourLabel.textContent = slot.hour + ':00';
    const projCount = document.createElement('span');
    projCount.className = 'text-white/25 text-[9px]';
    const pNames = Object.keys(slot.projects);
    projCount.textContent = pNames.length + '\uAC1C \uD504\uB85C\uC81D\uD2B8';
    left.append(arrow, hourLabel, projCount);
    const right = document.createElement('div');
    right.className = 'flex items-center gap-3 text-white/40 tabular-nums';
    const msgSpan = document.createElement('span'); msgSpan.textContent = fmtN(slot.message_count) + '\uAC74';
    const costSpan = document.createElement('span'); costSpan.className = 'text-amber-400/70 font-bold'; costSpan.textContent = fmt$(slot.cost_usd);
    right.append(msgSpan, costSpan);
    header.append(left, right);

    const detail = document.createElement('div');
    detail.className = 'hidden pb-2 px-1';
    header.addEventListener('click', () => {
      const open = !detail.classList.contains('hidden');
      detail.classList.toggle('hidden');
      arrow.textContent = open ? '\u25B6' : '\u25BC';
    });

    for (const [pName, pData] of Object.entries(slot.projects)) {
      const pRow = document.createElement('div');
      pRow.className = 'flex items-center justify-between py-1 pl-5 text-[10px]';
      const pLeft = document.createElement('span');
      pLeft.className = 'text-white/50 truncate max-w-[150px] inline-flex items-center';
      pLeft.appendChild(_projDot(pName, 6));
      const pLeftTxt = document.createElement('span'); pLeftTxt.textContent = pName; pLeft.appendChild(pLeftTxt);
      pLeft.title = pName;
      const pRight = document.createElement('div');
      pRight.className = 'flex items-center gap-3 text-white/35 tabular-nums';
      const pm = document.createElement('span'); pm.textContent = fmtN(pData.session_count) + '\uC138\uC158';
      const pc = document.createElement('span'); pc.className = 'text-amber-400/60'; pc.textContent = fmt$(pData.cost_usd);
      const pt = document.createElement('span'); pt.className = 'text-white/25';
      pt.textContent = fmtN((pData.input_tokens || 0) + (pData.output_tokens || 0)) + ' tok';
      pRight.append(pm, pc, pt); pRow.append(pLeft, pRight); detail.appendChild(pRow);
    }

    if (slot.sessions.length) {
      const sesTitle = document.createElement('div');
      sesTitle.className = 'text-[9px] text-white/20 uppercase tracking-wider mt-1.5 mb-1 pl-5';
      sesTitle.textContent = '\uD65C\uC131 \uC138\uC158';
      detail.appendChild(sesTitle);
      for (const ses of slot.sessions.slice(0, 10)) {
        const sRow = document.createElement('div');
        sRow.className = 'flex items-center justify-between py-0.5 pl-5 text-[10px] hover:bg-white/[0.02] spring cursor-pointer rounded';
        sRow.addEventListener('click', () => openConversation(ses.session_id));
        const sLeft = document.createElement('div');
        sLeft.className = 'flex items-center gap-1.5 text-white/40 truncate';
        const sProj = document.createElement('span'); sProj.className = 'truncate max-w-[100px]'; sProj.textContent = ses.project_name;
        const sModel = document.createElement('span'); sModel.className = 'text-white/20 text-[9px]'; sModel.textContent = ses.model ? shortModel(ses.model) : '';
        sLeft.append(sProj, sModel);
        if (ses.is_subagent) { const sb = document.createElement('span'); sb.className = 'text-blue-300/50 text-[8px]'; sb.textContent = 'sub'; sLeft.appendChild(sb); }
        const sRight = document.createElement('span');
        sRight.className = 'text-amber-400/50 tabular-nums'; sRight.textContent = fmt$(ses.cost_usd);
        sRow.append(sLeft, sRight); detail.appendChild(sRow);
      }
      if (slot.sessions.length > 10) {
        const more = document.createElement('div');
        more.className = 'text-[9px] text-white/15 pl-5 mt-0.5';
        more.textContent = '+' + (slot.sessions.length - 10) + '\uAC1C \uC138\uC158 \uB354';
        detail.appendChild(more);
      }
    }
    wrap.append(header, detail); section.appendChild(wrap);
  }
  container.appendChild(section);
}


// ═════════════════════════��══════════════════════════════════���══════════════
// 5. TREND COMPARISON (this week vs last week)
// ═══════════════════════════════════════════════════════════════════════════

async function _loadTrend() {
  try {
    const now = new Date();
    const [thisW, lastW] = await Promise.all([
      safeFetch('/api/timeline?date_from=' + _daysAgo(now, 6) + '&date_to=' + now.toISOString().slice(0, 10)),
      safeFetch('/api/timeline?date_from=' + _daysAgo(now, 13) + '&date_to=' + _daysAgo(now, 7)),
    ]);
    _renderTrendChart(thisW, lastW);
  } catch (e) { console.error('trend:', e); }
}

function _renderTrendChart(thisWeekData, lastWeekData) {
  const aggregate = (data) => {
    const daily = new Array(7).fill(0);
    for (const s of (data.sessions || [])) { daily[new Date(s.created_at).getDay()] += (s.cost_usd || 0); }
    return [...daily.slice(1), daily[0]];
  };
  const thisData = aggregate(thisWeekData), lastData = aggregate(lastWeekData);
  const labels = ['\uC6D4', '\uD654', '\uC218', '\uBAA9', '\uAE08', '\uD1A0', '\uC77C'];

  destroyChart('trend');
  const canvas = document.getElementById('chartTrend');
  if (!canvas) return;
  const tc = themeColors();

  setChart('trend', new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [
      { label: '\uC774\uBC88 \uC8FC', data: thisData, backgroundColor: 'rgba(52,211,153,0.35)', borderColor: CC.emerald, borderWidth: 1, borderRadius: 3 },
      { label: '\uC800\uBC88 \uC8FC', data: lastData, backgroundColor: 'rgba(255,255,255,0.06)', borderColor: 'rgba(255,255,255,0.15)', borderWidth: 1, borderRadius: 3 },
    ]},
    options: {
      ...CHART_D,
      plugins: {
        legend: { display: true, position: 'top', align: 'end', labels: { color: tc.legendColor, boxWidth: 10, font: { size: 11, family: 'Pretendard' } } },
        tooltip: tooltipOpts({ callbacks: { label: c => ' ' + c.dataset.label + ': ' + fmt$(c.raw) } }),
      },
      scales: { x: { grid: grd(), ticks: tck() }, y: { grid: grd(), ticks: { ...tck(), callback: v => '$' + v.toFixed(2) } } },
    },
  }));
}


// ═══════════════════════════════════════════════════════════════════════════
// 5b. DELTA VIEW (yesterday → today per-project)
// ═══════════════════════════════════════════════════════════════════════════

function _aggByProject(sessions) {
  const m = new Map();
  for (const s of sessions || []) {
    const k = s.project_name || '(unknown)';
    const prev = m.get(k) || { cost: 0, sessions: 0, duration: 0 };
    prev.cost += s.cost_usd || 0;
    prev.sessions += 1;
    prev.duration += s.duration_seconds || 0;
    m.set(k, prev);
  }
  return m;
}

function _deltaBaseDate() {
  const input = document.getElementById('tlDeltaDate');
  if (input && input.value) return input.value;
  return new Date().toISOString().slice(0, 10);
}

async function _loadDelta() {
  const body = document.getElementById('tlDeltaBody');
  const summary = document.getElementById('tlDeltaSummary');
  const rangeLabel = document.getElementById('tlDeltaRange');
  if (!body || !summary) return;

  const today = _deltaBaseDate();
  const ymd = new Date(today + 'T00:00:00Z');
  ymd.setUTCDate(ymd.getUTCDate() - 1);
  const yesterday = ymd.toISOString().slice(0, 10);
  if (rangeLabel) rangeLabel.textContent = yesterday + '  →  ' + today;

  body.textContent = '';
  summary.textContent = '';
  const loading = document.createElement('div');
  loading.className = 'text-center text-white/15 text-xs py-6 dots';
  loading.textContent = '\uB85C\uB529 \uC911';
  body.appendChild(loading);

  try {
    const [todayD, yestD] = await Promise.all([
      safeFetch('/api/timeline?date_from=' + today + '&date_to=' + today),
      safeFetch('/api/timeline?date_from=' + yesterday + '&date_to=' + yesterday),
    ]);
    _renderDelta(todayD.sessions || [], yestD.sessions || [], summary, body);
  } catch (e) {
    body.textContent = '';
    const err = document.createElement('div');
    err.className = 'text-center text-red-400/60 text-xs py-4';
    err.textContent = '\uB378\uD0C0 \uB85C\uB4DC \uC2E4\uD328';
    body.appendChild(err);
  }
}

function _renderDelta(todaySessions, yestSessions, summaryEl, bodyEl) {
  const todayAgg = _aggByProject(todaySessions);
  const yestAgg = _aggByProject(yestSessions);
  const totalToday = { cost: 0, sessions: todaySessions.length, duration: 0 };
  for (const v of todayAgg.values()) { totalToday.cost += v.cost; totalToday.duration += v.duration; }
  const totalYest = { cost: 0, sessions: yestSessions.length, duration: 0 };
  for (const v of yestAgg.values()) { totalYest.cost += v.cost; totalYest.duration += v.duration; }

  summaryEl.textContent = '';
  const mkSummary = (label, todayVal, yestVal, formatter, colorPositive) => {
    const card = document.createElement('div');
    card.className = 'bg-white/[0.03] rounded-lg p-2.5';
    const lbl = document.createElement('div');
    lbl.className = 'text-[9px] text-white/30 uppercase tracking-widest mb-1';
    lbl.textContent = label;
    const valRow = document.createElement('div');
    valRow.className = 'flex items-baseline gap-1.5';
    const val = document.createElement('div');
    val.className = 'text-sm font-bold text-white/85 tabular-nums';
    val.textContent = formatter(todayVal);
    valRow.appendChild(val);

    const delta = todayVal - yestVal;
    const pct = yestVal > 0 ? (delta / yestVal) * 100 : (todayVal > 0 ? 100 : 0);
    const sign = delta > 0 ? '+' : '';
    const deltaEl = document.createElement('span');
    const goodDirection = colorPositive ? delta > 0 : delta < 0;
    deltaEl.className = 'text-[10px] tabular-nums ' + (delta === 0 ? 'text-white/30' : goodDirection ? 'text-emerald-300/80' : 'text-rose-300/80');
    if (delta === 0) deltaEl.textContent = '=';
    else deltaEl.textContent = sign + formatter(delta) + ' (' + sign + pct.toFixed(0) + '%)';
    valRow.appendChild(deltaEl);

    const yestRow = document.createElement('div');
    yestRow.className = 'text-[9px] text-white/25 mt-0.5';
    yestRow.textContent = '\uC5B4\uC81C ' + formatter(yestVal);

    card.append(lbl, valRow, yestRow);
    return card;
  };

  summaryEl.append(
    mkSummary('\uBE44\uC6A9', totalToday.cost, totalYest.cost, fmt$, true),
    mkSummary('\uC138\uC158', totalToday.sessions, totalYest.sessions, fmtN, true),
    mkSummary('\uC18C\uC694', totalToday.duration, totalYest.duration, fmtDurationSec, true),
    mkSummary('\uD504\uB85C\uC81D\uD2B8', todayAgg.size, yestAgg.size, fmtN, true),
  );

  bodyEl.textContent = '';
  if (todayAgg.size === 0 && yestAgg.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'text-center text-white/20 text-xs py-6';
    empty.textContent = '\uB450 \uB0A0\uC9DC \uBAA8\uB450 \uB370\uC774\uD130 \uC5C6\uC74C';
    bodyEl.appendChild(empty);
    return;
  }

  // Union of projects
  const allProj = new Set([...todayAgg.keys(), ...yestAgg.keys()]);
  const rows = [...allProj].map(name => {
    const t = todayAgg.get(name) || { cost: 0, sessions: 0, duration: 0 };
    const y = yestAgg.get(name) || { cost: 0, sessions: 0, duration: 0 };
    return {
      name,
      todayCost: t.cost, yestCost: y.cost,
      todaySes: t.sessions, yestSes: y.sessions,
      deltaCost: t.cost - y.cost,
      isNew: t.cost > 0 && y.cost === 0 && y.sessions === 0,
      isEnded: t.cost === 0 && t.sessions === 0 && y.cost > 0,
    };
  });

  // Sort: new first, then by absolute |deltaCost| desc
  rows.sort((a, b) => {
    if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
    return Math.abs(b.deltaCost) - Math.abs(a.deltaCost);
  });

  const newCount = rows.filter(r => r.isNew).length;
  const endedCount = rows.filter(r => r.isEnded).length;

  // Header strip for new/ended counts
  if (newCount + endedCount > 0) {
    const strip = document.createElement('div');
    strip.className = 'flex items-center gap-3 text-[10px] mb-2';
    if (newCount > 0) {
      const s = document.createElement('span'); s.className = 'text-emerald-300/80 font-bold';
      s.textContent = '\uC2E0\uADDC ' + fmtN(newCount) + '\uAC1C';
      strip.appendChild(s);
    }
    if (endedCount > 0) {
      const s = document.createElement('span'); s.className = 'text-white/30';
      s.textContent = '\uC911\uB2E8 ' + fmtN(endedCount) + '\uAC1C';
      strip.appendChild(s);
    }
    bodyEl.appendChild(strip);
  }

  // Find max absolute delta for bar scaling
  const maxAbs = Math.max(1e-6, ...rows.map(r => Math.abs(r.deltaCost)));

  const table = document.createElement('table');
  table.className = 'w-full text-[11px]';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  htr.className = 'text-[9px] text-white/30 uppercase tracking-widest border-b border-white/[0.05]';
  ['\uD504\uB85C\uC81D\uD2B8', '\uC5B4\uC81C', '\uC624\uB298', '\uBCC0\uD654', ''].forEach((t, i) => {
    const th = document.createElement('th');
    th.className = (i === 0 ? 'text-left' : 'text-right') + ' px-2 py-1.5 font-bold';
    th.textContent = t;
    htr.appendChild(th);
  });
  thead.appendChild(htr); table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const r of rows.slice(0, 20)) {
    const tr = document.createElement('tr');
    tr.className = 'border-b border-white/[0.03] hover:bg-white/[0.03] spring';

    const nameTd = document.createElement('td');
    nameTd.className = 'px-2 py-1.5 truncate max-w-[220px]';
    nameTd.title = r.name;
    nameTd.appendChild(_projDot(r.name));
    if (r.isNew) {
      const b = document.createElement('span');
      b.className = 'inline-block mr-1 px-1 rounded text-[8px] font-bold bg-emerald-400/15 text-emerald-300 align-middle';
      b.textContent = 'NEW';
      nameTd.appendChild(b);
    } else if (r.isEnded) {
      const b = document.createElement('span');
      b.className = 'inline-block mr-1 px-1 rounded text-[8px] font-bold bg-white/5 text-white/40 align-middle';
      b.textContent = 'END';
      nameTd.appendChild(b);
    }
    const nameSpan = document.createElement('span');
    nameSpan.className = r.isEnded ? 'text-white/40' : 'text-white/75 font-semibold';
    nameSpan.textContent = r.name;
    nameTd.appendChild(nameSpan);
    tr.appendChild(nameTd);

    const mkNumTd = (text, cls) => {
      const td = document.createElement('td');
      td.className = 'px-2 py-1.5 text-right tabular-nums ' + cls;
      td.textContent = text;
      return td;
    };
    tr.appendChild(mkNumTd(r.yestCost > 0 ? fmt$(r.yestCost) : '\u2014',
      'text-white/40'));
    tr.appendChild(mkNumTd(r.todayCost > 0 ? fmt$(r.todayCost) : '\u2014',
      'text-amber-400/80 font-bold'));

    // Delta bar (signed, centered)
    const dTd = document.createElement('td');
    dTd.className = 'px-2 py-1.5';
    const dWrap = document.createElement('div');
    dWrap.className = 'flex items-center gap-2 justify-end';
    const dText = document.createElement('span');
    const delta = r.deltaCost;
    const sign = delta > 0 ? '+' : '';
    dText.className = 'tabular-nums text-[10px] ' + (Math.abs(delta) < 0.005 ? 'text-white/30' : delta > 0 ? 'text-emerald-300/85' : 'text-rose-300/85');
    dText.textContent = Math.abs(delta) < 0.005 ? '=' : (sign + fmt$(delta));
    const barWrap = document.createElement('div');
    barWrap.className = 'relative w-20 h-2 bg-white/[0.04] rounded-full overflow-hidden';
    const bar = document.createElement('div');
    const mag = Math.min(1, Math.abs(delta) / maxAbs);
    bar.style.position = 'absolute';
    bar.style.top = '0'; bar.style.bottom = '0';
    bar.style.width = (mag * 50).toFixed(1) + '%';
    if (delta >= 0) { bar.style.left = '50%'; bar.style.background = 'rgba(52,211,153,0.55)'; }
    else { bar.style.right = '50%'; bar.style.background = 'rgba(251,113,133,0.55)'; }
    // midline
    const mid = document.createElement('div');
    mid.style.position = 'absolute'; mid.style.left = '50%'; mid.style.top = '0'; mid.style.bottom = '0';
    mid.style.width = '1px'; mid.style.background = 'rgba(255,255,255,0.1)';
    barWrap.append(bar, mid);
    dWrap.append(dText, barWrap);
    dTd.appendChild(dWrap);
    tr.appendChild(dTd);

    const spark = document.createElement('td');
    spark.className = 'px-2 py-1.5 text-right text-[9px] text-white/25 tabular-nums';
    const sesDelta = r.todaySes - r.yestSes;
    spark.textContent = r.yestSes + '\u2192' + r.todaySes + '\uC138\uC158';
    if (sesDelta !== 0) {
      const ssign = sesDelta > 0 ? '+' : '';
      spark.textContent += ' (' + ssign + sesDelta + ')';
    }
    tr.appendChild(spark);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  bodyEl.appendChild(table);

  if (rows.length > 20) {
    const more = document.createElement('div');
    more.className = 'text-[9px] text-white/20 text-center mt-2';
    more.textContent = '+' + (rows.length - 20) + '\uAC1C \uB354';
    bodyEl.appendChild(more);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 6. (B) HOURLY STACKED BAR CHART
// ═══════════════════════════════════════════════════════════════════════════

let _hourlyStackedChart = null;

function cleanupTimelineCharts() {
  if (_hourlyStackedChart) { _hourlyStackedChart.destroy(); _hourlyStackedChart = null; }
}

async function _loadHourlyStacked(dateStr) {
  const canvas = document.getElementById('chartHourlyStacked');
  if (!canvas) return;
  if (!dateStr) {
    dateStr = new Date().toISOString().slice(0, 10);
    const dateInput = document.getElementById('tlHourlyDate');
    if (dateInput && !dateInput.value) dateInput.value = dateStr;
  }
  try {
    const data = await _fetchHourly(dateStr);
    _renderHourlyStacked(data);
  } catch (e) { console.error('hourlyStacked:', e); }
}

function _renderHourlyStacked(data) {
  const hours = data.hours || [];
  const metric = document.getElementById('tlHourlyMetric')?.value || 'cost';

  // Collect all project names across all hours, sorted by total cost desc
  const projTotals = new Map();
  for (const h of hours) {
    for (const [name, d] of Object.entries(h.projects)) {
      projTotals.set(name, (projTotals.get(name) || 0) + (d.cost_usd || 0));
    }
  }
  const projects = [...projTotals.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  if (!projects.length) {
    if (_hourlyStackedChart) { _hourlyStackedChart.destroy(); _hourlyStackedChart = null; }
    return;
  }

  const labels = hours.map(h => h.hour + ':00');
  const datasets = projects.map((proj) => ({
    label: proj,
    data: hours.map(h => {
      const p = h.projects[proj];
      if (!p) return 0;
      if (metric === 'messages') return p.message_count || 0;
      if (metric === 'tokens') return (p.input_tokens || 0) + (p.output_tokens || 0);
      return p.cost_usd || 0;
    }),
    backgroundColor: _projColorByName(proj, 0.55),
    borderColor: _projColorByName(proj, 0.85),
    borderWidth: 1,
    borderRadius: 2,
  }));

  if (_hourlyStackedChart) { _hourlyStackedChart.destroy(); _hourlyStackedChart = null; }
  const canvas = document.getElementById('chartHourlyStacked');
  if (!canvas) return;
  const tc = themeColors();

  const yCallback = metric === 'cost' ? (v => '$' + v.toFixed(2))
    : metric === 'tokens' ? (v => v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v)
    : (v => v);
  const tooltipLabel = (ctx) => {
    const v = ctx.raw;
    if (metric === 'cost') return ' ' + ctx.dataset.label + ': ' + fmt$(v);
    if (metric === 'tokens') return ' ' + ctx.dataset.label + ': ' + fmtN(v) + ' tok';
    return ' ' + ctx.dataset.label + ': ' + fmtN(v) + '\uAC74';
  };

  _hourlyStackedChart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: _prefersReducedMotion ? 0 : 350 },
      plugins: {
        legend: { display: false },
        tooltip: tooltipOpts({ callbacks: { label: tooltipLabel } }),
      },
      scales: {
        x: {
          stacked: true,
          grid: { color: tc.gridColor, drawBorder: false },
          ticks: { color: tc.tickColor, font: { size: 10, family: 'Pretendard' }, maxRotation: 0 },
        },
        y: {
          stacked: true,
          grid: { color: tc.gridColor, drawBorder: false },
          ticks: { color: tc.tickColor, font: { size: 10, family: 'Pretendard' }, callback: yCallback },
        },
      },
    },
  });

  // Legend
  const legendEl = document.getElementById('tlHourlyLegend');
  if (legendEl) {
    legendEl.textContent = '';
    for (let i = 0; i < Math.min(projects.length, 8); i++) {
      const w = document.createElement('span'); w.className = 'inline-flex items-center gap-1 mr-3';
      const dot = document.createElement('span'); dot.className = 'w-2 h-2 rounded-sm inline-block'; dot.style.background = _projColorByName(projects[i], 0.75);
      const txt = document.createElement('span'); txt.textContent = projects[i];
      w.append(dot, txt); legendEl.appendChild(w);
    }
    if (projects.length > 8) {
      const more = document.createElement('span'); more.className = 'text-white/15';
      more.textContent = '+' + (projects.length - 8) + '\uAC1C \uD504\uB85C\uC81D\uD2B8';
      legendEl.appendChild(more);
    }
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 7. (C) HEATMAP DRILL-DOWN
// ═══════════════════════════════════════════════════════════════════════════

function _heatmapDrillDown(dow, hour) {
  const drillEl = document.getElementById('tlHeatmapDrill');
  if (!drillEl) return;
  drillEl.classList.remove('hidden');
  drillEl.textContent = '';

  const loading = document.createElement('div');
  loading.className = 'text-center text-white/15 text-xs py-3 dots';
  loading.textContent = '\uB85C\uB529 \uC911';
  drillEl.appendChild(loading);

  // Find the most recent date matching this dow within 90 days, then load its hourly data
  const now = new Date();
  const candidates = [];
  for (let i = 0; i < 90; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    if (d.getDay() === dow) candidates.push(d.toISOString().slice(0, 10));
  }

  // Load aggregated data for the last 4 matching days
  const datesToLoad = candidates.slice(0, 4);
  Promise.all(datesToLoad.map(date => _fetchHourly(date).catch(() => null)))
    .then(results => {
      drillEl.textContent = '';
      const valid = results.filter(Boolean);
      if (!valid.length) {
        const empty = document.createElement('div');
        empty.className = 'text-center text-white/20 text-xs py-3';
        empty.textContent = '\uB370\uC774\uD130 \uC5C6\uC74C';
        drillEl.appendChild(empty);
        return;
      }

      // Header with close button
      const headerRow = document.createElement('div');
      headerRow.className = 'flex items-center justify-between mb-2';
      const titleText = document.createElement('span');
      titleText.className = 'text-[10px] font-bold text-white/40 uppercase tracking-widest';
      titleText.textContent = DOW_LABELS[dow] + ' ' + hour + '\uC2DC \uC0C1\uC138 (\uCD5C\uADFC ' + valid.length + '\uC8FC)';
      const closeBtn = document.createElement('button');
      closeBtn.className = 'text-white/25 hover:text-white/50 text-xs spring';
      closeBtn.textContent = '\u2715';
      closeBtn.addEventListener('click', () => { drillEl.classList.add('hidden'); drillEl.textContent = ''; });
      headerRow.append(titleText, closeBtn);
      drillEl.appendChild(headerRow);

      // Aggregate the specific hour across the loaded dates
      const projAgg = new Map();
      let totalMsg = 0, totalCost = 0;
      for (const data of valid) {
        const hSlot = (data.hours || []).find(h => parseInt(h.hour, 10) === hour);
        if (!hSlot || !hSlot.message_count) continue;
        totalMsg += hSlot.message_count;
        totalCost += hSlot.cost_usd || 0;
        for (const [name, p] of Object.entries(hSlot.projects)) {
          const prev = projAgg.get(name) || { msg: 0, cost: 0, sessions: 0 };
          prev.msg += p.message_count || 0;
          prev.cost += p.cost_usd || 0;
          prev.sessions += p.session_count || 0;
          projAgg.set(name, prev);
        }
      }

      // Summary cards
      const grid = document.createElement('div');
      grid.className = 'grid grid-cols-3 gap-2 mb-2';
      const mkC = (label, val, cls) => {
        const c = document.createElement('div'); c.className = 'bg-white/[0.03] rounded-lg p-1.5 text-center';
        const v = document.createElement('div'); v.className = 'text-xs font-bold ' + (cls || 'text-white/70'); v.textContent = val;
        const l = document.createElement('div'); l.className = 'text-[8px] text-white/25 mt-0.5'; l.textContent = label;
        c.append(v, l); return c;
      };
      grid.append(
        mkC('\uBA54\uC2DC\uC9C0', fmtN(totalMsg) + '\uAC74'),
        mkC('\uBE44\uC6A9', fmt$(totalCost), 'text-amber-400/70'),
        mkC('\uD504\uB85C\uC81D\uD2B8', fmtN(projAgg.size) + '\uAC1C', 'text-cyan-400/70'),
      );
      drillEl.appendChild(grid);

      // Per-project breakdown
      const sorted = [...projAgg.entries()].sort((a, b) => b[1].cost - a[1].cost);
      for (const [name, agg] of sorted) {
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between py-1 text-[10px] border-b border-white/[0.02]';
        const rLeft = document.createElement('span');
        rLeft.className = 'text-white/50 truncate max-w-[140px]'; rLeft.textContent = name; rLeft.title = name;
        const rRight = document.createElement('div');
        rRight.className = 'flex items-center gap-2 text-white/35 tabular-nums';
        const rm = document.createElement('span'); rm.textContent = fmtN(agg.msg) + '\uAC74';
        const rc = document.createElement('span'); rc.className = 'text-amber-400/60'; rc.textContent = fmt$(agg.cost);
        const rs = document.createElement('span'); rs.className = 'text-white/20'; rs.textContent = fmtN(agg.sessions) + '\uC138\uC158';
        rRight.append(rm, rc, rs);
        row.append(rLeft, rRight); drillEl.appendChild(row);
      }

      // Per-date breakdown
      const dateSection = document.createElement('div');
      dateSection.className = 'mt-2 pt-2 border-t border-white/[0.04]';
      const dateTitle = document.createElement('div');
      dateTitle.className = 'text-[9px] text-white/20 uppercase tracking-wider mb-1';
      dateTitle.textContent = '\uB0A0\uC9DC\uBCC4';
      dateSection.appendChild(dateTitle);
      for (let i = 0; i < valid.length; i++) {
        const data = valid[i];
        const hSlot = (data.hours || []).find(h => parseInt(h.hour, 10) === hour);
        if (!hSlot || !hSlot.message_count) continue;
        const dRow = document.createElement('div');
        dRow.className = 'flex items-center justify-between py-0.5 text-[10px]';
        const dLeft = document.createElement('span'); dLeft.className = 'text-white/40 tabular-nums'; dLeft.textContent = datesToLoad[i];
        const dRight = document.createElement('div'); dRight.className = 'flex gap-2 text-white/30 tabular-nums';
        const dm = document.createElement('span'); dm.textContent = fmtN(hSlot.message_count) + '\uAC74';
        const dc = document.createElement('span'); dc.className = 'text-amber-400/50'; dc.textContent = fmt$(hSlot.cost_usd);
        dRight.append(dm, dc); dRow.append(dLeft, dRight);
        dateSection.appendChild(dRow);
      }
      drillEl.appendChild(dateSection);
    });
}


// ─── Timeline node filter population ─────────────────────────────────
let _tlNodePopulated = false;
function _populateTlNodeFilter() {
  const sel = document.getElementById('tlNodeFilter');
  if (!sel || _tlNodePopulated) return;
  if (!state.nodes || !state.nodes.length) {
    // Retry after loadNodes completes
    if (typeof loadNodes === 'function') {
      loadNodes().then(() => { _tlNodePopulated = false; _populateTlNodeFilter(); });
    }
    return;
  }
  _tlNodePopulated = true;
  const cur = sel.value;
  sel.textContent = '';
  const all = document.createElement('option');
  all.value = ''; all.textContent = '\uC804\uCCB4 \uB178\uB4DC'; sel.appendChild(all);
  for (const n of state.nodes) {
    const o = document.createElement('option');
    o.value = n.node_id;
    o.textContent = (n.label || n.node_id) + (n.session_count ? ' (' + n.session_count + ')' : '');
    sel.appendChild(o);
  }
  sel.value = cur;
}


// ═══════════════════════════════════════════════════════════════════════════
// EVENT BINDINGS
// ═══════════════════════════════════════════════════════════════════════════

document.querySelectorAll('.tl-range').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tl-range').forEach(b => {
      b.classList.remove('active', 'bg-accent/15', 'text-accent', 'border-accent/30');
      b.classList.add('text-white/45', 'border-white/[0.07]');
    });
    btn.classList.add('active', 'bg-accent/15', 'text-accent', 'border-accent/30');
    btn.classList.remove('text-white/45', 'border-white/[0.07]');
    _tlRange = btn.dataset.range;
    savePrefs({ tlRange: _tlRange });
    document.getElementById('tlDateFrom').value = '';
    document.getElementById('tlDateTo').value = '';
    loadTimeline();
  });
});

(function _initTlRange() {
  document.querySelectorAll('.tl-range').forEach(b => {
    const isActive = b.dataset.range === _tlRange;
    b.classList.toggle('active', isActive);
    b.classList.toggle('bg-accent/15', isActive);
    b.classList.toggle('text-accent', isActive);
    b.classList.toggle('border-accent/30', isActive);
    b.classList.toggle('text-white/45', !isActive);
    b.classList.toggle('border-white/[0.07]', !isActive);
  });
})();

['tlDateFrom', 'tlDateTo'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => {
    if (document.getElementById('tlDateFrom')?.value && document.getElementById('tlDateTo')?.value) {
      document.querySelectorAll('.tl-range').forEach(b => {
        b.classList.remove('active', 'bg-accent/15', 'text-accent', 'border-accent/30');
        b.classList.add('text-white/45', 'border-white/[0.07]');
      });
      loadTimeline();
    }
  });
});

document.getElementById('tlShowSubagents')?.addEventListener('change', loadTimeline);
document.getElementById('tlShowLinks')?.addEventListener('change', () => {
  const c = getChart('timeline'); if (c) c.update('none');
});
document.getElementById('tlShowOutliers')?.addEventListener('change', () => {
  if (_tlLastData) {
    _renderTimelineChart(_tlLastData.data, _tlLastData.dateFrom, _tlLastData.dateTo);
    _renderEfficiency(_tlLastData.data);
  }
});
document.getElementById('tlNodeFilter')?.addEventListener('change', () => { _tlNodePopulated = false; loadTimeline(); });
document.getElementById('tlResetZoom')?.addEventListener('click', () => {
  const _tlChart = getChart('timeline'); if (_tlChart) { _tlChart.resetZoom(); document.getElementById('tlResetZoom')?.classList.add('hidden'); }
});
document.getElementById('tlReportDate')?.addEventListener('change', (e) => _loadDailyReport(e.target.value));
document.getElementById('tlHourlyDate')?.addEventListener('change', (e) => _loadHourlyStacked(e.target.value));
document.getElementById('tlHourlyMetric')?.addEventListener('change', () => {
  const dateVal = document.getElementById('tlHourlyDate')?.value;
  if (dateVal && _hourlyCache[dateVal]) _renderHourlyStacked(_hourlyCache[dateVal]);
  else if (dateVal) _loadHourlyStacked(dateVal);
});
document.getElementById('timelineChartWrap')?.addEventListener('mouseleave', () => {
  document.getElementById('tlHoverCard')?.classList.add('hidden');
});
document.getElementById('tlDeltaDate')?.addEventListener('change', _loadDelta);
document.getElementById('tlDeltaRefresh')?.addEventListener('click', _loadDelta);
