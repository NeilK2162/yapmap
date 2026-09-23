// The canvas: everything yapmap makes from one video. It renders two ways --
// all at once from the saved copy, or section by section while Claude is
// still writing it -- and the sections don't care which.

import {
  h, fmt, fmtDur, slug, toast, copy, download, downloadBlob, ytUrl, thumb, searchUrl,
  pushRecent, dropRecent, setAccent, sectionHead, MODE_ACCENT, menuButton, isNarrow, lsGet, lsSet,
  prefLang, langLabel, reminderSlot, googleCalendarUrl, icsEvent, clockTime,
} from '../util.js';
import { getCanvas, revoice, isStatic, deleteCanvas, languages } from '../api.js';
import { startJob, subscribe, cancelJob, findRunning } from '../jobs.js';
import { jumpTo, playCut, cutSegments } from '../player.js';
import { commit, listCommitments, logEvent } from '../store.js';
import { stickyCard } from '../storycard.js';
import { uiState, forgetUiState } from '../uistate.js';
import { buildArtifact, artifactMarkdown, artifactNameForMode, ARTIFACT_NAMES } from './artifacts.js';
import { mapSection } from './mapsection.js';
import { openDrawer, resetDrawer } from '../drawer.js';
import { printSheet } from '../print.js';
import { treeMarkdown, countIdeas } from '../mindmap.js';

const WAITING = [
  'reading the whole transcript so you don’t have to…', 'skipping the sponsor segment…', 'finding the actual point…',
  'separating the yap from the facts…', 'vibe-checking the transcript…', 'extracting the lore…', 'locking in…',
];
export const KIND_LABEL = {
  quote: 'they said it', aha: 'oh — that’s why', warning: 'heads up', stat: 'the number', tip: 'steal this',
};
const SHELF_ICON = { book: '📚', tool: '🛠️', person: '👤', paper: '📄', site: '🔗', other: '✦' };
const VOICES = [['straight', 'straight'], ['groupchat', 'group chat'], ['commentator', 'commentator'], ['brainrot', 'brainrot'], ['eli5', 'like i’m five']];
const FIELD_COUNT = 14;

// Sections, in page order -- which is also the order Claude writes them in.
const SECTIONS = [
  { id: 'map', keys: ['mindmap'], primary: true },
  { id: 'tool', keys: ['artifact'], primary: true },
  { id: 'wall', keys: ['stickies', 'stickies_label'], fold: true },
  { id: 'shelf', keys: ['shelf'], fold: true },
  { id: 'download', keys: ['summary'] },
  { id: 'grass', keys: ['moves'], fold: true },
  { id: 'receipts', keys: ['receipts', 'receipts_label'], fold: true },
];
const CHECKLIST = [
  ['headline', 'headline'], ['mindmap', 'the map'], ['artifact', 'the tool'], ['stickies', 'the wall'], ['shelf', 'the shelf'],
  ['summary', 'the download'], ['moves', 'moves'], ['questions', 'questions'], ['receipts', 'findings'],
];

export async function render(root, [videoId], query, ctx) {
  const force = query.get('force') === '1';
  const lang = query.get('lang') || null;
  ctx.onCleanup(resetDrawer);

  // Cooking right now -- maybe started on an earlier visit: watch it rather than start again.
  const running = findRunning('canvas', (p) => p.video_id === videoId && (!lang || p.lang === lang));
  if (running) { canvasPage(root, ctx, videoId, { rec: running, query }); return; }

  if (!force) {
    const slow = setTimeout(() => { if (ctx.alive()) root.replaceChildren(skeletonPage()); }, 250);
    let data;
    try {
      // Your language if this canvas exists in it; otherwise whichever one does.
      data = await getCanvas(videoId, { lang: lang || prefLang() });
    } catch (err) {
      clearTimeout(slow);
      if (ctx.alive()) root.replaceChildren(errorScreen(err, videoId));
      return;
    }
    clearTimeout(slow);
    if (!ctx.alive()) return;
    if (data) { canvasPage(root, ctx, videoId, { data, query }); return; }
  }

  let rec;
  try {
    rec = await startJob('canvas', { video_id: videoId, lang: lang || prefLang(), force });
  } catch (err) {
    if (!ctx.alive()) return;
    const screen = errorScreen(err, videoId);
    root.replaceChildren(screen);
    if (force) offerKept(screen, videoId, ctx);
    return;
  }
  if (!ctx.alive()) return;
  if (force) history.replaceState(null, '', `#/v/${videoId}` + (lang ? `?lang=${lang}` : ''));
  canvasPage(root, ctx, videoId, { rec, query });
}

function skeletonPage() {
  return h('div', { class: 'canvas', 'aria-busy': 'true' },
    h('div', { class: 'crown skeleton' }, h('div', { class: 'sk sk-title' }), h('div', { class: 'sk sk-line' }), h('div', { class: 'sk sk-line short' })),
    h('div', { class: 'sk sk-block' }),
  );
}

function errorScreen(err, videoId, { retry = true } = {}) {
  const usage = err.code === 'usage_limit';
  return h('div', { class: 'error' }, h('div', { class: 'card' },
    h('h1', { class: 'e-title' }, err.needsInstall ? 'that one needs the real thing.' : usage ? 'out of Claude for now.' : 'well. that flopped.'),
    h('p', null, err.message || String(err)),
    err.resets_at ? h('p', null, `Your limit resets around ${clockTime(err.resets_at)}.`) : null,
    h('div', { class: 'row' },
      retry && videoId && !err.needsInstall && !usage ? h('a', { class: 'ghost hot', href: `#/v/${videoId}?force=1` }, 'try again ↻') : null,
      h('a', { class: 'ghost', href: '#/' }, 'try another link'),
      err.needsInstall ? h('a', { class: 'ghost hot', href: '#/extras' }, 'how to install') : null,
      usage ? h('a', { class: 'ghost', href: '#/library' }, 'open your library') : null,
    ),
  ));
}

// A regenerate that fails or gets cancelled leaves the canvas you already had
// on disk, so point the way back to it rather than stranding you on the error.
async function offerKept(screen, videoId, ctx) {
  const kept = await getCanvas(videoId, { lang: prefLang() }).catch(() => null);
  const row = screen.querySelector('.row');
  if (!kept || !ctx.alive() || !row) return;
  row.querySelectorAll('.hot').forEach((a) => a.classList.remove('hot'));
  row.prepend(h('button', {
    class: 'ghost hot', type: 'button',
    onclick: () => {
      const target = `#/v/${videoId}`;
      // The hash may already read that (a regenerate drops its ?force=1), and then only an event re-routes.
      if (location.hash === target) window.dispatchEvent(new HashChangeEvent('hashchange'));
      else location.hash = target;
    },
  }, 'back to the one you had'));
}

// ─── the page ─────────────────────────────────────────────────────────────
function canvasPage(root, ctx, videoId, { data = null, rec = null, query }) {
  const ui = uiState(videoId);
  const d = data ? { ...data } : { video_id: videoId };
  const state = { final: !!data, rec, meta: null, stage: rec ? rec.stage : null, done: new Set(), started: Date.now(), map: null };

  const page = h('div', { class: 'canvas' });
  const crown = buildCrown();
  const rail = h('nav', { class: 'rail', 'aria-label': 'Jump to a section' });
  const sectionsEl = h('div', { class: 'sections' });
  page.append(crown.el, rail, sectionsEl);
  root.replaceChildren(page);

  const slots = SECTIONS.map((spec) => {
    const el = h('section', { class: 'sec' + (spec.primary ? ' primary' : ''), id: 'sec-' + spec.id });
    sectionsEl.append(el);
    return { spec, el, sig: null, built: false, api: null, empty: false };
  });

  // ─── applying data ──────────────────────────────────────────────────────
  function apply(keys) {
    if (keys.includes('mode') || keys.includes('artifact')) setAccent(MODE_ACCENT[d.mode] || 'lime');
    // The tool's name depends on the mode: retitle the placeholders once it's known.
    if (keys.includes('mode') && !state.final) slots.forEach((slot) => { if (!slot.built && !slot.empty) slot.el.replaceChildren(pending(slot.spec.id)); });
    if (keys.some((k) => ['mode', 'mode_label', 'headline', 'tldr', 'questions', 'receipts', 'artifact'].includes(k))) crown.update();
    slots.forEach((slot) => { if (slot.spec.keys.some((k) => keys.includes(k))) renderSlot(slot); });
    paintRail();
  }

  function sectionTitle(id) {
    if (id === 'map') return 'the map';
    if (id === 'tool') return d.artifact ? (ARTIFACT_NAMES[d.artifact.type] || 'the tool') : artifactNameForMode(d.mode);
    if (id === 'wall') return (d.stickies_label || 'the wall').toLowerCase();
    if (id === 'shelf') return 'the shelf';
    if (id === 'download') return 'the download';
    if (id === 'grass') return 'touch grass';
    return (d.receipts_label || 'receipts').toLowerCase();
  }

  function hasData(slot) {
    const v = d[slot.spec.keys[0]];
    return Array.isArray(v) ? v.length > 0 : !!v;
  }

  function renderSlot(slot) {
    const { spec, el } = slot;
    const complete = spec.keys.every((k) => k in d) && (state.final || state.done.has(spec.keys[0]));
    if (!hasData(slot)) {
      if (state.final || complete) { el.hidden = true; slot.empty = true; return; }
      if (!slot.built) el.replaceChildren(pending(spec.id));
      return;
    }
    el.hidden = false;
    slot.empty = false;
    if (spec.id === 'map') {
      if (!slot.api) {
        slot.api = mapSection({ data: d, ctx, ui, onAsk: (q) => ask(q) });
        state.map = slot.api;
        slot.say = h('p', { class: 'say' });
        el.replaceChildren(sectionShell(slot, [], slot.api.el));
      }
      slot.api.update(d.mindmap, { streaming: !complete });
      slot.say.textContent = slot.api.say();
      slot.built = true;
      return;
    }
    const sig = JSON.stringify(spec.keys.map((k) => d[k])) + (complete ? '#' : '~');
    if (sig === slot.sig) return;
    slot.sig = sig;
    const built = BUILDERS[spec.id]();
    if (!built) { el.hidden = true; slot.empty = true; return; }
    slot.say = h('p', { class: 'say' }, built.say);
    el.replaceChildren(sectionShell(slot, built.tools || [], built.el, built.preview));
    if (!complete) el.append(h('p', { class: 'still-writing' }, h('span', { class: 'pulse-dot' }), ' still writing this part…'));
    slot.built = true;
  }

  function pending(id) {
    return h('div', { class: 'sec-pending' },
      h('div', { class: 'sec-head' }, h('h2', { class: 'sec-title' }, sectionTitle(id)), h('p', { class: 'say' }, 'coming up…')),
      h('div', { class: 'sk sk-block' + (id === 'map' ? ' tall' : '') }),
    );
  }

  // Sections on a phone fold away behind their heading, remembering what you opened.
  function sectionShell(slot, tools, body, preview) {
    const { spec } = slot;
    const foldable = spec.fold && isNarrow();
    const open = ui.get('open', {});
    const isOpen = !foldable || (spec.id in open ? open[spec.id] : false);
    const head = sectionHead(null, sectionTitle(spec.id), null, ...tools);
    head.querySelector('.sec-title').after(slot.say);
    const bodyWrap = h('div', { class: 'sec-body', id: 'body-' + spec.id, hidden: !isOpen }, body);
    if (!foldable) return h('div', null, head, bodyWrap);
    const wrap = h('div', { class: 'foldable' + (isOpen ? '' : ' collapsed') });
    const toggle = h('button', {
      class: 'sec-toggle', type: 'button', 'aria-expanded': String(isOpen), 'aria-controls': 'body-' + spec.id,
      onclick: () => setOpen(bodyWrap.hidden),
    },
      h('span', { class: 'st-title' }, sectionTitle(spec.id)),
      preview ? h('span', { class: 'st-preview' }, preview) : null,
      h('span', { class: 'st-caret', 'aria-hidden': 'true' }, '▾'),
    );
    function setOpen(on) {
      bodyWrap.hidden = !on;
      toggle.setAttribute('aria-expanded', String(on));
      wrap.classList.toggle('collapsed', !on);
      ui.set('open', { ...ui.get('open', {}), [spec.id]: on });
    }
    slot.open = () => setOpen(true);
    head.querySelector('.sec-title').replaceWith(h('h2', { class: 'sec-title' }, toggle));
    wrap.append(head, bodyWrap);
    return wrap;
  }

  // ─── the rail ───────────────────────────────────────────────────────────
  let io = null;
  function paintRail() {
    const ready = slots.filter((s) => s.built && !s.empty && !s.el.hidden);
    const btns = ready.map((s) => h('button', {
      type: 'button', 'data-sec': s.spec.id,
      onclick: () => { if (s.open) s.open(); s.el.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
    }, s.spec.id === 'tool' ? sectionTitle('tool') : sectionTitle(s.spec.id)));
    rail.replaceChildren(...btns, state.final ? h('button', { type: 'button', class: 'rail-ask', onclick: () => ask() }, '💬 ask it') : null);
    rail.hidden = !btns.length;
    if (io) io.disconnect();
    io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const id = entry.target.id.replace('sec-', '');
        rail.querySelectorAll('button[data-sec]').forEach((b) => b.classList.toggle('on', b.dataset.sec === id));
      });
    }, { rootMargin: '-35% 0px -60% 0px' });
    ready.forEach((s) => io.observe(s.el));
  }
  ctx.onCleanup(() => io && io.disconnect());

  const ask = (question) => {
    if (!state.final) { toast('ask it once the canvas is done — nearly there'); return; }
    openDrawer({ canvas: d, tab: 'ask', question });
  };

  // ─── the crown ──────────────────────────────────────────────────────────
  function buildCrown() {
    const sticker = h('div', { class: 'sticker' });
    const title = h('h1', { class: 'c-title' });
    const byline = h('div', { class: 'byline' });
    const callit = h('div', { class: 'callit' });
    const tldr = h('div', { class: 'tldr-wrap' });
    const progress = h('div', { class: 'progress', 'aria-live': 'polite' });
    const meta = h('div', { class: 'meta' });
    const actions = h('div', { class: 'crown-actions' });
    const notices = h('div');
    const el = h('header', { class: 'crown' }, sticker, title, byline, callit, tldr, progress, meta, actions, notices);

    // Call it: guess the big idea before the tl;dr lands. Guessing first,
    // even wrong, makes the real answer stick (the pretesting effect).
    const guessOn = !data && lsGet('yapmap.callit', 'on') !== 'off';
    let guess = { state: guessOn ? 'asking' : 'off', text: '' };
    const input = h('input', {
      class: 'field sm', placeholder: 'e.g. “bad judgment, not AI, is the real risk”', maxlength: '200', 'aria-label': 'Your guess at the big idea',
    });

    function paintCallit() {
      if (guess.state === 'asking') {
        callit.replaceChildren(
          h('div', { class: 'ci-head' }, h('b', null, 'call it 🎯'), h('span', null, 'while it cooks: what’s the big idea? guessing first makes it stick.')),
          h('form', {
            class: 'row',
            onsubmit: (e) => {
              e.preventDefault();
              const v = input.value.trim();
              if (!v) { input.focus(); return; }
              guess = { state: 'locked', text: v };
              paintCallit();
              paintTldr();
            },
          }, input,
          h('button', { class: 'ghost sm', type: 'submit' }, 'lock it in'),
          h('button', { class: 'mini', type: 'button', onclick: () => { guess.state = 'off'; paintCallit(); paintTldr(); } }, 'skip'),
          h('button', { class: 'mini', type: 'button', title: 'Never ask me to guess again', onclick: () => { lsSet('yapmap.callit', 'off'); guess.state = 'off'; paintCallit(); paintTldr(); toast('ok — no more guessing games'); } }, 'never'),
          ),
        );
      } else if (guess.state === 'locked') {
        callit.replaceChildren(h('div', { class: 'ci-locked' }, `🔒 locked in: “${guess.text}”`, d.tldr ? '' : ' — we’ll see when the tl;dr lands.'));
      } else if (guess.state === 'revealed') {
        const grade = (g, msg) => {
          logEvent('call', { video_id: videoId, grade: g });
          guess.state = 'graded';
          callit.replaceChildren(h('div', { class: 'ci-locked' }, msg));
          toast(g === 'nailed' ? 'certified video whisperer 🎯' : 'logged — it’ll stick better now');
        };
        callit.replaceChildren(h('div', { class: 'ci-grade' },
          h('span', null, `you said: “${guess.text}” — so, did you call it?`),
          h('div', { class: 'row' },
            h('button', { class: 'mini', type: 'button', onclick: () => grade('nailed', 'Nailed it. Guessing first is why this one will stick.') }, 'nailed it 🎯'),
            h('button', { class: 'mini', type: 'button', onclick: () => grade('close', 'Close counts — having guessed makes the real answer stick harder.') }, 'close-ish'),
            h('button', { class: 'mini', type: 'button', onclick: () => grade('off', 'Way off still helps: you’ll remember the real answer better for having called it.') }, 'way off 💀'),
          ),
        ));
      } else if (guess.state !== 'graded') {
        callit.replaceChildren();
      }
      callit.hidden = !callit.childNodes.length;
    }

    function paintTldr() {
      if (!d.tldr) { tldr.replaceChildren(); return; }
      const hidden = guess.state === 'asking' || guess.state === 'locked';
      tldr.replaceChildren(h('p', { class: 'tldr' + (hidden ? ' blurred' : ''), 'aria-hidden': hidden ? 'true' : null }, d.tldr));
      if (hidden) {
        tldr.append(h('button', {
          class: 'reveal', type: 'button',
          onclick: () => {
            guess.state = guess.state === 'locked' ? 'revealed' : 'off';
            paintCallit();
            paintTldr();
          },
        }, guess.state === 'locked' ? '👀 reveal the tl;dr' : 'the tl;dr is ready — guess first, or peek'));
      }
    }

    function paintProgress() {
      if (state.final) { progress.replaceChildren(); progress.hidden = true; return; }
      progress.hidden = false;
      const secs = Math.round((Date.now() - state.started) / 1000);
      const partialMap = state.map && state.map.streaming;
      const stageText = {
        queued: 'getting ready…',
        transcript: 'grabbing the transcript…',
        reading: WAITING[Math.floor(secs / 4) % WAITING.length],
        thinking: `thinking it through before it writes${state.thinking ? ` · ${Math.round(state.thinking / 1000)}k characters of planning` : ''}…`,
        writing: state.writing ? `writing ${state.writing}…` : 'writing…',
        saving: 'saving it to your library…',
      }[state.stage] || 'cooking…';
      const done = state.done.size;
      progress.replaceChildren(
        h('div', { class: 'pg-top' },
          h('span', { class: 'orb sm', 'aria-hidden': 'true' }),
          h('span', { class: 'pg-stage' }, stageText),
          h('span', { class: 'pg-clock' }, `${secs}s`),
          state.rec ? h('button', { class: 'mini', type: 'button', onclick: () => cancelJob(state.rec) }, 'cancel') : null,
        ),
        h('div', { class: 'pg-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(FIELD_COUNT), 'aria-valuenow': String(done), 'aria-label': 'Sections written' },
          h('i', { style: { width: `${Math.max(4, (done / FIELD_COUNT) * 100)}%` } })),
        h('ul', { class: 'pg-list' }, CHECKLIST.map(([key, label]) => h('li', {
          class: state.done.has(key) ? 'done' : (state.current === key ? 'now' : ''),
        }, state.done.has(key) ? '✓ ' : state.current === key ? '● ' : '', label,
        key === 'mindmap' && partialMap ? ` · ${countIdeas(d.mindmap)}` : ''))),
        h('p', { class: 'pg-note' }, 'You can leave this page — it keeps cooking, and the nav tells you when it’s ready.'),
      );
    }

    function paintMeta() {
      const pills = [
        d.channel && { text: d.channel, live: true },
        d.duration && { text: `${fmtDur(d.duration)} of footage` },
        d.mindmap && state.final && { text: `${countIdeas(d.mindmap)} ideas` },
        d.receipts && d.receipts.length && state.final && { text: `${d.receipts.length} findings` },
        d.language && { text: d.language },
        d.truncated && { text: '⚠ long video — transcript trimmed' },
      ].filter(Boolean);
      meta.replaceChildren(...pills.map((p) => h('span', { class: 'pill' + (p.live ? ' live' : '') }, p.text)));
    }

    function paintActions() {
      if (!state.final) { actions.replaceChildren(); return; }
      const segs = cutSegments(d);
      const cutLen = segs.reduce((sum, s) => sum + (s.end - s.start), 0);
      const langName = d.lang === 'auto' ? (d.language || 'original').replace(/\s*\(auto-generated\)/, '') : langLabel(d.lang || 'en');
      const regen = () => { location.hash = `#/v/${videoId}?force=1` + (d.lang && d.lang !== 'en' ? `&lang=${d.lang}` : ''); };
      const langs = new Set(d.langs && d.langs.length ? d.langs : [d.lang || 'en']);
      const langItems = () => {
        const list = languages().filter((l) => l.code !== 'auto');
        return list.map((l) => {
          const saved = langs.has(l.code);
          if (l.code === (d.lang || 'en')) return { label: `${l.label} ✓`, hint: 'you’re reading this one', disabled: true };
          if (saved) return { label: l.label, hint: 'saved — opens instantly', href: `#/v/${videoId}?lang=${l.code}` };
          if (isStatic()) return null;
          return { label: l.label, hint: 'make it in this language · one Claude call', href: `#/v/${videoId}?force=1&lang=${l.code}` };
        }).filter(Boolean);
      };
      const more = menuButton('⋯ more', () => [
        !isStatic() ? { label: 'regenerate ↻', hint: 'a fresh take · one Claude call', onclick: regen } : null,
        { label: 'download the canvas (.md)', onclick: () => { download(fullMarkdown(d), `${slug(d.headline)}-canvas.md`); toast('whole canvas saved ✓'); } },
        { label: 'print a study sheet', hint: 'or save it as a PDF', onclick: () => printSheet(d, { kindLabel: KIND_LABEL }) },
        { label: 'copy the link to this video', onclick: () => copy(ytUrl(videoId), 'link copied ✓') },
        { label: 'open on youtube ↗', href: ytUrl(videoId), external: true },
        null,
        !isStatic() ? { label: 'delete from library…', danger: true, onclick: confirmDelete } : null,
        { label: 'map a new video', href: '#/' },
      ].filter((x, i, arr) => x !== null || (i > 0 && arr[i - 1] !== null)), { cls: 'ghost', ariaLabel: 'More actions' });
      actions.replaceChildren(
        segs.length ? h('button', {
          class: 'cta sm cut-cta', type: 'button', title: 'Plays only the moments that matter, back to back, in the real video',
          onclick: () => playCut({ videoId, title: d.headline, segments: segs, duration: d.duration }),
        }, `▶ no-yap cut · ${fmtDur(cutLen)}`) : null,
        h('button', { class: 'ghost', type: 'button', onclick: () => ask() }, '💬 ask it'),
        h('button', { class: 'ghost', type: 'button', 'aria-label': 'Transcript', onclick: () => openDrawer({ canvas: d, tab: 'transcript' }) },
          '📜', h('span', { class: 'lbl' }, ' transcript')),
        menuButton(['🌐', h('span', { class: 'lbl' }, ' ' + langName)], langItems, { cls: 'ghost', ariaLabel: `Language: ${langName}` }),
        more,
      );
    }

    function confirmDelete() {
      const box = h('div', { class: 'notice danger' },
        h('span', null, 'Delete this canvas — and its answers, transcript and flashcard reviews? The video on YouTube is untouched.'),
        h('div', { class: 'row' },
          h('button', {
            class: 'ghost sm danger', type: 'button',
            onclick: async () => {
              try {
                await deleteCanvas(videoId);
                forgetUiState(videoId);
                dropRecent(videoId);
                document.dispatchEvent(new CustomEvent('yapmap:changed'));
                toast('deleted. poof ✓');
                location.hash = '#/library';
              } catch (e) { toast(e.message); }
            },
          }, 'yes, delete it'),
          h('button', { class: 'ghost sm', type: 'button', onclick: () => box.remove() }, 'keep it'),
        ),
      );
      notices.prepend(box);
      box.querySelector('button').focus();
    }

    function paintNotices() {
      notices.replaceChildren(
        state.final && d.outdated ? h('div', { class: 'notice' },
          h('span', null, 'Made with an older yapmap — the map has no timestamps or notes, and there’s no question list. Regenerate to get all of it (one Claude call).'),
          !isStatic() ? h('button', { class: 'ghost sm', type: 'button', onclick: () => { location.hash = `#/v/${videoId}?force=1`; } }, 'regenerate ↻') : null,
        ) : null,
        isStatic() && d.license ? h('p', { class: 'credit' },
          'video by ', d.channel || 'its creator', ` · licensed ${d.license} · `,
          h('a', { href: ytUrl(videoId), target: '_blank', rel: 'noopener' }, 'watch the original'),
        ) : null,
      );
    }

    return {
      el,
      update() {
        sticker.textContent = (d.mode_label || (state.final ? 'deep dive' : 'cooking…')).toLowerCase();
        title.textContent = d.headline || (state.meta && state.meta.title) || 'getting the video…';
        byline.replaceChildren(
          !d.headline && !state.final ? h('img', { class: 'by-thumb', src: thumb(videoId), alt: '' }) : null,
          state.meta && !d.headline ? h('span', null, state.meta.channel || '') : null,
        );
        byline.hidden = !byline.childNodes.length;
        paintCallit();
        paintTldr();
        paintProgress();
        paintMeta();
        paintActions();
        paintNotices();
      },
      tick() { if (!state.final) paintProgress(); },
    };
  }

  // ─── builders ───────────────────────────────────────────────────────────
  const BUILDERS = {
    tool: () => {
      const art = buildArtifact(d, ctx, ui);
      if (!art) return null;
      return { say: art.say, tools: art.tools, el: art.el, preview: '' };
    },
    wall: () => wallSection(d, ui),
    shelf: () => shelfSection(d),
    download: () => downloadSection(d, ctx),
    grass: () => movesSection(d, ctx, ui),
    receipts: () => receiptsSection(d, ui),
  };

  // ─── go ─────────────────────────────────────────────────────────────────
  if (state.final) {
    finalize();
  } else {
    crown.update();
    slots.forEach((slot) => { slot.el.replaceChildren(pending(slot.spec.id)); });
    const clock = setInterval(() => crown.tick(), 1000);
    ctx.onCleanup(() => clearInterval(clock));
    const off = subscribe(rec, (evt) => {
      if (!ctx.alive()) return;
      if (evt.type === 'meta') {
        state.meta = evt;
        Object.assign(d, { title: evt.title, channel: evt.channel, duration: evt.duration, language: evt.language, truncated: evt.truncated, lang: evt.lang });
        document.title = `${evt.title} — cooking · yapmap`;
        crown.update();
      } else if (evt.type === 'stage') {
        state.stage = evt.stage;
        crown.tick();
      } else if (evt.type === 'progress') {
        if (evt.thinking) state.thinking = evt.thinking;
        state.current = evt.field || state.current;
        state.writing = evt.field ? fieldName(evt.field) : state.writing;
      } else if (evt.type === 'partial') {
        state.current = evt.key;
        d[evt.key] = evt.value;
        apply([evt.key]);
      } else if (evt.type === 'field') {
        state.done.add(evt.key);
        d[evt.key] = evt.value;
        apply([evt.key]);
        crown.tick();
      } else if (evt.type === 'warning') {
        toast(evt.message);
      } else if (evt.type === 'done') {
        Object.assign(d, evt.result);
        state.final = true;
        state.rec = null;
        finalize();
        if (!evt.result.cached) document.dispatchEvent(new CustomEvent('yapmap:changed'));
      } else if (evt.type === 'error' || evt.type === 'cancelled' || evt.type === 'lost') {
        const err = new Error(evt.message);
        err.code = evt.code;
        err.resets_at = evt.resets_at;
        const screen = evt.type === 'cancelled'
          ? h('div', { class: 'error' }, h('div', { class: 'card' },
            h('h1', { class: 'e-title' }, 'cancelled.'),
            h('p', null, 'Nothing was saved, and Claude stopped the moment you hit cancel.'),
            h('div', { class: 'row' },
              h('a', { class: 'ghost hot', href: `#/v/${videoId}?force=1` }, 'start it again'),
              h('a', { class: 'ghost', href: '#/' }, 'map something else'),
            )))
          : errorScreen(err, videoId);
        root.replaceChildren(screen);
        offerKept(screen, videoId, ctx);
      }
    });
    ctx.onCleanup(off);
  }

  function finalize() {
    state.final = true;
    pushRecent({ id: videoId, title: d.headline || d.title });
    document.title = `${d.headline || d.title} — yapmap`;
    ctx.onCleanup(() => { document.title = 'yapmap — turn the yap into a map'; });
    apply(Object.keys(d).concat(SECTIONS.flatMap((s) => s.keys)));
    crown.update();
    const t = Number(query.get('t'));
    if (query.has('t') && Number.isFinite(t)) jumpTo(videoId, t, { title: d.headline });
    if (query.get('ask') === '1') ask();
  }
}

function fieldName(key) {
  return {
    mode: 'the vibe check', mode_label: 'the vibe check', headline: 'the headline', tldr: 'the tl;dr', mindmap: 'the map',
    artifact: 'the tool', stickies_label: 'the wall', stickies: 'the wall', shelf: 'the shelf', summary: 'the download',
    moves: 'next moves', questions: 'questions to ask it', receipts_label: 'the findings', receipts: 'the findings',
  }[key] || '';
}

// ─── the wall ─────────────────────────────────────────────────────────────
function wallSection(d, ui) {
  const moved = ui.get('notes', {});
  const notes = d.stickies.map((s, i) => {
    const tilt = ((i * 37) % 7) - 3;
    const [dx, dy] = moved[i] || [0, 0];
    const note = h('div', {
      class: 'note k-' + s.kind,
      dataset: { tilt: String(tilt), dx: String(dx), dy: String(dy) },
      style: { transform: `translate(${dx}px, ${dy}px) rotate(${tilt}deg)` },
    },
      h('span', { class: 'kind' }, KIND_LABEL[s.kind] || s.kind),
      h('p', { class: 'n-text' }, s.text),
      h('div', { class: 'note-actions' },
        typeof s.t === 'number' ? h('button', { class: 'note-btn', type: 'button', onclick: () => jumpTo(d.video_id, s.t, { title: s.text }) }, '▶ ' + fmt(s.t)) : h('span'),
        h('button', { class: 'note-btn', type: 'button', title: 'Save as a 1080×1920 story image', onclick: () => storyCard(s, d) }, '⤓ story card'),
      ),
    );
    draggable(note, (x, y) => { moved[i] = [x, y]; ui.set('notes', moved); });
    return note;
  });
  const tidy = h('button', {
    class: 'mini', type: 'button',
    onclick: () => {
      notes.forEach((n) => { n.dataset.dx = '0'; n.dataset.dy = '0'; n.style.transform = `rotate(${n.dataset.tilt}deg)`; });
      ui.set('notes', {});
      toast('tidied ✓');
    },
  }, 'tidy up');
  return {
    say: 'the bits worth screenshotting. drag them around, or turn one into a story card.',
    tools: [tidy],
    el: h('div', { class: 'wall' }, notes),
    preview: `${d.stickies.length} notes`,
  };
}

async function storyCard(sticky, d) {
  toast('drawing your story card…');
  try {
    const blob = await stickyCard({ ...sticky, kindLabel: KIND_LABEL[sticky.kind], headline: d.headline, channel: d.channel });
    downloadBlob(blob, `yapmap-${slug(d.headline)}-${sticky.t ?? 'note'}.png`);
    logEvent('storycard', { video_id: d.video_id });
    toast('story card saved — go post it ✓');
  } catch (e) {
    toast('couldn’t draw that one');
  }
}

// Notes stay in grid flow and move by transform only -- dragging can never
// break the layout, and "tidy up" is just resetting two numbers.
function draggable(el, onMoved) {
  let startX = 0, startY = 0, baseX = 0, baseY = 0, active = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    active = true;
    startX = e.clientX; startY = e.clientY;
    baseX = parseFloat(el.dataset.dx) || 0; baseY = parseFloat(el.dataset.dy) || 0;
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', (e) => {
    if (!active) return;
    const dx = baseX + (e.clientX - startX), dy = baseY + (e.clientY - startY);
    el.dataset.dx = dx; el.dataset.dy = dy;
    el.style.transform = `translate(${dx}px, ${dy}px) rotate(${el.dataset.tilt}deg)`;
  });
  const end = (e) => {
    if (!active) return;
    active = false;
    el.classList.remove('dragging');
    try { el.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    onMoved(parseFloat(el.dataset.dx) || 0, parseFloat(el.dataset.dy) || 0);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// ─── the shelf ────────────────────────────────────────────────────────────
function shelfSection(d) {
  const hint = { book: ' book', paper: ' paper', person: '', tool: '', site: '', other: '' };
  const grid = h('div', { class: 'shelf-grid' }, d.shelf.map((item) => h('div', { class: 'shelf-item' },
    h('div', { class: 's-kind' }, h('span', { 'aria-hidden': 'true' }, SHELF_ICON[item.kind] || '✦'), item.kind),
    h('div', { class: 's-name' }, item.name),
    item.note ? h('p', { class: 's-note' }, item.note) : null,
    h('div', { class: 'row' },
      typeof item.t === 'number' ? h('button', { class: 'stamp', type: 'button', onclick: () => jumpTo(d.video_id, item.t, { title: item.name }) }, '▶ ' + fmt(item.t)) : null,
      h('a', { class: 'mini', href: searchUrl(item.name + (hint[item.kind] || '')), target: '_blank', rel: 'noopener' }, 'look it up ↗'),
      h('button', { class: 'mini', type: 'button', onclick: () => copy(item.name, 'copied ✓') }, 'copy'),
    ),
  )));
  const copyAll = h('button', {
    class: 'mini', type: 'button',
    onclick: () => copy(d.shelf.map((s) => `- ${s.name}${s.note ? ' — ' + s.note : ''}`).join('\n'), 'the whole shelf, copied ✓'),
  }, 'copy the list');
  return {
    say: 'every book, tool and person they name-dropped — with the second they said it.',
    tools: [copyAll],
    el: grid,
    preview: `${d.shelf.length} ${d.shelf.length === 1 ? 'thing' : 'things'}`,
  };
}

// ─── the download, in any voice ───────────────────────────────────────────
function downloadSection(d, ctx) {
  const prose = h('div', { class: 'prose cols drop' });
  const bar = h('div', { class: 'seg voices', role: 'tablist', 'aria-label': 'Pick a voice' });
  const cache = { straight: d.summary };
  let current = 'straight';

  function show(lines, voice) {
    if (voice === 'groupchat') {
      prose.className = 'prose';
      const people = {};
      prose.replaceChildren(h('div', { class: 'chat' }, lines.map((line) => {
        const m = line.match(/^\s*([^:]{1,24}):\s*(.+)$/);
        const name = m ? m[1].trim().toLowerCase() : '·';
        if (!(name in people)) people[name] = Object.keys(people).length % 3;
        return h('div', { class: 'bubble p' + people[name] }, h('small', null, name), m ? m[2] : line);
      })));
      return;
    }
    prose.className = 'prose cols' + (voice === 'straight' ? ' drop' : '');
    prose.replaceChildren(...lines.map((p) => h('p', null, p)));
  }

  async function pick(voice, label) {
    current = voice;
    [...bar.children].forEach((b) => { b.classList.toggle('on', b.dataset.voice === voice); b.setAttribute('aria-selected', String(b.dataset.voice === voice)); });
    if (cache[voice]) { show(cache[voice], voice); return; }
    prose.className = 'prose';
    prose.replaceChildren(h('p', { class: 'voice-wait' }, h('span', { class: 'pulse-dot' }), ` rewriting it as ${label}… one quick Claude call`));
    try {
      const res = await revoice(d.video_id, voice, d.lang);
      cache[voice] = res.lines;
      if (ctx.alive() && current === voice) show(res.lines, voice);
    } catch (e) {
      if (!ctx.alive() || current !== voice) return;
      prose.replaceChildren(h('p', { class: 'voice-wait' },
        e.needsInstall ? 'This voice wasn’t pre-made for the demo — install yapmap to re-voice anything.' : e.message));
    }
  }

  VOICES.forEach(([voice, label]) => bar.append(h('button', {
    type: 'button', role: 'tab', 'data-voice': voice, class: voice === 'straight' ? 'on' : '', 'aria-selected': String(voice === 'straight'),
    onclick: () => pick(voice, label),
  }, label)));
  show(d.summary, 'straight');

  const copyBtn = h('button', { class: 'mini', type: 'button', onclick: () => copy((cache[current] || d.summary).join('\n\n'), 'copied ✓') }, 'copy');
  return {
    say: 'the whole thing, in the time it takes to finish your coffee — in whatever voice hits.',
    tools: [copyBtn],
    el: h('div', null, bar, prose),
    preview: `${d.summary.length} paragraphs`,
  };
}

// ─── touch grass protocol ─────────────────────────────────────────────────
function movesSection(d, ctx, ui) {
  const doneMoves = ui.set_('movesDone');
  const rows = d.moves.map((move, i) => {
    const row = h('div', { class: 'move' + (doneMoves.has(i) ? ' done' : '') });
    const check = h('button', {
      class: 'm-check', type: 'button', role: 'checkbox', 'aria-checked': String(doneMoves.has(i)),
      onclick: () => { const on = ui.toggle('movesDone', i); row.classList.toggle('done', on); check.setAttribute('aria-checked', String(on)); },
    }, h('span', { class: 'box', 'aria-hidden': 'true' }), h('span', { class: 'mtext' }, move));
    const actions = h('div', { class: 'row' });
    const btn = h('button', {
      class: 'mini', type: 'button',
      onclick: async () => {
        btn.disabled = true;
        try {
          const c = await commit({ video_id: d.video_id, headline: d.headline, action: move });
          committed(c);
          toast('committed. we’ll check in on you 👀');
          document.dispatchEvent(new CustomEvent('yapmap:changed'));
        } catch (e) {
          btn.disabled = false;
          toast(e.message);
        }
      },
    }, '📌 i’ll do this');
    actions.append(btn);
    function committed(c) {
      btn.disabled = true;
      btn.classList.add('on');
      btn.textContent = 'committed ✓';
      actions.replaceChildren(btn, reminderMenu(c));
    }
    row.append(check, actions);
    return { move, row, committed };
  });

  listCommitments().then(({ items }) => {
    if (!ctx.alive()) return;
    rows.forEach((r) => {
      const c = items.find((x) => x.status === 'open' && x.video_id === d.video_id && x.action === r.move);
      if (c) r.committed(c);
    });
  }).catch(() => {});

  return {
    say: 'what to actually go do about it. pin one and yapmap will ask whether you did.',
    tools: [h('a', { class: 'mini', href: '#/grass' }, 'your commitments →')],
    el: h('div', { class: 'moves' }, rows.map((r) => r.row)),
    preview: `${d.moves.length} moves`,
  };
}

/** Put a commitment in your calendar: an evening two days out, with a reminder. */
export function reminderMenu(c) {
  const event = () => {
    const { start, end } = reminderSlot(2);
    return {
      uid: c.id,
      title: `🌱 ${c.action}`,
      description: `You said you'd do this${c.headline ? ` after watching "${c.headline}"` : ''}. Did you? Mark it in yapmap's grass tab.`,
      start,
      end,
    };
  };
  return menuButton('📅 remind me', () => [
    { label: 'Google Calendar', hint: 'opens with the event filled in', href: googleCalendarUrl(event()), external: true },
    {
      label: 'Apple / Outlook (.ics)', hint: 'a file your calendar app opens',
      onclick: () => { download(icsEvent(event()), `yapmap-${slug(c.action)}.ics`, 'text/calendar;charset=utf-8'); toast('reminder saved — open it to add it ✓'); },
    },
  ], { cls: 'mini', ariaLabel: 'Add a reminder to your calendar' });
}

// ─── receipts ─────────────────────────────────────────────────────────────
function receiptsSection(d, ui) {
  const picked = ui.set_('picked');
  const count = h('span', { class: 'count', 'aria-live': 'polite' });
  const save = () => ui.set('picked', [...picked]);
  const dl = h('button', {
    class: 'cta sm', type: 'button', disabled: true,
    onclick: () => { download(pickedMarkdown(d, picked), `${slug(d.headline)}-findings.md`); toast('saved. it’s yours now ✓'); },
  }, 'download .md ↓');
  const copyBtn = h('button', { class: 'mini', type: 'button', disabled: true, onclick: () => copy(pickedMarkdown(d, picked)) }, 'copy');

  const rows = d.receipts.map((r, i) => {
    const check = h('button', {
      class: 'r-check', type: 'button', role: 'checkbox', 'aria-checked': 'false',
      onclick: () => { if (picked.has(i)) picked.delete(i); else picked.add(i); save(); paint(); },
    },
      h('span', { class: 'box', 'aria-hidden': 'true' }),
      h('span', { class: 'r-body' }, h('span', { class: 'r-title' }, r.title), r.detail ? h('span', { class: 'r-detail' }, r.detail) : null),
    );
    const row = h('div', { class: 'receipt' }, check,
      typeof r.t === 'number' ? h('button', { class: 'stamp', type: 'button', onclick: () => jumpTo(d.video_id, r.t, { title: r.title }) }, '▶ ' + fmt(r.t)) : null,
    );
    return { row, check };
  });

  function paint() {
    rows.forEach(({ row, check }, i) => {
      row.classList.toggle('picked', picked.has(i));
      check.setAttribute('aria-checked', String(picked.has(i)));
    });
    const n = picked.size;
    count.textContent = n ? `${n} of ${d.receipts.length} picked` : 'nothing picked yet — tap the ones that matter';
    dl.disabled = n === 0;
    copyBtn.disabled = n === 0;
  }
  paint();

  return {
    say: 'tick what matters. take it with you. timestamps jump the video.',
    tools: [],
    el: h('div', null,
      h('div', { class: 'receipts-bar' },
        count,
        h('button', { class: 'mini', type: 'button', onclick: () => { d.receipts.forEach((_, i) => picked.add(i)); save(); paint(); } }, 'select all'),
        h('button', { class: 'mini', type: 'button', onclick: () => { picked.clear(); save(); paint(); } }, 'clear'),
        copyBtn,
        dl,
      ),
      h('div', { class: 'receipts' }, rows.map((r) => r.row)),
    ),
    preview: `${d.receipts.length} findings`,
  };
}

// ─── export ───────────────────────────────────────────────────────────────
const sourceLine = (d) => `Source: ${ytUrl(d.video_id)}` + (d.channel ? `  ·  ${d.channel}` : '');
const linker = (d) => (t) => (typeof t === 'number' ? ` — [${fmt(t)}](${ytUrl(d.video_id, t)})` : '');

function pickedMarkdown(d, picked) {
  const link = linker(d);
  const out = [`# ${d.headline || d.title}`, '', `*${d.receipts_label || 'Key findings'} — saved from yapmap*`, '', sourceLine(d), ''];
  d.receipts.filter((_, i) => picked.has(i)).forEach((r) => {
    out.push(`## ${r.title}${link(r.t)}`);
    if (r.detail) out.push('', r.detail);
    out.push('');
  });
  return out.join('\n');
}

export function fullMarkdown(d) {
  const link = linker(d);
  const out = [`# ${d.headline || d.title}`, ''];
  if (d.tldr) out.push(`> ${d.tldr}`, '');
  out.push(sourceLine(d), '');
  if (d.summary && d.summary.length) out.push('## Summary', '', d.summary.join('\n\n'), '');
  if (d.mindmap) out.push('## Mindmap', '', treeMarkdown(d.mindmap, d.video_id).replace(/^# .*\n+(> .*\n+)?/, ''), '');
  out.push(...artifactMarkdown(d, link));
  if (d.stickies && d.stickies.length) {
    out.push(`## ${d.stickies_label || 'Highlights'}`, '');
    d.stickies.forEach((s) => out.push(`- **${KIND_LABEL[s.kind] || s.kind}** — ${s.text}${link(s.t)}`));
    out.push('');
  }
  if (d.shelf && d.shelf.length) {
    out.push('## The shelf', '');
    d.shelf.forEach((s) => out.push(`- **${s.name}** (${s.kind})${s.note ? ` — ${s.note}` : ''}${link(s.t)}`));
    out.push('');
  }
  if (d.moves && d.moves.length) {
    out.push('## Next moves', '');
    d.moves.forEach((m) => out.push(`- [ ] ${m}`));
    out.push('');
  }
  if (d.questions && d.questions.length) {
    out.push('## Test yourself', '');
    d.questions.forEach((q) => out.push(`- ${q}`));
    out.push('');
  }
  if (d.receipts && d.receipts.length) {
    out.push(`## ${d.receipts_label || 'Key findings'}`, '');
    d.receipts.forEach((r) => {
      out.push(`### ${r.title}${link(r.t)}`);
      if (r.detail) out.push('', r.detail);
      out.push('');
    });
  }
  out.push('---', '', 'Made with yapmap · powered by Claude');
  return out.join('\n');
}
