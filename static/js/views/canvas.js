import {
  h, fmt, fmtDur, slug, toast, copy, download, downloadBlob, ytUrl, thumb, searchUrl,
  pushRecent, setAccent, sectionHead, MODE_ACCENT,
} from '../util.js';
import { getCanvas, getMeta, revoice, isStatic } from '../api.js';
import { createMap } from '../map.js';
import { jumpTo, playCut, cutSegments } from '../player.js';
import { commit, listCommitments, logEvent } from '../store.js';
import { stickyCard } from '../storycard.js';
import { buildArtifact, artifactMarkdown, artifactNameForMode } from './artifacts.js';

const LOADING = [
  'locking in…', 'reading the whole thing so you don’t have to…', 'extracting the lore…',
  'skipping the sponsor segment…', 'finding the actual point…', 'separating the yap from the facts…',
  'chat, is this information…', 'vibe-checking the transcript…', 'writing the flashcards…',
  'still cooking. it’s a long one…', 'nearly. don’t close the tab…',
];
export const KIND_LABEL = {
  quote: 'they said it', aha: 'oh — that’s why', warning: 'heads up', stat: 'the number', tip: 'steal this',
};
const SHELF_ICON = { book: '📚', tool: '🛠️', person: '👤', paper: '📄', site: '🔗', other: '✦' };
const VOICES = [['straight', 'straight'], ['groupchat', 'group chat'], ['commentator', 'commentator'], ['brainrot', 'brainrot'], ['eli5', 'like i’m five']];

export async function render(root, [videoId], query, ctx) {
  const force = query.get('force') === '1';
  const state = { id: videoId, picked: new Set(), map: null, mapCard: null };
  const loader = loadingScreen(videoId, ctx);
  // Cached canvases come back in milliseconds; only show the loading screen
  // for real generations, so opening the library doesn't flash.
  const showTimer = setTimeout(() => { if (ctx.alive()) { root.replaceChildren(loader.el); loader.start(); } }, force ? 0 : 300);
  ctx.onCleanup(() => { clearTimeout(showTimer); loader.stop(); });

  let data;
  try {
    data = await getCanvas(videoId, { force });
  } catch (err) {
    clearTimeout(showTimer);
    loader.stop();
    if (ctx.alive()) root.replaceChildren(errorScreen(err));
    return;
  }
  clearTimeout(showTimer);
  loader.stop();
  if (!ctx.alive()) return;

  if (force) history.replaceState(null, '', '#/v/' + videoId);
  state.data = data;
  state.guess = loader.guess();
  pushRecent({ id: videoId, title: data.headline || data.title });
  if (!data.cached) document.dispatchEvent(new CustomEvent('yapmap:changed'));
  setAccent(MODE_ACCENT[data.mode] || 'lime');
  document.title = `${data.headline || data.title} — yapmap`;
  ctx.onCleanup(() => { document.title = 'yapmap — turn the yap into a map'; });

  const page = h('div', { class: 'canvas' });
  root.replaceChildren(page);
  buildCanvas(page, state, ctx);

  const t = Number(query.get('t'));
  if (query.has('t') && Number.isFinite(t)) jumpTo(videoId, t, { title: data.headline });
}

// ─── loading, with "call it" ──────────────────────────────────────────────
function loadingScreen(videoId, ctx) {
  const line = h('h2', null, LOADING[0]);
  const clock = h('div', { class: 'clock' }, '0s · usually a minute or two');
  const title = h('div', { class: 'p-title' }, 'getting the video…');
  const sub = h('div', { class: 'p-sub' }, 'reading the transcript');
  const input = h('input', { class: 'field', placeholder: 'e.g. “bad judgment, not AI, is the real risk”', maxlength: '200', 'aria-label': 'Your guess' });
  let locked = '';
  const form = h('form', {
    class: 'row',
    onsubmit: (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      locked = v;
      form.replaceWith(h('div', { class: 'locked' }, `🔒 locked in: “${v}” — we’ll see when it lands.`));
    },
  }, input, h('button', { class: 'ghost', type: 'submit' }, 'lock it in'));

  const el = h('div', { class: 'loading', 'aria-live': 'polite' },
    h('div', { class: 'preview' }, h('img', { src: thumb(videoId), alt: '' }), h('div', null, title, sub)),
    h('div', { class: 'orb' }),
    line,
    h('p', null, 'Reading the whole transcript so you don’t have to.'),
    clock,
    h('div', { class: 'callit' },
      h('h3', null, 'call it 🎯'),
      h('p', null, 'While it cooks: what’s the big idea? Guessing first — even guessing wrong — makes the real answer stick. Learning research calls it the pretesting effect.'),
      form,
    ),
  );

  let phraseTimer, clockTimer;
  return {
    el,
    start() {
      const started = Date.now();
      let i = 0;
      phraseTimer = setInterval(() => { i = (i + 1) % LOADING.length; line.textContent = LOADING[i]; }, 2600);
      clockTimer = setInterval(() => { clock.textContent = `${Math.round((Date.now() - started) / 1000)}s · usually a minute or two`; }, 1000);
      getMeta(videoId).then((m) => {
        if (!m || !ctx.alive()) return;
        title.textContent = m.title;
        sub.textContent = m.channel || 'reading the transcript';
      });
    },
    stop() { clearInterval(phraseTimer); clearInterval(clockTimer); },
    // A typed-but-unlocked guess still counts: nobody should lose it to a fast load.
    guess() { return locked || input.value.trim(); },
  };
}

function errorScreen(err) {
  return h('div', { class: 'error' }, h('div', { class: 'card' },
    h('h3', null, err.needsInstall ? 'that one needs the real thing.' : 'well. that flopped.'),
    h('p', null, err.message || String(err)),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      h('a', { class: 'ghost', href: '#/' }, 'try another link'),
      err.needsInstall ? h('a', { class: 'ghost hot', href: '#/extras' }, 'how to install') : null,
    ),
  ));
}

// ─── the canvas ───────────────────────────────────────────────────────────
function buildCanvas(page, state, ctx) {
  const d = state.data;
  const rail = h('nav', { class: 'rail', 'aria-label': 'Jump to a section' });
  page.append(buildCrown(state), rail);

  const sections = [];
  let n = 0;
  const add = (id, label, builder) => {
    const el = builder(n + 1);
    if (!el) return;
    n += 1;
    el.id = 'sec-' + id;
    sections.push({ id, label, el });
    page.append(el);
  };

  add('map', 'the map', (num) => mapSection(state, ctx, num));
  const art = buildArtifact(d, ctx);
  if (art) add('tool', art.title, (num) => h('section', { class: 'sec' }, sectionHead(num, art.title, art.say, ...(art.tools || [])), art.el));
  if (d.stickies && d.stickies.length) add('wall', (d.stickies_label || 'the wall').toLowerCase(), (num) => wallSection(state, num));
  if (d.shelf && d.shelf.length) add('shelf', 'the shelf', (num) => shelfSection(state, num));
  if (d.summary && d.summary.length) add('download', 'the download', (num) => downloadSection(state, ctx, num));
  if (d.moves && d.moves.length) add('grass', 'touch grass', (num) => movesSection(state, ctx, num));
  if (d.receipts && d.receipts.length) add('receipts', (d.receipts_label || 'receipts').toLowerCase(), (num) => receiptsSection(state, num));

  const railBtns = sections.map((s) => h('button', {
    type: 'button', 'data-sec': s.id, onclick: () => s.el.scrollIntoView({ behavior: 'smooth', block: 'start' }),
  }, s.label));
  rail.append(...railBtns);
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const id = entry.target.id.replace('sec-', '');
      railBtns.forEach((b) => b.classList.toggle('on', b.dataset.sec === id));
    });
  }, { rootMargin: '-35% 0px -60% 0px' });
  sections.forEach((s) => io.observe(s.el));
  ctx.onCleanup(() => io.disconnect());

  // The map has to be in the document (and visible) before markmap measures anything.
  state.map = createMap(state.mapCard, d.mindmap, { expandLevel: 2 });
  ctx.onCleanup(() => state.map && state.map.destroy());
}

function buildCrown(state) {
  const d = state.data;
  const segs = cutSegments(d);
  const cutLen = segs.reduce((sum, s) => sum + (s.end - s.start), 0);
  const regen = () => { location.hash = `#/v/${d.video_id}?force=1`; };

  const pills = [
    d.channel && { text: d.channel, live: true },
    d.duration && { text: `${fmtDur(d.duration)} of footage` },
    d.receipts && d.receipts.length && { text: `${d.receipts.length} findings` },
    d.language && { text: d.language },
    d.truncated && { text: '⚠ long video — transcript trimmed' },
    d.cached && !isStatic() && { text: '↺ from cache' },
  ].filter(Boolean);

  return h('header', { class: 'crown' },
    h('div', { class: 'sticker' }, (d.mode_label || 'deep dive').toLowerCase()),
    h('h2', null, d.headline || d.title),
    state.guess ? callReveal(state) : null,
    d.tldr ? h('p', { class: 'tldr' }, d.tldr) : null,
    h('div', { class: 'meta' }, pills.map((p) => h('span', { class: 'pill' + (p.live ? ' live' : '') }, p.text))),
    h('div', { class: 'crown-actions' },
      segs.length ? h('button', {
        class: 'ghost hot cut-cta',
        title: 'Plays only the moments that matter, back to back, in the real video',
        onclick: () => playCut({ videoId: d.video_id, title: d.headline, segments: segs, duration: d.duration }),
      }, `▶ watch the no-yap cut · ${fmtDur(cutLen)}`) : null,
      !isStatic() ? h('button', { class: 'ghost', onclick: regen }, 'regenerate ↻') : null,
      h('button', {
        class: 'ghost',
        onclick: () => { download(fullMarkdown(d), `${slug(d.headline)}-canvas.md`); toast('whole canvas saved ✓'); },
      }, 'take the whole canvas ↓'),
      h('a', { class: 'ghost', href: ytUrl(d.video_id), target: '_blank', rel: 'noopener' }, 'open on youtube ↗'),
      h('a', { class: 'ghost', href: '#/' }, 'new video'),
    ),
    d.outdated ? h('div', { class: 'notice' },
      h('span', null, `Made with an older yapmap — no ${artifactNameForMode(d.mode)}, no shelf, and the no-yap cut uses rough clip ends. Regenerate to get all of it (one Claude call).`),
      !isStatic() ? h('button', { class: 'ghost', onclick: regen }, 'regenerate ↻') : null,
    ) : null,
    isStatic() && d.license ? h('div', { class: 'credit' },
      'video by ', d.channel || 'its creator', ` · licensed ${d.license} · `,
      h('a', { href: ytUrl(d.video_id), target: '_blank', rel: 'noopener' }, 'watch the original'),
    ) : null,
  );
}

function callReveal(state) {
  const d = state.data;
  const box = h('div', { class: 'call-reveal' });
  const grade = (g, msg) => {
    logEvent('call', { video_id: d.video_id, grade: g });
    box.replaceChildren(h('div', { class: 'cr-col', style: { gridColumn: '1 / -1' } }, h('small', null, 'noted'), h('div', null, msg)));
    toast(g === 'nailed' ? 'certified video whisperer 🎯' : 'logged — it’ll stick better now');
  };
  box.append(
    h('div', { class: 'cr-col' }, h('small', null, 'you called it'), h('div', null, `“${state.guess}”`)),
    h('div', { class: 'cr-col' }, h('small', null, 'the video'), h('div', null, d.tldr || d.headline)),
    h('div', { class: 'cr-actions' },
      h('span', null, 'so… did you?'),
      h('button', { class: 'mini', onclick: () => grade('nailed', 'Nailed it. Guessing first is why this one will stick.') }, 'nailed it 🎯'),
      h('button', { class: 'mini', onclick: () => grade('close', 'Close counts — having guessed makes the real answer stick harder.') }, 'close-ish'),
      h('button', { class: 'mini', onclick: () => grade('off', 'Way off still helps: you’ll remember the real answer better for having called it.') }, 'way off 💀'),
    ),
  );
  return box;
}

// ─── the map ──────────────────────────────────────────────────────────────
function mapSection(state, ctx, num) {
  const card = h('div', { class: 'map-card' }, h('div', { class: 'map-legend' }, 'scroll to zoom · drag to pan · click a node to fold it'));
  state.mapCard = card;
  let expanded = false;
  const expandBtn = h('button', {
    class: 'mini',
    onclick: () => {
      expanded = !expanded;
      expandBtn.textContent = expanded ? 'collapse' : 'expand all';
      expandBtn.classList.toggle('on', expanded);
      // Rebuilding at another expand level is the reliable way to fold in bulk --
      // setting payload.fold on a live tree doesn't re-fold open nodes.
      state.map.rebuild(expanded ? -1 : 2);
    },
  }, 'expand all');
  const fullBtn = h('button', { class: 'mini', onclick: toggleFull }, 'fullscreen');
  function toggleFull() {
    const full = card.classList.toggle('full');
    fullBtn.textContent = full ? 'exit' : 'fullscreen';
    fullBtn.classList.toggle('on', full);
    state.map.fit();
  }
  const onKey = (e) => { if (e.key === 'Escape' && card.classList.contains('full')) toggleFull(); };
  document.addEventListener('keydown', onKey);
  ctx.onCleanup(() => document.removeEventListener('keydown', onKey));

  return h('section', { class: 'sec' },
    sectionHead(num, 'the map', 'drag it, zoom it, collapse the parts you already know.',
      expandBtn, h('button', { class: 'mini', onclick: () => state.map.fit() }, 're-centre'), fullBtn),
    card,
  );
}

// ─── the wall ─────────────────────────────────────────────────────────────
function wallSection(state, num) {
  const d = state.data;
  const notes = d.stickies.map((s, i) => {
    const tilt = ((i * 37) % 7) - 3;
    const note = h('div', {
      class: 'note k-' + s.kind,
      dataset: { tilt: String(tilt), dx: '0', dy: '0' },
      style: { transform: `rotate(${tilt}deg)` },
    },
      h('span', { class: 'kind' }, KIND_LABEL[s.kind] || s.kind),
      s.text,
      h('div', { class: 'note-actions' },
        typeof s.t === 'number' ? h('button', { class: 'jump', onclick: () => jumpTo(d.video_id, s.t, { title: s.text }) }, '▶ ' + fmt(s.t)) : h('span'),
        h('button', { class: 'card-btn', title: 'Save as a 1080×1920 story image', onclick: () => storyCard(s, d) }, '⤓ story card'),
      ),
    );
    draggable(note);
    return note;
  });
  const tidy = h('button', {
    class: 'mini',
    onclick: () => {
      notes.forEach((n) => { n.dataset.dx = '0'; n.dataset.dy = '0'; n.style.transform = `rotate(${n.dataset.tilt}deg)`; });
      toast('tidied ✓');
    },
  }, 'tidy up');
  return h('section', { class: 'sec' },
    sectionHead(num, (d.stickies_label || 'the wall').toLowerCase(), 'the bits worth screenshotting. drag them around, or turn one into a story card.', tidy),
    h('div', { class: 'wall' }, notes),
  );
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
function draggable(el) {
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
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// ─── the shelf ────────────────────────────────────────────────────────────
function shelfSection(state, num) {
  const d = state.data;
  const hint = { book: ' book', paper: ' paper', person: '', tool: '', site: '', other: '' };
  const grid = h('div', { class: 'shelf-grid' }, d.shelf.map((item) => h('div', { class: 'shelf-item' },
    h('div', { class: 's-kind' }, h('span', null, SHELF_ICON[item.kind] || '✦'), item.kind),
    h('div', { class: 's-name' }, item.name),
    item.note ? h('div', { class: 's-note' }, item.note) : null,
    h('div', { class: 's-actions' },
      typeof item.t === 'number' ? h('button', { class: 'stamp', onclick: () => jumpTo(d.video_id, item.t, { title: item.name }) }, '▶ ' + fmt(item.t)) : null,
      h('a', { class: 'mini', href: searchUrl(item.name + (hint[item.kind] || '')), target: '_blank', rel: 'noopener' }, 'look it up ↗'),
      h('button', { class: 'mini', onclick: () => copy(item.name, 'copied ✓') }, 'copy'),
    ),
  )));
  const copyAll = h('button', {
    class: 'mini',
    onclick: () => copy(d.shelf.map((s) => `- ${s.name}${s.note ? ' — ' + s.note : ''}`).join('\n'), 'the whole shelf, copied ✓'),
  }, 'copy the list');
  return h('section', { class: 'sec' },
    sectionHead(num, 'the shelf', 'every book, tool and person they name-dropped — with the second they said it.', copyAll),
    grid,
  );
}

// ─── the download, in any voice ───────────────────────────────────────────
function downloadSection(state, ctx, num) {
  const d = state.data;
  const prose = h('div', { class: 'prose cols drop' });
  const bar = h('div', { class: 'voices', role: 'tablist', 'aria-label': 'Pick a voice' });
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
    prose.replaceChildren(h('p', { class: 'voice-wait' }, `rewriting it as ${label}… one quick Claude call`));
    try {
      const res = await revoice(d.video_id, voice);
      cache[voice] = res.lines;
      if (ctx.alive() && current === voice) show(res.lines, voice);
    } catch (e) {
      if (!ctx.alive() || current !== voice) return;
      prose.replaceChildren(h('p', { class: 'voice-wait' },
        e.needsInstall ? 'This voice wasn’t pre-made for the demo — install yapmap to re-voice anything.' : e.message));
    }
  }

  VOICES.forEach(([voice, label]) => bar.append(h('button', {
    role: 'tab', 'data-voice': voice, class: voice === 'straight' ? 'on' : '', 'aria-selected': String(voice === 'straight'),
    onclick: () => pick(voice, label),
  }, label)));
  show(d.summary, 'straight');

  const copyBtn = h('button', { class: 'mini', onclick: () => copy((cache[current] || d.summary).join('\n\n'), 'copied ✓') }, 'copy');
  return h('section', { class: 'sec' },
    sectionHead(num, 'the download', 'the whole thing, in the time it takes to finish your coffee — in whatever voice hits.', bar, copyBtn),
    prose,
  );
}

// ─── touch grass protocol ─────────────────────────────────────────────────
function movesSection(state, ctx, num) {
  const d = state.data;
  const rows = d.moves.map((move) => {
    const row = h('div', { class: 'move' });
    const btn = h('button', {
      class: 'commit-btn',
      onclick: async () => {
        btn.disabled = true;
        try {
          await commit({ video_id: d.video_id, headline: d.headline, action: move });
          committed(btn);
          toast('committed. we’ll check in on you 👀');
          document.dispatchEvent(new CustomEvent('yapmap:changed'));
        } catch (e) {
          btn.disabled = false;
          toast(e.message);
        }
      },
    }, '📌 i’ll do this');
    row.append(
      h('button', { class: 'm-check', onclick: () => row.classList.toggle('done') }, h('span', { class: 'box' }), h('span', { class: 'mtext' }, move)),
      btn,
    );
    return { row, btn, move };
  });

  listCommitments().then(({ items }) => {
    if (!ctx.alive()) return;
    rows.forEach((r) => {
      if (items.some((c) => c.status === 'open' && c.video_id === d.video_id && c.action === r.move)) committed(r.btn);
    });
  }).catch(() => {});

  return h('section', { class: 'sec' },
    sectionHead(num, 'touch grass protocol', 'what to actually go do about it. pin one and yapmap will ask whether you did.',
      h('a', { class: 'mini', href: '#/grass' }, 'your commitments →')),
    h('div', { class: 'moves' }, rows.map((r) => r.row)),
  );
}

function committed(btn) {
  btn.disabled = true;
  btn.classList.add('committed');
  btn.textContent = 'committed ✓';
}

// ─── receipts ─────────────────────────────────────────────────────────────
function receiptsSection(state, num) {
  const d = state.data;
  const count = h('span', { class: 'count' });
  const dl = h('button', {
    class: 'dl', disabled: true,
    onclick: () => { download(pickedMarkdown(d, state.picked), `${slug(d.headline)}-findings.md`); toast('saved. it’s yours now ✓'); },
  }, 'download .md ↓');
  const copyBtn = h('button', { class: 'mini', disabled: true, onclick: () => copy(pickedMarkdown(d, state.picked)) }, 'copy');

  const rows = d.receipts.map((r, i) => {
    const row = h('div', { class: 'receipt', role: 'checkbox', 'aria-checked': 'false', tabindex: '0' },
      h('span', { class: 'box' }),
      h('div', { class: 'body' }, h('h4', null, r.title), r.detail ? h('p', null, r.detail) : null),
      typeof r.t === 'number' ? h('button', {
        class: 'stamp',
        onclick: (e) => { e.stopPropagation(); jumpTo(d.video_id, r.t, { title: r.title }); },
      }, '▶ ' + fmt(r.t)) : null,
    );
    const toggle = () => {
      state.picked.has(i) ? state.picked.delete(i) : state.picked.add(i);
      paint();
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } });
    return row;
  });

  function paint() {
    rows.forEach((row, i) => {
      row.classList.toggle('picked', state.picked.has(i));
      row.setAttribute('aria-checked', String(state.picked.has(i)));
    });
    const n = state.picked.size;
    count.textContent = n ? `${n} of ${d.receipts.length} picked` : 'nothing picked yet — tap the ones that matter';
    dl.disabled = n === 0;
    copyBtn.disabled = n === 0;
  }
  paint();

  return h('section', { class: 'sec' },
    sectionHead(num, (d.receipts_label || 'receipts').toLowerCase(), 'tick what matters. take it with you. timestamps jump the video.'),
    h('div', { class: 'receipts-bar' },
      count,
      h('button', { class: 'mini', onclick: () => { d.receipts.forEach((_, i) => state.picked.add(i)); paint(); } }, 'select all'),
      h('button', { class: 'mini', onclick: () => { state.picked.clear(); paint(); } }, 'clear'),
      copyBtn,
      dl,
    ),
    h('div', { class: 'receipts' }, rows),
  );
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
  if (d.mindmap) out.push('## Mindmap', '', d.mindmap, '');
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
