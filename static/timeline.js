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
  const { dateFrom, dateTo } = _tlDates();
  const showSubs = document.getElementById('tlShowSubagents')?.checked || false;
  const url = `/api/timeline?date_from=${encodeURIComponent(dateFrom)}&date_to=${encodeURIComponent(dateTo)}&include_subagents=${showSubs}`;
  try {
    const data = await safeFetch(url);
    _tlLastData = { data, dateFrom, dateTo };
    _renderTimelineChart(data, dateFrom, dateTo);
    _renderEfficiency(data);
    reportSuccess('loadTimeline');
  } catch (e) {
    reportError('loadTimeline', e);
  }
  _loadHeatmap();
  _loadTrend();
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

  const barData = [], barMeta = [], barBg = [], barBorder = [];
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
        }
      }

      barData.push({ x: [start, adjustedEnd], y: proj });
      barMeta.push(s);
      const family = s.is_subagent ? '_sub' : _modelFamily(s.model);
      const palette = MODEL_COLORS[family] || MODEL_COLORS._default;
      const intensity = Math.min(1, (s.cost_usd || 0) / maxCost);
      const alpha = (0.3 + intensity * 0.5).toFixed(2);
      barBg.push(palette.bg.replace('A', alpha));
      barBorder.push(palette.border);
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

  if (state.charts.timeline) { state.charts.timeline.destroy(); state.charts.timeline = null; }

  const tc = themeColors();
  const resetBtn = document.getElementById('tlResetZoom');

  const datasets = [{
    type: 'bar', label: 'Sessions', data: barData,
    backgroundColor: barBg, borderColor: barBorder,
    borderWidth: 1, borderRadius: 3, borderSkipped: false,
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

  state.charts.timeline = new Chart(canvas, {
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
          ticks: { color: tc.tickColor, font: { size: 11, family: 'Pretendard', weight: 'bold' }, autoSkip: false },
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
              return ` ${fmtDurationSec(s.duration_seconds||0)} \u00b7 ${fmt$(s.cost_usd)} \u00b7 ${s.model?shortModel(s.model):'\u2014'}${s.is_subagent?' [sub]':''}`;
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
    }],
  });

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
    _renderTimelineChart(_tlLastData.data, _tlLastData.dateFrom, _tlLastData.dateTo);
    _renderEfficiency(_tlLastData.data);
  }
}
function _expandAll() {
  _tlCollapsed.clear();
  savePrefs({ tlCollapsed: [] });
  if (_tlLastData) {
    _renderTimelineChart(_tlLastData.data, _tlLastData.dateFrom, _tlLastData.dateTo);
    _renderEfficiency(_tlLastData.data);
  }
}

// ─── Empty state ─────────────────────────────────────────────────────────
function _renderEmptyTimeline() {
  if (state.charts.timeline) { state.charts.timeline.destroy(); state.charts.timeline = null; }
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
    const nameCell = mkTd(r.name, 'px-2 py-1.5 font-semibold text-white/70 truncate max-w-[180px]'); nameCell.title = r.name;
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
// 4. DAILY REPORT
// ═══════════════════════════════════════════════════════════════════════════

async function _loadDailyReport(dateStr) {
  const el = document.getElementById('tlDailyReport');
  if (!el || !dateStr) return;
  el.textContent = '';
  const loading = document.createElement('div'); loading.className = 'text-center text-white/15 text-xs py-4 dots'; loading.textContent = '\uB85C\uB529 \uC911'; el.appendChild(loading);
  try {
    const d = await safeFetch('/api/timeline?date_from=' + dateStr + '&date_to=' + dateStr);
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
      const left = document.createElement('span'); left.className = 'text-white/65 font-semibold truncate'; left.textContent = name;
      const right = document.createElement('span'); right.className = 'text-white/40 tabular-nums flex gap-3';
      const s1 = document.createElement('span'); s1.textContent = fmtN(ss.length) + '\uAC74';
      const s2 = document.createElement('span'); s2.className = 'text-amber-400/70'; s2.textContent = fmt$(cost);
      const s3 = document.createElement('span'); s3.textContent = fmtDurationSec(dur);
      right.append(s1, s2, s3);
      row.append(left, right); el.appendChild(row);
    }
  } catch (e) {
    el.textContent = '';
    const err = document.createElement('div'); err.className = 'text-center text-red-400/60 text-xs py-4'; err.textContent = '\uB9AC\uD3EC\uD2B8 \uB85C\uB4DC \uC2E4\uD328'; el.appendChild(err);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
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

  if (state.charts.trend) { state.charts.trend.destroy(); state.charts.trend = null; }
  const canvas = document.getElementById('chartTrend');
  if (!canvas) return;
  const tc = themeColors();

  state.charts.trend = new Chart(canvas, {
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
  });
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
document.getElementById('tlResetZoom')?.addEventListener('click', () => {
  if (state.charts.timeline) { state.charts.timeline.resetZoom(); document.getElementById('tlResetZoom')?.classList.add('hidden'); }
});
document.getElementById('tlReportDate')?.addEventListener('change', (e) => _loadDailyReport(e.target.value));
document.getElementById('timelineChartWrap')?.addEventListener('mouseleave', () => {
  document.getElementById('tlHoverCard')?.classList.add('hidden');
});
