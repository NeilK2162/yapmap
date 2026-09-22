// 1080×1920 PNGs drawn on a <canvas> -- the size Instagram and TikTok stories
// want. Always in the brand's dark look, whatever theme the app is in: the
// card is an ad for yapmap, so it should look the same everywhere it lands.

const W = 1080;
const H = 1920;
const NOTE_COLORS = { quote: '#ff9ae0', aha: '#e8ff7a', warning: '#ffc98a', stat: '#8bf0ff', tip: '#d0c0ff' };

async function loadFonts() {
  try {
    await Promise.all([
      document.fonts.load('96px "Luckiest Guy"'),
      document.fonts.load('600 56px "Space Grotesk"'),
      document.fonts.load('700 56px "Space Grotesk"'),
      document.fonts.load('500 30px "JetBrains Mono"'),
    ]);
  } catch (e) { /* fall back to whatever loaded */ }
}

function wrap(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = word; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function blob(ctx, x, y, r, color) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

function backdrop(ctx) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1b0f3a');
  g.addColorStop(0.5, '#0d0d18');
  g.addColorStop(1, '#062634');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  blob(ctx, 170, 250, 560, 'rgba(124,58,237,0.55)');
  blob(ctx, 980, 980, 480, 'rgba(8,145,178,0.45)');
  blob(ctx, 280, 1780, 520, 'rgba(163,230,53,0.22)');
}

function wordmark(ctx, x, y, size) {
  ctx.font = `${size}px "Luckiest Guy", "Space Grotesk", sans-serif`;
  const w = ctx.measureText('yapmap').width;
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, '#e2ff57');
  g.addColorStop(0.5, '#5eeaff');
  g.addColorStop(1, '#ff74dc');
  ctx.fillStyle = g;
  ctx.fillText('yapmap', x, y);
  return w;
}

function spaced(ctx, px) {
  if ('letterSpacing' in ctx) ctx.letterSpacing = px;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fmt(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

function header(ctx) {
  ctx.textBaseline = 'alphabetic';
  spaced(ctx, '0px');
  wordmark(ctx, 90, 210, 104);
  ctx.font = '500 30px "JetBrains Mono", monospace';
  ctx.fillStyle = '#b9b7d4';
  spaced(ctx, '2px');
  ctx.fillText('turn the yap into a map', 96, 268);
  spaced(ctx, '0px');
}

function footer(ctx) {
  ctx.font = '500 26px "JetBrains Mono", monospace';
  ctx.fillStyle = '#8482a8';
  spaced(ctx, '2px');
  ctx.fillText('made with yapmap · powered by Claude', 96, H - 110);
  spaced(ctx, '0px');
}

const toBlob = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));

/** A sticky note as a story. */
export async function stickyCard({ text, kind, kindLabel, t, headline, channel }) {
  await loadFonts();
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  backdrop(ctx);
  header(ctx);

  const nx = 110, nw = 860, pad = 64;
  let size = 64, lines = [];
  for (; size >= 34; size -= 4) {
    ctx.font = `600 ${size}px "Space Grotesk", sans-serif`;
    lines = wrap(ctx, kind === 'quote' ? `“${text}”` : text, nw - pad * 2);
    if (lines.length * size * 1.3 <= 780) break;
  }
  const lh = size * 1.3;
  const nh = 130 + lines.length * lh + (t != null ? 150 : 70);

  // Centre the note + caption between the header and footer, so a one-line
  // quote doesn't leave the bottom third of the story empty.
  ctx.font = '700 46px "Space Grotesk", sans-serif';
  const captionLines = wrap(ctx, headline || '', 900).slice(0, 3);
  const captionH = 170 + captionLines.length * 60 + (channel ? 40 : 0);
  const top = 360, bottom = H - 190;
  const ny = Math.max(top, top + (bottom - top - (nh + captionH)) / 2);

  ctx.save();
  ctx.translate(nx + nw / 2, ny + nh / 2);
  ctx.rotate(-0.035);
  ctx.translate(-(nx + nw / 2), -(ny + nh / 2));
  ctx.shadowColor = 'rgba(0,0,0,.5)';
  ctx.shadowBlur = 50;
  ctx.shadowOffsetX = 16;
  ctx.shadowOffsetY = 24;
  ctx.fillStyle = NOTE_COLORS[kind] || '#e8ff7a';
  ctx.fillRect(nx, ny, nw, nh);
  ctx.shadowColor = 'transparent';

  ctx.save();
  ctx.translate(nx + nw / 2, ny);
  ctx.rotate(-0.05);
  ctx.fillStyle = 'rgba(255,255,255,.42)';
  ctx.fillRect(-100, -26, 200, 52);
  ctx.restore();

  ctx.fillStyle = 'rgba(18,18,26,.6)';
  ctx.font = '600 28px "JetBrains Mono", monospace';
  spaced(ctx, '6px');
  ctx.fillText(String(kindLabel || kind).toUpperCase(), nx + pad, ny + 100);
  spaced(ctx, '0px');

  ctx.fillStyle = '#12121a';
  ctx.font = `600 ${size}px "Space Grotesk", sans-serif`;
  lines.forEach((line, i) => ctx.fillText(line, nx + pad, ny + 130 + (i + 1) * lh - lh * 0.22));

  if (t != null) {
    const py = ny + nh - 110;
    ctx.fillStyle = 'rgba(0,0,0,.14)';
    roundRect(ctx, nx + pad, py, 250, 64, 14);
    ctx.fill();
    ctx.fillStyle = '#12121a';
    ctx.font = '600 32px "JetBrains Mono", monospace';
    ctx.fillText('▶ ' + fmt(t), nx + pad + 26, py + 43);
  }
  ctx.restore();

  let y = ny + nh + 170;
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 46px "Space Grotesk", sans-serif';
  for (const line of captionLines) { ctx.fillText(line, 96, y); y += 60; }
  if (channel) {
    ctx.fillStyle = '#b9b7d4';
    ctx.font = '500 30px "JetBrains Mono", monospace';
    ctx.fillText(channel, 96, y + 16);
  }
  footer(ctx);
  return toBlob(canvas);
}

/** A month of yapmap, as a story. */
export async function wrappedCard({ monthLabel, persona, tiles, quote }) {
  await loadFonts();
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  backdrop(ctx);
  header(ctx);

  ctx.fillStyle = '#e2ff57';
  ctx.font = '600 30px "JetBrains Mono", monospace';
  spaced(ctx, '6px');
  ctx.fillText('YAPMAP WRAPPED', 96, 400);
  spaced(ctx, '0px');
  ctx.fillStyle = '#ffffff';
  ctx.font = '96px "Luckiest Guy", sans-serif';
  let y = 510;
  for (const line of wrap(ctx, monthLabel, 900)) { ctx.fillText(line, 96, y); y += 100; }
  ctx.font = '600 42px "Space Grotesk", sans-serif';
  ctx.fillStyle = '#e7e5f7';
  ctx.fillText(persona, 96, y + 10);

  const top = y + 80, gap = 24, tw = (W - 192 - gap) / 2, th = 210;
  tiles.slice(0, 6).forEach((tile, i) => {
    const x = 96 + (i % 2) * (tw + gap);
    const ty = top + Math.floor(i / 2) * (th + gap);
    ctx.fillStyle = i === 0 ? '#e2ff57' : 'rgba(255,255,255,.08)';
    roundRect(ctx, x, ty, tw, th, 28);
    ctx.fill();
    ctx.fillStyle = i === 0 ? '#0a0a0a' : '#ffffff';
    ctx.font = '84px "Luckiest Guy", sans-serif';
    ctx.fillText(String(tile.value), x + 34, ty + 112);
    ctx.fillStyle = i === 0 ? 'rgba(10,10,10,.7)' : '#b9b7d4';
    ctx.font = '600 26px "JetBrains Mono", monospace';
    spaced(ctx, '3px');
    ctx.fillText(String(tile.label).toUpperCase(), x + 36, ty + 168);
    spaced(ctx, '0px');
  });

  if (quote && quote.text) {
    const qy = top + 3 * (th + gap) + 40;
    ctx.font = '600 40px "Space Grotesk", sans-serif';
    const lines = wrap(ctx, `“${quote.text}”`, 780).slice(0, 4);
    const qh = 90 + lines.length * 54;
    if (qy + qh < H - 170) {
      ctx.save();
      ctx.translate(540, qy + qh / 2);
      ctx.rotate(-0.02);
      ctx.translate(-540, -(qy + qh / 2));
      ctx.fillStyle = '#ff9ae0';
      ctx.fillRect(110, qy, 860, qh);
      ctx.fillStyle = '#12121a';
      ctx.font = '600 40px "Space Grotesk", sans-serif';
      lines.forEach((line, i) => ctx.fillText(line, 150, qy + 70 + i * 54));
      ctx.restore();
    }
  }
  footer(ctx);
  return toBlob(canvas);
}
