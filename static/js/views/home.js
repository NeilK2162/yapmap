import { h, parseVideoId, readRecents, toast, thumb, fmtDur } from '../util.js';
import { isStatic, library } from '../api.js';

const MARQUEE = [
  'turn the yap into a map', 'skip the sponsor segment', 'receipts, not vibes', '3 hours → 3 minutes',
  'for the tab you never finished', 'your attention span says thanks', "don't skip the video. skip the yap.",
  'the mindmap moves. so should you.', 'touch grass (for real this time)',
];

const TOOLS = [
  { href: '#/beef', emoji: '🥩', name: 'beef mode', accent: 'pink', text: 'Two videos, one ring. See exactly where they clash — with receipts from both sides.' },
  { href: '#/purge', emoji: '🧹', name: 'the purge', accent: 'cyan', text: "Paste your watch-later pile. Get watch / skim / skip for every video, and the hours you'd save." },
  { href: '#/library', emoji: '📚', name: 'library', accent: 'violet', text: 'Search every video you’ve ever mapped. Results are timestamps that play the moment.' },
  { href: '#/grass', emoji: '🌱', name: 'grass', accent: 'green', text: 'Commit to one move from a video. yapmap checks in later: did you actually do it?' },
  { href: '#/wrapped', emoji: '🎁', name: 'wrapped', accent: 'orange', text: 'Your month, mapped: hours of yap skipped, your vibe, your sticky of the month.' },
  { href: '#/extras', emoji: '⚡', name: 'extras', accent: 'lime', text: 'The one-click “map this” button for YouTube, light mode, and where your data lives.' },
];

export function render(root, _params, query, ctx) {
  const input = h('input', {
    class: 'field', type: 'text', autocomplete: 'off',
    placeholder: "paste the link. we'll handle the yap.", 'aria-label': 'YouTube link',
  });
  const go = (value) => {
    const id = parseVideoId(value);
    if (!id) { toast(value.trim() ? "that doesn't look like a youtube link" : 'paste a link first 🫡'); input.focus(); return; }
    location.hash = '#/v/' + id;
  };

  const recents = readRecents();
  const hero = h('section', { class: 'hero' },
    h('span', { class: 'kicker' }, '3 hours of video · 3 minutes of you'),
    h('h1', null, 'make it ', h('em', null, 'make sense'), '.'),
    h('p', { class: 'sub' },
      'Drop any YouTube link. Get a canvas back — ',
      h('b', null, 'a mindmap you can actually move around'),
      ', a tool built for that kind of video, sticky notes for the good bits, a real summary, and receipts you can watch as a no-yap cut.'),
    h('form', { class: 'drop', onsubmit: (e) => { e.preventDefault(); go(input.value); } },
      input,
      h('button', { class: 'cta', type: 'submit' }, 'make it make sense'),
    ),
    h('div', { class: 'hint' },
      'anything with captions · lectures, podcasts, recipes, reviews, documentaries · ',
      h('a', { href: '#/extras' }, 'get the one-click button'),
    ),
    recents.length ? h('div', { class: 'recents' },
      h('span', { class: 'lbl' }, 'back to'),
      recents.map((r) => h('a', { class: 'chip', href: '#/v/' + r.id, title: r.title }, r.title)),
    ) : null,
  );

  const gallery = h('section', { class: 'gallery', hidden: true });

  const toolkit = h('section', { class: 'toolkit' },
    h('h2', { class: 'section-title' }, 'the toolkit'),
    h('p', { class: 'section-sub' }, 'Six more ways to get more out of YouTube and waste less of your life on it.'),
    h('div', { class: 'tool-grid' }, TOOLS.map((t) => h('a', {
      class: 'tool-card', href: t.href, style: { '--accent': `var(--${t.accent})`, '--accent-ink': `var(--${t.accent}-ink)` },
    },
      h('span', { class: 't-emoji' }, t.emoji),
      h('h4', null, t.name),
      h('p', null, t.text),
      h('span', { class: 'go' }, 'open →'),
    ))),
  );

  const how = h('section', { class: 'how' },
    step('01', 'paste', 'Any YouTube link with captions. Shorts, lectures, 4-hour podcasts — all fair game.'),
    step('02', 'let it cook', 'Claude reads the whole transcript, works out what kind of video it is, and builds the right tools for it.'),
    step('03', 'take it with you', 'Watch the no-yap cut, tick the findings that matter, export them. Yours, offline, forever.'),
  );

  const track = h('div', { class: 'track' });
  const doubled = [...MARQUEE, ...MARQUEE];
  track.append(...doubled.map((m) => h('span', null, m)));

  root.append(hero, gallery, toolkit, how, h('div', { class: 'marquee', 'aria-hidden': 'true' }, track));

  if (isStatic()) showGallery(gallery, ctx);
  if (!('ontouchstart' in window)) setTimeout(() => ctx.alive() && input.focus(), 50);
}

function step(n, title, text) {
  return h('div', { class: 'step' }, h('div', { class: 'n' }, n), h('h4', null, title), h('p', null, text));
}

async function showGallery(box, ctx) {
  let items = [];
  try { items = (await library()).items || []; } catch (e) { return; }
  if (!ctx.alive() || !items.length) return;
  box.hidden = false;
  box.append(
    h('h2', { class: 'section-title' }, 'try it right here'),
    h('p', { class: 'section-sub' }, 'Real canvases, one for every kind of video. Open one — everything works except making new ones.'),
    h('div', { class: 'lib-grid' }, items.map(libCard)),
  );
}

export function libCard(item) {
  return h('a', { class: 'lib-card', href: '#/v/' + item.video_id, 'data-mode': item.mode },
    h('div', { class: 'thumb' },
      h('img', { src: thumb(item.video_id), alt: '', loading: 'lazy' }),
      h('span', { class: 'mode', style: modeStyle(item.mode) }, item.mode_label || item.mode),
      item.duration ? h('span', { class: 'dur' }, fmtDur(item.duration)) : null,
    ),
    h('div', { class: 'lc-body' },
      h('div', { class: 'lc-title' }, item.headline),
      h('div', { class: 'lc-sub' }, [item.channel, item.receipts ? `${item.receipts} findings` : null].filter(Boolean).join(' · ')),
      item.outdated ? h('span', { class: 'old', title: 'Made before the newest sections existed' }, 'older version · regenerate for the new tools') : null,
    ),
  );
}

const MODE_COLOR = { study: 'lime', yap: 'pink', howto: 'cyan', verdict: 'orange', story: 'violet' };
export function modeStyle(mode) {
  const c = MODE_COLOR[mode] || 'lime';
  return { background: `var(--${c})`, color: '#0a0a0a' };
}
