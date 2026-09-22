// One tool per kind of video. Every item links back to the exact second it
// came from -- that's the rule that makes these more than a summary.

import { h, fmt, copy, download, slug, searchUrl, toast, lsGet, lsSet, ytUrl } from '../util.js';
import { jumpTo, onTime } from '../player.js';
import { startTimer } from '../timers.js';

export const ARTIFACT_NAMES = {
  flashcards: 'cram deck', cookalong: 'cook-along', verdict: 'the verdict', claims: 'claims to check', timeline: 'the timeline',
};
const MODE_ARTIFACT = { study: 'cram deck', howto: 'cook-along', verdict: 'buy/skip card', yap: 'claims to check', story: 'timeline' };
export const artifactNameForMode = (mode) => MODE_ARTIFACT[mode] || 'mode tool';

export function buildArtifact(canvas, ctx) {
  const art = canvas.artifact;
  if (!art || !art.type) return null;
  const build = { flashcards, cookalong, verdict, claims, timeline }[art.type];
  return build ? build(canvas, art, ctx) : null;
}

const stamp = (videoId, t, title, cls = 'stamp') =>
  typeof t === 'number' ? h('button', { class: cls, onclick: (e) => { e.stopPropagation(); jumpTo(videoId, t, { title }); } }, '▶ ' + fmt(t)) : null;

// ─── study: a deck whose answers are the creator explaining it ─────────────
function flashcards(canvas, art) {
  const cards = art.cards;
  let order = cards.map((_, i) => i);
  let pos = 0;
  let flipped = false;
  const known = new Set();

  const deck = h('div', { class: 'deck' });
  const progress = h('i');
  const pos_ = h('span', { class: 'pos' });

  function render() {
    progress.style.width = (known.size / cards.length * 100) + '%';
    if (!order.length) {
      deck.replaceChildren(
        h('div', { class: 'deck-progress' }, progress),
        h('div', { class: 'deck-done' },
          h('h4', null, 'deck cleared 🎉'),
          h('p', { style: { color: 'var(--haze)', margin: '0 0 16px' } }, `You know all ${cards.length}. Come back tomorrow and run it again — that’s when it actually sticks.`),
          h('button', { class: 'ghost hot', onclick: reset }, 'run it again'),
        ),
      );
      return;
    }
    pos = Math.min(pos, order.length - 1);
    const card = cards[order[pos]];
    pos_.textContent = `${pos + 1} / ${order.length}`;
    const flash = h('div', {
      class: 'flash' + (flipped ? ' flipped' : ''), tabindex: '0', role: 'button',
      'aria-label': flipped ? 'Answer. Press space to flip back.' : 'Question. Press space to see the answer.',
      onclick: (e) => { if (!e.target.closest('button')) flip(); },
      onkeydown: onKey,
    },
      h('div', { class: 'flash-inner' },
        h('div', { class: 'flash-face flash-front' },
          h('small', null, `question · ${known.size} of ${cards.length} known`),
          h('div', { class: 'q' }, card.q),
          h('span', { class: 'hint-flip' }, 'tap or space to flip'),
        ),
        h('div', { class: 'flash-face flash-back' },
          h('small', null, 'answer'),
          h('div', { class: 'a' }, card.a),
          typeof card.t === 'number'
            ? h('button', { class: 'explain', onclick: () => jumpTo(canvas.video_id, card.t, { title: card.q }) }, `▶ hear them explain it · ${fmt(card.t)}`)
            : null,
        ),
      ),
    );
    deck.replaceChildren(
      h('div', { class: 'deck-progress' }, progress),
      flash,
      h('div', { class: 'deck-bar' },
        h('button', { class: 'mini', onclick: () => move(-1), 'aria-label': 'Previous card' }, '←'),
        pos_,
        h('button', { class: 'mini', onclick: () => move(1), 'aria-label': 'Next card' }, '→'),
        h('button', { class: 'mini', onclick: again, disabled: !flipped }, 'again ↺'),
        h('button', { class: 'mini' + (flipped ? ' on' : ''), onclick: gotIt, disabled: !flipped }, 'got it ✓'),
        h('span', { style: { flex: '1' } }),
        h('button', { class: 'mini', onclick: shuffle }, 'shuffle'),
        h('button', { class: 'mini', onclick: anki }, 'download for anki ↓'),
      ),
    );
    return flash;
  }
  function focusCard() { const f = deck.querySelector('.flash'); if (f) f.focus({ preventScroll: true }); }
  function flip() { flipped = !flipped; render(); focusCard(); }
  function move(d) { pos = (pos + d + order.length) % order.length; flipped = false; render(); focusCard(); }
  function again() { const [x] = order.splice(pos, 1); order.push(x); flipped = false; render(); focusCard(); }
  function gotIt() { known.add(order[pos]); order.splice(pos, 1); flipped = false; render(); focusCard(); }
  function shuffle() {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    pos = 0; flipped = false; render(); toast('shuffled');
  }
  function reset() { order = cards.map((_, i) => i); known.clear(); pos = 0; flipped = false; render(); }
  function onKey(e) {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
    else if (e.key === '1' && flipped) again();
    else if (e.key === '2' && flipped) gotIt();
  }
  function anki() {
    const clean = (s) => String(s).replace(/[\t\r\n]+/g, ' ');
    const rows = cards.map((c) => `${clean(c.q)}\t${clean(c.a)}${typeof c.t === 'number' ? ` (${fmt(c.t)} — ${ytUrl(canvas.video_id, c.t)})` : ''}`);
    download(rows.join('\n'), `${slug(canvas.headline)}-anki.txt`, 'text/plain;charset=utf-8');
    toast('saved — in Anki: File → Import, tab-separated ✓');
  }

  render();
  return { title: 'cram deck', say: 'flip it, then hear them explain it. space flips, arrows move, 1 = again, 2 = got it.', el: deck };
}

// ─── howto: pantry, steps with timers, and a hands-free mode ───────────────
function cookalong(canvas, art, ctx) {
  const got = new Set();
  const pantryList = h('div');
  function renderPantry() {
    pantryList.replaceChildren(...art.ingredients.map((ing, i) => h('button', {
      class: 'ingr' + (got.has(i) ? ' got' : ''), onclick: () => { got.has(i) ? got.delete(i) : got.add(i); renderPantry(); },
    }, h('span', { class: 'box' }), h('span', { class: 'i-name' }, ing.item), h('span', { class: 'qty' }, ing.qty))));
  }
  renderPantry();

  const shopping = () => {
    const need = art.ingredients.filter((_, i) => !got.has(i));
    if (!need.length) { toast('you’ve got everything — go cook'); return; }
    copy(need.map((x) => `- ${[x.qty, x.item].filter(Boolean).join(' ')}`).join('\n'), `shopping list copied — ${need.length} to buy ✓`);
  };

  const pantry = art.ingredients.length ? h('aside', { class: 'pantry' },
    h('h4', null, 'the pantry'),
    h('div', { class: 'yields' }, art.yields ? `makes ${art.yields} · ` : '', 'tick what you’ve got'),
    pantryList,
    h('div', { class: 'pantry-actions' },
      h('button', { class: 'mini', onclick: shopping }, 'copy shopping list'),
    ),
  ) : null;

  const steps = h('div', { class: 'steps' }, art.steps.map((s, i) => h('div', { class: 'step-card' },
    h('span', { class: 'num' }, String(i + 1)),
    h('div', { class: 's-body' },
      h('div', { class: 's-text' }, s.text),
      h('div', { class: 's-actions' },
        stamp(canvas.video_id, s.t, `step ${i + 1}`),
        s.timer_seconds ? h('button', { class: 'timer-btn', onclick: () => startTimer(`step ${i + 1}: ${s.text}`, s.timer_seconds) }, `⏱ ${fmt(s.timer_seconds)} timer`) : null,
      ),
    ),
  )));

  const focusBtn = h('button', { class: 'mini on', onclick: () => handsFree(canvas, art, ctx) }, 'hands-free mode ↗');
  const el = h('div', { class: 'cook' }, pantry, steps);
  if (!pantry) el.style.gridTemplateColumns = '1fr';
  return { title: 'cook-along', say: 'tick the pantry, run the timers, or go hands-free and follow along step by step.', el, tools: [focusBtn] };
}

function handsFree(canvas, art, ctx) {
  let i = 0;
  const overlay = h('div', { class: 'focus-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Hands-free cook-along' });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  }
  function go(d) { i = Math.max(0, Math.min(art.steps.length - 1, i + d)); render(); }
  function render() {
    const s = art.steps[i];
    overlay.replaceChildren(h('div', { class: 'focus-box' },
      h('div', { class: 'f-top' }, h('span', null, `step ${i + 1} of ${art.steps.length}`), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '✕')),
      h('div', { class: 'f-step' }, s.text),
      h('div', { class: 'f-bar' },
        h('button', { class: 'ghost', onclick: () => go(-1), disabled: i === 0 }, '← back'),
        stamp(canvas.video_id, s.t, `step ${i + 1}`),
        s.timer_seconds ? h('button', { class: 'timer-btn', onclick: () => startTimer(`step ${i + 1}: ${s.text}`, s.timer_seconds) }, `⏱ start ${fmt(s.timer_seconds)}`) : null,
        h('span', { class: 'spacer' }),
        i < art.steps.length - 1
          ? h('button', { class: 'cta', onclick: () => go(1) }, 'next step →')
          : h('button', { class: 'cta', onclick: () => { close(); toast('done! go eat 🍽️'); } }, 'done 🎉'),
      ),
    ));
  }
  document.addEventListener('keydown', onKey);
  ctx.onCleanup(close);
  document.body.appendChild(overlay);
  render();
}

// ─── verdict: the reviewer's call, and who should ignore it ────────────────
function verdict(canvas, art) {
  const list = (cls, label, items, mark, withStamps) => items.length ? h('div', { class: 'v-list ' + cls },
    h('h5', null, label),
    h('ul', null, items.map((it) => h('li', null,
      h('span', { class: 'mk' }, mark),
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
function claims(canvas, art) {
  const key = `yapmap.claims.${canvas.video_id}`;
  const marks = lsGet(key, {});
  const summary = h('div', { class: 'claims-summary' });
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
      class: 'tri ' + value + (marks[i] === value ? ' on' : ''),
      onclick: () => {
        marks[i] === value ? delete marks[i] : (marks[i] = value);
        lsSet(key, marks);
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
        h('div', { class: 'c-actions' },
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
    class: 'dot', style: { left: pct(e.t) + '%' }, title: `${fmt(e.t)} — ${e.label}`, 'aria-label': `Jump to ${e.label}`,
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
