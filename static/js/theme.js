// Light / dark / follow-the-device. The choice is applied before first paint
// by an inline script in index.html; this module keeps it in sync afterwards.

const KEY = 'yapmap.theme';

export function themePref() {
  try { return localStorage.getItem(KEY) || 'system'; } catch (e) { return 'system'; }
}

const systemLight = () => !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
export const currentTheme = () => document.documentElement.getAttribute('data-theme') || 'dark';

function apply(theme, announce = true) {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#fbfaff' : '#0d0d18');
  const btn = document.getElementById('theme-btn');
  if (btn) {
    btn.textContent = theme === 'light' ? '☾' : '☀';
    btn.setAttribute('aria-label', theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
    btn.title = theme === 'light' ? 'dark mode' : 'light mode';
  }
  if (announce) document.dispatchEvent(new CustomEvent('yapmap:theme', { detail: theme }));
}

export function setThemePref(pref) {
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch (e) { /* storage blocked: the choice lasts this page view */ }
  apply(pref === 'system' ? (systemLight() ? 'light' : 'dark') : pref);
}

export function initTheme() {
  apply(currentTheme(), false);
  document.getElementById('theme-btn').addEventListener('click', () => {
    setThemePref(currentTheme() === 'light' ? 'dark' : 'light');
  });
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
      if (themePref() === 'system') apply(e.matches ? 'light' : 'dark');
    });
  }
}
