// Cook-along timers. They live outside any one view so the pasta keeps
// counting down while you wander off to another tool.

import { h, fmt, toast } from './util.js';

const timers = new Map();
let ticker = null;
let audio = null;

export function startTimer(label, seconds) {
  const id = Math.random().toString(36).slice(2);
  timers.set(id, { label, end: Date.now() + seconds * 1000, done: false });
  // The AudioContext has to be created inside a click, or the browser mutes
  // the beep that plays minutes later.
  try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; }
  if (!ticker) ticker = setInterval(render, 500);
  render();
  toast(`timer on — ${fmt(seconds)}`);
}

function render() {
  const tray = document.getElementById('timers');
  if (!tray) return;
  if (!timers.size) {
    tray.hidden = true;
    clearInterval(ticker);
    ticker = null;
    return;
  }
  tray.hidden = false;
  tray.replaceChildren(...[...timers].map(([id, tm]) => {
    const left = Math.max(0, Math.round((tm.end - Date.now()) / 1000));
    if (left === 0 && !tm.done) { tm.done = true; ring(tm.label); }
    return h('div', { class: 'timer' + (tm.done ? ' ring' : '') },
      h('span', { class: 'tm-left' }, tm.done ? 'done!' : fmt(left)),
      h('span', { class: 'tm-label' }, tm.label),
      h('button', { class: 'icon-btn', 'aria-label': 'Dismiss timer', onclick: () => { timers.delete(id); render(); } }, '✕'),
    );
  }));
}

function ring(label) {
  toast('⏰ time! ' + label);
  if (!audio) return;
  try {
    const now = audio.currentTime;
    [0, 0.35, 0.7].forEach((offset) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.28);
      osc.connect(gain).connect(audio.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.3);
    });
  } catch (e) { /* no sound, the toast still shows */ }
}
