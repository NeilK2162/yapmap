// The map section of a canvas: the mindmap, its toolbar, the inspector that
// opens on any idea (what the video says, the transcript at that moment, play,
// ask, got it, focus), the outline view, and exports.

import { h, fmt, toast, copy, download, downloadBlob, slug, menuButton, highlight, normalizeText } from '../util.js';
import { createMindmap, treeMarkdown, treeOpml, countIdeas } from '../mindmap.js';
import { getTranscript } from '../api.js';
import { jumpTo, onTime } from '../player.js';

export function mapSection({ data, ctx, ui, onAsk }) {
  const videoId = data.video_id;
  const got = new Set(ui.get('got', []));
  const saveGot = () => ui.set('got', [...got]);
  let view = ui.get('mapView', 'map');
  let tree = data.mindmap;
  let streaming = false;

  // ─── the pieces ─────────────────────────────────────────────────────────
  const card = h('div', {
    class: 'map-card', tabindex: '0', role: 'group',
    'aria-label': 'Mindmap. Arrow keys move between ideas, Enter plays, Space folds, G marks as got, F focuses a branch.',
  });
  const zoomBar = h('div', { class: 'mm-zoom' },
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Zoom in', onclick: () => map.zoom(1) }, '+'),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Zoom out', onclick: () => map.zoom(-1) }, '−'),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fit the whole map', onclick: () => map.fit() }, '⤢'),
  );
  const growing = h('div', { class: 'mm-growing', hidden: true }, h('span', { class: 'pulse-dot' }), h('span', { class: 'g-text' }, 'the map is growing…'));
  card.append(zoomBar, growing);

  const inspector = h('div', { class: 'inspector', role: 'region', hidden: true, 'aria-label': 'About this idea' });
  const outline = h('div', { class: 'outline-view', hidden: true });
  const stage = h('div', { class: 'map-stage' }, card, outline, inspector);

  // Search
  const searchInput = h('input', {
    class: 'field sm', type: 'search', placeholder: 'search the map…', 'aria-label': 'Search the map', autocomplete: 'off',
  });
  const searchCount = h('span', { class: 'mm-count', 'aria-live': 'polite' });
  const prevBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous match', disabled: true, onclick: () => step(-1) }, '↑');
  const nextBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next match', disabled: true, onclick: () => step(1) }, '↓');
  let searchSeq = 0;
  const runSearch = async () => {
    const mine = ++searchSeq;
    const q = searchInput.value;
    const res = await map.search(q);
    if (mine !== searchSeq) return;
    paintSearch(res, q);
    if (view === 'outline') renderOutline();
  };
  const step = async (dir) => paintSearch(await map.searchStep(dir), searchInput.value);
  function paintSearch(res, q) {
    searchCount.textContent = q.trim() ? (res.count ? `${res.index + 1} of ${res.count}` : 'no match') : '';
    prevBtn.disabled = nextBtn.disabled = res.count < 2;
  }
  let searchTimer;
  searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 160); });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { searchInput.value = ''; runSearch(); card.focus(); }
  });

  // Levels
  const levels = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'How much of the map to show' });
  [[1, '1'], [2, '2'], [3, '3'], [99, 'all']].forEach(([lv, label]) => levels.append(h('button', {
    type: 'button', role: 'radio', 'data-lv': String(lv), title: lv === 99 ? 'everything' : `${lv} level${lv > 1 ? 's' : ''} deep`,
    onclick: () => { map.setLevel(lv); ui.set('mapLevel', lv); paintLevels(); if (view === 'outline') renderOutline(); },
  }, label)));
  const paintLevels = () => [...levels.children].forEach((b) => {
    const on = Number(b.dataset.lv) === map.level();
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });

  // Map / outline
  const viewSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'View' });
  [['map', 'map'], ['outline', 'outline']].forEach(([v, label]) => viewSeg.append(h('button', {
    type: 'button', role: 'radio', 'data-v': v, onclick: () => setView(v),
  }, label)));
  function setView(v, init = false) {
    view = v;
    ui.set('mapView', v);
    [...viewSeg.children].forEach((b) => { b.classList.toggle('on', b.dataset.v === v); b.setAttribute('aria-checked', String(b.dataset.v === v)); });
    card.hidden = v !== 'map';
    outline.hidden = v !== 'outline';
    levels.hidden = v !== 'map';
    // A map laid out while hidden measured every label as zero: lay it out again now it's visible.
    if (v === 'outline') renderOutline(); else if (tree && !init) map.rebuild();
  }

  // Follow along
  const followBtn = h('button', {
    class: 'mini', type: 'button', 'aria-pressed': 'false', title: 'Highlight — and keep in view — whatever idea the video is on while it plays',
    onclick: () => setFollow(!(followBtn.getAttribute('aria-pressed') === 'true')),
  }, '◉ follow the video');
  function setFollow(on) {
    followBtn.setAttribute('aria-pressed', String(on));
    followBtn.classList.toggle('on', on);
    ui.set('mapFollow', on);
    map.setFollow(on);
    if (on && !nowId) toast('play any moment — the map follows along');
  }

  const exportMenu = menuButton('export ↓', () => [
    { label: 'image (.png)', hint: 'what’s on screen, sharp enough to print', onclick: exportPng },
    { label: 'vector (.svg)', hint: 'for slides and docs', onclick: exportSvg },
    null,
    { label: 'markdown outline (.md)', hint: 'every idea, note and timestamp', onclick: () => { download(treeMarkdown(tree, videoId), `${slug(data.headline)}-map.md`); toast('map saved as markdown ✓'); } },
    { label: 'OPML', hint: 'opens in XMind, MindNode, Obsidian, Logseq…', onclick: () => { download(treeOpml(tree, videoId, data.headline), `${slug(data.headline)}-map.opml`, 'text/x-opml;charset=utf-8'); toast('OPML saved ✓'); } },
    { label: 'copy as text', onclick: () => copy(treeMarkdown(tree, videoId), 'the whole map, copied ✓') },
  ], { cls: 'mini', ariaLabel: 'Export the map' });

  const fullBtn = h('button', { class: 'mini', type: 'button', onclick: toggleFull }, '⛶ fullscreen');
  const shell = h('div', { class: 'map-shell' });
  function toggleFull() {
    const full = shell.classList.toggle('full');
    fullBtn.textContent = full ? '✕ exit fullscreen' : '⛶ fullscreen';
    document.body.classList.toggle('map-full', full);
    map.setFullscreen(full);
    if (full) card.focus({ preventScroll: true });
  }
  const onKey = (e) => { if (e.key === 'Escape' && shell.classList.contains('full') && !e.defaultPrevented) toggleFull(); };
  document.addEventListener('keydown', onKey);

  const progressBar = h('i');
  const progressText = h('span');
  const nowChip = h('button', { class: 'now-chip', type: 'button', hidden: true, onclick: () => nowId && map.select(nowId) });
  const status = h('div', { class: 'map-status' },
    h('div', { class: 'got-meter', title: 'Ideas you’ve marked as got' }, h('div', { class: 'bar' }, progressBar), progressText),
    nowChip,
  );

  const toolbar = h('div', { class: 'map-toolbar' },
    h('div', { class: 'mm-search' }, h('span', { class: 's-icon', 'aria-hidden': 'true' }, '⌕'), searchInput, searchCount, prevBtn, nextBtn),
    viewSeg, levels,
    h('div', { class: 'tb-right' }, followBtn, exportMenu, fullBtn),
  );
  shell.append(toolbar, status, stage);

  // ─── the map itself ─────────────────────────────────────────────────────
  let nowId = null;
  // A big map opens on its themes -- readable at a glance, one tap from the
  // rest -- unless you've picked a depth for this video before.
  const map = createMindmap(card, {
    level: ui.get('mapLevel', countIdeas(tree) > 24 ? 1 : 2),
    got,
    title: `Mindmap of ${data.headline || 'this video'}`,
    onSelect: (node) => { renderInspector(node); if (view === 'outline') markOutlineSelection(); },
    onChange: () => { saveGot(); paintProgress(); if (view === 'outline') renderOutline(); },
    onNow: (node) => {
      nowId = node ? node.id : null;
      nowChip.hidden = !node;
      if (node) nowChip.replaceChildren(h('span', { class: 'pulse-dot' }), `now: ${node.label}`);
      if (view === 'outline') markOutlineNow();
    },
    onPlay: (node) => play(node),
  });

  function play(node) {
    if (typeof node.t !== 'number') return;
    jumpTo(videoId, node.t, { title: node.label });
  }

  const offTime = onTime((t, vid) => { if (vid === videoId) map.setNow(t); else map.clearNow(); });
  ctx.onCleanup(() => {
    offTime();
    clearTimeout(searchTimer);
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('map-full');
    map.destroy();
  });

  function paintProgress() {
    const total = map.total();
    const n = map.gotCount();
    progressBar.style.width = total ? `${(n / total) * 100}%` : '0';
    progressText.textContent = total
      ? (n ? `${n} of ${total} ideas got · ${Math.round((n / total) * 100)}%` : `${total} ideas · tap one, then “got it” as you learn them`)
      : 'mapping…';
  }

  // ─── inspector ──────────────────────────────────────────────────────────
  let excerptSeq = 0;
  function renderInspector(node) {
    if (!node) { inspector.hidden = true; stage.classList.remove('inspecting'); return; }
    inspector.hidden = false;
    stage.classList.add('inspecting');
    const hasT = typeof node.t === 'number';
    const excerpt = h('div', { class: 'excerpt' });
    const kids = childrenOf(node.id);

    const gotBtn = h('button', {
      class: 'ghost sm' + (node.got ? ' hot' : ''), type: 'button', 'aria-pressed': String(node.got),
      onclick: () => { map.setGot(node.id, !node.got); toast(node.got ? 'unmarked' : 'got it ✓ — one less thing to rewatch'); },
    }, node.got ? '✓ got it' : 'got it ✓');

    inspector.replaceChildren(
      h('div', { class: 'in-head' },
        h('nav', { class: 'crumbs', 'aria-label': 'Where this idea sits' },
          node.path.map((p) => h('button', { type: 'button', class: 'crumb', onclick: () => map.select(p.id) }, p.label)),
        ),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => { map.select(null); card.focus(); } }, '✕'),
      ),
      h('h3', { class: 'in-title' }, node.label),
      hasT ? h('button', { class: 'play-moment', type: 'button', onclick: () => play(node) },
        h('span', { class: 'pm-icon', 'aria-hidden': 'true' }, '▶'), h('span', null, `play this moment · ${fmt(node.t)}`)) : null,
      node.note ? h('p', { class: 'in-note' }, node.note) : null,
      hasT ? excerpt : null,
      kids.length ? h('div', { class: 'in-kids' },
        h('small', null, `inside · ${kids.length}`),
        h('div', { class: 'chips' }, kids.map((k) => h('button', {
          type: 'button', class: 'chip' + (map.isGot(k.id) ? ' got' : ''), onclick: () => map.select(k.id),
        }, k.label))),
      ) : null,
      h('div', { class: 'in-actions' },
        gotBtn,
        node.childCount ? h('button', {
          class: 'ghost sm', type: 'button',
          onclick: () => { const all = node.branchGot === node.branchSize; map.setGot(node.id, !all, { branch: true }); toast(all ? 'branch unmarked' : `whole branch got ✓ (${node.branchSize} ideas)`); },
        }, node.branchGot === node.branchSize ? 'unmark branch' : `got the branch (${node.branchGot}/${node.branchSize})`) : null,
        onAsk ? h('button', { class: 'ghost sm', type: 'button', onclick: () => onAsk(askAbout(node)) }, '💬 ask about this') : null,
        node.childCount || node.focused ? h('button', {
          class: 'ghost sm', type: 'button', onclick: () => map.focus(node.focused ? null : node.id),
        }, node.focused ? '⤺ whole map' : '⤢ focus this branch') : null,
        h('button', {
          class: 'ghost sm', type: 'button',
          onclick: () => copy(treeMarkdown(subtree(node.id), videoId), node.childCount ? 'branch copied ✓' : 'copied ✓'),
        }, '⧉ copy'),
      ),
    );

    if (hasT) {
      const mine = ++excerptSeq;
      excerpt.append(h('p', { class: 'ex-wait' }, 'finding it in the transcript…'));
      getTranscript(videoId).then((tr) => {
        if (mine !== excerptSeq) return;
        const blocks = (tr.blocks || []).filter((b) => b.t >= node.t - 3 && b.t <= node.t + 40).slice(0, 3);
        if (!blocks.length) { excerpt.remove(); return; }
        const terms = normalizeText(node.label).split(/\s+/).filter((w) => w.length > 3);
        excerpt.replaceChildren(
          h('small', null, 'what they actually said'),
          ...blocks.map((b) => h('button', { type: 'button', class: 'ex-line', onclick: () => jumpTo(videoId, b.t, { title: node.label }) },
            h('span', { class: 'ex-t' }, fmt(b.t)), h('span', null, highlight(b.text, terms)))),
        );
      }).catch(() => { if (mine === excerptSeq) excerpt.remove(); });
    }
  }

  const askAbout = (node) => {
    const where = node.path.length > 1 ? ` (under “${node.path[node.path.length - 1].label}”)` : '';
    return `What does the video say about “${node.label}”${where}? Explain it simply, with the specifics.`;
  };

  function nodeAt(id) {
    let node = tree;
    for (const part of id.split('.').slice(1)) node = node && node.children && node.children[Number(part)];
    return node;
  }
  const subtree = (id) => nodeAt(id);
  const childrenOf = (id) => ((nodeAt(id) || {}).children || []).map((c, i) => ({ id: `${id}.${i}`, label: c.label }));

  // ─── outline ────────────────────────────────────────────────────────────
  const closedOutline = new Set(ui.get('outlineClosed', []));
  function renderOutline() {
    if (!tree) { outline.replaceChildren(h('p', { class: 'hint' }, 'the outline appears as the map is written…')); return; }
    const q = normalizeText(searchInput.value.trim());
    const terms = q.split(/\s+/).filter(Boolean);
    const matchIds = new Set();
    if (terms.length) {
      map.ids().forEach((id) => {
        const n = nodeAt(id);
        if (n && terms.every((t) => normalizeText(`${n.label} ${n.note || ''}`).includes(t))) matchIds.add(id);
      });
    }
    const item = (node, id, depth) => {
      const kids = node.children || [];
      const open = !closedOutline.has(id) || (terms.length && [...matchIds].some((m) => m.startsWith(id + '.')));
      const li = h('li', { class: 'ol-item d' + Math.min(depth, 4) + (matchIds.has(id) ? ' match' : ''), 'data-id': id });
      const row = h('div', { class: 'ol-row' + (map.selected() === id ? ' sel' : '') + (nowId === id ? ' now' : '') },
        kids.length ? h('button', {
          class: 'ol-caret', type: 'button', 'aria-expanded': String(!!open), 'aria-label': open ? 'Collapse' : 'Expand',
          onclick: () => { if (open) closedOutline.add(id); else closedOutline.delete(id); ui.set('outlineClosed', [...closedOutline]); renderOutline(); },
        }, open ? '▾' : '▸') : h('span', { class: 'ol-caret none' }),
        depth ? h('button', {
          class: 'ol-check' + (map.isGot(id) ? ' on' : ''), type: 'button', role: 'checkbox', 'aria-checked': String(map.isGot(id)),
          'aria-label': `Got it: ${node.label}`, onclick: () => map.setGot(id, !map.isGot(id)),
        }) : null,
        h('button', { class: 'ol-label', type: 'button', onclick: () => map.select(id, { center: false }) },
          h('span', { class: 'ol-text' }, terms.length ? highlight(node.label, terms) : node.label),
          node.note ? h('span', { class: 'ol-note' }, terms.length ? highlight(node.note, terms) : node.note) : null,
        ),
        typeof node.t === 'number' && depth ? h('button', { class: 'stamp', type: 'button', onclick: () => play({ ...node, id }) }, '▶ ' + fmt(node.t)) : null,
      );
      li.append(row);
      if (kids.length && open) li.append(h('ol', null, kids.map((k, i) => item(k, `${id}.${i}`, depth + 1))));
      return li;
    };
    outline.replaceChildren(h('ol', { class: 'outline' }, item(tree, 'n', 0)));
  }
  function markOutlineSelection() {
    outline.querySelectorAll('.ol-row.sel').forEach((r) => r.classList.remove('sel'));
    const li = map.selected() && outline.querySelector(`li[data-id="${map.selected()}"] > .ol-row`);
    if (li) li.classList.add('sel');
  }
  function markOutlineNow() {
    outline.querySelectorAll('.ol-row.now').forEach((r) => r.classList.remove('now'));
    const row = nowId && outline.querySelector(`li[data-id="${nowId}"] > .ol-row`);
    if (row) {
      row.classList.add('now');
      if (followBtn.getAttribute('aria-pressed') === 'true') row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ─── exports ────────────────────────────────────────────────────────────
  async function exportPng() {
    if (view !== 'map') setView('map');
    toast('drawing the map…');
    try {
      downloadBlob(await map.exportPng(), `${slug(data.headline)}-map.png`);
      toast('map saved as an image ✓');
    } catch (e) {
      toast('this browser won’t draw it as PNG — saving an SVG instead');
      exportSvg();
    }
  }
  async function exportSvg() {
    if (view !== 'map') setView('map');
    try {
      const { text } = await map.exportSvg();
      download(text, `${slug(data.headline)}-map.svg`, 'image/svg+xml;charset=utf-8');
      toast('map saved as SVG ✓');
    } catch (e) { toast('couldn’t export the map'); }
  }

  // ─── go ─────────────────────────────────────────────────────────────────
  function update(nextTree, { streaming: s = false } = {}) {
    tree = nextTree;
    streaming = s;
    growing.hidden = !streaming;
    if (streaming) growing.querySelector('.g-text').textContent = `the map is growing… ${countIdeas(tree)} ideas so far`;
    map.setTree(tree, { streaming });
    paintProgress();
    if (view === 'outline') renderOutline();
  }

  setView(view, true);
  paintLevels();
  if (ui.get('mapFollow', false)) setFollow(true);
  if (tree) update(tree);
  else paintProgress();

  return {
    el: shell,
    update,
    map,
    say: () => {
      const ideas = countIdeas(tree);
      if (!ideas) return 'every idea, timestamped and explained. It grows while Claude writes it.';
      const timed = map.ids().filter((id) => id !== 'n' && typeof (map.node(id) || {}).t === 'number').length;
      return timed
        ? `${ideas} ideas, every one timestamped. Tap one for what the video says about it — or let it follow along as the video plays.`
        : `${ideas} ideas. Regenerate this canvas to get a timestamp and a note on every one.`;
    },
    get streaming() { return streaming; },
  };
}
