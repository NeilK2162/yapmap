// Small, dependency-free helpers shared by every view.

// Native append()/replaceChildren() turn a null argument into the literal text
// "null" -- which is how "null" once appeared on the purge page. Views build
// children with `cond ? node : null` everywhere, so make both skip empty
// values exactly the way h() does, instead of policing every call site.
for (const method of ['append', 'replaceChildren']) {
  for (const proto of [Element.prototype, DocumentFragment.prototype]) {
    const native = proto[method];
    proto[method] = function (...kids) {
      return native.apply(this, kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
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
      else if (key === 'style' && typeof value === 'object') {
        for (const [prop, v] of Object.entries(value)) {
          if (prop.startsWith('--')) el.style.setProperty(prop, v); else el.style[prop] = v;
        }
      } else if (key === 'dataset') Object.assign(el.dataset, value);
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

/** Escape text for the few places that must build an HTML string (the mindmap's node labels). */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

/** "[4:05]" / "[1:02:03]" -> seconds. */
export function parseStamp(text) {
  const parts = String(text).split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((total, n) => total * 60 + n, 0);
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

export function inDays(ts) {
  const days = Math.round((ts * 1000 - Date.now()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 14) return `in ${days} days`;
  if (days < 60) return `in ${Math.round(days / 7)} weeks`;
  return `in ${Math.round(days / 30)} months`;
}

export function monthName(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
}

export function clockTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function slug(s) {
  return (s || 'yapmap').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'yapmap';
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : (many || one + 's')}`;
}

/** Lowercase, accents off -- so "resume" finds "résumé". */
export function normalizeText(s) {
  return String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
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
/** A short message at the bottom. With an action, it waits longer and can be clicked. */
export function toast(msg, action) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.replaceChildren(h('span', null, msg), action ? h('a', {
    class: 'toast-action', href: action.href,
    onclick: (e) => { if (action.onclick) { e.preventDefault(); action.onclick(); } el.classList.remove('up'); },
  }, action.label) : null);
  el.classList.toggle('actionable', !!action);
  el.classList.add('up');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('up'), action ? 7000 : 2400);
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
  const start = Math.max(0, at - radius), end = Math.min(text.length, (at === -1 ? 0 : at) + radius * 2);
  let slice = text.slice(start, end);
  if (start > 0) slice = '…' + slice;
  if (end < text.length) slice += '…';
  return highlight(slice, terms);
}

export function highlight(text, terms) {
  const frag = document.createDocumentFragment();
  const clean = terms.filter(Boolean);
  if (!clean.length) { frag.append(text); return frag; }
  const re = new RegExp('(' + clean.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
  let last = 0;
  text.replace(re, (m, _g, idx) => {
    frag.append(text.slice(last, idx), h('mark', null, m));
    last = idx + m.length;
    return m;
  });
  frag.append(text.slice(last));
  return frag;
}

/**
 * Claude's answers, rendered safely: paragraphs, "- " bullets, **bold**, and
 * every [4:05] citation turned into a button that plays that moment.
 */
export function richText(text, onStamp) {
  const frag = document.createDocumentFragment();
  const inline = (line) => {
    const out = [];
    const re = /\*\*([^*]+)\*\*|\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;
    let last = 0;
    let m;
    while ((m = re.exec(line))) {
      out.push(line.slice(last, m.index));
      if (m[1]) out.push(h('strong', null, m[1]));
      else {
        const t = parseStamp(m[2]);
        out.push(onStamp && t !== null
          ? h('button', { class: 'stamp cite', type: 'button', onclick: () => onStamp(t), 'aria-label': `Play ${m[2]}` }, '▶ ' + m[2])
          : `[${m[2]}]`);
      }
      last = re.lastIndex;
    }
    out.push(line.slice(last));
    return out;
  };
  let list = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) { list = null; continue; }
    const bullet = line.match(/^[-*•]\s+(.*)$/) || line.match(/^\d+[.)]\s+(.*)$/);
    if (bullet) {
      if (!list) { list = h('ul'); frag.append(list); }
      list.append(h('li', null, inline(bullet[1])));
    } else {
      list = null;
      frag.append(h('p', null, inline(line.replace(/^#+\s*/, ''))));
    }
  }
  return frag;
}

// ─── storage: per-browser conveniences, never the source of truth ─────────
export function lsGet(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v === null || v === undefined ? fallback : v; }
  catch (e) { return fallback; }
}
export function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
}
export function lsDel(key) {
  try { localStorage.removeItem(key); } catch (e) { /* storage unavailable */ }
}

export function readRecents() {
  return lsGet('yapmap.recents', []);
}
export function pushRecent(item) {
  const list = readRecents().filter((r) => r.id !== item.id);
  list.unshift(item);
  lsSet('yapmap.recents', list.slice(0, 6));
}
export function dropRecent(id) {
  lsSet('yapmap.recents', readRecents().filter((r) => r.id !== id));
}

// ─── the language Claude writes in ────────────────────────────────────────
export const LANGS = [
  { code: 'en', label: 'English' },
  { code: 'hinglish', label: 'Hinglish' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'auto', label: 'same as the video' },
];
export const langLabel = (code) => (LANGS.find((l) => l.code === code) || { label: code || 'English' }).label;
export const prefLang = () => {
  const code = lsGet('yapmap.lang', 'en');
  return LANGS.some((l) => l.code === code) ? code : 'en';
};
export const setPrefLang = (code) => lsSet('yapmap.lang', code);

export const MODE_ACCENT = { study: 'lime', yap: 'pink', howto: 'cyan', verdict: 'orange', story: 'violet' };

export function setAccent(name) {
  const root = document.documentElement.style;
  root.setProperty('--accent', `var(--${name})`);
  root.setProperty('--accent-ink', `var(--${name}-ink)`);
}

/** Section heading used across every tool page. */
export function sectionHead(n, title, say, ...tools) {
  return h('div', { class: 'sec-head' },
    n ? h('span', { class: 'sec-n', 'aria-hidden': 'true' }, String(n).padStart(2, '0')) : null,
    h('h2', { class: 'sec-title' }, title),
    say ? h('p', { class: 'say' }, say) : null,
    tools.filter(Boolean).length ? h('div', { class: 'tools' }, tools) : null,
  );
}

export function emptyState(emoji, title, text, ...actions) {
  return h('div', { class: 'empty' },
    h('span', { class: 'e-emoji', 'aria-hidden': 'true' }, emoji),
    h('h2', null, title),
    h('p', null, text),
    actions.length ? h('div', { class: 'row center' }, actions) : null,
  );
}

/**
 * A button that opens a small menu. items: [{label, onclick | href, danger, hint}]
 * or null for a divider. Arrow keys move, Esc closes, a click outside closes.
 */
export function menuButton(label, items, { cls = 'ghost', title, align = 'right', ariaLabel } = {}) {
  const wrap = h('div', { class: 'menu-wrap' });
  const id = 'menu-' + Math.random().toString(36).slice(2, 8);
  const btn = h('button', {
    class: cls, type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': id, title,
    'aria-label': ariaLabel,
  }, label);
  const menu = h('div', { class: 'menu ' + align, role: 'menu', id, hidden: true });
  const close = (refocus) => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (refocus) btn.focus();
  };
  const outside = (e) => { if (!wrap.contains(e.target)) close(false); };
  const entries = () => [...menu.querySelectorAll('[role="menuitem"]')];
  const build = () => {
    const list = typeof items === 'function' ? items() : items;
    menu.replaceChildren(...list.map((it) => {
      if (!it) return h('div', { class: 'menu-sep', role: 'separator' });
      const attrs = { class: 'menu-item' + (it.danger ? ' danger' : ''), role: 'menuitem', tabindex: '-1' };
      const inner = [h('span', null, it.label), it.hint ? h('small', null, it.hint) : null];
      if (it.href) {
        return h('a', { ...attrs, href: it.href, target: it.external ? '_blank' : null, rel: it.external ? 'noopener' : null, onclick: () => close(false) }, inner);
      }
      return h('button', { ...attrs, type: 'button', disabled: it.disabled, onclick: () => { close(true); it.onclick && it.onclick(); } }, inner);
    }));
  };
  btn.addEventListener('click', () => {
    if (!menu.hidden) { close(false); return; }
    build();
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    const first = entries()[0];
    if (first) first.focus();
  });
  menu.addEventListener('keydown', (e) => {
    const list = entries();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); (list[i + 1] || list[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (list[i - 1] || list[list.length - 1]).focus(); }
    else if (e.key === 'Tab') close(false);
  });
  wrap.append(btn, menu);
  return wrap;
}

/** A destructive button that asks "sure?" in place, instead of a browser dialog. */
export function confirmButton(label, sureLabel, onConfirm, cls = 'mini', { ariaLabel } = {}) {
  let armed = false;
  let timer;
  const disarm = () => {
    armed = false;
    btn.textContent = label;
    btn.classList.remove('armed');
    if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
  };
  const btn = h('button', {
    class: cls + ' danger', type: 'button', 'aria-label': ariaLabel, title: ariaLabel,
    onclick: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!armed) {
        armed = true;
        btn.textContent = sureLabel;
        btn.classList.add('armed');
        if (ariaLabel) btn.setAttribute('aria-label', `${ariaLabel}: press again to confirm`);
        timer = setTimeout(disarm, 4000);
        return;
      }
      clearTimeout(timer);
      btn.disabled = true;
      try { await onConfirm(); } finally { btn.disabled = false; }
    },
  }, label);
  return btn;
}

// ─── calendar reminders ───────────────────────────────────────────────────
const icsDate = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function icsFold(line) {
  // RFC 5545: lines longer than 75 octets continue on the next line after a space.
  const out = [];
  let rest = line;
  while (new TextEncoder().encode(rest).length > 75) {
    let cut = 74;
    while (new TextEncoder().encode(rest.slice(0, cut)).length > 74) cut -= 1;
    out.push(rest.slice(0, cut));
    rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}

/** A reminder at 7pm, `days` from now -- the evening you actually have time. */
export function reminderSlot(days = 2) {
  const start = new Date();
  start.setDate(start.getDate() + days);
  start.setHours(19, 0, 0, 0);
  return { start, end: new Date(start.getTime() + 30 * 60000) };
}

export function icsEvent({ uid, title, description, start, end }) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//yapmap//touch grass//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}@yapmap`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(title)}`,
    `DESCRIPTION:${icsText(description)}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(title)}`, 'TRIGGER:-PT0M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

export function googleCalendarUrl({ title, description, start, end }) {
  const params = new URLSearchParams({
    action: 'TEMPLATE', text: title, details: description, dates: `${icsDate(start)}/${icsDate(end)}`,
  });
  return 'https://calendar.google.com/calendar/render?' + params.toString();
}

export const isNarrow = () => window.matchMedia('(max-width: 760px)').matches;
