// Every request the UI makes goes through here. In the local app it talks to
// Flask; in the GitHub Pages demo (no server) it reads the bundled demo/ files
// and says so plainly when something needs the real thing.

import { lsGet, lsSet, LANGS } from './util.js';

let mode = null; // 'app' | 'static'
let health = null;

export async function detectMode() {
  if (mode) return mode;
  // The Pages build stamps itself, so demo visitors never see a failed probe.
  if (document.documentElement.dataset.static === '1') { mode = 'static'; return mode; }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch('api/health', { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(timer);
    const data = res.ok ? await res.json() : null;
    mode = data && data.ok ? 'app' : 'static';
    health = data;
  } catch (e) {
    mode = 'static';
  }
  return mode;
}

export const isStatic = () => mode === 'static';
export const languages = () => (health && health.languages) || LANGS;

export class NeedsInstall extends Error {
  constructor(what) {
    super(`${what} runs on your own machine — the demo can only show what's already here. Install yapmap (about five minutes) to use it on anything.`);
    this.needsInstall = true;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error("Couldn't reach the yapmap server. Is `python app.py` still running?");
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data && data.code;
    throw err;
  }
  return data;
}

const demoCache = new Map();
export function demo(path) {
  if (!demoCache.has(path)) {
    const p = fetch('demo/' + path).then((r) => {
      if (!r.ok) { const e = new Error('Not in the demo gallery.'); e.status = r.status; throw e; }
      return r.json();
    });
    p.catch(() => demoCache.delete(path));
    demoCache.set(path, p);
  }
  return demoCache.get(path);
}

// ─── canvas ───────────────────────────────────────────────────────────────
/** The saved canvas, or null when this video hasn't been mapped yet. */
export async function getCanvas(id, { lang } = {}) {
  if (isStatic()) {
    const tries = lang && lang !== 'en' ? [`canvases/${id}.${lang}.json`, `canvases/${id}.json`] : [`canvases/${id}.json`];
    for (const path of tries) {
      try {
        const data = await demo(path);
        const index = await demo('index.json').catch(() => ({ items: [] }));
        const item = (index.items || []).find((x) => x.video_id === id);
        return { ...data, cached: true, outdated: false, langs: (item && item.langs) || [data.lang || 'en'] };
      } catch (e) { /* try the next */ }
    }
    throw new NeedsInstall('Mapping a new video');
  }
  try {
    return await api(`api/canvas/${id}` + (lang ? `?lang=${encodeURIComponent(lang)}` : ''));
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function deleteCanvas(id) {
  if (isStatic()) throw new NeedsInstall('Deleting');
  return api('api/canvas/' + id, { method: 'DELETE' });
}

export async function getMeta(id) {
  if (isStatic()) return null;
  try { return await api('api/meta?url=' + encodeURIComponent(id)); } catch (e) { return null; }
}

export async function revoice(id, voice, lang) {
  if (isStatic()) {
    try { return await demo(`voices/${id}.${voice}.json`); } catch (e) { throw new NeedsInstall('Re-voicing'); }
  }
  return api('api/revoice', { method: 'POST', body: { video_id: id, voice, lang } });
}

const transcripts = new Map();
/** The transcript as timestamped blocks -- fetched once per video per page load. */
export function getTranscript(id) {
  if (!transcripts.has(id)) {
    const p = isStatic() ? demo(`transcripts/${id}.json`) : api('api/transcript/' + id);
    p.catch(() => transcripts.delete(id));
    transcripts.set(id, p);
  }
  return transcripts.get(id);
}

export async function askHistory(id) {
  if (isStatic()) {
    const items = await demo(`ask/${id}.json`).catch(() => []);
    return { items: Array.isArray(items) ? items : items.items || [], demo: true };
  }
  return api('api/ask/' + id);
}

export async function clearAsk(id) {
  if (isStatic()) throw new NeedsInstall('Asking');
  return api('api/ask/' + id, { method: 'DELETE' });
}

// ─── beef + purge ─────────────────────────────────────────────────────────
export async function getBeefCached(a, b, lang) {
  if (isStatic()) {
    const index = await demo('beef/index.json').catch(() => []);
    const hit = index.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
    if (!hit) throw new NeedsInstall('Starting a new beef');
    const data = await demo(`beef/${hit.key}.json`);
    return data.a.video_id === a ? data : swapBeef(data);
  }
  try {
    return await api(`api/beef/${a}/${b}` + (lang ? `?lang=${encodeURIComponent(lang)}` : ''));
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function beefIndex() {
  if (!isStatic()) return [];
  return demo('beef/index.json').catch(() => []);
}

export function swapBeef(p) {
  return {
    ...p,
    a: p.b,
    b: p.a,
    clash: p.clash.map((c) => ({ ...c, a: c.b, t_a: c.t_b, b: c.a, t_b: c.t_a })),
    agree: p.agree.map((x) => ({ ...x, t_a: x.t_b, t_b: x.t_a })),
    only_a: p.only_b,
    only_b: p.only_a,
  };
}

export async function getPurge(key) {
  if (isStatic()) return demo('purge.json');
  return api('api/purge/' + key);
}

// ─── library, search, stats ───────────────────────────────────────────────
export async function library() {
  return isStatic() ? demo('index.json') : api('api/library');
}

export async function search(q) {
  if (!isStatic()) return api('api/search?q=' + encodeURIComponent(q));
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { hits: [], terms };
  const records = await demo('records.json');
  const hits = records.filter((r) => terms.every((t) => r.text.toLowerCase().includes(t))).slice(0, 120);
  return { hits, terms };
}

export async function stats() {
  return isStatic() ? demo('stats.json') : api('api/stats');
}

// ─── the review deck (spaced repetition) ──────────────────────────────────
// Same schedule as the server: days until a card comes back, by box.
const SRS_INTERVALS = [0, 1, 3, 7, 16, 35, 90];
const LS_REVIEWS = 'yapmap.reviews';

export function scheduleReview(state, grade, now = new Date()) {
  let box = state.box || 0;
  let lapses = state.lapses || 0;
  if (grade === 'again') { box = 0; lapses += 1; } else box = Math.min(SRS_INTERVALS.length - 1, box + (grade === 'easy' ? 2 : 1));
  const days = SRS_INTERVALS[box];
  let due = now;
  if (days) { due = new Date(now); due.setDate(due.getDate() + days); due.setHours(0, 0, 0, 0); }
  return { box, lapses, reps: (state.reps || 0) + 1, last: Math.floor(now / 1000), due: Math.floor(due / 1000) };
}

export async function deck() {
  if (!isStatic()) return api('api/deck');
  const index = await demo('index.json');
  const reviews = lsGet(LS_REVIEWS, {});
  const now = Math.floor(Date.now() / 1000);
  const cards = [];
  for (const item of index.items || []) {
    if (item.tool !== 'flashcards') continue;
    const canvas = await demo(`canvases/${item.video_id}.json`).catch(() => null);
    const art = canvas && canvas.artifact;
    if (!art || art.type !== 'flashcards') continue;
    art.cards.forEach((c) => {
      const id = `${item.video_id}:${c.id}`;
      const st = reviews[id] || {};
      cards.push({ id, video_id: item.video_id, headline: canvas.headline, q: c.q, a: c.a, t: c.t, box: st.box || 0, reps: st.reps || 0, due: st.due || null });
    });
  }
  return {
    cards,
    due: cards.filter((c) => c.reps && c.due <= now).length,
    new: cards.filter((c) => !c.reps).length,
    total: cards.length,
  };
}

export async function review(id, grade) {
  if (!isStatic()) return api('api/reviews', { method: 'POST', body: { id, grade } });
  const reviews = lsGet(LS_REVIEWS, {});
  reviews[id] = scheduleReview(reviews[id] || {}, grade);
  lsSet(LS_REVIEWS, reviews);
  return { id, ...reviews[id] };
}
