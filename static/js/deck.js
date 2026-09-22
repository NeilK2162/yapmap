// A flashcard deck with spaced repetition. The same component runs the cram
// deck on a canvas (one video, every card) and the review page (every video,
// only what's due). Knowing a card sends it further out; missing it brings
// it back tomorrow -- that's what makes it stick.

import { h, fmt, toast, inDays } from './util.js';
import { review, isStatic } from './api.js';
import { logEvent } from './store.js';
import { jumpTo } from './player.js';

const LEVEL = ['new', 'learning', 'level 2', 'level 3', 'level 4', 'level 5', 'mastered'];

export function studyDeck({ cards, title, showSource = false, onFinish, tools = [] }) {
  let queue = cards.map((c) => c);
  let pos = 0;
  let flipped = false;
  let known = 0;
  const total = cards.length;

  const el = h('div', { class: 'deck' });
  const bar = h('i');

  function status(card) {
    if (!card.reps) return 'new card';
    const due = card.due ? inDays(card.due) : '';
    return `${LEVEL[Math.min(card.box || 0, LEVEL.length - 1)]}${due ? ` · ${due === 'today' ? 'due today' : 'back ' + due}` : ''}`;
  }

  function render() {
    bar.style.width = `${(known / Math.max(1, total)) * 100}%`;
    if (!queue.length) {
      el.replaceChildren(
        h('div', { class: 'deck-progress' }, bar),
        h('div', { class: 'deck-done' },
          h('h3', null, 'deck cleared 🎉'),
          h('p', null, `All ${total} done. Each one comes back just before you’d forget it — that’s when reviewing actually works.`),
          h('div', { class: 'row center' },
            h('button', { class: 'ghost', type: 'button', onclick: restart }, 'run it again'),
            h('a', { class: 'ghost hot', href: '#/review' }, 'see what’s due →'),
          ),
        ),
      );
      if (onFinish) onFinish();
      return;
    }
    pos = Math.min(pos, queue.length - 1);
    const card = queue[pos];
    const flash = h('div', {
      class: 'flash' + (flipped ? ' flipped' : ''), tabindex: '0', role: 'button',
      'aria-label': flipped ? `Answer: ${card.a}. Press space to flip back.` : `Question: ${card.q}. Press space to see the answer.`,
      onclick: flip, onkeydown: onKey,
    },
      h('div', { class: 'flash-inner' },
        h('div', { class: 'flash-face flash-front', 'aria-hidden': 'true' },
          h('small', null, `question · ${pos + 1} of ${queue.length}`),
          h('div', { class: 'q' }, card.q),
          h('span', { class: 'hint-flip' }, 'tap or space to flip'),
        ),
        h('div', { class: 'flash-face flash-back', 'aria-hidden': 'true' },
          h('small', null, 'answer'),
          h('div', { class: 'a' }, card.a),
        ),
      ),
    );
    const explain = typeof card.t === 'number'
      ? h('button', { class: 'ghost sm', type: 'button', onclick: () => jumpTo(card.video_id, card.t, { title: card.q }) }, `▶ hear them explain it · ${fmt(card.t)}`)
      : null;
    el.replaceChildren(
      h('div', { class: 'deck-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(known), 'aria-label': 'Cards done' }, bar),
      showSource ? h('a', { class: 'deck-source', href: '#/v/' + card.video_id }, 'from: ' + card.headline) : null,
      flash,
      h('div', { class: 'deck-under' },
        h('span', { class: 'deck-status' }, status(card)),
        flipped ? explain : h('span', { class: 'hint' }, 'guess first, then flip'),
      ),
      h('div', { class: 'deck-bar' },
        h('button', { class: 'icon-btn', type: 'button', onclick: () => move(-1), 'aria-label': 'Previous card' }, '←'),
        h('span', { class: 'pos' }, `${pos + 1} / ${queue.length}`),
        h('button', { class: 'icon-btn', type: 'button', onclick: () => move(1), 'aria-label': 'Next card' }, '→'),
        h('button', { class: 'ghost sm', type: 'button', onclick: () => grade('again'), disabled: !flipped }, 'again ↺'),
        h('button', { class: 'ghost sm hot', type: 'button', onclick: () => grade('good'), disabled: !flipped }, 'got it ✓'),
        h('span', { class: 'spacer' }),
        tools.map((t) => t({ shuffle, cards })),
      ),
    );
    return flash;
  }

  const focusCard = () => { const f = el.querySelector('.flash'); if (f) f.focus({ preventScroll: true }); };
  function flip() { flipped = !flipped; render(); focusCard(); }
  function move(d) { pos = (pos + d + queue.length) % queue.length; flipped = false; render(); focusCard(); }
  async function grade(g) {
    const card = queue[pos];
    queue.splice(pos, 1);
    if (g === 'again') queue.push(card); else known += 1;
    flipped = false;
    render();
    focusCard();
    try {
      const state = await review(card.id, g);
      Object.assign(card, { box: state.box, due: state.due, reps: state.reps });
      // The server logs its own reviews for Wrapped; the demo keeps them in this browser.
      if (isStatic()) logEvent('review', { video_id: card.video_id });
      document.dispatchEvent(new CustomEvent('yapmap:reviewed'));
      if (g !== 'again' && state.due) toast(`back ${inDays(state.due)} ✓`);
    } catch (e) { toast('couldn’t save that review — ' + e.message); }
  }
  function shuffle() {
    for (let i = queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [queue[i], queue[j]] = [queue[j], queue[i]]; }
    pos = 0; flipped = false; render(); toast('shuffled');
  }
  function restart() { queue = cards.map((c) => c); known = 0; pos = 0; flipped = false; render(); }
  function onKey(e) {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
    else if (e.key === '1' && flipped) grade('again');
    else if (e.key === '2' && flipped) grade('good');
  }

  render();
  return { el, title };
}
