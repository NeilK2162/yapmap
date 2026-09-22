import { h, fmt, fmtDur, debounce, snippet, thumb, emptyState, toast, lsGet, lsSet, dropRecent } from '../util.js';
import { library, search, deleteCanvas, isStatic } from '../api.js';
import { forgetUiState } from '../uistate.js';
import { libCard } from './home.js';

const FIELD_LABEL = {
  headline: 'headline', tldr: 'tl;dr', summary: 'summary', receipt: 'finding', sticky: 'sticky', shelf: 'shelf',
  move: 'move', map: 'map', flashcard: 'flashcard', step: 'step', ingredient: 'ingredient', claim: 'claim',
  timeline: 'timeline', verdict: 'verdict',
};
const MODE_NAME = { study: 'study', yap: 'yap', howto: 'how-to', verdict: 'verdict', story: 'story' };
const SORTS = {
  newest: ['newest', (a, b) => String(b.created_at).localeCompare(String(a.created_at))],
  oldest: ['oldest', (a, b) => String(a.created_at).localeCompare(String(b.created_at))],
  longest: ['longest', (a, b) => (b.duration || 0) - (a.duration || 0)],
  shortest: ['shortest', (a, b) => (a.duration || 0) - (b.duration || 0)],
  az: ['a–z', (a, b) => a.headline.localeCompare(b.headline)],
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
  const controls = h('div', { class: 'lib-controls' });
  const body = h('div');

  page.append(
    h('div', { class: 'page-head' },
      h('span', { class: 'kicker' }, 'library'),
      h('h1', null, 'everything you’ve ', h('em', null, 'mapped'), '.'),
      h('p', { class: 'sub' }, 'Every canvas you make lands here. Search across all of them at once — every result is a timestamp that plays the exact moment.'),
    ),
    h('div', { class: 'search-wrap' }, h('span', { class: 's-icon', 'aria-hidden': 'true' }, '⌕'), input),
    stats,
    controls,
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

  let sort = lsGet('yapmap.libSort', 'newest');
  if (!SORTS[sort]) sort = 'newest';
  let mode = 'all';

  const paintStats = () => {
    const footage = items.reduce((sum, it) => sum + (it.duration || 0), 0);
    const ideas = items.reduce((sum, it) => sum + (it.ideas || 0), 0);
    stats.replaceChildren(
      h('span', { class: 'pill live' }, `${items.length} ${items.length === 1 ? 'video' : 'videos'}`),
      h('span', { class: 'pill' }, `${fmtDur(footage)} of footage`),
      ideas ? h('span', { class: 'pill' }, `${ideas} ideas mapped`) : null,
    );
  };

  const paintControls = () => {
    const counts = items.reduce((acc, it) => { acc[it.mode] = (acc[it.mode] || 0) + 1; return acc; }, {});
    const modes = Object.keys(counts);
    const select = h('select', {
      class: 'field sm select', 'aria-label': 'Sort by',
      onchange: (e) => { sort = e.target.value; lsSet('yapmap.libSort', sort); showGrid(); },
    }, Object.entries(SORTS).map(([key, [label]]) => h('option', { value: key, selected: key === sort }, 'sort: ' + label)));
    controls.replaceChildren(
      modes.length > 1 ? h('div', { class: 'filters', role: 'radiogroup', 'aria-label': 'Filter by kind of video' },
        [['all', `all · ${items.length}`], ...modes.map((m) => [m, `${MODE_NAME[m] || m} · ${counts[m]}`])].map(([m, label]) => h('button', {
          class: 'chip' + (mode === m ? ' on' : ''), type: 'button', role: 'radio', 'aria-checked': String(mode === m),
          onclick: () => { mode = m; paintControls(); showGrid(); },
        }, label)),
      ) : h('span'),
      items.length > 1 ? select : null,
    );
  };

  async function remove(item) {
    try {
      await deleteCanvas(item.video_id);
      forgetUiState(item.video_id);
      dropRecent(item.video_id);
      items = items.filter((x) => x.video_id !== item.video_id);
      paintStats();
      paintControls();
      showGrid();
      document.dispatchEvent(new CustomEvent('yapmap:changed'));
      toast('deleted. poof ✓');
    } catch (e) { toast(e.message); }
  }

  const showGrid = () => {
    if (input.value.trim()) return;
    if (!items.length) {
      body.replaceChildren(emptyState('📚', 'nothing mapped yet', 'Map your first video and it lands here — searchable forever.',
        h('a', { class: 'ghost hot', href: '#/' }, 'map a video')));
      controls.hidden = true;
      return;
    }
    controls.hidden = false;
    const shown = items.filter((it) => mode === 'all' || it.mode === mode).sort(SORTS[sort][1]);
    body.replaceChildren(
      h('h2', { class: 'sr-only' }, 'Your canvases'),
      h('div', { class: 'lib-grid' }, shown.map((item) => libCard(item, isStatic() ? {} : { onDelete: remove }))),
    );
  };

  let seq = 0;
  const runSearch = async (q) => {
    const mine = ++seq;
    const clean = q.trim();
    history.replaceState(null, '', '#/library' + (clean ? '?q=' + encodeURIComponent(clean) : ''));
    controls.hidden = !!clean || !items.length;
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
      h('h2', { class: 'sr-only' }, 'Search results'),
      h('p', { class: 'hint left', 'aria-live': 'polite' }, `${res.hits.length} hits across ${groups.size} ${groups.size === 1 ? 'video' : 'videos'}`),
      ...[...groups].map(([vid, g]) => h('div', { class: 'hit-group' },
        h('a', { class: 'hg-head', href: '#/v/' + vid },
          h('img', { src: thumb(vid), alt: '' }),
          h('div', null, h('h3', { class: 'hg-title' }, g.headline), h('div', { class: 'hg-count' }, `${g.hits.length} ${g.hits.length === 1 ? 'hit' : 'hits'} · open the canvas →`)),
        ),
        g.hits.slice(0, 8).map((hit) => h('div', { class: 'hit' },
          h('span', { class: 'h-field' }, FIELD_LABEL[hit.field] || hit.field),
          h('span', { class: 'h-text' }, snippet(hit.text, res.terms)),
          typeof hit.t === 'number' ? h('a', { class: 'stamp', href: `#/v/${vid}?t=${hit.t}` }, '▶ ' + fmt(hit.t)) : null,
        )),
      )),
    );
  };

  paintStats();
  paintControls();
  input.addEventListener('input', debounce(() => runSearch(input.value), 220));
  if (input.value) runSearch(input.value); else showGrid();
  setTimeout(() => ctx.alive() && input.focus(), 50);
}
