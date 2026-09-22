import { h, timeAgo, toast, emptyState } from '../util.js';
import { listCommitments, updateCommitment } from '../store.js';
import { reminderMenu } from './canvas.js';

export async function render(root, _params, _query, ctx) {
  const page = h('div', { class: 'page narrow' });
  root.append(page);
  page.append(h('div', { class: 'page-head' },
    h('span', { class: 'kicker' }, 'touch grass protocol'),
    h('h1', null, 'did you ', h('em', null, 'actually'), ' do it?'),
    h('p', { class: 'sub' }, 'Self-improvement videos get watched like TV and nothing changes. Pin one move from any canvas, put it in your calendar, and yapmap asks you about it later. The streak counts things you did — not things you watched.'),
  ));
  const body = h('div');
  page.append(body);

  const draw = async () => {
    let data;
    try { data = await listCommitments(); } catch (err) { body.replaceChildren(emptyState('🫠', 'couldn’t load your commitments', err.message)); return; }
    if (!ctx.alive()) return;
    const { items, streak } = data;
    const open = items.filter((c) => c.status === 'open').sort((a, b) => a.created_at.localeCompare(b.created_at));
    const history = items.filter((c) => c.status !== 'open').sort((a, b) => (b.resolved_at || '').localeCompare(a.resolved_at || ''));

    const statRow = h('div', { class: 'streak-row' },
      h('div', { class: 'stat big' }, h('b', null, `🔥 ${streak.current}`), h('span', null, 'kept in a row')),
      h('div', { class: 'stat' }, h('b', null, String(streak.best)), h('span', null, 'best streak')),
      h('div', { class: 'stat' }, h('b', null, String(streak.kept)), h('span', null, 'kept')),
      h('div', { class: 'stat' }, h('b', null, String(streak.dropped)), h('span', null, 'dropped')),
    );

    if (!items.length) {
      body.replaceChildren(statRow, emptyState('🌱', 'no commitments yet',
        'Open any canvas, scroll to “touch grass”, and hit “i’ll do this” on one move. Start small — one is plenty.',
        h('a', { class: 'ghost hot', href: '#/library' }, 'pick a canvas')));
      return;
    }

    const act = async (c, patch, msg) => {
      try {
        await updateCommitment(c.id, patch);
        toast(msg);
        document.dispatchEvent(new CustomEvent('yapmap:changed'));
        draw();
      } catch (err) { toast(err.message); }
    };

    const card = (c) => h('div', { class: 'commit-card ' + c.status },
      h('div', { class: 'cc-body' },
        h('div', { class: 'cc-action' }, c.action),
        h('div', { class: 'cc-sub' },
          c.status === 'open' ? `committed ${timeAgo(c.created_at)}` : `${c.status === 'done' ? 'kept' : 'dropped'} ${timeAgo(c.resolved_at)}`,
          c.headline ? ' · from ' : '',
          c.headline ? (c.video_id ? h('a', { href: '#/v/' + c.video_id }, c.headline) : c.headline) : null,
        ),
      ),
      c.status === 'open'
        ? h('div', { class: 'row' },
          h('button', { class: 'mini on', type: 'button', onclick: () => act(c, { status: 'done' }, 'kept it. that’s growth fr 🌱') }, 'did it ✓'),
          h('button', { class: 'mini', type: 'button', onclick: () => act(c, { snooze_days: 2 }, 'we’ll ask again in two days') }, 'not yet'),
          h('button', { class: 'mini', type: 'button', onclick: () => act(c, { status: 'dropped' }, 'dropped. no shame, just data.') }, 'drop it'),
          reminderMenu(c),
        )
        : h('div', { class: 'row' },
          h('button', { class: 'mini', type: 'button', onclick: () => act(c, { status: 'open' }, 'reopened') }, 'reopen')),
    );

    body.replaceChildren(
      statRow,
      h('h2', { class: 'sub-title' }, open.length ? `on your plate · ${open.length}` : 'on your plate'),
      open.length ? h('div', { class: 'commits' }, open.map(card))
        : h('p', { class: 'hint left' }, 'nothing open — go pin a new move from a canvas.'),
      history.length ? h('h2', { class: 'sub-title' }, 'the record') : null,
      history.length ? h('div', { class: 'commits' }, history.map(card)) : null,
    );
  };
  draw();
}
