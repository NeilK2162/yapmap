import { h, fmt, fmtDur, slug, toast, download, parseVideoId, thumb, ytUrl, sectionHead } from '../util.js';
import { getBeef, beefIndex, isStatic } from '../api.js';
import { createMap } from '../map.js';
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

  const result = h('div');
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
        h('div', { class: 'corner a' }, h('label', null, 'corner A'), inputA),
        h('span', { class: 'vs' }, 'vs'),
        h('div', { class: 'corner b' }, h('label', null, 'corner B'), inputB),
      ),
      h('button', { class: 'cta accent', type: 'submit' }, 'start the beef 🥩'),
    ),
    h('div', { style: { height: '44px' } }),
    result,
  );

  if (!aId || !bId) {
    if (isStatic()) {
      const demos = await beefIndex();
      if (ctx.alive() && demos.length) {
        result.append(h('div', { class: 'x-card' },
          h('h3', null, 'try the demo beef'),
          h('p', null, 'Making a new one needs the local app — but here’s a real one to poke at.'),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            demos.map((x) => h('a', { class: 'ghost hot', href: `#/beef/${x.a}/${x.b}` }, x.headline || x.topic || 'open'))),
        ));
      }
    }
    return;
  }

  const line = h('h2', null, LOADING[0]);
  let i = 0;
  const spin = setInterval(() => { i = (i + 1) % LOADING.length; line.textContent = LOADING[i]; }, 2600);
  ctx.onCleanup(() => clearInterval(spin));
  result.replaceChildren(h('div', { class: 'loading', style: { paddingTop: '10px' } },
    h('div', { class: 'orb' }), line, h('p', null, 'Reading two whole transcripts. Usually one to three minutes.')));

  let beef;
  try {
    beef = await getBeef(aId, bId, { force: query.get('force') === '1' });
  } catch (err) {
    clearInterval(spin);
    if (!ctx.alive()) return;
    result.replaceChildren(h('div', { class: 'error', style: { margin: '0' } }, h('div', { class: 'card' },
      h('h3', null, err.needsInstall ? 'that beef needs the real thing.' : 'the beef got cancelled.'),
      h('p', null, err.message),
      err.needsInstall ? h('a', { class: 'ghost hot', href: '#/extras' }, 'how to install') : null,
    )));
    return;
  }
  clearInterval(spin);
  if (!ctx.alive()) return;
  if (query.get('force') === '1') history.replaceState(null, '', `#/beef/${aId}/${bId}`);
  if (!beef.cached) document.dispatchEvent(new CustomEvent('yapmap:changed'));
  result.replaceChildren(buildResult(beef, ctx));
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
    ? h('button', { class: 'stamp ' + which + '-side', onclick: () => jumpTo(side.video_id, t, { title: label }) }, `▶ ${which.toUpperCase()} ${fmt(t)}`)
    : null;
}

function buildResult(beef, ctx) {
  const { a, b } = beef;
  const wrap = h('div');
  let n = 0;
  const sec = (title, say, body, ...tools) => h('section', { class: 'sec' }, sectionHead(++n, title, say, ...tools), body);

  wrap.append(h('header', { class: 'crown', style: { marginBottom: '26px' } },
    h('div', { class: 'sticker' }, ('beef · ' + (beef.topic || 'the matchup')).toLowerCase()),
    h('h2', null, beef.headline || `${a.title} vs ${b.title}`),
    h('div', { class: 'fighters' }, fighter(a, 'A'), h('span', { class: 'vs' }, 'vs'), fighter(b, 'B')),
    h('div', { class: 'crown-actions' },
      h('button', { class: 'ghost', onclick: () => { download(beefMarkdown(beef), `${slug(beef.headline || 'beef')}-beef.md`); toast('beef saved ✓'); } }, 'take the beef ↓'),
      h('a', { class: 'ghost', href: `#/beef/${b.video_id}/${a.video_id}` }, 'swap corners ⇄'),
      !isStatic() ? h('a', { class: 'ghost', href: `#/beef/${a.video_id}/${b.video_id}?force=1` }, 'rematch ↻') : null,
      h('a', { class: 'ghost', href: '#/beef' }, 'new beef'),
    ),
  ));

  if (!beef.related) wrap.append(h('div', { class: 'warn' }, '⚠ These two aren’t really about the same thing, so there isn’t much to fight about. Try two takes on one topic.'));
  if (beef.verdict) wrap.append(h('div', { class: 'ref', style: { marginBottom: '56px' } }, h('small', null, 'the ref’s call'), beef.verdict));

  if (beef.clash.length) {
    wrap.append(sec('the beef', 'where they genuinely disagree — play each side and decide for yourself.',
      h('div', { class: 'clash' }, beef.clash.map((c) => h('div', { class: 'clash-row' },
        h('div', { class: 'c-topic' }, c.topic),
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
      h('h4', null, title),
      h('div', { class: 'plain-list' }, items.length
        ? items.map((p) => h('div', { class: 'plain-item' }, h('span', { class: 'pi-text' }, p.point), sideStamp(side, p.t, which, p.point)))
        : h('div', { class: 'plain-item' }, 'nothing only they said')),
    );
    wrap.append(sec('only one of them said it', 'the blind spots — what each one leaves out.',
      h('div', { class: 'split' }, col('col-a', 'only A', beef.only_a, a, 'a'), col('col-b', 'only B', beef.only_b, b, 'b'))));
  }

  const card = h('div', { class: 'map-card' }, h('div', { class: 'map-legend' }, 'the whole fight, as a map'));
  wrap.append(sec('the map', 'the beef, the common ground and the blind spots in one tree.', card));
  const map = createMap(card, beefMindmap(beef), { expandLevel: 3 });
  ctx.onCleanup(() => map.destroy());
  return wrap;
}

function beefMindmap(beef) {
  const lines = [`# ${beef.topic || 'the beef'}`, ''];
  if (beef.clash.length) {
    lines.push('## the beef');
    beef.clash.forEach((c) => lines.push(`- ${c.topic}`, `  - A: ${c.a}`, `  - B: ${c.b}`));
  }
  if (beef.agree.length) { lines.push('## they agree'); beef.agree.forEach((p) => lines.push(`- ${p.point}`)); }
  if (beef.only_a.length) { lines.push('## only A'); beef.only_a.forEach((p) => lines.push(`- ${p.point}`)); }
  if (beef.only_b.length) { lines.push('## only B'); beef.only_b.forEach((p) => lines.push(`- ${p.point}`)); }
  return lines.join('\n');
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
