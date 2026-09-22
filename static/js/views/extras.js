import { h, copy, lsGet, lsSet, prefLang, setPrefLang, toast } from '../util.js';
import { isStatic, languages } from '../api.js';
import { setThemePref, themePref } from '../theme.js';

export function render(root, _params, _query, ctx) {
  const page = h('div', { class: 'page narrow' });
  root.append(page);

  const origin = location.origin + location.pathname.replace(/index\.html$/, '');
  // Opens yapmap with whatever YouTube video the current tab is on.
  const code = `javascript:(()=>{location.href=${JSON.stringify(origin)}+'?v='+encodeURIComponent(location.href)})()`;

  const radios = (label, options, current, onPick) => {
    const seg = h('div', { class: 'seg wrap', role: 'radiogroup', 'aria-label': label });
    const paint = (value) => [...seg.children].forEach((b) => {
      b.classList.toggle('on', b.dataset.v === value);
      b.setAttribute('aria-checked', String(b.dataset.v === value));
    });
    options.forEach(([value, text]) => seg.append(h('button', {
      type: 'button', role: 'radio', 'data-v': value, onclick: () => { onPick(value); paint(value); },
    }, text)));
    paint(current());
    seg.repaint = () => paint(current());
    return seg;
  };

  const themeSeg = radios('Theme', [['system', 'match my device'], ['light', '☀ light'], ['dark', '☾ dark']], themePref, setThemePref);
  // The toggle in the top bar changes the theme too; keep this control honest.
  document.addEventListener('yapmap:theme', themeSeg.repaint);
  ctx.onCleanup(() => document.removeEventListener('yapmap:theme', themeSeg.repaint));

  const langSeg = radios('Language Claude writes in', languages().map((l) => [l.code, l.label]), prefLang, (v) => {
    setPrefLang(v);
    toast(v === 'auto' ? 'new canvases will match each video’s language ✓' : 'new canvases will be written in that language ✓');
  });

  const callitSeg = radios('Call it before the tl;dr', [['on', 'ask me to guess'], ['off', 'skip the guessing']],
    () => lsGet('yapmap.callit', 'on'), (v) => lsSet('yapmap.callit', v));

  page.append(
    h('div', { class: 'page-head' },
      h('span', { class: 'kicker' }, 'extras'),
      h('h1', null, 'the ', h('em', null, 'little things'), '.'),
      h('p', { class: 'sub' }, 'The one-click button, the language Claude writes in, your theme, keyboard shortcuts, and exactly where your stuff lives.'),
    ),
    h('div', { class: 'extras-grid' },
      isStatic() ? h('section', { class: 'x-card accent-violet' },
        h('h2', null, 'you’re in the demo gallery'),
        h('p', null, 'Everything here is real output, running in your browser with no server. Making new canvases, asking questions, beefs and purges need the local app — it runs on your own Claude subscription, no API key, and takes about five minutes to set up.'),
        h('ol', null,
          h('li', null, 'Install the Claude Code CLI: ', h('code', null, 'npm install -g @anthropic-ai/claude-code')),
          h('li', null, 'Sign in with your subscription: ', h('code', null, 'claude auth login')),
          h('li', null, 'Clone the repo, then ', h('code', null, 'pip install -r requirements.txt')),
          h('li', null, 'Run ', h('code', null, 'python app.py'), ' and open ', h('code', null, 'http://localhost:5000')),
        ),
        h('a', { class: 'cta sm', href: 'https://github.com/NeilK2162/yapmap', target: '_blank', rel: 'noopener' }, 'get it on github ↗'),
      ) : null,

      h('section', { class: 'x-card' },
        h('h2', null, 'the one-click button'),
        h('p', null, isStatic()
          ? 'Once yapmap is running locally, this page (on your own machine) gives you a bookmark that maps whatever YouTube video you’re watching.'
          : 'Drag this to your bookmarks bar. On any YouTube video, click it — the video opens straight in yapmap.'),
        !isStatic() ? h('a', {
          class: 'bookmarklet', href: code, onclick: (e) => { e.preventDefault(); },
          title: 'Drag me to your bookmarks bar',
        }, '🗺️ map this') : null,
        !isStatic() ? h('p', { class: 'small' },
          'Can’t drag? Make a new bookmark by hand and paste this as its URL: ',
          h('button', { class: 'mini', type: 'button', onclick: () => copy(code, 'bookmark code copied ✓') }, 'copy the code')) : null,
      ),

      h('section', { class: 'x-card' },
        h('h2', null, 'the language Claude writes in'),
        h('p', null, 'For new canvases, answers, beefs and purges — whatever language the video is in. Hinglish is Hindi in the Latin alphabet, mixed with English. The app’s buttons stay English. A canvas can be remade in another language from its 🌐 menu.'),
        langSeg,
      ),

      h('section', { class: 'x-card' },
        h('h2', null, 'theme'),
        h('p', null, 'Light, dark, or whatever your device is set to. The toggle in the top bar flips it too.'),
        themeSeg,
      ),

      h('section', { class: 'x-card' },
        h('h2', null, 'call it'),
        h('p', null, 'While a new canvas cooks, yapmap asks you to guess the big idea and keeps the tl;dr blurred until you do. Guessing first — even wrong — makes the real answer stick.'),
        callitSeg,
      ),

      h('section', { class: 'x-card' },
        h('h2', null, 'keyboard'),
        h('h3', { class: 'x-sub' }, 'on the map'),
        h('div', { class: 'kbd-list' },
          h('kbd', null, '← → ↑ ↓'), h('span', null, 'move between ideas (click the map first)'),
          h('kbd', null, 'Enter'), h('span', null, 'play that moment'),
          h('kbd', null, 'Space'), h('span', null, 'fold or unfold a branch'),
          h('kbd', null, 'G'), h('span', null, 'mark an idea as got'),
          h('kbd', null, 'F'), h('span', null, 'focus on a branch · again for the whole map'),
          h('kbd', null, '+ − 0'), h('span', null, 'zoom in, out, fit · ctrl + scroll zooms too'),
        ),
        h('h3', { class: 'x-sub' }, 'everywhere else'),
        h('div', { class: 'kbd-list' },
          h('kbd', null, 'Esc'), h('span', null, 'close the player, the panel, fullscreen, or hands-free mode'),
          h('kbd', null, 'Space'), h('span', null, 'flip a flashcard · play/pause during the no-yap cut'),
          h('kbd', null, '← →'), h('span', null, 'previous / next flashcard, cook-along step, or cut clip'),
          h('kbd', null, '1 · 2'), h('span', null, 'on a flipped flashcard: again · got it'),
        ),
      ),

      h('section', { class: 'x-card' },
        h('h2', null, 'where your stuff lives'),
        h('ul', null,
          h('li', null, h('code', null, '.cache/'), ' — every canvas, transcript, answer, beef, purge and voice you’ve made. Delete it to start fresh; regenerating costs Claude usage again.'),
          h('li', null, h('code', null, '.yapmap/'), ' — your commitments, flashcard reviews and the activity behind Wrapped. Separate on purpose, so clearing the cache never wipes your streak or your deck.'),
          h('li', null, 'Nothing is sent anywhere except transcripts and your questions to Claude, through the CLI you’re signed into.'),
        ),
        h('p', { class: 'small' }, 'This browser also remembers your recent videos, your theme and language, and what you ticked on each canvas — that’s it.'),
      ),
    ),
  );
}
