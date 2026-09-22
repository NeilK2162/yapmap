// Long work -- a canvas, a beef, a purge, an answer -- runs on the server as
// a job and streams its progress here. Jobs outlive the page that started
// them: leave while a canvas cooks and it keeps going, the nav shows it, and
// coming back picks the stream up where it is.

import { api, isStatic, NeedsInstall } from './api.js';

const jobs = new Map();
const watchers = new Set();
const TERMINAL = new Set(['done', 'error', 'cancelled', 'lost']);

export async function startJob(kind, body) {
  if (isStatic()) throw new NeedsInstall(kind === 'ask' ? 'Asking a video' : 'Making something new');
  const res = await api('api/jobs', { method: 'POST', body: { kind, ...body } });
  return attach(res.job);
}

function attach(summary) {
  let rec = jobs.get(summary.id);
  if (rec) return rec;
  rec = {
    ...summary,
    events: [],
    latest: {},        // the newest partial of each field still being written, plus progress
    completed: new Set(),
    subs: new Set(),
    result: null,
    es: null,
  };
  jobs.set(rec.id, rec);
  connect(rec);
  notify();
  return rec;
}

function connect(rec) {
  const es = new EventSource(`api/jobs/${rec.id}/events`);
  rec.es = es;
  es.onmessage = (e) => {
    let evt;
    try { evt = JSON.parse(e.data); } catch (err) { return; }
    handle(rec, evt);
  };
  es.onerror = () => {
    // A dropped connection reconnects by itself and resumes from the last
    // event. A closed one means the job is gone -- the server restarted.
    if (es.readyState === EventSource.CLOSED && rec.status === 'running') {
      handle(rec, { type: 'lost', message: 'Lost touch with the server — it may have restarted. Nothing is running any more.' });
    }
  };
}

function handle(rec, evt) {
  if (evt.type === 'partial') {
    if (rec.completed.has(evt.key)) return;
    rec.latest[evt.key] = evt;
  } else if (evt.type === 'progress') {
    rec.latest._progress = evt;
  } else {
    rec.events.push(evt);
    if (evt.type === 'field') { rec.completed.add(evt.key); delete rec.latest[evt.key]; }
    if (evt.type === 'stage') rec.stage = evt.stage;
    if (evt.type === 'meta' && evt.title) rec.title = evt.title;
    if (TERMINAL.has(evt.type)) {
      rec.status = evt.type === 'done' ? 'done' : evt.type;
      if (evt.type === 'done') rec.result = evt.result;
      delete rec.latest._progress;
      if (rec.es) rec.es.close();
      document.dispatchEvent(new CustomEvent('yapmap:jobend', { detail: rec }));
    }
  }
  rec.subs.forEach((fn) => { try { fn(evt, rec); } catch (err) { console.error(err); } });
  notify();
}

/** Hear everything so far (in order), then everything new. Returns an unsubscribe. */
export function subscribe(rec, fn) {
  rec.events.forEach((evt) => fn(evt, rec));
  Object.values(rec.latest).forEach((evt) => fn(evt, rec));
  rec.subs.add(fn);
  return () => rec.subs.delete(fn);
}

export async function cancelJob(rec) {
  if (rec.status !== 'running') return;
  try { await api('api/jobs/' + rec.id, { method: 'DELETE' }); } catch (e) { /* already over */ }
}

export const runningJobs = () => [...jobs.values()].filter((r) => r.status === 'running' && r.kind !== 'ask');

/** Reattach to anything still cooking on the server -- after a reload, say. */
export async function resumeJobs() {
  if (isStatic()) return;
  try {
    const { jobs: list } = await api('api/jobs');
    list.filter((j) => j.status === 'running').forEach(attach);
  } catch (e) { /* the server will say so elsewhere */ }
}

export function findRunning(kind, match) {
  return [...jobs.values()].find((r) => r.kind === kind && r.status === 'running' && match(r.params || {}));
}

export function onJobsChange(fn) {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

// Batched, but on a timer rather than an animation frame: frames stop in a
// background tab, and the nav should still know a job finished.
let pending = false;
function notify() {
  if (pending) return;
  pending = true;
  setTimeout(() => { pending = false; watchers.forEach((fn) => fn()); }, 60);
}

export function jobHref(rec) {
  const p = rec.params || {};
  if (rec.kind === 'canvas') return `#/v/${p.video_id}` + (p.lang && p.lang !== 'en' ? `?lang=${p.lang}` : '');
  if (rec.kind === 'beef') return `#/beef/${p.a}/${p.b}`;
  if (rec.kind === 'purge') return '#/purge';
  return '#/';
}
