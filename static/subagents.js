// Claude Dashboard — subagent analysis module.
// Extracted from app.js. Powers the #/subagents view (heatmap +
// success matrix). Loaded as a regular script after app.js.
//
// Dependencies from app.js: safeFetch, esc, fmtN, fmt$, stopReasonBadge.

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
