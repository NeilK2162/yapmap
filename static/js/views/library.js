import { h, fmt, fmtDur, debounce, snippet, thumb, emptyState } from '../util.js';
import { library, search } from '../api.js';
import { libCard } from './home.js';

const FIELD_LABEL = {
  headline: 'headline', tldr: 'tl;dr', summary: 'summary', receipt: 'finding', sticky: 'sticky', shelf: 'shelf',
  move: 'move', map: 'map', flashcard: 'flashcard', step: 'step', ingredient: 'ingredient', claim: 'claim',
  timeline: 'timeline', verdict: 'verdict',
};

export async function render(root, _params, query, ctx) {
  const page = h('div', { class: 'page' });
  root.append(page);

  const input = h('input', {
    class: 'field', type: 'search', autocomplete: 'off', 'aria-label': 'Search your library',
    placeholder: 'search everything you’ve mapped — try “rate limiting” or “yeast”',
    value: query.get('q') || '',
  });
  const stats = h('div', { class: 'lib-stats' });
  const body = h('div');

  page.append(
    h('div', { class: 'page-head' },
      h('span', { class: 'kicker' }, 'library'),
      h('h1', null, 'everything you’ve ', h('em', null, 'mapped'), '.'),
      h('p', { class: 'sub' }, 'Every canvas you make lands here. Search across all of them at once — every result is a timestamp that plays the exact moment.'),
    ),
    h('div', { class: 'search-wrap' }, h('span', { class: 's-icon' }, '🔎'), input),
    stats,
    body,
  );

  let items = [];
  try {
    items = (await library()).items || [];
  } catch (err) {
    if (ctx.alive()) body.replaceChildren(emptyState('🫠', 'couldn’t open the library', err.message));
    return;
  }
  if (!ctx.alive()) return;

  const footage = items.reduce((sum, it) => sum + (it.duration || 0), 0);
  stats.append(
    h('span', { class: 'pill live' }, `${items.length} ${items.length === 1 ? 'video' : 'videos'}`),
    h('span', { class: 'pill' }, `${fmtDur(footage)} of footage`),
  );

  const showGrid = () => {
    if (!items.length) {
      body.replaceChildren(emptyState('📚', 'nothing mapped yet', 'Map your first video and it lands here — searchable forever.',
        h('a', { class: 'ghost hot', href: '#/' }, 'map a video')));
      return;
    }
    body.replaceChildren(h('div', { class: 'lib-grid' }, items.map(libCard)));
  };

  let seq = 0;
  const runSearch = async (q) => {
    const mine = ++seq;
    const clean = q.trim();
    history.replaceState(null, '', '#/library' + (clean ? '?q=' + encodeURIComponent(clean) : ''));
    if (!clean) { showGrid(); return; }
    let res;
    try { res = await search(clean); } catch (err) { body.replaceChildren(emptyState('🫠', 'search broke', err.message)); return; }
    if (mine !== seq || !ctx.alive()) return;
    if (!res.hits.length) {
      body.replaceChildren(emptyState('🦗', 'nothing yet', `No canvas mentions “${clean}”. Map a video about it and it will.`));
      return;
    }
    const groups = new Map();
    res.hits.forEach((hit) => {
      if (!groups.has(hit.video_id)) groups.set(hit.video_id, { headline: hit.headline, hits: [] });
      groups.get(hit.video_id).hits.push(hit);
    });
    body.replaceChildren(
      h('p', { class: 'hint', style: { margin: '0 0 14px' } }, `${res.hits.length} hits across ${groups.size} ${groups.size === 1 ? 'video' : 'videos'}`),
      ...[...groups].map(([vid, g]) => h('div', { class: 'hit-group' },
        h('a', { class: 'hg-head', href: '#/v/' + vid },
          h('img', { src: thumb(vid), alt: '' }),
          h('div', null, h('div', { class: 'hg-title' }, g.headline), h('div', { class: 'hg-count' }, `${g.hits.length} ${g.hits.length === 1 ? 'hit' : 'hits'} · open the canvas →`)),
        ),
        g.hits.slice(0, 8).map((hit) => h('div', { class: 'hit' },
          h('span', { class: 'h-field' }, FIELD_LABEL[hit.field] || hit.field),
          h('span', { class: 'h-text' }, snippet(hit.text, res.terms)),
          typeof hit.t === 'number' ? h('a', { class: 'stamp', href: `#/v/${vid}?t=${hit.t}` }, '▶ ' + fmt(hit.t)) : null,
        )),
      )),
    );
  };

  input.addEventListener('input', debounce(() => runSearch(input.value), 220));
  if (input.value) runSearch(input.value); else showGrid();
  setTimeout(() => ctx.alive() && input.focus(), 50);
}
