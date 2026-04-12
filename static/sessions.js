// Claude Dashboard — sessions module.
// Extracted from app.js. Contains: filter presets, bulk operations,
// loadSessions/renderSessions, advanced filter UI, session delete/pin/tag
// management, tag edit modal.
//
// Loaded as a regular script after app.js. All functions become window.*
// globals. Depends on app.js globals: state, sortState, savePrefs, loadPrefs,
// _prefs, safeFetch, reportError, showToast, renderError, set, esc, fmt$,
// fmtN, fmtTok, shortModel, trimPath, fmtDuration, fmtDurationSec,
// fmtTime, relTime, openDeleteConfirm, sortArrowHtml, sortThHtml,
// sortPillHtml, stopReasonBadge, markUpdated, showNewDataBadge, showView,
// drillToSessionsToday, drillToSessionsWeek, openConversation.

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
      ${sortThHtml('sessions','model','모델','text-left hide-sm')}
      ${sortThHtml('sessions','input','입력','text-right hide-sm')}
      ${sortThHtml('sessions','output','출력','text-right hide-sm')}
      ${sortThHtml('sessions','cache','캐시','text-right hide-sm')}
      ${sortThHtml('sessions','cost','비용','text-right')}
      ${sortThHtml('sessions','messages','메시지','text-right hide-sm')}
      ${sortThHtml('sessions','updated_at','활동','text-right')}
      <th class="text-center px-3 py-2.5 font-bold text-white/35 w-16 hide-sm">관리</th>
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
      ? tagList.map(t => `<span class="tag-badge">#${esc(t)}</span>`).join(' ')
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
      <td class="px-3 py-3 hide-sm"><span class="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/45 whitespace-nowrap">${esc(shortModel(s.model||''))}</span></td>
      <td class="px-3 py-3 text-right text-white/55 tabular-nums hide-sm">${fmtTok(s.total_input_tokens||0)}</td>
      <td class="px-3 py-3 text-right text-emerald-400/75 tabular-nums hide-sm">${fmtTok(s.total_output_tokens||0)}</td>
      <td class="px-3 py-3 text-right text-cyan-400/75 tabular-nums hide-sm" title="읽기 ${fmtN(s.total_cache_read_tokens||0)} / 생성 ${fmtN(s.total_cache_creation_tokens||0)}">${fmtTok(s.total_cache_read_tokens||0)}</td>
      <td class="px-3 py-3 text-right"><span class="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400/85 font-bold tabular-nums">${fmt$(s.total_cost_usd)}</span>${(()=>{const ms=s.turn_duration_ms||0;if(ms<=0||!(s.total_cost_usd>0))return '';const perHr=s.total_cost_usd/(ms/3600000);return '<div class="text-[9px] text-white/25 tabular-nums mt-0.5" title="비용 효율 ($/시간)">'+fmt$(perHr)+'/hr</div>';})()}</td>
      <td class="px-3 py-3 text-right hide-sm">
        <div class="tabular-nums text-white/70">${fmtN(mc)}</div>
        ${msgSubtext}
      </td>
      <td class="px-3 py-3 text-right">
        <div class="text-white/35">${relTime(s.updated_at)}</div>
        ${durLabel?`<div class="text-[9px] text-white/25 tabular-nums">${durLabel}</div>`:''}
      </td>
      <td class="px-3 py-3 text-center whitespace-nowrap hide-sm"></td>`;
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

