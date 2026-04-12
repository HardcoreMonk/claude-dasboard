// Claude Dashboard — subagent analysis module.
// Extracted from app.js. Powers the #/subagents view (heatmap +
// success matrix). Loaded as a regular script after app.js.
//
// Dependencies from app.js: safeFetch, esc, fmtN, fmt$, stopReasonBadge.

// ─── Subagent detail panels (6 remaining sections) ────────────────────
async function loadSubagentDetails() {
  try {
    const d = await safeFetch('/api/subagents/stats');
    _renderByType(d);
    _renderByStopReason(d);
    _renderTopList('subagentTopCost', d.top_by_cost || [], 'cost');
    _renderTopList('subagentTopDuration', d.top_by_duration || [], 'duration');
    _renderTopParents(d.parents_with_most_subs || []);
  } catch (e) { console.error('loadSubagentDetails:', e); }
}

function _renderByType(d) {
  const wrap = document.getElementById('subagentByType');
  if (!wrap) return;
  const rows = d.by_type || [];
  const totals = d.totals || {};
  if (!rows.length) { wrap.textContent = '데이터 없음'; return; }
  // NOTE: innerHTML here is safe — all values pass through esc()/fmtN()/fmt$()
  let html = '<table class="text-[10px] min-w-full"><thead><tr class="text-white/35 font-bold">';
  html += '<th class="text-left px-2 py-1">유형</th><th class="text-right px-2 py-1">수</th><th class="text-right px-2 py-1">비용</th><th class="text-right px-2 py-1">평균</th><th class="text-right px-2 py-1">메시지</th>';
  html += '</tr></thead><tbody>';
  rows.forEach(r => {
    html += `<tr><td class="px-2 py-1.5 font-bold text-white/60">${esc(r.agent_type)}</td>`;
    html += `<td class="px-2 py-1.5 text-right tabular-nums text-white/70">${fmtN(r.count)}</td>`;
    html += `<td class="px-2 py-1.5 text-right tabular-nums text-amber-400/80">${fmt$(r.cost)}</td>`;
    html += `<td class="px-2 py-1.5 text-right tabular-nums text-white/50">${fmt$(r.avg_cost)}</td>`;
    html += `<td class="px-2 py-1.5 text-right tabular-nums text-white/50">${fmtN(r.messages)}</td></tr>`;
  });
  html += `<tr class="border-t border-white/[0.05]"><td class="px-2 py-1.5 font-bold text-white/40">합계</td>`;
  html += `<td class="px-2 py-1.5 text-right tabular-nums text-white/50">${fmtN(totals.count)}</td>`;
  html += `<td class="px-2 py-1.5 text-right tabular-nums text-amber-400/60">${fmt$(totals.cost)}</td>`;
  html += `<td></td><td class="px-2 py-1.5 text-right tabular-nums text-white/40">${fmtN(totals.messages)}</td></tr>`;
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function _renderByStopReason(d) {
  const wrap = document.getElementById('subagentByStopReason');
  if (!wrap) return;
  const rows = d.by_stop_reason || [];
  if (!rows.length) { wrap.textContent = '데이터 없음'; return; }
  const total = rows.reduce((s, r) => s + (r.count || 0), 0);
  // NOTE: innerHTML safe — all dynamic values via esc()/fmtN()/fmt$()/stopReasonBadge()
  let html = '<table class="text-[10px] min-w-full"><thead><tr class="text-white/35 font-bold">';
  html += '<th class="text-left px-2 py-1">종료 사유</th><th class="text-right px-2 py-1">수</th><th class="text-right px-2 py-1">비율</th><th class="text-right px-2 py-1">비용</th>';
  html += '</tr></thead><tbody>';
  rows.forEach(r => {
    const pct = total > 0 ? (r.count / total * 100).toFixed(1) : '0';
    html += `<tr><td class="px-2 py-1.5 font-bold text-white/60">${stopReasonBadge(r.stop_reason)} ${esc(r.stop_reason)}</td>`;
    html += `<td class="px-2 py-1.5 text-right tabular-nums text-white/70">${fmtN(r.count)}</td>`;
    html += `<td class="px-2 py-1.5 text-right tabular-nums text-white/50">${pct}%</td>`;
    html += `<td class="px-2 py-1.5 text-right tabular-nums text-amber-400/80">${fmt$(r.cost)}</td></tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function _renderTopList(containerId, rows, mode) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  if (!rows.length) { wrap.textContent = '데이터 없음'; return; }
  wrap.textContent = '';
  rows.forEach((r, i) => {
    const div = document.createElement('div');
    div.className = 'flex items-center gap-2 py-1.5 border-b border-white/[0.03] last:border-b-0 text-[10px]';
    const rank = document.createElement('span');
    rank.className = 'text-white/25 font-bold w-5 text-center';
    rank.textContent = '#' + (i + 1);
    const info = document.createElement('div');
    info.className = 'flex-1 min-w-0';
    const name = document.createElement('div');
    name.className = 'text-white/60 truncate font-semibold';
    name.textContent = r.agent_type || r.agent_description || r.id || '—';
    name.title = r.id || '';
    const sub = document.createElement('div');
    sub.className = 'text-[9px] text-white/30';
    sub.textContent = (r.message_count || 0) + ' msg';
    info.append(name, sub);
    const val = document.createElement('span');
    val.className = 'tabular-nums font-bold whitespace-nowrap';
    if (mode === 'cost') {
      val.className += ' text-amber-400/80';
      val.textContent = fmt$(r.cost_usd);
    } else {
      val.className += ' text-cyan-400/80';
      val.textContent = fmtDurationSec(r.duration_seconds || 0);
    }
    div.append(rank, info, val);
    wrap.appendChild(div);
  });
}

function _renderTopParents(rows) {
  const wrap = document.getElementById('subagentTopParents');
  if (!wrap) return;
  if (!rows.length) { wrap.textContent = '데이터 없음'; return; }
  wrap.textContent = '';
  rows.forEach((r, i) => {
    const div = document.createElement('div');
    div.className = 'flex items-center gap-2 py-1.5 border-b border-white/[0.03] last:border-b-0 text-[10px]';
    const rank = document.createElement('span');
    rank.className = 'text-white/25 font-bold w-5 text-center';
    rank.textContent = '#' + (i + 1);
    const info = document.createElement('div');
    info.className = 'flex-1 min-w-0';
    const name = document.createElement('div');
    name.className = 'text-white/60 truncate font-semibold';
    name.textContent = r.project || '—';
    name.title = r.parent_session_id || '';
    const sub = document.createElement('div');
    sub.className = 'text-[9px] text-white/30';
    sub.textContent = (r.sub_count || 0) + ' subagents · ' + fmt$(r.total_cost);
    info.append(name, sub);
    const val = document.createElement('span');
    val.className = 'tabular-nums font-bold text-purple-400/80 whitespace-nowrap';
    val.textContent = (r.sub_count || 0) + '개';
    div.append(rank, info, val);
    wrap.appendChild(div);
  });
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
    const types = [];
    const seenT = new Set();
    const reasons = [];
    const seenR = new Set();
    const cells = {};
    const rowTotals = {};
    for (const r of rows) {
      if (!seenT.has(r.agent_type)) { seenT.add(r.agent_type); types.push(r.agent_type); }
      if (!seenR.has(r.stop_reason)) { seenR.add(r.stop_reason); reasons.push(r.stop_reason); }
      cells[`${r.agent_type}|${r.stop_reason}`] = { count: r.count, cost: r.cost };
      rowTotals[r.agent_type] = (rowTotals[r.agent_type] || 0) + r.count;
    }
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

// ─── Subagent heatmap (agentType × project) ────────────────────────────
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
