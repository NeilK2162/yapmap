// markmap, tamed. Every lesson from getting the first map to render lives here:
//  - create() lays the tree out but never centres it, so fit() is required;
//  - setData()'s promise only settles when d3 transitions finish, which never
//    happens in a background tab, so fit() is polled instead of chained;
//  - fitting against a zero-width container burns in translate(NaN,NaN), so
//    the poll waits for a real width;
//  - a tree laid out while the tab is hidden measures every label as zero and
//    collapses to a point, so it is rebuilt when the tab comes back;
//  - reusing an <svg> leaves the old instance's state attached, so every
//    build gets a brand-new one.

import { debounce } from './util.js';

const PALETTES = {
  dark: ['#e2ff57', '#ff74dc', '#5eeaff', '#bda2ff', '#ffb85c'],
  light: ['#7c3aed', '#db2777', '#0891b2', '#65a30d', '#ea580c'],
};

const instances = new Set();
const theme = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

export function createMap(card, markdown, { expandLevel = 2 } = {}) {
  const inst = { card, markdown, expandLevel, mm: null, fitTimer: null, builtHidden: false };
  instances.add(inst);
  build(inst);
  return {
    rebuild(level) { if (level !== undefined) inst.expandLevel = level; build(inst); },
    fit() { refit(inst); },
    destroy() {
      clearInterval(inst.fitTimer);
      try { if (inst.mm) inst.mm.destroy(); } catch (e) { /* nothing to tear down */ }
      instances.delete(inst);
    },
  };
}

function build(inst) {
  const mk = window.markmap;
  if (!mk || !mk.Transformer || !mk.Markmap) {
    inst.card.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'map-missing';
    msg.textContent = 'The mindmap library didn’t load — check your connection and refresh. Everything else on this page still works.';
    inst.card.appendChild(msg);
    return;
  }
  if (inst.mm) {
    try { inst.mm.destroy(); } catch (e) { /* older builds have no destroy */ }
    inst.mm = null;
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'map-svg');
  const old = inst.card.querySelector('svg.map-svg');
  if (old) old.replaceWith(svg); else inst.card.prepend(svg);

  const palette = PALETTES[theme()];
  const root = new mk.Transformer().transform(inst.markdown || '# —').root;
  inst.mm = mk.Markmap.create(svg, {
    color: (node) => palette[((node && node.state && node.state.depth) || 0) % palette.length],
    duration: 250,
    maxWidth: 320,
    paddingX: 18,
    spacingVertical: 9,
    initialExpandLevel: inst.expandLevel,
    fitRatio: 0.92,
  });
  inst.mm.setData(root);
  inst.builtHidden = document.hidden;
  refit(inst);
}

function refit(inst) {
  clearInterval(inst.fitTimer);
  let tries = 0;
  inst.fitTimer = setInterval(() => {
    tries += 1;
    const svg = inst.card.querySelector('svg.map-svg');
    if (!inst.mm || !svg || !svg.isConnected || tries > 40) { clearInterval(inst.fitTimer); return; }
    if (svg.getBoundingClientRect().width < 50) return;
    try { inst.mm.fit(); } catch (e) { /* not measured yet -- next tick */ }
    const g = svg.querySelector('g');
    const matched = g && (g.getAttribute('transform') || '').match(/scale\(([-\d.e+]+)\)/i);
    const scale = matched ? parseFloat(matched[1]) : 0;
    if (Number.isFinite(scale) && scale > 0.01 && tries >= 3) clearInterval(inst.fitTimer);
  }, 120);
}

window.addEventListener('resize', debounce(() => instances.forEach(refit), 200));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  instances.forEach((inst) => (inst.builtHidden ? build(inst) : refit(inst)));
});
// Branch colours are baked in at build time, so a theme switch rebuilds.
document.addEventListener('yapmap:theme', () => instances.forEach(build));
