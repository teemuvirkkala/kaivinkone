// The site stays shut until unlock.json's time (sets.UNLOCK, ADR-0061), showing a countdown. The time is the
// server's, from the Date header of the request for unlock.json, so a device's wrong clock opens nothing early.
// For testing: ?esikatselu opens everything on this device until ?esikatselu=pois; ?nyt=2026-12-24T00:00+02:00
// pretends it is that time.
const PREVIEW_KEY = 'kaivinkone-esikatselu';
const DAY_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 1000;
const ZONE = 'Europe/Helsinki';   // the site's readers' clock, for saying when it opens

function preview(params) {
  try {
    if (params.get('esikatselu') === 'pois') localStorage.removeItem(PREVIEW_KEY);
    else if (params.has('esikatselu')) localStorage.setItem(PREVIEW_KEY, '1');
    return localStorage.getItem(PREVIEW_KEY) === '1';
  } catch {
    return params.has('esikatselu') && params.get('esikatselu') !== 'pois';
  }
}

// {open, at, now()}: whether the site is open, when it opens and the time now, as the server keeps it. asked: the
// request for unlock.json, if the page has made it already
export async function lockState(asked = fetch(new URL('unlock.json', import.meta.url), { cache: 'no-store' })) {
  const params = new URLSearchParams(location.search);
  const response = await asked;
  const at = new Date((await response.json()).at);
  const pretend = params.has('nyt') ? new Date(params.get('nyt')) : null;
  const server = Date.parse(response.headers.get('Date'));
  const skew = pretend && !isNaN(pretend) ? pretend - Date.now()
             : isNaN(server) ? 0 : server - Date.now();
  const now = () => new Date(Date.now() + skew);
  return { open: preview(params) || now() >= at, at, now };
}

// The nights left as the back cover's panel says a word (website.py's countdown): the word turned up its side, the
// huge one, and the one after
function nights(ms) {
  const n = Math.ceil(ms / DAY_MS);
  return n === 1 ? { side: 'Enää', count: '1', word: 'yö!', said: 'Enää yksi yö!' }
                 : { side: 'Vielä', count: String(n), word: 'yötä!', said: `Vielä ${n} yötä!` };
}

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / TICK_MS));
  const pad = n => String(n).padStart(2, '0');
  const days = Math.floor(ms / DAY_MS);
  return `${days ? `${days} pv ` : ''}${pad(Math.floor(s / 3600) % 24)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

// Shows `locked` with a countdown until the site opens, filling its [data-lock] parts (side, count, word, clock, when)
// and the page's title, then hides it, shows `content` (and its data-title as the page's title) and calls onOpen,
// with true if it opened while the page was open
export async function guard({ locked, content, onOpen = () => {} }) {
  const state = await lockState();
  const part = name => locked.querySelector(`[data-lock="${name}"]`);
  const open = live => {
    locked.hidden = true;
    content.hidden = false;
    if (content.dataset.title) document.title = content.dataset.title;   // the page's title, kept till it opens
    onOpen(live);
  };
  if (state.open) return open(false);
  const when = state.at.toLocaleString('fi-FI', { timeZone: ZONE, day: 'numeric', month: 'numeric', hour: 'numeric', minute: '2-digit' });
  part('when').textContent = `Aukeaa ${when}. · Opens then.`;   // not what opens: a surprise till then
  locked.hidden = false;
  const tick = () => {
    const left = state.at - state.now();
    if (left <= 0) return open(true);
    const words = nights(left);
    for (const name of ['side', 'count', 'word']) part(name).textContent = words[name];
    part('count').parentElement.setAttribute('aria-label', words.said);
    document.title = words.said;
    part('clock').textContent = clock(left);
    setTimeout(tick, TICK_MS - (Date.now() % TICK_MS));
  };
  tick();
}
