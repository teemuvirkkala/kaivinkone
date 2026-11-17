// ?ajat: the page's timings on the screen, to time it on a phone without DevTools (#219, ADR-0067): the time to the
// first picture and when each phase ended (viewer.js mark()), each step's time from the tap to its picture drawn, and
// how the model file came, its bytes over the network against unpacked, which shows whether the server gzipped it; and
// the GPU's time a frame and for the light's passes (ADR-0070), where the browser can time the GPU.
const PREFIX = '3d:';
const GZIPPED = 0.5;   // a file that came in under this share of its unpacked size was compressed
const KB = 1000;
// each phase's mark (the first picture's, whichever it is: the address may open on any step) and its name
const PHASES = [['started', 'käynnissä'], ['fetched', 'haettu'], ['parsed', 'luettu'], ['built ', 'rakennettu']];

function marks() {
  return new Map(performance.getEntriesByType('mark').filter(m => m.name.startsWith(PREFIX))
    .map(m => [m.name.slice(PREFIX.length), m.startTime]));
}

function first(m, name) {
  // when the first mark whose name starts with name came, or undefined
  const times = [...m].filter(([k]) => k.startsWith(name)).map(([, at]) => at);
  return times.length ? Math.min(...times) : undefined;
}

function model() {
  // the model file as the browser fetched it: whether gzipped, its sizes, or that it came from the cache
  const file = performance.getEntriesByType('resource').find(r => new URL(r.name).pathname.endsWith(window.model));
  if (!file) return 'malli: –';
  const size = `${Math.round(file.encodedBodySize / KB)} / ${Math.round(file.decodedBodySize / KB)} kt`;
  const gzipped = file.encodedBodySize < file.decodedBodySize * GZIPPED ? 'gzip ✓' : 'ei gzip ✗';
  return `malli: ${gzipped} ${size}${file.transferSize === 0 ? ' (välimuistista)' : ''}, ${Math.round(file.duration)} ms`;
}

function steps(m) {
  // [[step, ms from its tap to its picture drawn]] of the steps tapped to
  const out = [];
  for (const [name, at] of m) {
    const n = name.startsWith('asked ') ? name.slice('asked '.length) : null;
    if (n && m.has(`shown ${n}`)) out.push([n, Math.round(m.get(`shown ${n}`) - at)]);
  }
  return out;
}

const gpu = new Map();   // what the GPU drew (its Finnish name) -> [ms of its latest few times]
const KEPT = 30;         // the times kept of each: a median over a second of frames at 30 fps

function gpuLines() {
  if (!gpu.size) return [];
  const median = ms => [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)];
  return [`GPU: ${[...gpu].map(([name, ms]) => `${name} ${median(ms).toFixed(1)} ms`).join(' · ')}`];
}

// A GPU timer for gl (WebGL2), or null where the browser has none (EXT_disjoint_timer_query_webgl2): time(name, draw)
// runs draw and, where it says it drew (returns true), times it on the GPU, read back frames later
export function gpuTimer(gl) {
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return null;
  const pending = [];
  const collect = () => {
    while (pending.length && gl.getQueryParameter(pending[0][0], gl.QUERY_RESULT_AVAILABLE)) {
      const [query, name] = pending.shift();
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        const ms = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
        gpu.set(name, [...(gpu.get(name) ?? []), ms].slice(-KEPT));
      }
      gl.deleteQuery(query);
    }
  };
  return {
    time(name, draw) {
      collect();
      const query = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      const drew = draw();
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      if (drew === false) gl.deleteQuery(query);
      else pending.push([query, name]);
      return drew;
    },
  };
}

function text() {
  const m = marks();
  const net = navigator.connection?.effectiveType;
  const shown = first(m, 'shown ');
  const lines = [`ensimmäinen kuva ${shown === undefined ? '…' : `${Math.round(shown)} ms`}${net ? ` (${net})` : ''}`,
    PHASES.filter(([k]) => first(m, k) !== undefined).map(([k, label]) => `${label} ${Math.round(first(m, k))}`).join(' · '),
    model()];
  const times = steps(m);
  if (times.length) {
    const sorted = times.map(([, ms]) => ms).sort((a, b) => a - b);
    lines.push(`vaiheet, napautuksesta kuvaan: mediaani ${sorted[Math.floor(sorted.length / 2)]} ms, pisin ${sorted.at(-1)} ms`);
    lines.push(times.map(([n, ms]) => `${n}: ${ms}`).join('  '));
  }
  return [...lines, ...gpuLines()].join('\n');
}

// Shows the timings in a panel of their own, kept up to date as marks come
export function showTimes() {
  const panel = document.createElement('pre');
  panel.id = 'ajat';
  document.body.append(panel);
  const update = () => { panel.textContent = text(); };
  new PerformanceObserver(update).observe({ entryTypes: ['mark', 'resource'] });
  setInterval(update, 1000);   // the GPU's times come without a mark
  update();
}
