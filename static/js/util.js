// Small, dependency-free helpers shared by every view.

// Native append()/replaceChildren() turn a null argument into the literal text
// "null" -- which is how "null" once appeared on the purge page. Views build
// children with `cond ? node : null` everywhere, so make both skip empty
// values exactly the way h() does, instead of policing every call site.
for (const method of ['append', 'replaceChildren']) {
  for (const proto of [Element.prototype, DocumentFragment.prototype]) {
    const native = proto[method];
    proto[method] = function (...kids) {
      return native.apply(this, kids.filter((k) => k !== null && k !== undefined && k !== false));
    };
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * Build DOM safely: strings become text nodes, never HTML, so nothing a
 * transcript says can inject markup. `html` exists only for static markup
 * written in this codebase.
 */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'html') el.innerHTML = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, value);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** "1:02:03" / "4:05" -- a timestamp. */
export function fmt(sec) {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return '';
  sec = Math.max(0, Math.round(sec));
  const hrs = Math.floor(sec / 3600), min = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (hrs ? hrs + ':' + String(min).padStart(2, '0') : min) + ':' + String(s).padStart(2, '0');
}

/** "2h 05m" / "8 min" / "40s" -- a length of time. */
export function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec < 60) return sec + 's';
  const totalMin = Math.round(sec / 60);
  const hrs = Math.floor(totalMin / 60), min = totalMin % 60;
  return hrs ? `${hrs}h ${String(min).padStart(2, '0')}m` : `${min} min`;
}

export function timeAgo(iso) {
  const then = Date.parse(iso);
  if (!then) return '';
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

export function monthName(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
}

export function slug(s) {
  return (s || 'yapmap').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'yapmap';
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : (many || one + 's')}`;
}

const ID_PATTERNS = [
  /(?:youtube\.com\/watch\?.*[?&]v=|youtube\.com\/watch\?v=)([0-9A-Za-z_-]{11})/,
  /youtu\.be\/([0-9A-Za-z_-]{11})/,
  /youtube\.com\/embed\/([0-9A-Za-z_-]{11})/,
  /youtube\.com\/shorts\/([0-9A-Za-z_-]{11})/,
  /youtube\.com\/live\/([0-9A-Za-z_-]{11})/,
];

/** The same parsing the server does, so the UI can react before any request. */
export function parseVideoId(input) {
  const s = String(input || '').trim();
  for (const pattern of ID_PATTERNS) {
    const match = s.match(pattern);
    if (match) return match[1];
  }
  return /^[0-9A-Za-z_-]{11}$/.test(s) ? s : null;
}

export const thumb = (id, quality = 'mqdefault') => `https://i.ytimg.com/vi/${id}/${quality}.jpg`;
export const ytUrl = (id, t) => `https://www.youtube.com/watch?v=${id}` + (t ? `&t=${Math.floor(t)}s` : '');
export const searchUrl = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;

export function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

let toastTimer;
export function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('up');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('up'), 2200);
}

export function downloadBlob(blob, name) {
  const href = URL.createObjectURL(blob);
  const a = h('a', { href, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1500);
}

export function download(text, name, type = 'text/markdown;charset=utf-8') {
  downloadBlob(new Blob([text], { type }), name);
}

export function copy(text, msg = 'copied fr ✓') {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => toast(msg),
      () => toast('clipboard said no — try downloading instead'),
    );
  } else {
    toast('clipboard needs localhost or https — download instead');
  }
}

/** A <mark>-highlighted fragment of `text` around the first matching term. */
export function snippet(text, terms, radius = 90) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) { const i = lower.indexOf(t); if (i !== -1 && (at === -1 || i < at)) at = i; }
  let start = Math.max(0, at - radius), end = Math.min(text.length, (at === -1 ? 0 : at) + radius * 2);
  let slice = text.slice(start, end);
  if (start > 0) slice = '…' + slice;
  if (end < text.length) slice += '…';
  const frag = document.createDocumentFragment();
  if (!terms.length) { frag.append(slice); return frag; }
  const re = new RegExp('(' + terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
  let last = 0;
  slice.replace(re, (m, _g, idx) => {
    frag.append(slice.slice(last, idx), h('mark', null, m));
    last = idx + m.length;
    return m;
  });
  frag.append(slice.slice(last));
  return frag;
}

// ─── recents: a per-browser convenience, never the source of truth ─────────
export function readRecents() {
  try { return JSON.parse(localStorage.getItem('yapmap.recents') || '[]'); } catch (e) { return []; }
}
export function pushRecent(item) {
  try {
    const list = readRecents().filter((r) => r.id !== item.id);
    list.unshift(item);
    localStorage.setItem('yapmap.recents', JSON.stringify(list.slice(0, 6)));
  } catch (e) { /* private window or full storage -- not worth breaking over */ }
}

export function lsGet(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v === null || v === undefined ? fallback : v; }
  catch (e) { return fallback; }
}
export function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
}

export const MODE_ACCENT = { study: 'lime', yap: 'pink', howto: 'cyan', verdict: 'orange', story: 'violet' };

export function setAccent(name) {
  const root = document.documentElement.style;
  root.setProperty('--accent', `var(--${name})`);
  root.setProperty('--accent-ink', `var(--${name}-ink)`);
}

/** Section heading used across every tool page. */
export function sectionHead(n, title, say, ...tools) {
  return h('div', { class: 'sec-head' },
    n ? h('span', { class: 'sec-n' }, String(n).padStart(2, '0')) : null,
    h('h3', null, title),
    say ? h('span', { class: 'say' }, say) : null,
    tools.length ? h('div', { class: 'tools' }, tools) : null,
  );
}

export function emptyState(emoji, title, text, ...actions) {
  return h('div', { class: 'empty' },
    h('span', { class: 'e-emoji' }, emoji),
    h('h3', null, title),
    h('p', null, text),
    actions.length ? h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' } }, actions) : null,
  );
}
