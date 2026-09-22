// One YouTube player for the whole app. It lives in the dock: small for
// timestamp jumps, full-screen "theater" for the no-yap cut. Growing and
// shrinking the dock only resizes the iframe -- moving it in the DOM would
// reload the video.

import { h, fmt, fmtDur, toast, ytUrl } from './util.js';
import { logEvent } from './store.js';

const yt = { player: null, ready: false, whenReady: null, videoId: null, apiPromise: null };
const listeners = new Set();
let ticker = null;
let cut = null;

const dockEl = () => document.getElementById('dock');

export function initDock() {
  document.getElementById('dock-min').addEventListener('click', () => {
    if (cut) return exitTheater();
    dockEl().classList.toggle('min');
  });
  document.getElementById('dock-close').addEventListener('click', closeDock);
  document.addEventListener('keydown', (e) => {
    if (!cut || !dockEl().classList.contains('theater')) return;
    if (e.target.closest && e.target.closest('input,textarea')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeDock(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepClip(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); stepClip(-1); }
    else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  });
}

function showDock(state, title) {
  const d = dockEl();
  d.hidden = false;
  d.classList.remove('min', 'theater');
  if (state === 'theater') d.classList.add('theater');
  document.getElementById('dock-title').textContent = title || 'the tape';
  document.getElementById('dock-min').textContent = state === 'theater' ? '▭' : '▁';
  document.getElementById('dock-min').setAttribute('aria-label', state === 'theater' ? 'Shrink to the mini player' : 'Minimise player');
}

function closeDock() {
  if (cut) cut = null;
  try { if (yt.player && yt.ready) yt.player.pauseVideo(); } catch (e) { /* player gone */ }
  dockEl().hidden = true;
  dockEl().classList.remove('theater', 'min');
  stopTickerIfIdle();
}

function exitTheater() {
  cut = null;
  showDock('mini', 'the tape');
  stopTickerIfIdle();
}

function loadApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (yt.apiPromise) return yt.apiPromise;
  yt.apiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (typeof previous === 'function') previous(); resolve(); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => reject(new Error('blocked'));
    document.head.appendChild(s);
    setTimeout(() => { if (!(window.YT && window.YT.Player)) reject(new Error('timeout')); }, 9000);
  });
  yt.apiPromise.catch(() => { yt.apiPromise = null; });
  return yt.apiPromise;
}

function createPlayer(videoId, start) {
  yt.videoId = videoId;
  yt.whenReady = new Promise((resolve, reject) => {
    yt.player = new window.YT.Player('player', {
      videoId,
      playerVars: { rel: 0, modestbranding: 1, playsinline: 1, autoplay: 1, start: Math.floor(start || 0) },
      events: {
        onReady: () => { yt.ready = true; try { yt.player.playVideo(); } catch (e) { /* autoplay refused */ } resolve(); },
        onError: (e) => { if (!yt.ready) reject(new Error('player ' + e.data)); else embedFailed(e.data); },
      },
    });
  });
  return yt.whenReady;
}

async function goTo(videoId, start) {
  await loadApi();
  if (!yt.player) { await createPlayer(videoId, start); return; }
  await yt.whenReady;
  if (yt.videoId !== videoId) {
    yt.videoId = videoId;
    yt.player.loadVideoById({ videoId, startSeconds: start || 0 });
  } else {
    yt.player.seekTo(start || 0, true);
    yt.player.playVideo();
  }
}

function embedFailed(code) {
  const vid = yt.videoId;
  cut = null;
  showDock('mini', "can't play this one here");
  const body = document.querySelector('#dock .dock-body');
  const note = h('div', { class: 'cut-done' },
    h('p', null, code === 101 || code === 150 ? 'This creator switched off embedding, so it has to play on YouTube.' : 'The player tripped over this video.'),
    h('a', { class: 'ghost', href: ytUrl(vid), target: '_blank', rel: 'noopener' }, 'open on youtube ↗'),
  );
  note.style.cssText = 'position:absolute;inset:0;display:grid;place-content:center;background:var(--panel);';
  body.style.position = 'relative';
  body.querySelectorAll('.cut-done').forEach((n) => n.remove());
  body.appendChild(note);
}

function clearEmbedNote() {
  document.querySelectorAll('#dock .dock-body .cut-done').forEach((n) => n.remove());
}

export function openAt(videoId, t) {
  window.open(ytUrl(videoId, t), '_blank', 'noopener');
}

/** Jump the (mini) player to a moment. Falls back to a YouTube tab if the embed API is blocked. */
export async function jumpTo(videoId, t, { title } = {}) {
  if (cut) cut = null;
  clearEmbedNote();
  showDock('mini', title ? '▶ ' + title : 'the tape');
  try {
    await goTo(videoId, t);
  } catch (e) {
    dockEl().hidden = true;
    toast("the player couldn't load — opening YouTube instead");
    openAt(videoId, t);
  }
}

export const currentVideo = () => yt.videoId;

// ─── time listeners (timeline sync, the cut) ─────────────────────────────
export function onTime(cb) {
  listeners.add(cb);
  startTicker();
  return () => { listeners.delete(cb); stopTickerIfIdle(); };
}

function startTicker() {
  if (!ticker) ticker = setInterval(tick, 250);
}
function stopTickerIfIdle() {
  if (ticker && !listeners.size && !cut) { clearInterval(ticker); ticker = null; }
}
function currentTime() {
  try { return yt.player && yt.ready ? yt.player.getCurrentTime() : null; } catch (e) { return null; }
}
function tick() {
  const t = currentTime();
  if (t === null) return;
  if (cut && !dockEl().hidden) cutTick(t);
  listeners.forEach((cb) => { try { cb(t, yt.videoId); } catch (e) { /* a listener's bug is its own */ } });
}

// ─── the no-yap cut ──────────────────────────────────────────────────────
/**
 * segments: [{start, end, label}] sorted and non-overlapping.
 * Plays each clip back to back in the real YouTube player -- the creator
 * still gets the view, which is the one thing summaries take from them.
 */
export async function playCut({ videoId, title, segments, duration }) {
  if (!segments.length) { toast('no timestamps to cut from'); return; }
  const total = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  cut = { videoId, title, segs: segments, i: 0, total, duration, done: false, settleUntil: 0, ui: {} };
  clearEmbedNote();
  showDock('theater', 'the no-yap cut');
  renderCut();
  logEvent('cut', { video_id: videoId });
  try {
    await goTo(videoId, segments[0].start);
    cut && (cut.settleUntil = Date.now() + 1200);
  } catch (e) {
    closeDock();
    toast("the player couldn't load — opening YouTube instead");
    openAt(videoId, segments[0].start);
    return;
  }
  startTicker();
}

function seekClip(i) {
  if (!cut) return;
  cut.i = Math.max(0, Math.min(cut.segs.length - 1, i));
  cut.done = false;
  cut.settleUntil = Date.now() + 1000;
  try { yt.player.seekTo(cut.segs[cut.i].start, true); yt.player.playVideo(); } catch (e) { /* not ready */ }
  renderCut();
}

function stepClip(delta) {
  if (!cut) return;
  if (cut.done && delta < 0) return seekClip(cut.segs.length - 1);
  seekClip(cut.i + delta);
}

function togglePlay() {
  if (!yt.player || !yt.ready) return;
  try { yt.player.getPlayerState() === 1 ? yt.player.pauseVideo() : yt.player.playVideo(); } catch (e) { /* ignore */ }
}

function cutTick(t) {
  if (!cut || cut.done || yt.videoId !== cut.videoId) return;
  if (Date.now() < cut.settleUntil) { updateCutProgress(t); return; }
  const segs = cut.segs;
  const inside = (s) => t >= s.start - 1.5 && t < s.end - 0.25;
  if (inside(segs[cut.i])) { updateCutProgress(t); return; }
  const found = segs.findIndex(inside);
  if (found !== -1) { cut.i = found; renderCut(); updateCutProgress(t); return; }
  const next = segs.findIndex((s) => s.start > t);
  if (next === -1) { finishCut(); return; }
  cut.i = next;
  cut.settleUntil = Date.now() + 1000;
  try { yt.player.seekTo(segs[next].start, true); } catch (e) { /* ignore */ }
  renderCut();
}

function finishCut() {
  cut.done = true;
  try { yt.player.pauseVideo(); } catch (e) { /* ignore */ }
  renderCut();
}

function renderCut() {
  if (!cut) return;
  const panel = document.getElementById('cut-panel');
  const bar = document.getElementById('cut-bar');
  const { segs, i, total, duration } = cut;

  if (cut.done) {
    const saved = Math.max(0, (duration || 0) - total);
    panel.replaceChildren(h('div', { class: 'cut-done' },
      h('h4', null, "that's the cut."),
      h('p', null, duration
        ? `${fmtDur(duration)} of video → ${fmtDur(total)}. That's ~${fmtDur(saved)} of yap you didn't sit through.`
        : `${fmtDur(total)} of the parts that matter.`),
      h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' } },
        h('button', { class: 'cb-btn', onclick: () => seekClip(0) }, '↺ replay'),
        h('button', { class: 'cb-btn', onclick: closeDock }, 'back to the canvas'),
      ),
    ));
  } else {
    cut.ui.left = h('b', null, '');
    panel.replaceChildren(
      h('div', { class: 'cp-head' }, 'clip ', h('b', null, String(i + 1)), ` of ${segs.length} · `, cut.ui.left, ' left'),
      h('div', { class: 'cut-list' }, segs.map((s, n) => h('button', {
        class: 'cut-item' + (n === i ? ' on' : '') + (n < i ? ' past' : ''),
        onclick: () => seekClip(n),
      },
        h('span', { class: 'ci-n' }, String(n + 1)),
        h('span', null, s.label, h('span', { class: 'ci-t' }, `${fmt(s.start)} – ${fmt(s.end)}`)),
      ))),
    );
    const onItem = panel.querySelector('.cut-item.on');
    if (onItem) onItem.scrollIntoView({ block: 'nearest' });
  }

  cut.ui.fills = [];
  const track = h('div', { class: 'cb-track' }, segs.map((s, n) => {
    const fill = h('i');
    cut.ui.fills.push(fill);
    return h('div', { class: 'cb-seg' + (n < i || cut.done ? ' done' : ''), style: { flex: String(Math.max(1, s.end - s.start)) } }, fill);
  }));
  cut.ui.barLeft = h('span', { class: 'cb-left' }, '');
  bar.replaceChildren(
    h('button', { class: 'cb-btn', 'aria-label': 'Previous clip', onclick: () => stepClip(-1) }, '⏮'),
    h('button', { class: 'cb-btn', 'aria-label': 'Play or pause', onclick: togglePlay }, '⏯'),
    h('button', { class: 'cb-btn', 'aria-label': 'Next clip', onclick: () => stepClip(1) }, '⏭'),
    track,
    cut.ui.barLeft,
  );
  document.getElementById('dock-title').textContent =
    `the no-yap cut · ${duration ? fmtDur(duration) + ' → ' : ''}${fmtDur(total)}`;
}

function updateCutProgress(t) {
  if (!cut || cut.done || !cut.ui.fills) return;
  const seg = cut.segs[cut.i];
  const pct = Math.max(0, Math.min(1, (t - seg.start) / (seg.end - seg.start)));
  const fill = cut.ui.fills[cut.i];
  if (fill) fill.style.width = (pct * 100).toFixed(1) + '%';
  const remaining = Math.max(0, seg.end - t) + cut.segs.slice(cut.i + 1).reduce((a, s) => a + (s.end - s.start), 0);
  if (cut.ui.left) cut.ui.left.textContent = fmt(remaining);
  if (cut.ui.barLeft) cut.ui.barLeft.textContent = fmt(remaining) + ' left';
}

/**
 * The clips in a no-yap cut, merged where they touch. Usually the receipts,
 * each from its timestamp to its end point (or 40s on). For a how-to, the
 * cook-along steps instead: what you want to watch is each step being done.
 */
export function cutSegments(canvas) {
  const duration = canvas.duration || Infinity;
  const steps = canvas.artifact && canvas.artifact.type === 'cookalong'
    ? canvas.artifact.steps.filter((s) => typeof s.t === 'number').sort((a, b) => a.t - b.t)
    : [];
  const source = steps.length >= 3
    ? steps.map((s, i) => ({ t: s.t, t_end: Math.min(steps[i + 1] ? steps[i + 1].t : s.t + 60, s.t + 75), title: `step: ${s.text}` }))
    : (canvas.receipts || []);
  const segs = source
    .filter((r) => typeof r.t === 'number')
    .map((r) => {
      let end = typeof r.t_end === 'number' && r.t_end > r.t ? r.t_end : r.t + 40;
      end = Math.min(end, r.t + 150, duration + 5);
      return { start: Math.max(0, r.t - 1), end, label: r.title };
    })
    .filter((s) => s.end > s.start + 3)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end + 3) {
      last.end = Math.max(last.end, s.end);
      last.extra = (last.extra || 0) + 1;
    } else merged.push({ ...s });
  }
  return merged.map((s) => ({ ...s, label: s.extra ? `${s.label} (+${s.extra})` : s.label }));
}
