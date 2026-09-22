import { h, emptyState, inDays, plural } from '../util.js';
import { deck, isStatic } from '../api.js';
import { studyDeck } from '../deck.js';

// How many brand-new cards join a session -- enough to make progress,
// few enough that reviewing stays a five-minute thing.
const NEW_PER_SESSION = 20;

export async function render(root, _params, _query, ctx) {
  const page = h('div', { class: 'page narrow' });
  root.append(page);
  page.append(h('div', { class: 'page-head' },
    h('span', { class: 'kicker' }, 'review'),
    h('h1', null, 'don’t just watch it. ', h('em', null, 'keep it'), '.'),
    h('p', { class: 'sub' }, 'Every cram deck you’ve made, on a schedule: a card comes back right before you’d forget it, and further out each time you know it. Five minutes a day beats rewatching.'),
  ));
  const body = h('div');
  page.append(body);

  let data;
  try { data = await deck(); } catch (err) {
    if (ctx.alive()) body.replaceChildren(emptyState('🫠', 'couldn’t load your deck', err.message));
    return;
  }
  if (!ctx.alive()) return;

  if (!data.total) {
    body.replaceChildren(emptyState('🃏', 'no cards yet',
      'Study-mode videos — lectures, explainers, tutorials — come with a cram deck. Map one and its cards land here.',
      h('a', { class: 'ghost hot', href: '#/' }, 'map a video')));
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const due = data.cards.filter((c) => c.reps && (c.due || 0) <= now).sort((a, b) => (a.due || 0) - (b.due || 0));
  const fresh = data.cards.filter((c) => !c.reps).slice(0, NEW_PER_SESSION);
  const upcoming = data.cards.filter((c) => c.reps && (c.due || 0) > now).sort((a, b) => a.due - b.due);
  const videos = new Set(data.cards.map((c) => c.video_id)).size;

  const stats = h('div', { class: 'streak-row' },
    h('div', { class: 'stat big' }, h('b', null, String(due.length)), h('span', null, 'due now')),
    h('div', { class: 'stat' }, h('b', null, String(data.new)), h('span', null, 'new')),
    h('div', { class: 'stat' }, h('b', null, String(data.total)), h('span', null, `cards from ${plural(videos, 'video')}`)),
    h('div', { class: 'stat' }, h('b', null, upcoming.length ? inDays(upcoming[0].due) : '—'), h('span', null, 'next one back')),
  );

  const session = [...due, ...fresh];
  if (!session.length) {
    const next = upcoming.length ? upcoming.filter((c) => c.due === upcoming[0].due).length : 0;
    body.replaceChildren(stats, emptyState('✨', 'all caught up',
      next
        ? `Nothing due. ${next === 1 ? 'The next card comes' : `The next ${next} cards come`} back ${inDays(upcoming[0].due)}.`
        : 'Nothing due right now.',
      h('a', { class: 'ghost', href: '#/library' }, 'browse your library')));
    return;
  }

  const label = [due.length ? plural(due.length, 'review') : null, fresh.length ? plural(fresh.length, 'new card') : null].filter(Boolean).join(' + ');
  const run = studyDeck({
    cards: session,
    showSource: true,
    onFinish: () => document.dispatchEvent(new CustomEvent('yapmap:reviewed')),
  });
  body.replaceChildren(
    stats,
    h('h2', { class: 'sub-title' }, `today’s session · ${label}`),
    isStatic() ? h('p', { class: 'hint left' }, 'In the demo, your reviews are kept in this browser only.') : null,
    run.el,
  );
}
