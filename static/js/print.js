// A study sheet: the canvas as something you can print or save as a PDF --
// the map as an outline, the tool, the findings, every timestamp kept.

import { h, fmt, fmtDur, ytUrl } from './util.js';

export function printSheet(d, { kindLabel = {} } = {}) {
  const link = (t) => (typeof t === 'number' ? h('span', { class: 'ps-t' }, fmt(t)) : null);
  const section = (title, ...body) => h('section', { class: 'ps-sec' }, h('h2', null, title), ...body);

  const outline = (node, depth = 0) => h('li', { class: 'ps-d' + Math.min(depth, 4) },
    h('span', { class: 'ps-label' }, node.label), link(node.t),
    node.note ? h('div', { class: 'ps-note' }, node.note) : null,
    (node.children || []).length ? h('ul', null, node.children.map((c) => outline(c, depth + 1))) : null,
  );

  const art = d.artifact;
  let tool = null;
  if (art && art.type === 'flashcards') {
    tool = section('Flashcards', h('ol', { class: 'ps-cards' }, art.cards.map((c) => h('li', null,
      h('div', { class: 'ps-q' }, c.q, link(c.t)), h('div', { class: 'ps-a' }, c.a)))));
  } else if (art && art.type === 'cookalong') {
    tool = section('Cook-along',
      art.yields ? h('p', null, 'Makes ' + art.yields) : null,
      art.ingredients.length ? h('ul', { class: 'ps-cols' }, art.ingredients.map((x) => h('li', null, '☐ ', [x.qty, x.item].filter(Boolean).join(' ')))) : null,
      h('ol', null, art.steps.map((s) => h('li', null, s.text, s.timer_seconds ? ` (timer ${fmt(s.timer_seconds)})` : '', link(s.t)))));
  } else if (art && art.type === 'verdict') {
    tool = section(`Verdict: ${art.call.toUpperCase()}${art.product ? ' — ' + art.product : ''}`,
      art.call_line ? h('p', null, art.call_line) : null,
      art.pros.length ? h('p', null, h('b', null, 'The good: '), art.pros.map((p) => p.text).join(' · ')) : null,
      art.cons.length ? h('p', null, h('b', null, 'The bad: '), art.cons.map((p) => p.text).join(' · ')) : null,
      art.deal_breaker ? h('p', null, h('b', null, 'Deal-breaker: '), art.deal_breaker.text) : null);
  } else if (art && art.type === 'claims') {
    tool = section('Claims to check', h('ul', null, art.claims.map((c) => h('li', null,
      c.who ? h('b', null, c.who + ': ') : null, c.claim, link(c.t), c.check ? h('div', { class: 'ps-note' }, 'check: ' + c.check) : null))));
  } else if (art && art.type === 'timeline') {
    tool = section('Timeline', h('ul', null, art.events.map((e) => h('li', null,
      e.when ? h('b', null, e.when + ' ') : null, e.label, link(e.t), e.detail ? h('div', { class: 'ps-note' }, e.detail) : null))));
  }

  const sheet = h('div', { id: 'print-sheet' },
    h('header', null,
      h('div', { class: 'ps-brand' }, 'yapmap study sheet'),
      h('h1', null, d.headline || d.title),
      h('p', { class: 'ps-src' }, [d.channel, d.duration ? fmtDur(d.duration) : null, ytUrl(d.video_id)].filter(Boolean).join(' · ')),
      d.tldr ? h('p', { class: 'ps-tldr' }, d.tldr) : null,
    ),
    d.mindmap ? section('The map', h('ul', { class: 'ps-outline' }, (d.mindmap.children || []).map((c) => outline(c, 1)))) : null,
    tool,
    d.receipts && d.receipts.length ? section(d.receipts_label || 'Key findings', h('ol', null, d.receipts.map((r) => h('li', null,
      h('b', null, r.title), link(r.t), r.detail ? h('div', { class: 'ps-note' }, r.detail) : null)))) : null,
    d.summary && d.summary.length ? section('Summary', ...d.summary.map((p) => h('p', null, p))) : null,
    d.stickies && d.stickies.length ? section(d.stickies_label || 'Highlights', h('ul', null, d.stickies.map((s) => h('li', null,
      h('i', null, (kindLabel[s.kind] || s.kind) + ': '), s.text, link(s.t))))) : null,
    d.questions && d.questions.length ? section('Test yourself', h('ol', null, d.questions.map((q) => h('li', null, q)))) : null,
    d.moves && d.moves.length ? section('Next moves', h('ul', null, d.moves.map((m) => h('li', null, '☐ ' + m)))) : null,
    h('footer', null, 'Timestamps are [minutes:seconds] into the video. Made with yapmap · powered by Claude'),
  );

  document.getElementById('print-sheet')?.remove();
  document.body.appendChild(sheet);
  document.body.classList.add('printing');
  const done = () => {
    document.body.classList.remove('printing');
    sheet.remove();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 50);
}
