// Commitments ("touch grass, for real") and activity events for Wrapped.
// The local app keeps them in .yapmap/ on disk; the static demo keeps them in
// the visitor's own browser so the feature still works there.

import { api, isStatic } from './api.js';
import { lsGet, lsSet } from './util.js';

const LS_COMMITS = 'yapmap.commitments';
const LS_EVENTS = 'yapmap.events';

export function streakOf(items) {
  const resolved = items
    .filter((c) => (c.status === 'done' || c.status === 'dropped') && c.resolved_at)
    .sort((a, b) => a.resolved_at.localeCompare(b.resolved_at));
  let run = 0, best = 0;
  for (const c of resolved) {
    if (c.status === 'done') { run += 1; best = Math.max(best, run); } else run = 0;
  }
  return {
    current: run,
    best,
    kept: items.filter((c) => c.status === 'done').length,
    dropped: items.filter((c) => c.status === 'dropped').length,
    open: items.filter((c) => c.status === 'open').length,
  };
}

const nowIso = () => new Date().toISOString();

export async function listCommitments() {
  if (isStatic()) {
    const items = lsGet(LS_COMMITS, []);
    return { items, streak: streakOf(items) };
  }
  return api('api/commitments');
}

export async function commit({ video_id, headline, action }) {
  if (isStatic()) {
    const items = lsGet(LS_COMMITS, []);
    const existing = items.find((c) => c.status === 'open' && c.action === action && c.video_id === video_id);
    if (existing) return existing;
    const c = {
      id: Math.random().toString(16).slice(2, 14), video_id, headline, action,
      status: 'open', created_at: nowIso(), resolved_at: null, snooze_until: null,
    };
    items.push(c);
    lsSet(LS_COMMITS, items);
    return c;
  }
  return api('api/commitments', { method: 'POST', body: { video_id, headline, action } });
}

export async function updateCommitment(id, patch) {
  if (isStatic()) {
    const items = lsGet(LS_COMMITS, []);
    const c = items.find((x) => x.id === id);
    if (!c) throw new Error("That commitment isn't around any more.");
    if (patch.status === 'done' || patch.status === 'dropped') Object.assign(c, { status: patch.status, resolved_at: nowIso(), snooze_until: null });
    if (patch.status === 'open') Object.assign(c, { status: 'open', resolved_at: null });
    if (patch.snooze_days) c.snooze_until = new Date(Date.now() + patch.snooze_days * 86400000).toISOString();
    lsSet(LS_COMMITS, items);
    return c;
  }
  return api('api/commitments/' + id, { method: 'PATCH', body: patch });
}

/** Fire-and-forget: Wrapped's numbers should never block or break the UI. */
export function logEvent(type, extra = {}) {
  if (isStatic()) {
    const events = lsGet(LS_EVENTS, []);
    events.push({ type, ...extra, at: nowIso() });
    lsSet(LS_EVENTS, events.slice(-2000));
    return;
  }
  api('api/events', { method: 'POST', body: { type, ...extra } }).catch(() => {});
}

export function localEvents() {
  return lsGet(LS_EVENTS, []);
}
