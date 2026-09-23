// The mindmap. markmap lays it out and animates it; everything that makes it
// a study tool is ours. Every node is a moment in the video and carries a
// note. The map can be searched, folded to a level, narrowed to one branch,
// driven from the keyboard, told to follow the video as it plays, ticked off
// idea by idea, read as an outline, and exported as PNG, SVG, Markdown or
// OPML. While Claude is still writing it, it grows in front of you.
//
// markmap lessons that still apply:
//  - create() lays the tree out but never centres it, so fit() is required;
//  - fitting against a zero-width container burns in translate(NaN,NaN), so
//    fitting is polled until the card has a real width;
//  - a tree laid out while the tab is hidden measures every label as zero and
//    collapses to a point, so it is rebuilt when the tab comes back;
//  - markmap rewrites each node's class attribute on every render, so our
//    state lives in data-* attributes, re-applied after each render.

import { h, esc, fmt, debounce, normalizeText, ytUrl } from './util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PALETTES = {
  dark: ['#e2ff57', '#ff74dc', '#5eeaff', '#bda2ff', '#ffb85c', '#6dffb0', '#ff9a8b', '#8fc8ff'],
  light: ['#6d28d9', '#c0267a', '#0e7490', '#4d7c0f', '#c2410c', '#047857', '#be123c', '#1d4ed8'],
};
const ROOT_INK = { dark: '#ffffff', light: '#15121f' };
const instances = new Set();
const theme = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

/** Walk a {label, t, note, children} tree into an index keyed by path ids ("n", "n.0", "n.0.2"). */
function indexTree(tree) {
  const index = new Map();
  const order = [];
  const walk = (node, id, parentId, depth, branch) => {
    const kids = Array.isArray(node.children) ? node.children : [];
    const info = { id, node, parentId, depth, branch, childIds: [] };
    index.set(id, info);
    order.push(id);
    kids.forEach((child, i) => {
      const childId = `${id}.${i}`;
      info.childIds.push(childId);
      walk(child, childId, id, depth + 1, depth === 0 ? i : branch);
    });
  };
  if (tree && tree.label) walk(tree, 'n', null, 0, 0);
  const timeline = order
    .map((id, i) => ({ id, i, t: index.get(id).node.t }))
    .filter((x) => typeof x.t === 'number')
    .sort((a, b) => a.t - b.t || a.i - b.i);
  return { index, order, timeline };
}

export function createMindmap(host, opts = {}) {
  const o = {
    level: 2, showTimes: true, got: new Set(), title: 'Mindmap',
    onSelect() {}, onChange() {}, onNow() {}, onPlay: null,
    ...opts,
  };
  const s = {
    tree: null, index: new Map(), order: [], timeline: [],
    level: o.level, focusId: null, selectedId: null, nowId: null,
    userFold: new Map(), query: '', terms: [], matches: [], matchIndex: -1,
    got: o.got, showTimes: o.showTimes, follow: false,
    userMoved: false, streaming: false, fullscreen: false,
    mm: null, svg: null, live: new Map(), fitTimer: null, builtHidden: false, destroyed: false,
  };

  const hint = h('div', { class: 'mm-hint', 'aria-hidden': 'true' });
  const announcer = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  host.append(hint, announcer);

  // ─── data ───────────────────────────────────────────────────────────────
  function setTree(tree, { streaming = false } = {}) {
    s.tree = tree;
    s.streaming = streaming;
    Object.assign(s, indexTree(tree));
    if (s.selectedId && !s.index.has(s.selectedId)) s.selectedId = null;
    if (s.focusId && !s.index.has(s.focusId)) s.focusId = null;
    if (s.query) computeMatches();
    if (!s.mm && !mount()) return;
    render().then(() => { if (!s.userMoved) fitSoon(); });
  }

  const info = (id) => {
    const it = s.index.get(id);
    if (!it) return null;
    const path = [];
    for (let p = it.parentId; p; p = s.index.get(p).parentId) path.unshift({ id: p, label: s.index.get(p).node.label });
    const branch = subtreeIds(id);
    return {
      id, ...it.node, depth: it.depth, parentId: it.parentId, path,
      childCount: it.childIds.length,
      branchSize: branch.length,
      branchGot: branch.filter((x) => s.got.has(x)).length,
      got: s.got.has(id), folded: isFolded(id), focused: s.focusId === id,
    };
  };

  function subtreeIds(id) {
    const out = [];
    const walk = (x) => { out.push(x); (s.index.get(x)?.childIds || []).forEach(walk); };
    if (s.index.has(id)) walk(id);
    return out;
  }

  // ─── folding ────────────────────────────────────────────────────────────
  const rootId = () => (s.focusId && s.index.has(s.focusId) ? s.focusId : 'n');

  function isFolded(id) {
    const it = s.index.get(id);
    if (!it || !it.childIds.length) return false;
    if (s.userFold.has(id)) return s.userFold.get(id) === 1;
    const rel = it.depth - (s.index.get(rootId())?.depth || 0);
    return rel >= s.level;
  }

  function isVisible(id) {
    const root = rootId();
    let cur = s.index.get(id);
    if (!cur) return false;
    if (id === root) return true;
    for (let p = cur.parentId; p; p = s.index.get(p).parentId) {
      if (isFolded(p)) return false;
      if (p === root) return true;
    }
    return false;
  }

  function revealPath(id) {
    for (let p = s.index.get(id)?.parentId; p; p = s.index.get(p).parentId) s.userFold.set(p, 0);
    if (s.focusId && !subtreeIds(s.focusId).includes(id)) s.focusId = null;
  }

  const visibleAncestor = (id) => {
    let cur = id;
    while (cur && !isVisible(cur)) cur = s.index.get(cur)?.parentId;
    return cur;
  };

  // ─── markmap ────────────────────────────────────────────────────────────
  function mount() {
    const mk = window.markmap;
    if (!mk || !mk.Markmap) {
      host.querySelectorAll('.map-missing').forEach((n) => n.remove());
      host.prepend(h('div', { class: 'map-missing' }, 'The mindmap library didn’t load — check your connection and refresh. The outline view still works.'));
      return false;
    }
    if (s.mm) { try { s.mm.destroy(); } catch (e) { /* nothing to tear down */ } }
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'mm-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${o.title}. Select the map and use the arrow keys to move between ideas, or switch to the outline.`);
    const old = host.querySelector('svg.mm-svg');
    if (old) old.replaceWith(svg); else host.prepend(svg);
    s.svg = svg;

    const palette = PALETTES[theme()];
    const rootInk = ROOT_INK[theme()];
    const mm = mk.Markmap.create(svg, {
      autoFit: false,
      duration: 320,
      maxWidth: 270,
      paddingX: 10,
      spacingVertical: 9,
      spacingHorizontal: 64,
      initialExpandLevel: -1,
      fitRatio: 0.92,
      maxInitialScale: 1.35,
      color: (d) => (d.payload && d.payload.depth === 0 ? rootInk : palette[((d.payload && d.payload.branch) || 0) % palette.length]),
      lineWidth: (d) => [3.4, 2.6, 1.9, 1.5, 1.2][Math.min((d.payload && d.payload.depth) || 0, 4)],
    });
    s.mm = mm;

    // Our data-* flags survive markmap's re-renders; new nodes get them here.
    const renderData = mm.renderData.bind(mm);
    mm.renderData = (...args) => { const p = renderData(...args); refreshLive(); decorate(); return p; };
    // Folding by the circle: remember it, so the next data update keeps it.
    const handleClick = mm.handleClick;
    mm.handleClick = (e, d) => {
      handleClick(e, d);
      if (d && d.payload) s.userFold.set(d.payload.id, d.payload.fold ? 1 : 0);
      o.onChange();
    };
    // Plain scrolling scrolls the page; ctrl/⌘ + scroll (or a pinch) zooms. In fullscreen, scrolling zooms.
    mm.svg.on('wheel', null);
    mm.zoom.filter((e) => (e.type === 'wheel' ? (s.fullscreen || e.ctrlKey || e.metaKey) : !e.ctrlKey && !e.button));
    mm.zoom.on('zoom.yapmap', (e) => { if (e.sourceEvent) s.userMoved = true; });
    svg.addEventListener('wheel', onWheelHint, { passive: true });
    svg.addEventListener('click', onClick);
    svg.addEventListener('dblclick', onDblClick, true);

    s.builtHidden = document.hidden;
    return true;
  }

  function buildData(id) {
    const it = s.index.get(id);
    const n = it.node;
    const time = s.showTimes && typeof n.t === 'number' && it.depth > 0 ? `<span class="mm-t">${fmt(n.t)}</span>` : '';
    return {
      content: `<span class="mm-l">${esc(n.label)}</span>${time}`,
      children: it.childIds.map(buildData),
      payload: { id, fold: isFolded(id) ? 1 : 0, branch: it.branch, depth: it.depth },
    };
  }

  async function render() {
    if (!s.mm || !s.index.size) return;
    await s.mm.setData(buildData(rootId()));
    decorate();
  }

  function refreshLive() {
    s.live.clear();
    const walk = (d) => { if (d && d.payload) { s.live.set(d.payload.id, d); (d.children || []).forEach(walk); } };
    walk(s.mm && s.mm.state && s.mm.state.data);
  }

  function decorate() {
    if (!s.svg) return;
    const matches = new Set(s.matches);
    const current = s.matches[s.matchIndex];
    const now = s.nowId ? visibleAncestor(s.nowId) : null;
    s.svg.querySelectorAll('g.markmap-node').forEach((g) => {
      const d = g.__data__;
      if (!d || !d.payload) return;
      const id = d.payload.id;
      const node = s.index.get(id);
      flag(g, 'sel', id === s.selectedId);
      flag(g, 'got', s.got.has(id));
      flag(g, 'now', id === now);
      flag(g, 'match', matches.has(id));
      flag(g, 'current', id === current);
      flag(g, 'dim', !!s.query && s.matches.length > 0 && !matches.has(id));
      flag(g, 'note', !!(node && node.node.note));
      flag(g, 'root', d.payload.depth === 0);
    });
  }
  const flag = (el, name, on) => { if (on) el.setAttribute('data-' + name, ''); else el.removeAttribute('data-' + name); };

  // ─── fitting ────────────────────────────────────────────────────────────
  function fitSoon() {
    clearInterval(s.fitTimer);
    let tries = 0;
    s.fitTimer = setInterval(() => {
      tries += 1;
      if (!s.mm || !s.svg || !s.svg.isConnected || tries > 40) { clearInterval(s.fitTimer); return; }
      if (s.svg.getBoundingClientRect().width < 50) return;
      try { s.mm.fit(); } catch (e) { /* not measured yet -- next tick */ }
      const g = s.svg.querySelector(':scope > g');
      const m = g && (g.getAttribute('transform') || '').match(/scale\(([-\d.e+]+)\)/i);
      const scale = m ? parseFloat(m[1]) : 0;
      if (Number.isFinite(scale) && scale > 0.01 && tries >= 3) clearInterval(s.fitTimer);
    }, 120);
  }

  function fit() { s.userMoved = false; fitSoon(); }

  function zoom(dir) {
    if (!s.mm) return;
    s.userMoved = true;
    s.mm.rescale(dir > 0 ? 1.25 : 0.8);
  }

  function ensureVisible(id) {
    const live = s.live.get(visibleAncestor(id));
    if (!live || !s.mm) return;
    // On phones the inspector is a sheet over the bottom of the map: keep the node above it.
    const sheet = host.closest('.map-stage')?.querySelector('.inspector:not([hidden])');
    const covered = sheet && getComputedStyle(sheet).position === 'absolute' ? sheet.offsetHeight : 0;
    try { s.mm.ensureVisible(live, { left: 40, right: 40, top: 40, bottom: covered + 40 }); } catch (e) { /* not laid out yet */ }
  }

  // ─── selection, interaction ─────────────────────────────────────────────
  async function select(id, { center = true, via = 'api' } = {}) {
    if (id && !s.index.has(id)) id = null;
    s.selectedId = id;
    if (id && !isVisible(id)) { revealPath(id); await render(); }
    decorate();
    if (id && center) ensureVisible(id);
    const it = id ? info(id) : null;
    if (it) announcer.textContent = `${it.label}${typeof it.t === 'number' ? ', at ' + fmt(it.t) : ''}${it.childCount ? `, ${it.childCount} ideas inside` : ''}${it.got ? ', got it' : ''}`;
    o.onSelect(it, via);
  }

  function onClick(e) {
    if (e.target.closest('circle')) return;
    const g = e.target.closest('g.markmap-node');
    if (!g) { if (s.selectedId) select(null); return; }
    const d = g.__data__;
    if (d && d.payload) select(d.payload.id, { center: false, via: 'click' });
  }

  function onDblClick(e) {
    const g = e.target.closest('g.markmap-node');
    if (!g) return;
    e.stopPropagation();
    e.preventDefault();
    const d = g.__data__;
    if (d && d.payload) toggleFold(d.payload.id);
  }

  let hintTimer;
  function onWheelHint(e) {
    if (s.fullscreen || e.ctrlKey || e.metaKey) return;
    hint.textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? 'hold ⌘ and scroll to zoom · or use + and −' : 'hold ctrl and scroll to zoom · or use + and −';
    hint.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.remove('show'), 1300);
  }

  function toggleFold(id) {
    const live = s.live.get(id);
    const it = s.index.get(id);
    if (!it || !it.childIds.length) return;
    const folded = isFolded(id);
    s.userFold.set(id, folded ? 0 : 1);
    if (live && s.mm) s.mm.toggleNode(live); else render();
    o.onChange();
  }

  function setLevel(level) {
    s.level = level;
    s.userFold.clear();
    if (s.selectedId && !isVisible(s.selectedId)) revealPath(s.selectedId);
    render().then(fit);
    o.onChange();
  }

  function focus(id) {
    s.focusId = id && id !== 'n' ? id : null;
    render().then(fit);
    o.onChange();
    if (s.selectedId) o.onSelect(info(s.selectedId));
  }

  function setGot(id, on, { branch = false } = {}) {
    const ids = branch ? subtreeIds(id) : [id];
    ids.forEach((x) => (on ? s.got.add(x) : s.got.delete(x)));
    decorate();
    o.onChange();
    if (s.selectedId) o.onSelect(info(s.selectedId));
  }

  function computeMatches() {
    s.terms = normalizeText(s.query).split(/\s+/).filter(Boolean);
    s.matches = s.terms.length
      ? s.order.filter((id) => {
        const n = s.index.get(id).node;
        const text = normalizeText(`${n.label} ${n.note || ''}`);
        return s.terms.every((t) => text.includes(t));
      })
      : [];
    if (s.matchIndex >= s.matches.length) s.matchIndex = s.matches.length ? 0 : -1;
  }

  async function search(query) {
    s.query = query.trim();
    s.matchIndex = -1;
    computeMatches();
    if (!s.matches.length) { decorate(); return { count: 0, index: -1 }; }
    s.matchIndex = 0;
    s.matches.forEach(revealPath);
    // The count is known now; unfolding and centring can finish in their own time.
    render().then(() => select(s.matches[0]));
    return { count: s.matches.length, index: 0 };
  }

  async function searchStep(dir) {
    if (!s.matches.length) return { count: 0, index: -1 };
    s.matchIndex = (s.matchIndex + dir + s.matches.length) % s.matches.length;
    await select(s.matches[s.matchIndex]);
    return { count: s.matches.length, index: s.matchIndex };
  }

  // ─── following the video ────────────────────────────────────────────────
  function setNow(t) {
    let best = null;
    for (const x of s.timeline) { if (x.t <= t + 0.5) best = x.id; else break; }
    if (best === s.nowId) return;
    s.nowId = best;
    if (s.follow && best) {
      if (!isVisible(best)) { revealPath(best); render().then(() => ensureVisible(best)); } else ensureVisible(best);
    }
    decorate();
    o.onNow(best ? info(best) : null);
  }

  function clearNow() {
    if (!s.nowId) return;
    s.nowId = null;
    decorate();
    o.onNow(null);
  }

  // ─── keyboard ───────────────────────────────────────────────────────────
  function onKey(e) {
    if (e.target !== host) return;
    const sel = s.selectedId && s.index.get(s.selectedId);
    const key = e.key;
    const go = (id) => { if (id) { e.preventDefault(); select(id, { via: 'key' }); } };
    if (key === 'ArrowRight') {
      if (!sel) return go(rootId());
      if (sel.childIds.length) {
        e.preventDefault();
        if (isFolded(sel.id)) toggleFold(sel.id); else select(sel.childIds[0]);
      }
    } else if (key === 'ArrowLeft') {
      if (!sel) return go(rootId());
      if (sel.id !== rootId()) go(sel.parentId);
    } else if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (!sel) return go(rootId());
      const dir = key === 'ArrowDown' ? 1 : -1;
      const siblings = sel.parentId ? s.index.get(sel.parentId).childIds : [];
      const next = siblings[siblings.indexOf(sel.id) + dir];
      if (next) return go(next);
      const inView = new Set(subtreeIds(rootId()));
      const visible = s.order.filter((id) => inView.has(id) && isVisible(id));
      go(visible[visible.indexOf(sel.id) + dir]);
    } else if (key === 'Home') {
      go(rootId());
    } else if (key === 'Enter' && sel) {
      e.preventDefault();
      if (typeof sel.node.t === 'number' && o.onPlay) o.onPlay(info(sel.id));
    } else if (key === ' ' && sel) {
      e.preventDefault();
      toggleFold(sel.id);
    } else if ((key === 'g' || key === 'G') && sel) {
      e.preventDefault();
      setGot(sel.id, !s.got.has(sel.id));
    } else if ((key === 'f' || key === 'F') && sel) {
      e.preventDefault();
      focus(s.focusId === sel.id ? null : sel.id);
    } else if (key === '+' || key === '=') {
      e.preventDefault();
      zoom(1);
    } else if (key === '-' || key === '_') {
      e.preventDefault();
      zoom(-1);
    } else if (key === '0') {
      e.preventDefault();
      fit();
    } else if (key === 'Escape') {
      if (s.selectedId) { e.preventDefault(); select(null); }
    }
  }
  host.addEventListener('keydown', onKey);

  // ─── export ─────────────────────────────────────────────────────────────
  const STYLE_PROPS = ['color', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'background-color',
    'border-radius', 'padding', 'margin-left', 'white-space', 'overflow-wrap', 'word-break', 'display', 'opacity',
    'text-decoration-line', 'text-align', 'width', 'box-sizing'];

  // The export carries its own fonts. Without them the labels reflow in a
  // fallback font and stop lining up with the branches drawn for them.
  let fontData = null;
  const base64Of = async (url) => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  async function embeddedFonts() {
    if (fontData !== null) return fontData;
    const faces = [];
    try {
      faces.push(`@font-face{font-family:'Luckiest Guy';src:url(data:font/ttf;base64,${await base64Of('static/fonts/LuckiestGuy-Regular.ttf')}) format('truetype')}`);
    } catch (e) { /* the root label falls back */ }
    try {
      // The Latin cuts of the page's own Google Fonts: the map's labels and timestamps.
      const link = document.querySelector('link[href*="fonts.googleapis.com/css2"]');
      const css = link ? await (await fetch(link.href)).text() : '';
      const blocks = css.split('@font-face').slice(1).map((b) => '@font-face' + b.slice(0, b.indexOf('}') + 1));
      const cache = new Map();
      for (const block of blocks) {
        if (!/Space Grotesk|JetBrains Mono/.test(block) || !/U\+0000-00FF/.test(block)) continue;
        const url = (block.match(/url\((https:[^)]+)\)/) || [])[1];
        if (!url) continue;
        if (!cache.has(url)) cache.set(url, await base64Of(url));
        faces.push(block.replace(url, `data:font/woff2;base64,${cache.get(url)}`));
      }
    } catch (e) { /* offline: the labels fall back to a system font */ }
    fontData = faces.join('\n');
    return fontData;
  }

  async function exportSvg() {
    if (!s.svg) throw new Error('no map to export');
    const g = s.svg.querySelector(':scope > g');
    const box = g.getBBox();
    const pad = 36;
    const clone = s.svg.cloneNode(true);
    clone.setAttribute('xmlns', SVG_NS);
    clone.setAttribute('width', Math.ceil(box.width + pad * 2));
    clone.setAttribute('height', Math.ceil(box.height + pad * 2));
    clone.setAttribute('viewBox', `${box.x - pad} ${box.y - pad} ${box.width + pad * 2} ${box.height + pad * 2}`);
    clone.removeAttribute('style');
    clone.querySelector(':scope > g').removeAttribute('transform');

    const liveEls = s.svg.querySelectorAll('.markmap-foreign div, .markmap-foreign span');
    const cloneEls = clone.querySelectorAll('.markmap-foreign div, .markmap-foreign span');
    liveEls.forEach((el, i) => {
      const cs = getComputedStyle(el);
      cloneEls[i].setAttribute('style', STYLE_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';'));
    });
    const liveShapes = s.svg.querySelectorAll('line, path, circle');
    const cloneShapes = clone.querySelectorAll('line, path, circle');
    liveShapes.forEach((el, i) => {
      const cs = getComputedStyle(el);
      cloneShapes[i].setAttribute('stroke', cs.stroke);
      cloneShapes[i].setAttribute('fill', cs.fill);
      cloneShapes[i].setAttribute('stroke-width', cs.strokeWidth);
    });
    clone.querySelectorAll('.markmap-foreign').forEach((fo) => { fo.style.opacity = '1'; });

    const bg = getComputedStyle(host).backgroundColor || '#ffffff';
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', box.x - pad);
    rect.setAttribute('y', box.y - pad);
    rect.setAttribute('width', box.width + pad * 2);
    rect.setAttribute('height', box.height + pad * 2);
    rect.setAttribute('fill', bg);
    clone.insertBefore(rect, clone.firstChild);
    const style = document.createElementNS(SVG_NS, 'style');
    style.textContent = await embeddedFonts();
    clone.insertBefore(style, clone.firstChild);
    return { text: new XMLSerializer().serializeToString(clone), width: box.width + pad * 2, height: box.height + pad * 2 };
  }

  async function exportPng() {
    const { text, width, height } = await exportSvg();
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
    await img.decode();
    const scale = Math.min(3, Math.max(1.5, 3200 / Math.max(width, height)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png'));
  }

  // ─── lifecycle ──────────────────────────────────────────────────────────
  const inst = {
    rebuild() { if (mount()) render().then(fitSoon); },
    refit() { if (!s.userMoved) fitSoon(); },
    visible() { if (s.builtHidden) inst.rebuild(); else if (!s.userMoved) fitSoon(); },
  };
  instances.add(inst);

  return {
    setTree,
    select,
    selected: () => s.selectedId,
    node: info,
    tree: () => s.tree,
    ids: () => s.order,
    subtreeIds,
    toggleFold,
    setLevel,
    level: () => s.level,
    focus,
    focused: () => s.focusId,
    search,
    searchStep,
    matches: () => ({ count: s.matches.length, index: s.matchIndex }),
    setGot,
    isGot: (id) => s.got.has(id),
    gotCount: () => s.order.filter((id) => id !== 'n' && s.got.has(id)).length,
    total: () => Math.max(0, s.order.length - 1),
    setNow,
    clearNow,
    now: () => s.nowId,
    setFollow(on) { s.follow = on; if (on && s.nowId) { revealPath(s.nowId); render().then(() => ensureVisible(s.nowId)); } },
    setShowTimes(on) { s.showTimes = on; render(); },
    setFullscreen(on) { s.fullscreen = on; setTimeout(fit, 60); },
    rebuild() { inst.rebuild(); },
    fit,
    zoom,
    exportSvg,
    exportPng,
    destroy() {
      s.destroyed = true;
      clearInterval(s.fitTimer);
      host.removeEventListener('keydown', onKey);
      try { if (s.mm) s.mm.destroy(); } catch (e) { /* nothing to tear down */ }
      instances.delete(inst);
    },
  };
}

window.addEventListener('resize', debounce(() => instances.forEach((i) => i.refit()), 200));
document.addEventListener('visibilitychange', () => { if (!document.hidden) instances.forEach((i) => i.visible()); });
// Branch colours are baked in at build time, so a theme switch rebuilds.
document.addEventListener('yapmap:theme', () => instances.forEach((i) => i.rebuild()));

// ─── text exports (work without the map on screen) ───────────────────────
export function treeMarkdown(tree, videoId, { depth = 0 } = {}) {
  const lines = [];
  const walk = (node, d) => {
    const time = typeof node.t === 'number' ? ` [${fmt(node.t)}](${ytUrl(videoId, node.t)})` : '';
    const note = node.note ? ` — ${node.note}` : '';
    if (d === 0) lines.push(`# ${node.label}${time}`, '', node.note ? `> ${node.note}` : null, node.note ? '' : null);
    else lines.push(`${'  '.repeat(d - 1)}- **${node.label}**${note}${time}`);
    (node.children || []).forEach((c) => walk(c, d + 1));
  };
  if (tree) walk(tree, depth);
  return lines.filter((l) => l !== null).join('\n');
}

export function treeOpml(tree, videoId, title) {
  const attr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
  const walk = (node, pad) => {
    const bits = [`text="${attr(node.label)}"`];
    if (node.note) bits.push(`_note="${attr(node.note)}"`);
    if (typeof node.t === 'number') bits.push(`url="${attr(ytUrl(videoId, node.t))}"`, `time="${fmt(node.t)}"`);
    const kids = node.children || [];
    if (!kids.length) return `${pad}<outline ${bits.join(' ')}/>`;
    return `${pad}<outline ${bits.join(' ')}>\n${kids.map((k) => walk(k, pad + '  ')).join('\n')}\n${pad}</outline>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>${attr(title)}</title></head>\n  <body>\n${tree ? walk(tree, '    ') : ''}\n  </body>\n</opml>\n`;
}

/** Count every idea below the root. */
export function countIdeas(tree) {
  let n = 0;
  const walk = (node) => { (node.children || []).forEach((c) => { n += 1; walk(c); }); };
  if (tree) walk(tree);
  return n;
}
