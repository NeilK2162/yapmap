// The side panel on a canvas: ask the video anything (answers stream in and
// cite the second they came from), or read the whole transcript, following
// along as it plays. One panel for the app; it closes when you leave a canvas.

import { h, fmt, toast, richText, highlight, normalizeText, clockTime, debounce } from './util.js';
import { askHistory, clearAsk, getTranscript, isStatic } from './api.js';
import { startJob, subscribe, cancelJob } from './jobs.js';
import { jumpTo, onTime } from './player.js';

let panel = null;

export function openDrawer({ canvas, tab = 'ask', question = null }) {
  if (!panel || panel.videoId !== canvas.video_id) {
    if (panel) panel.destroy();
    panel = buildPanel(canvas);
  }
  panel.open(tab);
  if (question) panel.ask(question);
}

/** Hide the panel; its conversation stays for when it opens again. */
export function closeDrawer() {
  if (panel) panel.close();
}

/** Throw the panel away -- leaving the canvas it belongs to. */
export function resetDrawer() {
  if (panel) { panel.destroy(); panel = null; }
}

export const drawerOpen = () => !!(panel && panel.isOpen());

function buildPanel(canvas) {
  const videoId = canvas.video_id;
  const cleanups = [];
  let tab = 'ask';

  // ─── frame ──────────────────────────────────────────────────────────────
  const tabs = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Panel' });
  const askTab = h('button', { type: 'button', role: 'tab', id: 'dr-tab-ask', 'aria-controls': 'dr-ask', onclick: () => show('ask') }, '💬 ask');
  const trTab = h('button', { type: 'button', role: 'tab', id: 'dr-tab-tr', 'aria-controls': 'dr-tr', onclick: () => show('transcript') }, '📜 transcript');
  tabs.append(askTab, trTab);
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close the panel', onclick: () => closeDrawer() }, '✕');

  const askPane = h('div', { class: 'dr-pane', id: 'dr-ask', role: 'tabpanel', 'aria-labelledby': 'dr-tab-ask' });
  const trPane = h('div', { class: 'dr-pane', id: 'dr-tr', role: 'tabpanel', 'aria-labelledby': 'dr-tab-tr', hidden: true });
  const el = h('aside', { class: 'drawer', 'aria-label': 'Ask the video, or read its transcript' },
    h('div', { class: 'dr-head' }, tabs, h('span', { class: 'dr-title' }, canvas.headline || canvas.title), closeBtn),
    askPane, trPane,
  );
  document.body.appendChild(el);

  const onKey = (e) => { if (e.key === 'Escape' && isOpen() && !e.defaultPrevented && !e.target.closest('.map-card')) closeDrawer(); };
  document.addEventListener('keydown', onKey);
  cleanups.push(() => document.removeEventListener('keydown', onKey));

  function isOpen() { return el.classList.contains('open'); }
  function close() {
    el.classList.remove('open');
    document.body.classList.remove('drawer-open');
  }
  function open(which) {
    el.classList.add('open');
    document.body.classList.add('drawer-open');
    show(which);
  }
  function show(which) {
    tab = which;
    askTab.setAttribute('aria-selected', String(which === 'ask'));
    trTab.setAttribute('aria-selected', String(which === 'transcript'));
    askTab.classList.toggle('on', which === 'ask');
    trTab.classList.toggle('on', which === 'transcript');
    askPane.hidden = which !== 'ask';
    trPane.hidden = which !== 'transcript';
    if (which === 'ask') { loadHistory(); setTimeout(() => input.focus(), 60); } else loadTranscript();
  }

  // ─── ask ────────────────────────────────────────────────────────────────
  const thread = h('div', { class: 'thread', 'aria-live': 'polite' });
  const suggestions = h('div', { class: 'suggest' });
  const input = h('textarea', {
    class: 'field', rows: '2', maxlength: '600', 'aria-label': 'Your question',
    placeholder: isStatic() ? 'asking new questions needs the local app' : 'ask anything about this video…',
  });
  const send = h('button', { class: 'cta sm', type: 'submit' }, 'ask');
  const clearBtn = h('button', {
    class: 'mini', type: 'button', hidden: true,
    onclick: async () => {
      try { await clearAsk(videoId); history = []; renderThread(); toast('chat cleared'); } catch (e) { toast(e.message); }
    },
  }, 'clear chat');
  const form = h('form', {
    class: 'ask-form',
    onsubmit: (e) => { e.preventDefault(); const q = input.value.trim(); if (q) ask(q); else input.focus(); },
  }, input, h('div', { class: 'ask-row' },
    h('span', { class: 'hint' }, 'answers cite the moment they came from · enter to send'),
    clearBtn, send,
  ));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  askPane.append(
    h('p', { class: 'dr-intro' }, 'Ask it anything. Claude answers from the transcript and cites every moment — tap one to hear it.'),
    thread, suggestions, form,
  );

  let history = null;
  let historyLoad = null;
  let live = null; // the answer being written right now

  function loadHistory() {
    if (!historyLoad) {
      historyLoad = askHistory(videoId)
        .then((res) => { history = res.items || []; })
        .catch(() => { history = []; })
        .then(renderThread);
    }
    return historyLoad;
  }

  const play = (t) => jumpTo(videoId, t, { title: canvas.headline });

  function qa(item) {
    return h('div', { class: 'qa' },
      h('div', { class: 'q' }, item.q),
      h('div', { class: 'a' }, richText(item.a, play),
        h('div', { class: 'a-foot' },
          item.at ? h('span', null, clockTime(item.at)) : null,
          item.partial ? h('span', { title: 'Long video: Claude read the parts that match your question best' }, 'searched the transcript') : null,
        ),
      ),
    );
  }

  function renderThread() {
    const items = history || [];
    thread.replaceChildren(...items.map(qa), live ? live.el : null);
    clearBtn.hidden = !items.length || isStatic();
    const qs = (canvas.questions || []).filter((q) => !items.some((it) => it.q === q)).slice(0, 5);
    suggestions.replaceChildren(
      qs.length ? h('small', null, items.length ? 'more to ask' : 'try one') : null,
      ...qs.map((q) => h('button', { type: 'button', class: 'chip', onclick: () => ask(q) }, q)),
    );
    if (!items.length && !live && isStatic()) {
      thread.append(h('p', { class: 'hint' }, 'No demo answers for this one yet — on your own machine you can ask it anything.'));
    }
    thread.scrollTop = thread.scrollHeight;
  }

  async function ask(question) {
    if (live && live.running) { toast('one question at a time — it’s still answering'); return; }
    input.value = '';
    const answer = h('div', { class: 'a streaming' }, h('p', { class: 'typing' }, h('span', { class: 'pulse-dot' }), ' reading the transcript…'));
    const stop = h('button', { class: 'mini', type: 'button', onclick: () => live && live.rec && cancelJob(live.rec) }, 'stop');
    const card = h('div', { class: 'qa' }, h('div', { class: 'q' }, question), answer, h('div', { class: 'a-foot' }, stop));
    live = { el: card, running: true, text: '' };
    renderThread();
    send.disabled = true;
    const finish = () => { live = null; send.disabled = false; };
    try {
      const rec = await startJob('ask', { video_id: videoId, question, lang: canvas.lang });
      live.rec = rec;
      let pending = false;
      const paint = () => {
        pending = false;
        if (!live) return;
        answer.replaceChildren(richText(live.text, play));
        thread.scrollTop = thread.scrollHeight;
      };
      const off = subscribe(rec, (evt) => {
        if (!live) return;
        if (evt.type === 'delta') {
          live.text += evt.text;
          if (!pending) { pending = true; requestAnimationFrame(paint); }
        } else if (evt.type === 'stage' && (evt.stage === 'reading' || evt.stage === 'thinking')) {
          answer.replaceChildren(h('p', { class: 'typing' }, h('span', { class: 'pulse-dot' }), ' thinking…'));
        } else if (evt.type === 'warning') {
          toast(evt.message);
        } else if (evt.type === 'done') {
          history = [...(history || []), evt.result];
          finish();
          off();
          renderThread();
        } else if (evt.type === 'error' || evt.type === 'cancelled' || evt.type === 'lost') {
          const message = evt.type === 'cancelled' ? 'Stopped.' : evt.message;
          answer.replaceChildren(
            live.text ? richText(live.text, play) : null,
            h('p', { class: 'a-error' }, message),
            evt.type !== 'cancelled' ? h('button', { class: 'mini', type: 'button', onclick: () => { card.remove(); ask(question); } }, 'try again') : null,
          );
          stop.remove();
          live.running = false;
          const keep = card;
          finish();
          off();
          thread.append(keep);
        }
      });
      cleanups.push(off);
    } catch (e) {
      answer.replaceChildren(h('p', { class: 'a-error' }, e.message), e.needsInstall ? h('a', { class: 'mini', href: '#/extras' }, 'how to install →') : null);
      stop.remove();
      const keep = card;
      finish();
      thread.append(keep);
    }
  }

  // ─── transcript ─────────────────────────────────────────────────────────
  const trSearch = h('input', { class: 'field sm', type: 'search', placeholder: 'search what they said…', 'aria-label': 'Search the transcript' });
  const trCount = h('span', { class: 'mm-count' });
  const followBtn = h('button', { class: 'mini on', type: 'button', 'aria-pressed': 'true', onclick: () => {
    const on = followBtn.getAttribute('aria-pressed') !== 'true';
    followBtn.setAttribute('aria-pressed', String(on));
    followBtn.classList.toggle('on', on);
  } }, '◉ follow the video');
  const trList = h('div', { class: 'tr-list' });
  trPane.append(h('div', { class: 'tr-tools' }, trSearch, trCount, followBtn), trList);

  let blocks = null;
  let rows = [];
  async function loadTranscript() {
    if (blocks) return;
    trList.replaceChildren(h('p', { class: 'hint' }, 'loading the transcript…'));
    try {
      const data = await getTranscript(videoId);
      blocks = data.blocks || [];
      renderTranscript();
    } catch (e) {
      trList.replaceChildren(h('p', { class: 'hint' }, isStatic() ? 'This demo video’s transcript isn’t bundled.' : e.message));
    }
  }
  function renderTranscript() {
    const terms = normalizeText(trSearch.value.trim()).split(/\s+/).filter(Boolean);
    let hits = 0;
    rows = blocks.map((b) => {
      const match = terms.length && terms.every((t) => normalizeText(b.text).includes(t));
      if (match) hits += 1;
      return h('button', {
        type: 'button', class: 'tr-row' + (match ? ' match' : ''), 'data-t': String(b.t),
        onclick: () => jumpTo(videoId, b.t, { title: canvas.headline }),
      }, h('span', { class: 'ex-t' }, fmt(b.t)), h('span', null, terms.length ? highlight(b.text, terms) : b.text));
    });
    trList.replaceChildren(...rows);
    trCount.textContent = terms.length ? `${hits} ${hits === 1 ? 'match' : 'matches'}` : `${blocks.length} lines`;
    const first = trList.querySelector('.tr-row.match');
    if (first) first.scrollIntoView({ block: 'center' });
  }
  trSearch.addEventListener('input', debounce(() => blocks && renderTranscript(), 180));

  let lastRow = null;
  const offTime = onTime((t, vid) => {
    if (vid !== videoId || !rows.length) return;
    let idx = -1;
    for (let i = 0; i < blocks.length; i += 1) { if (blocks[i].t <= t + 0.3) idx = i; else break; }
    const row = rows[idx];
    if (row === lastRow) return;
    if (lastRow) lastRow.classList.remove('now');
    lastRow = row;
    if (!row) return;
    row.classList.add('now');
    if (followBtn.getAttribute('aria-pressed') === 'true' && isOpen() && tab === 'transcript') row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  cleanups.push(offTime);

  return {
    videoId,
    open,
    close,
    isOpen,
    ask: (q) => { show('ask'); loadHistory().then(() => ask(q)); },
    destroy() {
      cleanups.forEach((fn) => { try { fn(); } catch (e) { /* gone */ } });
      el.remove();
      document.body.classList.remove('drawer-open');
    },
  };
}
