import { h, fmt, fmtDur, slug, toast, download, parseVideoId, thumb, ytUrl, sectionHead, prefLang } from '../util.js';
import { getBeefCached, beefIndex, isStatic, swapBeef } from '../api.js';
import { startJob, subscribe, cancelJob, findRunning } from '../jobs.js';
import { createMindmap } from '../mindmap.js';
import { jumpTo } from '../player.js';

const LOADING = [
  'two creators enter…', 'pulling receipts from both corners…', 'checking who said it first…',
  'separating beef from vibes…', 'finding where they actually disagree…', 'the ref is reviewing the tape…',
];

export async function render(root, params, query, ctx) {
  const [aId, bId] = params;
  const page = h('div', { class: 'page' });
  root.append(page);

  const inputA = h('input', { class: 'field', placeholder: 'youtube link — corner A', 'aria-label': 'Video A link' });
  const inputB = h('input', { class: 'field', placeholder: 'youtube link — corner B', 'aria-label': 'Video B link' });
  if (aId) inputA.value = 'https://youtu.be/' + aId;
  if (bId) inputB.value = 'https://youtu.be/' + bId;

  const result = h('div', { class: 'result-slot' });
  page.append(
    h('div', { class: 'page-head' },
      h('span', { class: 'kicker' }, 'beef mode'),
      h('h1', null, 'put two videos ', h('em', null, 'in the ring'), '.'),
      h('p', { class: 'sub' }, 'Two takes on the same thing. yapmap reads both and shows exactly where they clash — each side’s receipt, playable — plus where they agree and what only one of them covers.'),
    ),
    h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const a = parseVideoId(inputA.value), b = parseVideoId(inputB.value);
        if (!a || !b) { toast('paste a youtube link in each corner'); return; }
        if (a === b) { toast('that’s the same video twice'); return; }
        location.hash = `#/beef/${a}/${b}`;
      },
    },
      h('div', { class: 'ring-form' },
        h('div', { class: 'corner a' }, h('label', null, 'corner A', inputA)),
        h('span', { class: 'vs', 'aria-hidden': 'true' }, 'vs'),
        h('div', { class: 'corner b' }, h('label', null, 'corner B', inputB)),
      ),
      h('button', { class: 'cta accent', type: 'submit' }, 'start the beef 🥩'),
    ),
    result,
  );

  if (!aId || !bId) {
    if (isStatic()) {
      const demos = await beefIndex();
      if (ctx.alive() && demos.length) {
        result.append(h('div', { class: 'x-card' },
          h('h2', null, 'try the demo beef'),
          h('p', null, 'Making a new one needs the local app — but here’s a real one to poke at.'),
          h('div', { class: 'row' }, demos.map((x) => h('a', { class: 'ghost hot', href: `#/beef/${x.a}/${x.b}` }, x.headline || x.topic || 'open'))),
        ));
      }
    }
    return;
  }

  const force = query.get('force') === '1';
  const lang = prefLang();
  const show = (beef) => {
    if (!ctx.alive()) return;
    result.replaceChildren(buildResult(beef.a.video_id === aId ? beef : swapBeef(beef), ctx));
  };
  const fail = (err) => {
    if (!ctx.alive()) return;
    result.replaceChildren(h('div', { class: 'error inline' }, h('div', { class: 'card' },
      h('h2', null, err.needsInstall ? 'that beef needs the real thing.' : err.code === 'usage_limit' ? 'out of Claude for now.' : 'the beef got cancelled.'),
      h('p', null, err.message),
      h('div', { class: 'row' },
        err.needsInstall ? h('a', { class: 'ghost hot', href: '#/extras' }, 'how to install') : null,
        !err.needsInstall && err.code !== 'usage_limit' ? h('a', { class: 'ghost', href: `#/beef/${aId}/${bId}?force=1` }, 'try again ↻') : null,
      ),
    )));
  };

  let rec = findRunning('beef', (p) => (p.a === aId && p.b === bId) || (p.a === bId && p.b === aId));
  if (!rec && !force) {
    try {
      const cached = await getBeefCached(aId, bId, lang);
      if (cached) { show(cached); return; }
    } catch (err) { fail(err); return; }
  }
  if (!rec) {
    try { rec = await startJob('beef', { a: aId, b: bId, lang, force }); } catch (err) { fail(err); return; }
    if (force) history.replaceState(null, '', `#/beef/${aId}/${bId}`);
  }
  if (!ctx.alive()) return;

  const line = h('h2', { class: 'ld-line' }, LOADING[0]);
  const detail = h('p', null, 'Reading two whole transcripts. Usually one to three minutes — you can leave, it keeps going.');
  const clock = h('span', { class: 'pg-clock' });
  const started = Date.now();
  let i = 0;
  const spin = setInterval(() => {
    i += 1;
    if (i % 3 === 0) line.textContent = LOADING[(i / 3) % LOADING.length];
    clock.textContent = `${Math.round((Date.now() - started) / 1000)}s`;
  }, 1000);
  ctx.onCleanup(() => clearInterval(spin));
  result.replaceChildren(h('div', { class: 'loading', 'aria-live': 'polite' },
    h('div', { class: 'orb', 'aria-hidden': 'true' }), line, detail,
    h('div', { class: 'row center' }, clock, h('button', { class: 'mini', type: 'button', onclick: () => cancelJob(rec) }, 'cancel')),
  ));

  const off = subscribe(rec, (evt) => {
    if (evt.type === 'stage' && evt.stage === 'transcript') detail.textContent = 'Grabbing both transcripts…';
    else if (evt.type === 'meta') detail.textContent = `${evt.a.title}  vs  ${evt.b.title}`;
    else if (evt.type === 'warning') toast(evt.message);
    else if (evt.type === 'done') { clearInterval(spin); if (!evt.result.cached) document.dispatchEvent(new CustomEvent('yapmap:changed')); show(evt.result); }
    else if (evt.type === 'error' || evt.type === 'lost') { clearInterval(spin); const e = new Error(evt.message); e.code = evt.code; fail(e); }
    else if (evt.type === 'cancelled') { clearInterval(spin); fail(new Error('Cancelled — nothing was saved.')); }
  });
  ctx.onCleanup(off);
}

function fighter(side, tag) {
  return h('a', { class: 'fighter ' + tag.toLowerCase(), href: ytUrl(side.video_id), target: '_blank', rel: 'noopener' },
    h('img', { src: thumb(side.video_id), alt: '' }),
    h('div', null,
      h('div', { class: 'f-tag' }, tag),
      h('div', { class: 'f-title' }, side.title),
      h('div', { class: 'f-sub' }, [side.channel, side.duration ? fmtDur(side.duration) : null].filter(Boolean).join(' · ')),
    ),
  );
}

function sideStamp(side, t, which, label) {
  return typeof t === 'number'
    ? h('button', { class: 'stamp ' + which + '-side', type: 'button', onclick: () => jumpTo(side.video_id, t, { title: label }) }, `▶ ${which.toUpperCase()} ${fmt(t)}`)
    : null;
}

function buildResult(beef, ctx) {
  const { a, b } = beef;
  const wrap = h('div');
  let n = 0;
  const sec = (title, say, body, ...tools) => h('section', { class: 'sec' }, sectionHead(++n, title, say, ...tools), body);

  wrap.append(h('header', { class: 'crown' },
    h('div', { class: 'sticker' }, ('beef · ' + (beef.topic || 'the matchup')).toLowerCase()),
    h('h2', { class: 'c-title' }, beef.headline || `${a.title} vs ${b.title}`),
    h('div', { class: 'fighters' }, fighter(a, 'A'), h('span', { class: 'vs', 'aria-hidden': 'true' }, 'vs'), fighter(b, 'B')),
    h('div', { class: 'crown-actions' },
      h('button', { class: 'ghost', type: 'button', onclick: () => { download(beefMarkdown(beef), `${slug(beef.headline || 'beef')}-beef.md`); toast('beef saved ✓'); } }, 'take the beef ↓'),
      h('a', { class: 'ghost', href: `#/beef/${b.video_id}/${a.video_id}` }, 'swap corners ⇄'),
      !isStatic() ? h('a', { class: 'ghost', href: `#/beef/${a.video_id}/${b.video_id}?force=1` }, 'rematch ↻') : null,
      h('a', { class: 'ghost', href: '#/beef' }, 'new beef'),
    ),
  ));

  if (!beef.related) wrap.append(h('div', { class: 'warn' }, '⚠ These two aren’t really about the same thing, so there isn’t much to fight about. Try two takes on one topic.'));
  if (beef.verdict) wrap.append(h('div', { class: 'ref' }, h('small', null, 'the ref’s call'), beef.verdict));

  if (beef.clash.length) {
    wrap.append(sec('the beef', 'where they genuinely disagree — play each side and decide for yourself.',
      h('div', { class: 'clash' }, beef.clash.map((c) => h('div', { class: 'clash-row' },
        h('h3', { class: 'c-topic' }, c.topic),
        h('div', { class: 'clash-sides' },
          h('div', { class: 'side a' }, h('span', { class: 's-who' }, 'A says'), c.a, sideStamp(a, c.t_a, 'a', c.topic)),
          h('div', { class: 'side b' }, h('span', { class: 's-who' }, 'B says'), c.b, sideStamp(b, c.t_b, 'b', c.topic)),
        ),
        c.why ? h('div', { class: 'why' }, h('b', null, 'why it matters'), c.why) : null,
      )))));
  }

  if (beef.agree.length) {
    wrap.append(sec('they agree', 'common ground — the parts you can probably trust.',
      h('div', { class: 'plain-list' }, beef.agree.map((p) => h('div', { class: 'plain-item' },
        h('span', { class: 'pi-text' }, p.point),
        h('span', { class: 'pi-stamps' }, sideStamp(a, p.t_a, 'a', p.point), sideStamp(b, p.t_b, 'b', p.point)),
      )))));
  }

  if (beef.only_a.length || beef.only_b.length) {
    const col = (cls, title, items, side, which) => h('div', { class: cls },
      h('h3', null, title),
      h('div', { class: 'plain-list' }, items.length
        ? items.map((p) => h('div', { class: 'plain-item' }, h('span', { class: 'pi-text' }, p.point), sideStamp(side, p.t, which, p.point)))
        : h('div', { class: 'plain-item' }, 'nothing only they said')),
    );
    wrap.append(sec('only one of them said it', 'the blind spots — what each one leaves out.',
      h('div', { class: 'split' }, col('col-a', 'only A', beef.only_a, a, 'a'), col('col-b', 'only B', beef.only_b, b, 'b'))));
  }

  // The whole fight as a map: tap a leaf and it plays that side's moment.
  const card = h('div', { class: 'map-card', tabindex: '0', role: 'group', 'aria-label': 'The beef as a mindmap. Tap an idea to play it.' });
  wrap.append(sec('the map', 'the beef, the common ground and the blind spots in one tree. tap a side to hear it.',
    h('div', { class: 'map-shell plain' }, h('div', { class: 'map-stage' }, card))));
  const map = createMindmap(card, {
    level: 3,
    title: `The beef: ${beef.topic || 'the matchup'}`,
    onSelect: (node) => {
      if (!node || typeof node.t !== 'number' || !node.side) return;
      const side = node.side === 'a' ? a : b;
      jumpTo(side.video_id, node.t, { title: node.label });
    },
    onPlay: (node) => { if (node.side) jumpTo((node.side === 'a' ? a : b).video_id, node.t, { title: node.label }); },
  });
  requestAnimationFrame(() => map.setTree(beefTree(beef)));
  ctx.onCleanup(() => map.destroy());
  return wrap;
}

function beefTree(beef) {
  const point = (side, text, t) => ({ label: `${side.toUpperCase()}: ${text}`, t, side, note: '', children: [] });
  const children = [];
  if (beef.clash.length) {
    children.push({
      label: 'the beef', t: null, note: '',
      children: beef.clash.map((c) => ({ label: c.topic, t: null, note: c.why || '', children: [point('a', c.a, c.t_a), point('b', c.b, c.t_b)] })),
    });
  }
  if (beef.agree.length) children.push({ label: 'they agree', t: null, note: '', children: beef.agree.map((p) => ({ label: p.point, t: p.t_a, side: 'a', note: '', children: [] })) });
  if (beef.only_a.length) children.push({ label: 'only A', t: null, note: '', children: beef.only_a.map((p) => point('a', p.point, p.t)) });
  if (beef.only_b.length) children.push({ label: 'only B', t: null, note: '', children: beef.only_b.map((p) => point('b', p.point, p.t)) });
  return { label: beef.topic || 'the beef', t: null, note: '', children };
}

function beefMarkdown(beef) {
  const { a, b } = beef;
  const link = (side, t) => (typeof t === 'number' ? ` [${fmt(t)}](${ytUrl(side.video_id, t)})` : '');
  const out = [`# ${beef.headline || 'Beef'}`, '', `**A:** ${a.title} — ${a.channel}  `, `**B:** ${b.title} — ${b.channel}`, ''];
  if (beef.verdict) out.push(`> ${beef.verdict}`, '');
  if (beef.clash.length) {
    out.push('## Where they clash', '');
    beef.clash.forEach((c) => out.push(`### ${c.topic}`, `- **A:** ${c.a}${link(a, c.t_a)}`, `- **B:** ${c.b}${link(b, c.t_b)}`, c.why ? `- *Why it matters:* ${c.why}` : '', ''));
  }
  if (beef.agree.length) { out.push('## Where they agree', ''); beef.agree.forEach((p) => out.push(`- ${p.point}${link(a, p.t_a)}${link(b, p.t_b)}`)); out.push(''); }
  if (beef.only_a.length) { out.push('## Only A', ''); beef.only_a.forEach((p) => out.push(`- ${p.point}${link(a, p.t)}`)); out.push(''); }
  if (beef.only_b.length) { out.push('## Only B', ''); beef.only_b.forEach((p) => out.push(`- ${p.point}${link(b, p.t)}`)); out.push(''); }
  out.push('---', '', 'Made with yapmap · powered by Claude');
  return out.join('\n');
}
