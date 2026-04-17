// ─── Search View ────────────────────────────────────────────────────────────
// Standalone search page: left panel (results) + right panel (3-section context).
// Does NOT touch state.convMessages — keeps conversations view unaffected.

let _srchRole = '';
let _srchTimer = null;
let _srchCurrentSid = null;
let _srchCurrentSession = null;

const _SRCH_CTX = 3; // messages before/after selected message

function srchInput(q) {
  clearTimeout(_srchTimer);
  if (q.trim().length < 2) { _srchClearResults(); return; }
  _srchTimer = setTimeout(() => _srchRun(q.trim()), 300);
}

function srchSetRole(role) {
  _srchRole = role;
  document.querySelectorAll('.srch-role-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.srchRole === role);
  });
  const q = (document.getElementById('srchInput')?.value || '').trim();
  if (q.length >= 2) _srchRun(q);
}

async function _srchRun(q) {
  const url = '/api/sessions/search?q=' + encodeURIComponent(q) +
    (_srchRole ? '&role=' + encodeURIComponent(_srchRole) : '') + '&limit=50';
  try {
    const data = await safeFetch(url);
    _srchRenderResults(Array.isArray(data) ? data : (data.results || []), q);
  } catch (e) {
    const el = document.getElementById('srchResultsList');
    if (!el) return;
    el.textContent = '';
    const p = document.createElement('p');
    p.className = 'text-red-400/70 text-xs p-3';
    p.textContent = '검색 실패: ' + (e.message || String(e));
    el.appendChild(p);
  }
}

function _srchClearResults() {
  const list = document.getElementById('srchResultsList');
  const count = document.getElementById('srchResultCount');
  if (list) list.textContent = '';
  if (count) count.textContent = '';
  _srchResetPanel();
  _srchCurrentSid = null;
  _srchCurrentSession = null;
}

function _srchResetPanel() {
  const hdr = document.getElementById('srch-convViewerHeader');
  const contextPane = document.getElementById('srch-contextPane');
  const emptyState = document.getElementById('srch-emptyState');
  const nav = document.getElementById('srch-convNavBar');
  if (hdr) hdr.textContent = '결과를 선택하면 전체 대화가 표시됩니다.';
  if (contextPane) contextPane.classList.add('hidden');
  if (emptyState) emptyState.classList.remove('hidden');
  if (nav) nav.classList.add('hidden');
  ['srch-prevMsgs', 'srch-selMsg', 'srch-nextMsgs'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '';
  });
  const prevSep = document.getElementById('srch-prevSep');
  if (prevSep) prevSep.classList.add('hidden');
  const nextSep = document.getElementById('srch-nextSep');
  if (nextSep) nextSep.classList.add('hidden');
}

const _SRCH_ROLE_LABEL = { user: '사용자', assistant: '어시스턴트', system: '시스템', tool: '도구' };
const _SRCH_ROLE_CLS = { user: 'bg-sky-500/15 text-sky-300', assistant: 'bg-emerald-500/15 text-emerald-300', system: 'bg-violet-500/15 text-violet-300', tool: 'bg-amber-500/15 text-amber-300' };

function _srchMakeCard(r, q) {
  const card = document.createElement('div');
  card.className = 'srch-result-card cursor-pointer px-3 py-2.5 rounded-lg hover:bg-white/5 spring border border-transparent';
  card.dataset.sid = String(r.session_id);
  card.dataset.mid = String(r.id);
  card.addEventListener('click', () => _srchOpenResult(String(r.session_id), String(r.id), card));

  const meta = document.createElement('div');
  meta.className = 'flex items-center gap-1.5 mb-1 flex-wrap';

  const role = r.role || '';
  const badge = document.createElement('span');
  badge.className = 'text-[10px] px-1.5 py-0.5 rounded-full ' + (_SRCH_ROLE_CLS[role] || 'bg-white/10 text-white/50');
  badge.textContent = _SRCH_ROLE_LABEL[role] || role;
  meta.appendChild(badge);

  if (r.project_name) {
    const proj = document.createElement('span');
    proj.className = 'text-white/50 truncate text-xs';
    proj.textContent = r.project_name;
    meta.appendChild(proj);
  }

  if (r.timestamp) {
    const ts = document.createElement('span');
    ts.className = 'text-white/30 shrink-0 text-xs';
    ts.textContent = r.timestamp.slice(0, 10);
    meta.appendChild(ts);
  }

  card.appendChild(meta);

  if (r.content_preview) {
    const preview = document.createElement('div');
    preview.className = 'text-white/60 text-xs leading-relaxed line-clamp-2';
    // safe: esc() applied before highlightTokens adds <mark> tags
    preview.innerHTML = highlightTokens(esc(r.content_preview.slice(0, 120)), q);
    card.appendChild(preview);
  }

  return card;
}

function _srchRenderResults(results, q) {
  const list = document.getElementById('srchResultsList');
  const count = document.getElementById('srchResultCount');
  if (!list) return;

  list.textContent = '';
  if (count) count.textContent = results.length > 0 ? results.length + '건' : '';

  if (results.length === 0) {
    const p = document.createElement('p');
    p.className = 'text-white/30 text-xs p-3 text-center';
    p.textContent = '검색 결과 없음';
    list.appendChild(p);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const r of results) frag.appendChild(_srchMakeCard(r, q));
  list.appendChild(frag);
}

// Render a single message with position badge into container
function _srchRenderContextMsg(container, m, posIdx, isSelected, allMsgs) {
  const row = document.createElement('div');
  row.className = 'flex gap-2 items-start';

  const badge = document.createElement('div');
  // FIX-004: badge opacity — selected bright emerald, context soft white
  badge.className = 'shrink-0 font-mono text-[9px] pt-2.5 w-7 text-right select-none ' +
    (isSelected ? 'text-emerald-400 font-semibold' : 'text-white/30');
  badge.textContent = '#' + (posIdx + 1);
  row.appendChild(badge);

  const msgWrap = document.createElement('div');
  msgWrap.className = 'flex-1 min-w-0 flex flex-col';
  _renderSingleMessage(msgWrap, m, allMsgs, null);
  row.appendChild(msgWrap);

  container.appendChild(row);
}

async function _srchOpenResult(sid, msgId, cardEl) {
  document.querySelectorAll('.srch-result-card').forEach(c => {
    c.classList.remove('active', 'bg-white/8', 'border-emerald-500/20');
  });
  if (cardEl) cardEl.classList.add('active', 'bg-white/8', 'border-emerald-500/20');

  const hdr = document.getElementById('srch-convViewerHeader');
  const contextPane = document.getElementById('srch-contextPane');
  const emptyState = document.getElementById('srch-emptyState');
  const nav = document.getElementById('srch-convNavBar');

  // Show loading state
  if (hdr) {
    hdr.textContent = '';
    const loading = document.createElement('span');
    loading.className = 'text-white/30 text-xs animate-pulse';
    loading.textContent = '로딩 중...';
    hdr.appendChild(loading);
  }
  if (contextPane) contextPane.classList.add('hidden');
  if (emptyState) emptyState.classList.add('hidden');
  if (nav) nav.classList.add('hidden');

  _srchCurrentSid = sid;

  try {
    const [s, pos] = await Promise.all([
      safeFetch('/api/sessions/' + encodeURIComponent(sid)),
      safeFetch('/api/sessions/' + encodeURIComponent(sid) + '/message-position?message_id=' + encodeURIComponent(msgId)),
    ]);
    _srchCurrentSession = s;

    const position = pos.position || 0; // 0-based absolute index
    const prevStart = Math.max(0, position - _SRCH_CTX);
    const prevCount = position - prevStart;
    const totalMsgs = s.message_count || 0;

    // Load prev + selected + next in two fetches
    const [prevData, selData] = await Promise.all([
      prevCount > 0
        ? safeFetch('/api/sessions/' + encodeURIComponent(sid) + '/messages?limit=' + prevCount + '&offset=' + prevStart)
        : Promise.resolve({ messages: [] }),
      safeFetch('/api/sessions/' + encodeURIComponent(sid) + '/messages?limit=' + (1 + _SRCH_CTX) + '&offset=' + position),
    ]);

    const prevMsgs = Array.isArray(prevData) ? prevData : (prevData.messages || []);
    const selAndNext = Array.isArray(selData) ? selData : (selData.messages || []);
    const selMsg = selAndNext[0] || null;
    const nextMsgs = selAndNext.slice(1);
    const allFetched = [...prevMsgs, ...selAndNext];

    // FIX-001: Render session header — visible, structured
    if (hdr) {
      hdr.textContent = '';
      const row = document.createElement('div');
      row.className = 'flex flex-wrap items-center gap-x-2.5 gap-y-1';

      const nameEl = document.createElement('span');
      nameEl.className = 'font-semibold text-white/85 text-sm leading-tight';
      nameEl.textContent = s.project_name || '알 수 없음';
      row.appendChild(nameEl);

      if (s.model) {
        const dot = document.createElement('span');
        dot.className = 'text-white/20 text-xs';
        dot.textContent = '·';
        row.appendChild(dot);
        const modelEl = document.createElement('span');
        modelEl.className = 'text-white/45 text-xs font-mono';
        modelEl.textContent = s.model;
        row.appendChild(modelEl);
      }

      if (s.total_cost_usd != null) {
        const dot2 = document.createElement('span');
        dot2.className = 'text-white/20 text-xs';
        dot2.textContent = '·';
        row.appendChild(dot2);
        const costEl = document.createElement('span');
        costEl.className = 'text-emerald-400/80 text-xs';
        costEl.textContent = '$' + Number(s.total_cost_usd).toFixed(4);
        row.appendChild(costEl);
      }

      hdr.appendChild(row);
    }

    // FIX-002: Show/hide "이전 메시지" top separator
    const prevSep = document.getElementById('srch-prevSep');
    if (prevSep) prevSep.classList.toggle('hidden', prevMsgs.length === 0);

    // Render prev messages
    const prevEl = document.getElementById('srch-prevMsgs');
    if (prevEl) {
      prevEl.textContent = '';
      for (let i = 0; i < prevMsgs.length; i++) {
        _srchRenderContextMsg(prevEl, prevMsgs[i], prevStart + i, false, allFetched);
      }
    }

    // Render selected message
    const selEl = document.getElementById('srch-selMsg');
    if (selEl) {
      selEl.textContent = '';
      if (selMsg) _srchRenderContextMsg(selEl, selMsg, position, true, allFetched);
    }

    // Render next messages
    const nextEl = document.getElementById('srch-nextMsgs');
    const nextSep = document.getElementById('srch-nextSep');
    if (nextEl) {
      nextEl.textContent = '';
      if (nextMsgs.length > 0) {
        for (let i = 0; i < nextMsgs.length; i++) {
          _srchRenderContextMsg(nextEl, nextMsgs[i], position + 1 + i, false, allFetched);
        }
        if (nextSep) nextSep.classList.remove('hidden');
      } else {
        if (nextSep) nextSep.classList.add('hidden');
      }
    }

    // Show context pane
    if (contextPane) contextPane.classList.remove('hidden');
    if (emptyState) emptyState.classList.add('hidden');

    // Nav bar + FIX-006: thread position track
    const msgCount = document.getElementById('srch-convMsgCount');
    const posInfo = document.getElementById('srch-convPosInfo');
    const posTrack = document.getElementById('srch-posTrack');
    if (msgCount) msgCount.textContent = totalMsgs ? totalMsgs + '개 메시지' : '';
    if (posInfo) posInfo.textContent = '#' + (position + 1);
    if (posTrack && totalMsgs > 0) {
      const pct = Math.round(((position + 1) / totalMsgs) * 100);
      posTrack.style.left = Math.max(0, Math.min(pct, 98)) + '%';
      posTrack.title = '전체 대화의 ' + pct + '% 위치';
    }
    if (nav) nav.classList.remove('hidden');

  } catch (e) {
    if (hdr) {
      hdr.textContent = '';
      const err = document.createElement('span');
      err.className = 'text-red-400/70 text-xs';
      err.textContent = '로딩 실패: ' + (e.message || String(e));
      hdr.appendChild(err);
    }
    if (emptyState) emptyState.classList.remove('hidden');
  }
}

function openConversationFromSearch() {
  if (!_srchCurrentSid) return;
  showView('conversations');
  if (typeof openConversation === 'function') openConversation(_srchCurrentSid, _srchCurrentSession);
}
