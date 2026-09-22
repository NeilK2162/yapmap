// Boot, routing, and the bits of chrome every page shares: the tool tabs,
// the "yap skipped" counter, the demo banner, and the touch-grass check-in.

import { h, fmtDur, timeAgo, toast, setAccent, parseVideoId } from './util.js';
import { detectMode, isStatic, stats } from './api.js';
import { listCommitments, updateCommitment } from './store.js';
import { initDock } from './player.js';
import { initTheme } from './theme.js';
import * as home from './views/home.js';
import * as canvas from './views/canvas.js';
import * as beef from './views/beef.js';
import * as purge from './views/purge.js';
import * as library from './views/library.js';
import * as grass from './views/grass.js';
import * as wrapped from './views/wrapped.js';
import * as extras from './views/extras.js';

// Hash routes work identically under Flask and on GitHub Pages, where every
// path has to resolve to the one index.html.
const ROUTES = [
  { re: /^\/?$/, tab: 'map', accent: 'lime', view: home },
  { re: /^\/v\/([0-9A-Za-z_-]{11})$/, tab: 'map', accent: 'lime', view: canvas },
  { re: /^\/beef(?:\/([0-9A-Za-z_-]{11})\/([0-9A-Za-z_-]{11}))?$/, tab: 'beef', accent: 'pink', view: beef },
  { re: /^\/purge(?:\/([0-9a-f]{12}))?$/, tab: 'purge', accent: 'cyan', view: purge },
  { re: /^\/library$/, tab: 'library', accent: 'violet', view: library },
  { re: /^\/grass$/, tab: 'grass', accent: 'green', view: grass },
  { re: /^\/wrapped(?:\/(\d{4}-\d{2}))?$/, tab: 'wrapped', accent: 'orange', view: wrapped },
  { re: /^\/extras$/, tab: 'extras', accent: 'lime', view: extras },
];

let routeId = 0;
let cleanups = [];

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const q = raw.indexOf('?');
  return { path: q === -1 ? raw : raw.slice(0, q), query: new URLSearchParams(q === -1 ? '' : raw.slice(q + 1)) };
}

async function route() {
  const { path, query } = parseHash();
  cleanups.splice(0).forEach((fn) => { try { fn(); } catch (e) { /* a view's cleanup failing shouldn't block the next */ } });
  const id = ++routeId;

  const found = ROUTES.map((r) => ({ r, m: path.match(r.re) })).find((x) => x.m);
  if (!found) { location.replace('#/'); return; }
  const { r, m } = found;

  document.querySelectorAll('#tabs a').forEach((a) => {
    const on = a.dataset.tab === r.tab;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  setAccent(r.accent);

  const root = h('div');
  document.getElementById('view').replaceChildren(root);
  window.scrollTo(0, 0);

  // Views get a context so async work that finishes after the user has moved
  // on can tell, and so every timer and listener they start gets torn down.
  const ctx = {
    alive: () => id === routeId,
    onCleanup: (fn) => {
      if (id === routeId) cleanups.push(fn);
      else { try { fn(); } catch (e) { /* already gone */ } }
    },
  };

  try {
    await r.view.render(root, m.slice(1), query, ctx);
  } catch (err) {
    console.error(err);
    if (ctx.alive()) {
      root.replaceChildren(h('div', { class: 'error' }, h('div', { class: 'card' },
        h('h3', null, 'something broke on our side.'),
        h('p', null, (err && err.message) || String(err)),
        h('a', { class: 'ghost', href: '#/' }, 'go home'),
      )));
    }
  }
  refreshCheckin();
}

// ─── the "yap skipped" counter ────────────────────────────────────────────
async function refreshSkipped() {
  const pill = document.getElementById('skipped');
  try {
    const s = await stats();
    const sec = s && s.total && s.total.skipped_s;
    if (!sec) { pill.hidden = true; return; }
    pill.hidden = false;
    pill.replaceChildren('⏱ ', h('b', null, fmtDur(sec)), ' of yap skipped');
    pill.title = 'Hours of video you didn’t have to sit through — see Wrapped';
  } catch (e) {
    pill.hidden = true;
  }
}

// ─── the touch-grass check-in ─────────────────────────────────────────────
const dismissed = new Set();
try { JSON.parse(sessionStorage.getItem('yapmap.dismissed') || '[]').forEach((x) => dismissed.add(x)); } catch (e) { /* none */ }

async function refreshCheckin() {
  const box = document.getElementById('checkin');
  let data;
  try { data = await listCommitments(); } catch (e) { box.hidden = true; return; }
  const now = Date.now();
  const due = data.items
    .filter((c) => c.status === 'open'
      && now - Date.parse(c.created_at) > 20 * 3600 * 1000
      && (!c.snooze_until || Date.parse(c.snooze_until) <= now)
      && !dismissed.has(c.id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  if (!due) { box.hidden = true; return; }

  const when = timeAgo(due.created_at);
  const resolve = async (patch, msg) => {
    try {
      await updateCommitment(due.id, patch);
      toast(msg);
      document.dispatchEvent(new CustomEvent('yapmap:changed'));
    } catch (e) { toast(e.message); }
  };
  box.hidden = false;
  box.replaceChildren(
    h('span', { class: 'b-emoji', 'aria-hidden': 'true' }, '🌱'),
    h('div', { class: 'b-text' },
      `${when.charAt(0).toUpperCase() + when.slice(1)} you said you’d `, h('b', null, due.action), '. Did you?',
      due.headline ? h('small', null, 'from: ' + due.headline) : null,
    ),
    h('div', { class: 'b-actions' },
      h('button', { class: 'mini on', onclick: () => resolve({ status: 'done' }, 'kept it. that’s growth fr 🌱') }, 'did it ✓'),
      h('button', { class: 'mini', onclick: () => resolve({ snooze_days: 2 }, 'we’ll ask again in two days') }, 'not yet'),
      h('button', { class: 'mini', onclick: () => resolve({ status: 'dropped' }, 'dropped. no shame, just data.') }, 'drop it'),
      h('button', {
        class: 'icon-btn', 'aria-label': 'Hide for now',
        onclick: () => {
          dismissed.add(due.id);
          try { sessionStorage.setItem('yapmap.dismissed', JSON.stringify([...dismissed])); } catch (e) { /* fine */ }
          box.hidden = true;
        },
      }, '✕'),
    ),
  );
}

function showDemoBanner() {
  const box = document.getElementById('demo-banner');
  box.hidden = false;
  box.replaceChildren(
    h('span', { class: 'b-emoji', 'aria-hidden': 'true' }, '👀'),
    h('div', { class: 'b-text' }, 'You’re in the live demo. Every canvas here is real output — open one and poke everything.',
      h('small', null, 'Mapping new videos runs on your own machine with your Claude subscription. No API key.')),
    h('div', { class: 'b-actions' }, h('a', { class: 'mini on', href: '#/extras' }, 'how to install →')),
  );
}

// Sticky elements sit under the nav, whose height changes when the tab row wraps.
function trackNavHeight() {
  const nav = document.querySelector('.nav');
  const set = () => document.documentElement.style.setProperty('--nav-h', nav.offsetHeight + 'px');
  set();
  if ('ResizeObserver' in window) new ResizeObserver(set).observe(nav);
}

async function boot() {
  trackNavHeight();
  initTheme();
  initDock();
  await detectMode();
  if (isStatic()) showDemoBanner();

  // The one-click bookmark lands here as ?v=<youtube url>.
  const v = new URLSearchParams(location.search).get('v');
  if (v) {
    const id = parseVideoId(v);
    history.replaceState(null, '', location.pathname + (id ? '#/v/' + id : '#/'));
    if (!id) toast("that tab wasn't a youtube video");
  }

  window.addEventListener('hashchange', route);
  document.addEventListener('yapmap:changed', () => { refreshSkipped(); refreshCheckin(); });
  route();
  refreshSkipped();
}

boot();
