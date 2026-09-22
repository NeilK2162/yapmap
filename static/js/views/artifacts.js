// One tool per kind of video. Every item links back to the exact second it
// came from -- that's the rule that makes these more than a summary.

import { h, fmt, copy, download, slug, searchUrl, toast, ytUrl } from '../util.js';
import { deck as loadDeck } from '../api.js';
import { jumpTo, onTime } from '../player.js';
import { startTimer } from '../timers.js';
import { studyDeck } from '../deck.js';

export const ARTIFACT_NAMES = {
  flashcards: 'cram deck', cookalong: 'cook-along', verdict: 'the verdict', claims: 'claims to check', timeline: 'the timeline',
};
const MODE_ARTIFACT = { study: 'cram deck', howto: 'cook-along', verdict: 'the verdict', yap: 'claims to check', story: 'the timeline' };
export const artifactNameForMode = (mode) => MODE_ARTIFACT[mode] || 'the tool';

export function buildArtifact(canvas, ctx, ui) {
  const art = canvas.artifact;
  if (!art || !art.type) return null;
  const build = { flashcards, cookalong, verdict, claims, timeline }[art.type];
  return build ? build(canvas, art, ctx, ui) : null;
}

const stamp = (videoId, t, title) =>
  typeof t === 'number' ? h('button', { class: 'stamp', type: 'button', onclick: (e) => { e.stopPropagation(); jumpTo(videoId, t, { title }); } }, '▶ ' + fmt(t)) : null;

// ─── study: a deck whose answers are the creator explaining it ─────────────
function flashcards(canvas, art, ctx) {
  const holder = h('div');
  const cards = art.cards.map((c) => ({
    id: `${canvas.video_id}:${c.id}`, q: c.q, a: c.a, t: c.t, video_id: canvas.video_id, headline: canvas.headline, box: 0, reps: 0, due: null,
  }));
  const anki = () => {
    const clean = (s) => String(s).replace(/[\t\r\n]+/g, ' ');
    const rows = cards.map((c) => `${clean(c.q)}\t${clean(c.a)}${typeof c.t === 'number' ? ` (${fmt(c.t)} — ${ytUrl(canvas.video_id, c.t)})` : ''}`);
    download(rows.join('\n'), `${slug(canvas.headline)}-anki.txt`, 'text/plain;charset=utf-8');
    toast('saved — in Anki: File → Import, tab-separated ✓');
  };
  const mount = () => holder.replaceChildren(studyDeck({
    cards,
    tools: [
      ({ shuffle }) => h('button', { class: 'mini', type: 'button', onclick: shuffle }, 'shuffle'),
      () => h('button', { class: 'mini', type: 'button', onclick: anki }, 'anki ↓'),
    ],
  }).el);
  // Each card's spaced-repetition level comes from the review deck.
  holder.append(h('p', { class: 'hint' }, 'shuffling the deck…'));
  loadDeck().then((d) => {
    const byId = new Map((d.cards || []).map((c) => [c.id, c]));
    cards.forEach((c) => { const st = byId.get(c.id); if (st) Object.assign(c, { box: st.box, due: st.due, reps: st.reps }); });
  }).catch(() => {}).then(() => { if (ctx.alive()) mount(); });
  return {
    title: 'cram deck',
    say: 'flip it, then hear them explain it. what you know comes back later, right before you’d forget it.',
    el: holder,
    tools: [h('a', { class: 'mini', href: '#/review' }, 'review deck →')],
  };
}

// ─── howto: pantry, steps with timers, and a hands-free mode ───────────────
function cookalong(canvas, art, ctx, ui) {
  const got = ui.set_('pantry');
  const pantryList = h('div', { role: 'group', 'aria-label': 'Ingredients' });
  function renderPantry() {
    pantryList.replaceChildren(...art.ingredients.map((ing, i) => h('button', {
      class: 'ingr' + (got.has(i) ? ' got' : ''), type: 'button', role: 'checkbox', 'aria-checked': String(got.has(i)),
      onclick: () => { ui.toggle('pantry', i); got.has(i) ? got.delete(i) : got.add(i); renderPantry(); },
    }, h('span', { class: 'box', 'aria-hidden': 'true' }), h('span', { class: 'i-name' }, ing.item), h('span', { class: 'qty' }, ing.qty))));
  }
  renderPantry();

  const shopping = () => {
    const need = art.ingredients.filter((_, i) => !got.has(i));
    if (!need.length) { toast('you’ve got everything — go cook'); return; }
    copy(need.map((x) => `- ${[x.qty, x.item].filter(Boolean).join(' ')}`).join('\n'), `shopping list copied — ${need.length} to buy ✓`);
  };

  const pantry = art.ingredients.length ? h('div', { class: 'pantry', role: 'group', 'aria-label': 'The pantry' },
    h('h3', null, 'the pantry'),
    h('div', { class: 'yields' }, art.yields ? `makes ${art.yields} · ` : '', 'tick what you’ve got'),
    pantryList,
    h('div', { class: 'row' },
      h('button', { class: 'mini', type: 'button', onclick: shopping }, 'copy shopping list'),
    ),
  ) : null;

  const steps = h('ol', { class: 'steps' }, art.steps.map((s, i) => h('li', { class: 'step-card' },
    h('span', { class: 'num', 'aria-hidden': 'true' }, String(i + 1)),
    h('div', { class: 's-body' },
      h('div', { class: 's-text' }, s.text),
      h('div', { class: 'row' },
        stamp(canvas.video_id, s.t, `step ${i + 1}`),
        s.timer_seconds ? h('button', { class: 'mini warm', type: 'button', onclick: () => startTimer(`step ${i + 1}: ${s.text}`, s.timer_seconds) }, `⏱ ${fmt(s.timer_seconds)} timer`) : null,
      ),
    ),
  )));

  const focusBtn = h('button', { class: 'mini on', type: 'button', onclick: () => handsFree(canvas, art, ctx) }, 'hands-free mode ↗');
  const el = h('div', { class: 'cook' + (pantry ? '' : ' solo') }, pantry, steps);
  return { title: 'cook-along', say: 'tick the pantry, run the timers, or go hands-free and follow along step by step.', el, tools: [focusBtn] };
}

function handsFree(canvas, art, ctx) {
  let i = 0;
  const opener = document.activeElement;
  const overlay = h('div', { class: 'focus-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Hands-free cook-along' });
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (opener && opener.focus) opener.focus();
  };
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  }
  function go(d) { i = Math.max(0, Math.min(art.steps.length - 1, i + d)); render(); }
  function render() {
    const s = art.steps[i];
    overlay.replaceChildren(h('div', { class: 'focus-box' },
      h('div', { class: 'f-top' }, h('span', null, `step ${i + 1} of ${art.steps.length}`), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, '✕')),
      h('div', { class: 'f-step', 'aria-live': 'polite' }, s.text),
      h('div', { class: 'f-bar' },
        h('button', { class: 'ghost', type: 'button', onclick: () => go(-1), disabled: i === 0 }, '← back'),
        stamp(canvas.video_id, s.t, `step ${i + 1}`),
        s.timer_seconds ? h('button', { class: 'mini warm', type: 'button', onclick: () => startTimer(`step ${i + 1}: ${s.text}`, s.timer_seconds) }, `⏱ start ${fmt(s.timer_seconds)}`) : null,
        h('span', { class: 'spacer' }),
        i < art.steps.length - 1
          ? h('button', { class: 'cta', type: 'button', onclick: () => go(1) }, 'next step →')
          : h('button', { class: 'cta', type: 'button', onclick: () => { close(); toast('done! go eat 🍽️'); } }, 'done 🎉'),
      ),
    ));
    const next = overlay.querySelector('.cta');
    if (next) next.focus();
  }
  document.addEventListener('keydown', onKey);
  ctx.onCleanup(close);
  document.body.appendChild(overlay);
  render();
}

// ─── verdict: the reviewer's call, and who should ignore it ────────────────
function verdict(canvas, art) {
  const list = (cls, label, items, mark, withStamps) => items.length ? h('div', { class: 'v-list ' + cls },
    h('h3', null, label),
    h('ul', null, items.map((it) => h('li', null,
      h('span', { class: 'mk', 'aria-hidden': 'true' }, mark),
      h('span', { class: 'li-text' }, withStamps ? it.text : it),
      withStamps ? stamp(canvas.video_id, it.t, it.text) : null,
    ))),
  ) : null;

  const el = h('div', { class: 'verdict-card' },
    h('div', { class: 'call-box ' + art.call },
      h('small', null, 'the reviewer’s call'),
      h('div', { class: 'call' }, art.call),
      art.product ? h('div', { class: 'product' }, art.product) : null,
      art.call_line ? h('div', { class: 'call-line' }, art.call_line) : null,
    ),
    h('div', { class: 'verdict-cols' },
      list('for', 'it’s for you if', art.for_who, '✓'),
      list('skipif', 'skip it if', art.skip_if, '✗'),
      list('pro', 'the good', art.pros, '+', true),
      list('con', 'the bad', art.cons, '−', true),
    ),
    art.deal_breaker ? h('div', { class: 'breaker' },
      h('span', { class: 'b-label' }, '⚠ deal-breaker'),
      h('span', { class: 'b-text' }, art.deal_breaker.text),
      stamp(canvas.video_id, art.deal_breaker.t, 'the deal-breaker'),
    ) : null,
  );
  return { title: 'the verdict', say: 'the reviewer’s bottom line, who it’s for, and the one thing that might stop you.', el };
}

// ─── yap: every checkable claim, and a place to mark what holds up ─────────
function claims(canvas, art, ctx, ui) {
  const marks = ui.get('claims', {});
  const summary = h('p', { class: 'claims-summary' });
  const wrap = h('div', { class: 'claims' });

  function renderSummary() {
    const vals = Object.values(marks);
    const nope = vals.filter((v) => v === 'nope').length;
    summary.textContent = vals.length
      ? `checked ${vals.length} of ${art.claims.length}` + (nope ? ` · ${nope} didn’t hold up` : ' · all holding so far')
      : `${art.claims.length} claims worth checking · mark each one as you go`;
  }

  wrap.append(...art.claims.map((c, i) => {
    const card = h('div', { class: 'claim' });
    const tri = (value, label) => h('button', {
      class: 'mini tri ' + value + (marks[i] === value ? ' on' : ''), type: 'button', 'aria-pressed': String(marks[i] === value),
      onclick: () => {
        if (marks[i] === value) delete marks[i]; else marks[i] = value;
        ui.set('claims', marks);
        paint();
        renderSummary();
      },
    }, label);
    function paint() {
      card.className = 'claim' + (marks[i] ? ' s-' + marks[i] : '');
      card.replaceChildren(
        h('div', { class: 'c-top' },
          c.who ? h('span', { class: 'who' }, c.who) : null,
          h('span', { class: 'c-text' }, c.claim),
          stamp(canvas.video_id, c.t, c.claim),
        ),
        c.check ? h('div', { class: 'c-check' }, h('b', null, 'to check'), c.check) : null,
        h('div', { class: 'row' },
          h('a', { class: 'mini', href: searchUrl(c.check || c.claim), target: '_blank', rel: 'noopener' }, 'look it up ↗'),
          tri('holds', '✓ holds up'), tri('nope', '✗ doesn’t'), tri('unsure', '? unsure'),
        ),
      );
    }
    paint();
    return card;
  }));
  renderSummary();
  return { title: 'claims to check', say: 'every checkable claim, with the second it was said. look it up, then mark what holds up.', el: h('div', null, summary, wrap) };
}

// ─── story: a timeline you can scrub, that follows the video ───────────────
function timeline(canvas, art, ctx) {
  const events = [...art.events].sort((a, b) => (a.t ?? 1e9) - (b.t ?? 1e9));
  const last = Math.max(0, ...events.map((e) => e.t || 0));
  const duration = Math.max(canvas.duration || 0, last + 30);
  const pct = (t) => Math.max(0, Math.min(100, (t / duration) * 100));

  const played = h('div', { class: 'played' });
  const head = h('div', { class: 'head' });
  const dots = events.map((e, i) => typeof e.t === 'number' ? h('button', {
    class: 'dot', type: 'button', style: { left: pct(e.t) + '%' }, title: `${fmt(e.t)} — ${e.label}`, 'aria-label': `Jump to ${e.label}`,
    onclick: (ev) => { ev.stopPropagation(); jumpTo(canvas.video_id, e.t, { title: e.label }); setActive(i); },
  }) : null);
  const scrub = h('div', {
    class: 'tl-scrub', title: 'click anywhere to jump there',
    onclick: (ev) => {
      const r = scrub.getBoundingClientRect();
      jumpTo(canvas.video_id, ((ev.clientX - r.left) / r.width) * duration, { title: canvas.headline });
    },
  },
    h('div', { class: 'rail-line' }), played, head, dots,
    h('span', { class: 'tl-time', style: { left: '0' } }, '0:00'),
    h('span', { class: 'tl-time', style: { right: '0' } }, fmt(duration)),
  );

  const cards = events.map((e) => h('div', { class: 'tl-card' },
    h('span', { class: 'when' }, [e.when, typeof e.t === 'number' ? fmt(e.t) : null].filter(Boolean).join(' · ')),
    h('span', { class: 'lbl' }, e.label),
    e.detail ? h('span', { class: 'det' }, e.detail) : null,
    stamp(canvas.video_id, e.t, e.label),
  ));
  const row = h('div', { class: 'tl-cards' }, cards);

  let active = -1;
  function setActive(i) {
    if (i === active) return;
    active = i;
    dots.forEach((d, n) => d && d.classList.toggle('on', n === i));
    cards.forEach((c, n) => c.classList.toggle('on', n === i));
    const card = cards[i];
    if (card) row.scrollTo({ left: card.offsetLeft - row.offsetLeft - 8, behavior: 'smooth' });
  }

  // Follow the player while it's on this video.
  const off = onTime((t, vid) => {
    if (vid !== canvas.video_id) { head.classList.remove('show'); return; }
    head.classList.add('show');
    head.style.left = pct(t) + '%';
    played.style.width = pct(t) + '%';
    let idx = -1;
    events.forEach((e, n) => { if (typeof e.t === 'number' && e.t <= t + 0.5) idx = n; });
    setActive(idx);
  });
  ctx.onCleanup(off);

  return { title: 'the timeline', say: 'click anywhere on the line to jump there. while the video plays, the timeline follows along.', el: h('div', null, scrub, row) };
}

// ─── markdown for the "take the whole canvas" export ───────────────────────
export function artifactMarkdown(canvas, link) {
  const art = canvas.artifact;
  if (!art) return [];
  const out = [];
  if (art.type === 'flashcards') {
    out.push('## Flashcards', '');
    art.cards.forEach((c) => out.push(`**Q:** ${c.q}  `, `**A:** ${c.a}${link(c.t)}`, ''));
  } else if (art.type === 'cookalong') {
    out.push('## Cook-along', '');
    if (art.yields) out.push(`*Makes: ${art.yields}*`, '');
    if (art.ingredients.length) {
      out.push('### Ingredients', '');
      art.ingredients.forEach((x) => out.push(`- [ ] ${[x.qty, x.item].filter(Boolean).join(' ')}`));
      out.push('');
    }
    out.push('### Steps', '');
    art.steps.forEach((s, i) => out.push(`${i + 1}. ${s.text}${s.timer_seconds ? ` *(timer: ${fmt(s.timer_seconds)})*` : ''}${link(s.t)}`));
    out.push('');
  } else if (art.type === 'verdict') {
    out.push(`## The verdict: ${art.call.toUpperCase()}${art.product ? ` — ${art.product}` : ''}`, '');
    if (art.call_line) out.push(`> ${art.call_line}`, '');
    if (art.for_who.length) out.push('**It’s for you if:** ' + art.for_who.join('; '), '');
    if (art.skip_if.length) out.push('**Skip it if:** ' + art.skip_if.join('; '), '');
    if (art.deal_breaker) out.push(`**Deal-breaker:** ${art.deal_breaker.text}${link(art.deal_breaker.t)}`, '');
    if (art.pros.length) { out.push('### The good', ''); art.pros.forEach((p) => out.push(`- ${p.text}${link(p.t)}`)); out.push(''); }
    if (art.cons.length) { out.push('### The bad', ''); art.cons.forEach((p) => out.push(`- ${p.text}${link(p.t)}`)); out.push(''); }
  } else if (art.type === 'claims') {
    out.push('## Claims to check', '');
    art.claims.forEach((c) => out.push(`- **${c.who || 'claim'}:** ${c.claim}${link(c.t)}${c.check ? `  \n  *To check:* ${c.check}` : ''}`));
    out.push('');
  } else if (art.type === 'timeline') {
    out.push('## Timeline', '');
    art.events.forEach((e) => out.push(`- ${e.when ? `**${e.when}** ` : ''}${e.label}${e.detail ? ` — ${e.detail}` : ''}${link(e.t)}`));
    out.push('');
  }
  return out;
}

