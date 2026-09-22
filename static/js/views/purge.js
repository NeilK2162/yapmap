import { h, fmt, fmtDur, toast, copy, thumb, ytUrl, lsGet, lsSet, prefLang } from '../util.js';
import { getPurge, isStatic } from '../api.js';
import { startJob, subscribe, cancelJob, runningJobs } from '../jobs.js';
import { jumpTo } from '../player.js';

const LOADING = [
  'reading the room…', 'judging thumbnails by their transcripts…', 'finding the filler…',
  'checking which ones are 20 minutes of intro…', 'sorting the bangers from the yap…',
];
const LABEL = { watch: 'watch', skim: 'skim', skip: 'skip', unknown: '??' };

export async function render(root, [key], _query, ctx) {
  const page = h('div', { class: 'page' });
  root.append(page);

  const area = h('textarea', {
    class: 'field', spellcheck: 'false', 'aria-label': 'YouTube links, one per line',
    placeholder: 'https://youtu.be/…\nhttps://www.youtube.com/watch?v=…\nhttps://www.youtube.com/playlist?list=…',
  });
  const result = h('div', { class: 'result-slot' });
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
    result,
  );

  function fail(err) {
    if (!ctx.alive()) return;
    result.replaceChildren(h('div', { class: 'error inline' }, h('div', { class: 'card' },
      h('h2', null, err.needsInstall ? 'the purge needs the real thing.' : 'the purge stalled.'),
      h('p', null, err.message),
      err.needsInstall ? h('a', { class: 'ghost hot', href: '#/extras' }, 'how to install') : null,
    )));
  }

  function watch(rec) {
    button.disabled = true;
    const line = h('h2', { class: 'ld-line' }, LOADING[0]);
    const detail = h('p', null, 'Fetching transcripts, then one judgement call for the lot.');
    const clock = h('span', { class: 'pg-clock' });
    const started = Date.now();
    let i = 0;
    const spin = setInterval(() => {
      i += 1;
      if (i % 3 === 0) line.textContent = LOADING[(i / 3) % LOADING.length];
      clock.textContent = `${Math.round((Date.now() - started) / 1000)}s`;
    }, 1000);
    const stop = () => { clearInterval(spin); button.disabled = false; };
    ctx.onCleanup(stop);
    result.replaceChildren(h('div', { class: 'loading', 'aria-live': 'polite' },
      h('div', { class: 'orb', 'aria-hidden': 'true' }), line, detail,
      h('div', { class: 'row center' }, clock, h('button', { class: 'mini', type: 'button', onclick: () => cancelJob(rec) }, 'cancel')),
    ));
    const off = subscribe(rec, (evt) => {
      if (!ctx.alive()) return;
      if (evt.type === 'progress' && evt.total) detail.textContent = `Transcripts: ${evt.done} of ${evt.total}…`;
      else if (evt.type === 'stage' && evt.stage === 'reading') detail.textContent = `Judging ${evt.total || 'the'} videos in one go…`;
      else if (evt.type === 'warning') toast(evt.message);
      else if (evt.type === 'done') {
        stop();
        const data = evt.result;
        lsSet('yapmap.lastPurge', data.key);
        history.replaceState(null, '', '#/purge/' + data.key);
        if (!data.cached) document.dispatchEvent(new CustomEvent('yapmap:changed'));
        result.replaceChildren(buildResult(data));
      } else if (evt.type === 'error' || evt.type === 'lost') { stop(); fail(new Error(evt.message)); }
      else if (evt.type === 'cancelled') { stop(); fail(new Error('Cancelled — nothing was saved.')); }
    });
    ctx.onCleanup(off);
  }

  async function run(urls) {
    try { watch(await startJob('purge', { urls, lang: prefLang() })); } catch (err) { fail(err); }
  }

  // A purge still running (you left and came back): pick it up.
  const running = runningJobs().find((r) => r.kind === 'purge');
  if (running) { watch(running); return; }

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
      h('div', { class: 't-item watch' }, h('b', null, String(counts.watch || 0)), h('span', null, 'watch')),
      h('div', { class: 't-item skim' }, h('b', null, String(counts.skim || 0)), h('span', null, 'skim')),
      h('div', { class: 't-item skip' }, h('b', null, String(counts.skip || 0)), h('span', null, 'skip')),
      h('div', { class: 't-item saved' }, h('b', null, fmtDur(data.saved_seconds || 0)), h('span', null, 'you just saved (est.)')),
    ),
    data.summary_line ? h('p', { class: 'purge-line' }, data.summary_line) : null,
    data.trimmed ? h('div', { class: 'warn' }, `Only the first 12 were judged — ${data.trimmed} more got left in the pile. Run those separately.`) : null,
  );

  let filter = 'all';
  const filters = h('div', { class: 'filters', role: 'radiogroup', 'aria-label': 'Show' });
  const list = h('div', { class: 'purge-list' });
  const renderList = () => {
    [...filters.children].forEach((b) => { b.classList.toggle('on', b.dataset.f === filter); b.setAttribute('aria-checked', String(b.dataset.f === filter)); });
    list.replaceChildren(...data.items.filter((it) => filter === 'all' || it.verdict === filter).map(row));
  };
  ['all', 'watch', 'skim', 'skip'].forEach((f) => filters.append(h('button', {
    class: 'chip', type: 'button', role: 'radio', 'data-f': f, onclick: () => { filter = f; renderList(); },
  }, f)));
  renderList();

  const keep = data.items.filter((it) => it.verdict === 'watch' || it.verdict === 'skim');
  wrap.append(h('h2', { class: 'sr-only' }, 'Verdicts'), filters, list, h('div', { class: 'row', style: { marginTop: '18px' } },
    h('button', {
      class: 'ghost', type: 'button',
      onclick: () => copy(keep.map((it) => `${it.verdict.toUpperCase()}  ${it.title} — ${ytUrl(it.video_id, it.best_t)}`).join('\n') || 'nothing survived the purge 💀', 'the keepers, copied ✓'),
    }, 'copy the keepers'),
  ));
  return wrap;
}

function row(it) {
  return h('div', { class: 'purge-row' },
    h('img', { src: thumb(it.video_id), alt: '', loading: 'lazy' }),
    h('div', { class: 'pr-body' },
      h('h3', { class: 'pr-title' }, it.title),
      h('div', { class: 'pr-sub' }, [it.channel, it.duration ? fmtDur(it.duration) : null].filter(Boolean).join(' · ')),
      h('p', { class: 'pr-why' }, it.why),
      h('div', { class: 'row' },
        typeof it.best_t === 'number'
          ? h('button', { class: 'stamp', type: 'button', onclick: () => jumpTo(it.video_id, it.best_t, { title: it.best_label || it.title }) },
            `▶ best bit · ${fmt(it.best_t)}${it.best_label ? ' — ' + it.best_label : ''}`)
          : null,
        it.verdict !== 'skip' && it.verdict !== 'unknown' ? h('a', { class: 'mini', href: '#/v/' + it.video_id }, 'map it →') : null,
        h('a', { class: 'mini', href: ytUrl(it.video_id), target: '_blank', rel: 'noopener' }, 'open ↗'),
      ),
    ),
    h('span', { class: 'verdict-badge ' + it.verdict }, LABEL[it.verdict] || it.verdict),
  );
}
