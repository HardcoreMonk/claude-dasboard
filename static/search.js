// ─── Search View ────────────────────────────────────────────────────────────
// Standalone search page: left panel (results) + right panel (conversation).
// Does NOT touch state.convMessages — keeps conversations view unaffected.

let _srchRole = '';
let _srchTimer = null;
let _srchCurrentSid = null;
let _srchCurrentSession = null;

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
    const results = await safeFetch(url);
    _srchRenderResults(Array.isArray(results) ? results : [], q);
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
  const hdr = document.getElementById('srch-convViewerHeader');
  if (hdr) hdr.textContent = '';
  const nav = document.getElementById('srch-convNavBar');
  if (nav) nav.classList.add('hidden');
  const msgs = document.getElementById('srch-convMessages');
  if (msgs) msgs.textContent = '';
  _srchCurrentSid = null;
  _srchCurrentSession = null;
}

const _SRCH_ROLE_LABEL = { user: '사용자', assistant: '어시스턴트', system: '시스템', tool: '도구' };
const _SRCH_ROLE_CLS = { user: 'bg-sky-500/15 text-sky-300', assistant: 'bg-emerald-500/15 text-emerald-300', system: 'bg-violet-500/15 text-violet-300', tool: 'bg-amber-500/15 text-amber-300' };

function _srchMakeCard(r, q) {
  const card = document.createElement('div');
  card.className = 'srch-result-card cursor-pointer px-3 py-2.5 rounded-lg hover:bg-white/5 spring border border-transparent';
  card.dataset.sid = String(r.session_id);
  card.dataset.mid = String(r.message_id);
  card.addEventListener('click', () => _srchOpenResult(String(r.session_id), String(r.message_id), card));

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

async function _srchOpenResult(sid, msgId, cardEl) {
  document.querySelectorAll('.srch-result-card').forEach(c => {
    c.classList.remove('active', 'bg-white/8', 'border-emerald-500/20');
  });
  if (cardEl) cardEl.classList.add('active', 'bg-white/8', 'border-emerald-500/20');

  const hdr = document.getElementById('srch-convViewerHeader');
  const msgs = document.getElementById('srch-convMessages');
  const nav = document.getElementById('srch-convNavBar');
  if (msgs) msgs.textContent = '';
  if (nav) nav.classList.add('hidden');
  if (hdr) {
    hdr.textContent = '';
    const loading = document.createElement('span');
    loading.className = 'text-white/30 text-xs animate-pulse';
    loading.textContent = '로딩 중...';
    hdr.appendChild(loading);
  }
  _srchCurrentSid = sid;

  try {
    const [s, pos] = await Promise.all([
      safeFetch('/api/sessions/' + encodeURIComponent(sid)),
      safeFetch('/api/sessions/' + encodeURIComponent(sid) + '/message-position?message_id=' + encodeURIComponent(msgId)),
    ]);
    _srchCurrentSession = s;

    const targetOffset = Math.max(0, (pos.position || 0) - 50);
    const localIdx = (pos.position || 0) - targetOffset;

    const data = await safeFetch('/api/sessions/' + encodeURIComponent(sid) + '/messages?limit=500&offset=' + targetOffset);
    const allMsgs = Array.isArray(data) ? data : (data.messages || []);

    if (hdr) {
      hdr.textContent = '';
      const row = document.createElement('div');
      row.className = 'flex flex-wrap items-center gap-x-3 gap-y-1';

      const nameEl = document.createElement('span');
      nameEl.className = 'font-semibold text-white/80 text-sm';
      nameEl.textContent = s.project_name || '알 수 없음';
      row.appendChild(nameEl);

      if (s.model) {
        const modelEl = document.createElement('span');
        modelEl.className = 'text-white/40 text-xs';
        modelEl.textContent = s.model;
        row.appendChild(modelEl);
      }

      if (s.total_cost_usd != null) {
        const costEl = document.createElement('span');
        costEl.className = 'text-emerald-400 text-xs';
        costEl.textContent = '$' + Number(s.total_cost_usd).toFixed(4);
        row.appendChild(costEl);
      }

      if (s.message_count != null) {
        const cntEl = document.createElement('span');
        cntEl.className = 'text-white/30 text-xs';
        cntEl.textContent = String(s.message_count) + '개 메시지';
        row.appendChild(cntEl);
      }

      hdr.appendChild(row);
    }

    if (msgs) {
      msgs.textContent = '';
      let prevBr = null;
      for (const m of allMsgs) {
        _renderTimeGap(msgs, m, prevBr);
        _renderSingleMessage(msgs, m, allMsgs, prevBr);
        prevBr = m;
      }
    }

    const msgCount = document.getElementById('srch-convMsgCount');
    if (msgCount) msgCount.textContent = allMsgs.length + '개 메시지 (offset ' + targetOffset + ')';
    if (nav) nav.classList.remove('hidden');

    setTimeout(() => {
      if (!msgs) return;
      const allEls = msgs.querySelectorAll('[data-msg-role]');
      const target = allEls[localIdx];
      if (target) {
        target.classList.add('conv-msg-focused');
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 80);

  } catch (e) {
    if (hdr) {
      hdr.textContent = '';
      const err = document.createElement('span');
      err.className = 'text-red-400/70 text-xs';
      err.textContent = '로딩 실패: ' + (e.message || String(e));
      hdr.appendChild(err);
    }
  }
}

function openConversationFromSearch() {
  if (!_srchCurrentSid) return;
  showView('conversations');
  if (typeof openConversation === 'function') openConversation(_srchCurrentSid, _srchCurrentSession);
}
