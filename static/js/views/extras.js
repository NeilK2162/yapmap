import { h, copy, lsGet } from '../util.js';
import { isStatic } from '../api.js';
import { setThemePref, themePref } from '../theme.js';

export function render(root, _params, _query, ctx) {
  const page = h('div', { class: 'page narrow' });
  root.append(page);

  const origin = location.origin + location.pathname.replace(/index\.html$/, '');
  // Opens yapmap with whatever YouTube video the current tab is on.
  const code = `javascript:(()=>{location.href=${JSON.stringify(origin)}+'?v='+encodeURIComponent(location.href)})()`;

  const themeSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Theme' });
  const paint = () => [...themeSeg.children].forEach((b) => {
    b.classList.toggle('on', b.dataset.pref === themePref());
    b.setAttribute('aria-checked', String(b.dataset.pref === themePref()));
  });
  [['system', 'match my device'], ['light', '☀ light'], ['dark', '☾ dark']].forEach(([pref, label]) =>
    themeSeg.append(h('button', { role: 'radio', 'data-pref': pref, onclick: () => { setThemePref(pref); paint(); } }, label)));
  paint();
  // The toggle in the top bar changes the theme too; keep this control honest.
  document.addEventListener('yapmap:theme', paint);
  ctx.onCleanup(() => document.removeEventListener('yapmap:theme', paint));

  page.append(
    h('div', { class: 'page-head' },
      h('span', { class: 'kicker' }, 'extras'),
      h('h1', null, 'the ', h('em', null, 'little things'), '.'),
      h('p', { class: 'sub' }, 'The one-click button, your theme, keyboard shortcuts, and exactly where your stuff lives.'),
    ),
    h('div', { class: 'extras-grid' },
      isStatic() ? h('div', { class: 'x-card', style: { borderColor: 'var(--violet)' } },
        h('h3', null, 'you’re in the demo gallery'),
        h('p', null, 'Everything here is real output, running in your browser with no server. Making new canvases, beefs and purges needs the local app — it runs on your own Claude subscription, no API key, and takes about five minutes to set up.'),
        h('ol', null,
          h('li', null, 'Install the Claude Code CLI: ', h('code', null, 'npm install -g @anthropic-ai/claude-code')),
          h('li', null, 'Sign in with your subscription: ', h('code', null, 'claude auth login')),
          h('li', null, 'Clone the repo, then ', h('code', null, 'pip install -r requirements.txt')),
          h('li', null, 'Run ', h('code', null, 'python app.py'), ' and open ', h('code', null, 'http://localhost:5000')),
        ),
        h('a', { class: 'ghost hot', href: 'https://github.com/NeilK2162/yapmap', target: '_blank', rel: 'noopener' }, 'get it on github ↗'),
      ) : null,

      h('div', { class: 'x-card' },
        h('h3', null, 'the one-click button'),
        h('p', null, isStatic()
          ? 'Once yapmap is running locally, this page (on your own machine) gives you a bookmark that maps whatever YouTube video you’re watching.'
          : 'Drag this to your bookmarks bar. On any YouTube video, click it — the video opens straight in yapmap.'),
        !isStatic() ? h('a', {
          class: 'bookmarklet', href: code, onclick: (e) => { e.preventDefault(); },
          title: 'Drag me to your bookmarks bar',
        }, '🗺️ map this') : null,
        !isStatic() ? h('p', { style: { marginTop: '14px', fontSize: '13px' } },
          'Can’t drag? Make a new bookmark by hand and paste this as its URL: ',
          h('button', { class: 'mini', onclick: () => copy(code, 'bookmark code copied ✓') }, 'copy the code')) : null,
      ),

      h('div', { class: 'x-card' },
        h('h3', null, 'theme'),
        h('p', null, 'Light, dark, or whatever your device is set to. The toggle in the top bar flips it too.'),
        themeSeg,
      ),

      h('div', { class: 'x-card' },
        h('h3', null, 'keyboard'),
        h('div', { class: 'kbd-list' },
          h('kbd', null, 'Esc'), h('span', null, 'close the player, the fullscreen map, or hands-free mode'),
          h('kbd', null, 'space'), h('span', null, 'flip a flashcard · play/pause during the no-yap cut'),
          h('kbd', null, '← →'), h('span', null, 'previous / next flashcard, cook-along step, or cut clip'),
          h('kbd', null, '1 · 2'), h('span', null, 'on a flipped flashcard: again · got it'),
        ),
      ),

      h('div', { class: 'x-card' },
        h('h3', null, 'where your stuff lives'),
        h('ul', null,
          h('li', null, h('code', null, '.cache/'), ' — every canvas, beef, purge and voice you’ve generated. Delete it to start fresh; regenerating costs Claude usage again.'),
          h('li', null, h('code', null, '.yapmap/'), ' — your commitments and the activity behind Wrapped. Separate on purpose, so clearing the cache never wipes your streak.'),
          h('li', null, 'Nothing is sent anywhere except the transcript to Claude, through the CLI you’re signed into.'),
        ),
        h('p', { style: { margin: 0, fontSize: '13px' } }, `This browser also remembers your ${lsGet('yapmap.recents', []).length} recent videos and your theme — that’s it.`),
      ),
    ),
  );
}
