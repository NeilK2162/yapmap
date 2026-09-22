import { h, fmtDur, monthName, downloadBlob, toast, emptyState, fmt } from '../util.js';
import { stats, isStatic } from '../api.js';
import { localEvents } from '../store.js';
import { wrappedCard } from '../storycard.js';
import { jumpTo } from '../player.js';

const PERSONA = {
  study: 'certified study goblin 📚',
  yap: 'podcast philosopher 🎙️',
  howto: 'tutorial speedrunner 🛠️',
  verdict: 'professional overthinker 🧐',
  story: 'lore collector 📜',
};

export async function render(root, [month], _query, ctx) {
  const page = h('div', { class: 'page' });
  root.append(page);
  page.append(h('div', { class: 'page-head' },
    h('span', { class: 'kicker' }, 'yapmap wrapped'),
    h('h1', null, 'your month, ', h('em', null, 'mapped'), '.'),
    h('p', { class: 'sub' }, 'How much yap you skipped, what kind of watcher you were, and the line that hit hardest. Built from what’s on your own machine — nothing leaves it.'),
  ));
  const body = h('div');
  page.append(body);

  let data;
  try { data = await stats(); } catch (err) {
    if (ctx.alive()) body.replaceChildren(emptyState('🫠', 'couldn’t add it up', err.message));
    return;
  }
  if (!ctx.alive()) return;

  const months = data.months || [];
  if (!months.length) {
    body.replaceChildren(emptyState('🎁', 'nothing to wrap yet', 'Map a few videos and come back — your month builds itself.',
      h('a', { class: 'ghost hot', href: '#/' }, 'map a video')));
    return;
  }

  // The demo's numbers are the gallery's; the visitor's own story cards and
  // calls live in their browser, so fold those in there.
  if (isStatic()) {
    const mine = localEvents();
    months.forEach((m) => {
      mine.filter((e) => String(e.at).slice(0, 7) === m.month).forEach((e) => {
        if (e.type === 'storycard') m.storycards += 1;
        if (e.type === 'call') { m.calls += 1; if (e.grade === 'nailed') m.nailed += 1; }
        if (e.type === 'cut') m.cuts += 1;
      });
    });
  }

  const current = months.find((m) => m.month === month) || months[0];
  const chips = h('div', { class: 'month-chips' }, months.map((m) => h('a', {
    class: 'chip' + (m.month === current.month ? ' on' : ''), href: '#/wrapped/' + m.month,
  }, monthName(m.month))));

  const persona = PERSONA[current.top_mode] || 'fresh account energy ✨';
  const tiles = [
    { value: fmtDur(current.skipped_s), label: 'of yap skipped', hot: true, wide: true },
    { value: current.videos, label: current.videos === 1 ? 'video mapped' : 'videos mapped' },
    { value: fmtDur(current.footage_s), label: 'of footage' },
    { value: fmtDur(current.reading_s), label: 'actually spent reading', wide: true },
    { value: current.kept, label: current.kept === 1 ? 'move kept' : 'moves kept' },
    { value: current.cuts, label: current.cuts === 1 ? 'no-yap cut' : 'no-yap cuts' },
    { value: `${current.nailed}/${current.calls}`, label: 'calls nailed' },
    { value: current.storycards, label: current.storycards === 1 ? 'story card' : 'story cards' },
  ];
  if (current.beefs) tiles.push({ value: current.beefs, label: current.beefs === 1 ? 'beef settled' : 'beefs settled' });
  if (current.purges) tiles.push({ value: current.purges, label: current.purges === 1 ? 'pile purged' : 'piles purged' });

  const quote = current.featured;
  const card = h('div', { class: 'wrapped-card' },
    h('div', { class: 'w-kicker' }, 'yapmap wrapped'),
    h('h2', null, monthName(current.month)),
    h('div', { class: 'persona' }, 'you were a ', h('b', null, persona),
      current.top_channel ? ` · most mapped: ${current.top_channel}` : ''),
    h('div', { class: 'tiles' }, tiles.map((t) => h('div', { class: 'tile' + (t.hot ? ' hot' : '') + (t.wide ? ' wide' : '') },
      h('b', null, String(t.value)), h('span', null, t.label)))),
    quote ? h('div', { class: 'w-quote' },
      h('small', null, 'the line that hit hardest'),
      h('div', null, `“${quote.text}”`),
      typeof quote.t === 'number'
        ? h('button', { class: 'mini', style: { marginTop: '12px' }, onclick: () => jumpTo(quote.video_id, quote.t, { title: quote.headline }) }, `▶ ${fmt(quote.t)} · ${quote.headline}`)
        : null,
    ) : null,
    current.longest ? h('div', { class: 'w-foot' }, `longest thing you mapped: ${current.longest.headline} (${fmtDur(current.longest.duration)})`) : null,
  );

  const share = h('button', {
    class: 'cta accent',
    onclick: async () => {
      toast('drawing your wrapped…');
      try {
        const blob = await wrappedCard({
          monthLabel: monthName(current.month),
          persona: 'you were a ' + persona.replace(/\s\S+$/u, ''),
          tiles: tiles.slice(0, 6).map((t) => ({ value: t.value, label: t.label })),
          quote,
        });
        downloadBlob(blob, `yapmap-wrapped-${current.month}.png`);
        toast('saved — post it, you earned it ✓');
      } catch (e) { toast('couldn’t draw it this time'); }
    },
  }, 'download as a story ↓');

  body.replaceChildren(chips, card, h('div', { class: 'w-actions' }, share, h('a', { class: 'ghost', href: '#/grass' }, 'check your streak →')));
}
