// The index page's opening view (tools/website.py, ADR-0071): the still of the cover's model, the 3D page's own first
// picture of it (tools/poster3d.cjs), gives way to the 3D page's model (3d/?esittely) once the page has loaded and that
// page has drawn its first frame, from the same camera; then it turns round. Not for a reader who asks for less
// motion or to save data: the still stays.
const QUIET = '(prefers-reduced-motion: reduce)';
const FADE_MS = 600;   // the still's fade into the model (site.css's .malli transition)

function whenIdle(f) {
  const idle = window.requestIdleCallback ?? (g => setTimeout(g, 0));
  const start = () => idle(f);
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

// hero: the link round the still, its data-set the set's number; live: the site opened while the page was open
export function liven(hero, live) {
  if (live) document.body.classList.add('auki');
  if (!hero || matchMedia(QUIET).matches || navigator.connection?.saveData) return;
  whenIdle(() => {
    const frame = document.createElement('iframe');
    const query = new URLSearchParams(location.search);   // ?esikatselu and ?nyt go with it, for the lock's
    query.set('esittely', '');
    frame.src = `3d/?${query}#${hero.dataset.set}`;
    frame.title = '';
    frame.tabIndex = -1;
    frame.setAttribute('aria-hidden', 'true');
    window.addEventListener('message', e => {
      if (e.origin !== location.origin || e.source !== frame.contentWindow || e.data !== '3d:shown') return;
      hero.classList.add('elää');
      // once the still has faded into the model, the model turns round while it can be seen, and rests while not
      const say = word => frame.contentWindow.postMessage(word, location.origin);
      setTimeout(() => new IntersectionObserver(([seen]) => say(seen.isIntersecting ? 'turn' : 'pause')).observe(hero), FADE_MS);
    });
    hero.append(frame);
  });
}
