// What you did on a canvas -- the findings you ticked, the pantry, the moves
// you finished, the claims you checked, the ideas you've got, which sections
// are open -- kept per video in this browser, so reopening it picks up where
// you left off. One key per video; nothing here is ever sent anywhere.

import { lsGet, lsSet, lsDel } from './util.js';

const cache = new Map();
const key = (videoId) => 'yapmap.ui.' + videoId;

export function uiState(videoId) {
  if (cache.has(videoId)) return cache.get(videoId);
  let data = lsGet(key(videoId), null);
  if (!data || typeof data !== 'object') {
    data = {};
    // Claims used to have a key of their own.
    const claims = lsGet('yapmap.claims.' + videoId, null);
    if (claims) {
      data.claims = claims;
      lsSet(key(videoId), data);
      lsDel('yapmap.claims.' + videoId);
    }
  }
  const state = {
    get(k, fallback) { return k in data ? data[k] : fallback; },
    set(k, value) { data[k] = value; lsSet(key(videoId), data); },
    /** A Set-valued entry, saved as an array. */
    set_(k) { return new Set(state.get(k, [])); },
    toggle(k, item) {
      const s = state.set_(k);
      if (s.has(item)) s.delete(item); else s.add(item);
      state.set(k, [...s]);
      return s.has(item);
    },
  };
  cache.set(videoId, state);
  return state;
}

export function forgetUiState(videoId) {
  cache.delete(videoId);
  lsDel(key(videoId));
  lsDel('yapmap.claims.' + videoId);
}
