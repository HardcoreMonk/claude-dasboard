// Codex-only override for the subagent surface.
// This script is loaded after the bundle so it can replace any legacy
// Claude fallback behavior without rewriting the older module in place.

function _renderCodexSubagentEmptyState() {
  const ids = [
    'subagentByType',
    'subagentByStopReason',
    'subagentTopCost',
    'subagentTopDuration',
    'subagentTopParents',
  ];
  ids.forEach((id) => {
    const node = document.getElementById(id);
    if (!node) return;
    node.innerHTML = '<div class="text-[11px] text-white/35">Codex agent 데이터 없음</div>';
  });
}

function _renderCodexSubagentMode() {
  const view = document.getElementById('view-subagents');
  if (!view || document.getElementById('subagentSurfaceMode')) return;
  const wrap = document.createElement('div');
  wrap.id = 'subagentSurfaceMode';
  wrap.className = 'mb-3 flex items-center gap-2 text-[10px] text-white/45';
  wrap.innerHTML = `
    <span class="px-2.5 py-1 rounded-full border border-accent/20 bg-accent/10 text-accent font-semibold">Codex Agents</span>
    <span>Claude fallback disabled</span>
  `;
  view.prepend(wrap);
}

window.loadSubagentDetails = async function loadSubagentDetailsCodexOnly() {
  try {
    _renderCodexSubagentMode();
    const codexAgents = await safeFetch('/api/agents/summary');
    if ((codexAgents?.total_runs || 0) > 0 && typeof renderCodexAgentSurface === 'function') {
      renderCodexAgentSurface(codexAgents);
      return;
    }
    _renderCodexSubagentEmptyState();
  } catch (e) {
    reportError('loadSubagentDetails', e);
  }
};

window.loadSubagentSuccessMatrix = async function loadSubagentSuccessMatrixCodexOnly() {
  const wrap = document.getElementById('subagentSuccessMatrix');
  if (!wrap) return;
  try {
    _renderCodexSubagentMode();
    const codexAgents = await safeFetch('/api/agents/summary');
    if ((codexAgents?.total_runs || 0) > 0) {
      const matrix = {};
      (codexAgents.agents || []).forEach((row) => {
        const key = `${row.agent_name}|${row.status}`;
        matrix[key] = (matrix[key] || 0) + 1;
      });
      wrap.innerHTML = `
        <div class="grid gap-2">
          ${Object.entries(matrix).map(([key, count]) => {
            const [agent, status] = key.split('|');
            return `<div class="rounded-xl border border-white/[0.05] bg-black/20 px-3 py-2 text-[11px] flex items-center justify-between gap-3">
              <span class="text-white/65">${esc(agent)}</span>
              <span class="text-white/35">${esc(status)} · ${fmtN(count)}</span>
            </div>`;
          }).join('')}
        </div>`;
      return;
    }
    wrap.innerHTML = '<div class="text-center text-white/20 text-xs py-6">Codex agent 데이터 없음</div>';
  } catch (e) {
    reportError('loadSubagentSuccessMatrix', e);
    wrap.innerHTML = '<div class="text-center text-red-400/40 text-xs py-6">로딩 실패</div>';
  }
};

window.loadSubagentHeatmap = async function loadSubagentHeatmapCodexOnly() {
  const wrap = document.getElementById('subagentHeatmap');
  const totalEl = document.getElementById('subagentHeatmapTotal');
  if (!wrap) return;
  try {
    _renderCodexSubagentMode();
    const codexAgents = await safeFetch('/api/agents/summary');
    if ((codexAgents?.total_runs || 0) > 0) {
      wrap.innerHTML = `
        <div class="grid gap-2">
          ${(codexAgents.agents || []).slice(0, 12).map((row) => `
            <div class="rounded-xl border border-white/[0.05] bg-black/20 px-3 py-2">
              <div class="text-[11px] font-semibold text-white/75">${esc(row.agent_name || 'agent')}</div>
              <div class="text-[10px] text-white/35 mt-1">${esc(row.session_id || '')} · ${esc(row.timestamp || '')}</div>
              <div class="text-[10px] text-white/35 mt-1">${esc(row.body_text || '')}</div>
            </div>
          `).join('')}
        </div>`;
      if (totalEl) totalEl.textContent = `${fmtN(codexAgents.total_runs || 0)} Codex agent runs`;
      return;
    }
    wrap.innerHTML = '<div class="text-center text-white/20 text-xs py-6">Codex agent 데이터 없음</div>';
    if (totalEl) totalEl.textContent = '0 Codex agent runs';
  } catch (e) {
    reportError('loadSubagentHeatmap', e);
    wrap.innerHTML = '<div class="text-center text-red-400/40 text-xs py-6">로딩 실패</div>';
  }
};
