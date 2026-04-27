// ─── timeline-card.js — per-session timeline card list ─────────────────
// Renders /api/sessions/{sid}/timeline events as DOM cards in ts ASC order
// and live-appends new events via /ws { type: 'timeline_event' }.
// DOM-safe: createElement + textContent only. No innerHTML, no template
// strings → ADR-005 / ADR-013 compliant.
//
// Concatenated by build.js, so `class TimelineCard` is exposed as a global.
// Activated by app.js when ?view=timeline is in the URL.

// Per-event-type body renderers. Adding a new event_type = one-line append.
// Each renderer receives (body, payload) and mutates `body` in place.
// `card` is also passed for handlers that need to attach extra children
// (e.g. subagent_dispatch's child-session link).
const _TC_RENDERERS = {
  tool_use: (body, p) => {
    const tool = p.tool || p.name || '?';
    const preview = p.input_preview || p.preview || '';
    body.textContent = `${tool}  ${preview}`;
  },
  permission_prompt: (body, p) => {
    const tool = p.tool || '?';
    const message = p.message || p.reason || '';
    body.textContent = `${tool} 권한 — ${message}`;
  },
  subagent_dispatch: (body, p) => {
    const agent = p.agent_type || '?';
    const desc = p.description || '';
    const arrowLine = document.createElement('div');
    arrowLine.textContent = `→ ${agent}  ${desc}`;
    body.appendChild(arrowLine);
    if (p.child_session_id) {
      const linkWrap = document.createElement('div');
      linkWrap.className = 'mt-1 text-[10px]';
      const link = document.createElement('a');
      const childId = p.child_session_id;
      link.href = `/app/session/${encodeURIComponent(childId)}?view=timeline`;
      link.className = 'text-accent/85 hover:text-accent underline font-mono';
      link.textContent = `child: ${String(childId).slice(0, 8)}`;
      linkWrap.appendChild(link);
      body.appendChild(linkWrap);
    }
  },
  message_user: (body, p) => { body.textContent = p.preview || ''; },
  message_assistant: (body, p) => { body.textContent = p.preview || ''; },
  end_turn: (body, p) => { body.textContent = `(입력 대기) ${p.preview || ''}`; },
  session_start: (body, p) => { body.textContent = `시작  ${p.cwd || ''}`; },
  session_stop: (body, p) => { body.textContent = `종료  ${p.reason || ''}`; },
};

function _tcDefaultRender(body, payload) {
  try {
    body.textContent = JSON.stringify(payload).slice(0, 120);
  } catch {
    body.textContent = '';
  }
}

class TimelineCard {
  constructor(container) {
    this.container = container;
    this.events = [];   // [{id, event_type, ts, payload, source}]
    this.ws = null;
    this.sid = null;
    this._listEl = null;
  }

  async load(sid) {
    this.sid = sid;
    // Reset DOM target
    this.container.textContent = '';
    const list = document.createElement('div');
    list.className = 'tl-card-list flex flex-col gap-2 p-4';
    this._listEl = list;
    this.container.appendChild(list);

    const loading = document.createElement('div');
    loading.className = 'text-center text-white/25 text-xs py-10 dots';
    loading.textContent = '타임라인 로딩 중';
    list.appendChild(loading);

    let data;
    try {
      const url = `/api/sessions/${encodeURIComponent(sid)}/timeline?limit=200`;
      const resp = await fetch(url, { credentials: 'same-origin' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      data = await resp.json();
    } catch (err) {
      list.textContent = '';
      const fail = document.createElement('div');
      fail.className = 'text-center text-white/25 text-xs py-10';
      fail.textContent = '타임라인 로딩 실패';
      list.appendChild(fail);
      return;
    }

    list.textContent = '';
    const events = (data.events || []).slice();
    // API returns ASC by id which mirrors ts. Sort defensively by ts then id.
    // ts is an ISO 8601 string — lexicographic compare matches chronological.
    events.sort((a, b) => {
      if (a.ts !== b.ts) return (a.ts < b.ts) ? -1 : 1;
      return (a.id || 0) - (b.id || 0);
    });
    if (!events.length) {
      const empty = document.createElement('div');
      empty.className = 'text-center text-white/25 text-xs py-10';
      empty.textContent = '이벤트 없음';
      list.appendChild(empty);
    } else {
      for (const ev of events) {
        list.appendChild(this._cardFor(ev));
      }
    }
    this.events = events;
    this._subscribeWs(sid);
  }

  _cardFor(ev) {
    const card = document.createElement('div');
    card.className = 'tl-card border border-white/[0.07] bg-white/[0.02] rounded-md px-3 py-2 text-[11px]';
    card.dataset.eventId = String(ev.id || '');
    card.dataset.eventType = ev.event_type || '';

    const header = document.createElement('div');
    header.className = 'tl-header flex items-center gap-2 text-[10px] text-white/45 mb-1 tabular-nums';

    const timeEl = document.createElement('span');
    timeEl.className = 'tl-time text-white/55 font-mono';
    timeEl.textContent = TimelineCard._fmtTime(ev.ts);
    header.appendChild(timeEl);

    const typeEl = document.createElement('span');
    typeEl.className = 'tl-type uppercase tracking-wider text-accent/80 font-bold';
    typeEl.textContent = ev.event_type || 'event';
    header.appendChild(typeEl);

    if (ev.source) {
      const srcEl = document.createElement('span');
      srcEl.className = 'tl-source text-white/30';
      srcEl.textContent = ev.source;
      header.appendChild(srcEl);
    }

    const body = document.createElement('div');
    body.className = 'tl-body text-white/75 whitespace-pre-wrap break-words';

    const payload = (ev.payload && typeof ev.payload === 'object') ? ev.payload : {};
    const renderer = _TC_RENDERERS[ev.event_type] || _tcDefaultRender;
    renderer(body, payload);

    card.appendChild(header);
    card.appendChild(body);
    return card;
  }

  static _fmtTime(ts) {
    if (!ts && ts !== 0) return '--:--:--';
    // Accept ISO 8601 strings ("2026-04-27T12:00:00Z") or numerics
    // (epoch seconds or ms). String × 1000 = NaN — must branch on type.
    let d;
    if (typeof ts === 'number') {
      d = new Date(ts > 1e12 ? ts : ts * 1000);
    } else {
      d = new Date(ts);
    }
    if (isNaN(d.getTime())) return '--:--:--';
    // Slice HH:MM:SS out of "YYYY-MM-DDTHH:MM:SS.sssZ"
    return d.toISOString().slice(11, 19);
  }

  _subscribeWs(sid) {
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.ws = new WebSocket(`${proto}//${location.host}/ws`);
    } catch (e) {
      console.warn('TimelineCard WS create failed:', e);
      return;
    }
    this.ws.onopen = () => {
      try {
        this.ws.send(JSON.stringify({ type: 'subscribe_timeline', session_id: sid }));
      } catch {}
    };
    this.ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (!m || m.type !== 'timeline_event') return;
      if (m.session_id !== this.sid) return;
      const ev = m.event;
      if (!ev) return;
      // Avoid duplicate appends when REST + WS overlap
      if (ev.id && this.events.some(x => x.id === ev.id)) return;
      this.events.push(ev);
      if (this._listEl) {
        this._listEl.appendChild(this._cardFor(ev));
        // Auto-scroll bottom
        this.container.scrollTop = this.container.scrollHeight;
      }
    };
    this.ws.onerror = () => { /* swallow; user gets stale view, no crash */ };
  }

  destroy() {
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN && this.sid) {
          this.ws.send(JSON.stringify({ type: 'unsubscribe_timeline', session_id: this.sid }));
        }
      } catch {}
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.events = [];
    this._listEl = null;
    this.sid = null;
  }
}

// Expose for callers (window-scoped after build.js concat)
window.TimelineCard = TimelineCard;
