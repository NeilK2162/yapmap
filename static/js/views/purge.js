import { h, fmt, fmtDur, toast, copy, thumb, ytUrl, lsGet, lsSet } from '../util.js';
import { runPurge, getPurge, isStatic } from '../api.js';
import { jumpTo } from '../player.js';

const LOADING = [
  'reading the room…', 'judging thumbnails by their transcripts…', 'finding the filler…',
  'checking which ones are 20 minutes of intro…', 'sorting the bangers from the yap…',
];
const LABEL = { watch: 'watch', skim: 'skim', skip: 'skip', unknown: '??' };

export async function render(root, [key], query, ctx) {
  const page = h('div', { class: 'page' });
  root.append(page);

  const area = h('textarea', {
    class: 'field', spellcheck: 'false', 'aria-label': 'YouTube links',
    placeholder: 'https://youtu.be/…\nhttps://www.youtube.com/watch?v=…\nhttps://www.youtube.com/playlist?list=…',
  });
  const result = h('div');
  const button = h('button', { class: 'cta accent', type: 'submit' }, 'start the purge 🧹');

  page.append(
    h('div', { class: 'page-head' },
      h('span', { class: 'kicker' }, 'the purge'),
      h('h1', null, 'clear your ', h('em', null, 'watch later'), '.'),
      h('p', { class: 'sub' }, 'Paste up to 12 videos, one per line, or a playlist link. yapmap reads a slice of each — the start, the middle, the end — and tells you honestly what’s worth your time.'),
    ),
    h('form', {
      class: 'purge-form',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!area.value.trim()) { toast('paste some links first'); return; }
        await run(area.value);
      },
    },
      area,
      h('div', { class: 'row' },
        button,
        h('p', { class: 'hint' }, 'one Claude call for the whole pile · usually 1–2 min'),
      ),
    ),
    h('div', { style: { height: '40px' } }),
    result,
  );

  async function run(urls) {
    button.disabled = true;
    const line = h('h2', null, LOADING[0]);
    let i = 0;
    const spin = setInterval(() => { i = (i + 1) % LOADING.length; line.textContent = LOADING[i]; }, 2600);
    ctx.onCleanup(() => clearInterval(spin));
    result.replaceChildren(h('div', { class: 'loading', style: { paddingTop: '0' } },
      h('div', { class: 'orb' }), line, h('p', null, 'Fetching transcripts, then one judgement call for the lot.')));
    try {
      const data = await runPurge(urls);
      if (!ctx.alive()) return;
      lsSet('yapmap.lastPurge', data.key);
      history.replaceState(null, '', '#/purge/' + data.key);
      if (!data.cached) document.dispatchEvent(new CustomEvent('yapmap:changed'));
      result.replaceChildren(buildResult(data));
    } catch (err) {
      if (!ctx.alive()) return;
      result.replaceChildren(h('div', { class: 'error', style: { margin: '0' } }, h('div', { class: 'card' },
        h('h3', null, err.needsInstall ? 'the purge needs the real thing.' : 'the purge stalled.'),
        h('p', null, err.message),
        err.needsInstall ? h('a', { class: 'ghost hot', href: '#/extras' }, 'how to install') : null,
      )));
    } finally {
      clearInterval(spin);
      button.disabled = false;
    }
  }

  // Show a result: the one in the URL, the demo's, or the last one run here.
  const showKey = key || (isStatic() ? 'demo' : lsGet('yapmap.lastPurge', null));
  if (showKey) {
    try {
      const data = await getPurge(showKey);
      if (!ctx.alive()) return;
      if (data && data.items) {
        area.value = data.items.map((it) => ytUrl(it.video_id)).join('\n');
        result.replaceChildren(buildResult(data));
      }
    } catch (e) { /* nothing to show yet */ }
  }
}

function buildResult(data) {
  const wrap = h('div');
  const counts = data.counts || {};
  wrap.append(
    h('div', { class: 'tally' },
      h('div', { class: 't-item watch' }, h('b', null, counts.watch || 0), h('span', null, 'watch')),
      h('div', { class: 't-item skim' }, h('b', null, counts.skim || 0), h('span', null, 'skim')),
      h('div', { class: 't-item skip' }, h('b', null, counts.skip || 0), h('span', null, 'skip')),
      h('div', { class: 't-item saved' }, h('b', null, fmtDur(data.saved_seconds || 0)), h('span', null, 'you just saved (est.)')),
    ),
    data.summary_line ? h('p', { class: 'purge-line' }, data.summary_line) : null,
    data.trimmed ? h('div', { class: 'warn' }, `Only the first 12 were judged — ${data.trimmed} more got left in the pile. Run those separately.`) : null,
  );

  let filter = 'all';
  const filters = h('div', { class: 'filters' });
  const list = h('div', { class: 'purge-list' });
  const renderList = () => {
    [...filters.children].forEach((b) => b.classList.toggle('on', b.dataset.f === filter));
    list.replaceChildren(...data.items.filter((it) => filter === 'all' || it.verdict === filter).map(row));
  };
  ['all', 'watch', 'skim', 'skip'].forEach((f) => filters.append(h('button', { class: 'chip', 'data-f': f, onclick: () => { filter = f; renderList(); } }, f)));
  renderList();

  const keep = data.items.filter((it) => it.verdict === 'watch' || it.verdict === 'skim');
  wrap.append(filters, list, h('div', { class: 'w-actions', style: { marginTop: '18px' } },
    h('button', {
      class: 'ghost',
      onclick: () => copy(keep.map((it) => `${it.verdict.toUpperCase()}  ${it.title} — ${ytUrl(it.video_id, it.best_t)}`).join('\n') || 'nothing survived the purge 💀', 'the keepers, copied ✓'),
    }, 'copy the keepers'),
  ));
  return wrap;
}

function row(it) {
  return h('div', { class: 'purge-row' },
    h('img', { src: thumb(it.video_id), alt: '', loading: 'lazy' }),
    h('div', { class: 'pr-body' },
      h('div', { class: 'pr-title' }, it.title),
      h('div', { class: 'pr-sub' }, [it.channel, it.duration ? fmtDur(it.duration) : null].filter(Boolean).join(' · ')),
      h('div', { class: 'pr-why' }, it.why),
      h('div', { class: 'pr-actions' },
        typeof it.best_t === 'number'
          ? h('button', { class: 'stamp', onclick: () => jumpTo(it.video_id, it.best_t, { title: it.best_label || it.title }) },
            `▶ best bit · ${fmt(it.best_t)}${it.best_label ? ' — ' + it.best_label : ''}`)
          : null,
        it.verdict !== 'skip' && it.verdict !== 'unknown' ? h('a', { class: 'mini', href: '#/v/' + it.video_id }, 'map it →') : null,
        h('a', { class: 'mini', href: ytUrl(it.video_id), target: '_blank', rel: 'noopener' }, 'open ↗'),
      ),
    ),
    h('span', { class: 'verdict-badge ' + it.verdict }, LABEL[it.verdict] || it.verdict),
  );
}
