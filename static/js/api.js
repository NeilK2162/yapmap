// Every request the UI makes goes through here. In the local app it talks to
// Flask; in the GitHub Pages demo (no server) it reads the bundled demo/ files
// and says so plainly when something needs the real thing.

let mode = null; // 'app' | 'static'

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
  } catch (e) {
    mode = 'static';
  }
  return mode;
}

export const isStatic = () => mode === 'static';

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
export async function getCanvas(id, { force = false } = {}) {
  if (isStatic()) {
    try {
      const data = await demo(`canvases/${id}.json`);
      return { ...data, cached: true, outdated: false };
    } catch (e) {
      throw new NeedsInstall('Mapping a new video');
    }
  }
  return api('api/canvas', { method: 'POST', body: { url: id, force } });
}

export async function getMeta(id) {
  if (isStatic()) return null;
  try { return await api('api/meta?url=' + encodeURIComponent(id)); } catch (e) { return null; }
}

export async function revoice(id, voice) {
  if (isStatic()) {
    try { return await demo(`voices/${id}.${voice}.json`); } catch (e) { throw new NeedsInstall('Re-voicing'); }
  }
  return api('api/revoice', { method: 'POST', body: { video_id: id, voice } });
}

// ─── beef + purge ─────────────────────────────────────────────────────────
export async function getBeef(a, b, { force = false } = {}) {
  if (isStatic()) {
    const index = await demo('beef/index.json').catch(() => []);
    const hit = index.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
    if (!hit) throw new NeedsInstall('Starting a new beef');
    const data = await demo(`beef/${hit.key}.json`);
    return data.a.video_id === a ? data : swapBeef(data);
  }
  return api('api/beef', { method: 'POST', body: { a, b, force } });
}

export async function beefIndex() {
  if (!isStatic()) return [];
  return demo('beef/index.json').catch(() => []);
}

function swapBeef(p) {
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

export async function runPurge(urls, { force = false } = {}) {
  if (isStatic()) throw new NeedsInstall('Running a purge');
  return api('api/purge', { method: 'POST', body: { urls, force } });
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
