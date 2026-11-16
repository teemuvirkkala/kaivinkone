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

function nights(ms) {
  const n = Math.ceil(ms / DAY_MS);
  return n === 1 ? 'Enää yksi yö!' : `Vielä ${n} yötä!`;
}

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / TICK_MS));
  const pad = n => String(n).padStart(2, '0');
  const days = Math.floor(ms / DAY_MS);
  return `${days ? `${days} pv ` : ''}${pad(Math.floor(s / 3600) % 24)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

// Shows `locked` with a countdown until the site opens, then hides it, shows `content` and calls onOpen
export async function guard({ locked, content, onOpen = () => {} }) {
  const state = await lockState();
  const open = () => { locked.hidden = true; content.hidden = false; onOpen(); };
  if (state.open) return open();
  const when = state.at.toLocaleString('fi-FI', { timeZone: ZONE, day: 'numeric', month: 'numeric', hour: 'numeric', minute: '2-digit' });
  locked.innerHTML = '<p class="nights"></p><p class="clock"></p><p class="when"></p>';
  locked.querySelector('.when').textContent = `Ohjeet aukeavat ${when}. · The instructions open then.`;
  locked.hidden = false;
  const tick = () => {
    const left = state.at - state.now();
    if (left <= 0) return open();
    locked.querySelector('.nights').textContent = nights(left);
    locked.querySelector('.clock').textContent = clock(left);
    setTimeout(tick, TICK_MS - (Date.now() % TICK_MS));
  };
  tick();
}
