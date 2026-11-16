// The 3D instructions: the booklet's pictures (NUMBER.json, tools/web3d.py), each built from the pieces as its page
// draws them (turned over, posed, apart) and seen from its camera, the parts packed in NUMBER.mpd. A picture opens as
// the page shows it, its new pieces outlined (outline.js); then the pieces drawn apart go to their places and the
// other new ones drop into theirs, the outline fading once they are in place, until the reader turns the model round
// themselves. ?shot opens a bare picture for tools/compare3d.py (window.shot).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from 'three/addons/materials/LDrawConditionalLineMaterial.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { lockState } from '../lock.js';
import { asBooklet, curves, isGlass, setLines } from './look.js';
import { drawOutline, prepare, setOutline } from './outline.js';

const DROP_LDU = 72;         // a new piece not drawn apart starts this far above its place, three bricks
const HOLD_MS = 700;         // a picture stays as the page draws it this long before its pieces move
const DROP_MS = 650;
const STAGGER_MS = 160;      // between the moves of one picture's units
const CAMERA_MS = 800;
const FADE_MS = 600;         // the new pieces' outline fades out this long once they are in place
const FINALE_SPIN = 1.2;     // OrbitControls autoRotateSpeed on the finished model
const FIT_MARGIN = 1.15;     // room round the pieces when they fill the screen (NUMBER.json's fit)
const SHOT = new URLSearchParams(location.search).has('shot');

const $ = id => document.getElementById(id);
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: SHOT });
renderer.setPixelRatio(SHOT ? 1 : Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.NeutralToneMapping;
if (SHOT) document.body.classList.add('shot');

const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.9;
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(0.5, 1, 0.8);
scene.add(sun);

// The booklet's cameras are orthographic (renderer/src/render.rs): a picture sees the fov's arc at the target
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -20000, 20000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = false;
controls.addEventListener('start', () => { cameraTween = null; controls.autoRotate = false; });

// LDraw's y points down: turned over, the model stands the right way up in three.js
const stage = new THREE.Group();
stage.rotation.x = Math.PI;
scene.add(stage);
const fromLDraw = ([x, y, z]) => new THREE.Vector3(x, -y, -z);

let data = null;         // NUMBER.json
let loader = null;       // holds the parts of NUMBER.mpd once loaded
const built = new Map(); // picture index -> its group (a promise while it is built)
let at = -1;             // the picture shown
let shownCamera = '';    // the booklet camera last placed: the same one leaves the reader's view as it is
let view = null;         // { target, offset, up, unitsPerPx } the booklet camera, in three.js axes
let moves = [];
let cameraTween = null;
let loadId = 0;
let shown = null;        // the picture's group on the screen
let outlineFades = 0;    // when (performance.now()) its outline starts fading out

function ease(t) {        // out-back: overshoots a little and settles, like a piece clicking on
  const c = 1.4;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}

function ldrawText(pic) {
  const lines = pic.parts.map(([file, colour, m]) => `1 ${colour} ${m.join(' ')} ${file}`);
  return `0 Picture\n${data.colours}${lines.join('\n')}\n`;
}

// The pieces are drawn in the booklet's colours (NUMBER.json's colours, ldrender's LEGO palette) with its
// high-contrast studs; the figure keeps LDConfig's (figure.colours), as the page lights it as LEGO's booklets shade
// theirs. A colour LDConfig hasn't got, the studs' sides, is the figure piece's own, as the library's studs draw it.
function asFigure(pieces) {
  // pieces: [[object, its colour code]]. Each material is copied once a colour, in the order the loader made them:
  // three.js draws opaque faces in its materials' order where they lie on one another, as a print on its piece
  const uses = [];
  for (const [piece, part] of pieces) {
    piece.traverse(o => {
      if (o.material) [o.material].flat().forEach((m, k) => uses.push({ o, k, m, part }));
    });
  }
  const copies = new Map();
  for (const { m, part } of [...uses].sort((a, b) => a.m.id - b.m.id)) {
    const key = `${m.id} ${part}`;
    if (copies.has(key)) continue;
    const [value, edge] = data.figure.colours[m.userData.code] ?? data.figure.colours[part];
    const own = m.clone();
    own.color.setStyle(m.isMeshStandardMaterial ? value : edge, THREE.SRGBColorSpace);
    copies.set(key, own);
  }
  for (const { o, k, m, part } of uses) {
    const own = copies.get(`${m.id} ${part}`);
    if (Array.isArray(o.material)) o.material[k] = own;
    else o.material = own;
  }
}

function picture(i) {
  if (!built.has(i)) {
    const pic = data.steps[i];
    built.set(i, new Promise((resolve, reject) => loader.parse(ldrawText(pic), group => {
      if (group.children.length !== pic.parts.length) {
        reject(new Error(`picture ${i + 1}: ${group.children.length} of ${pic.parts.length} pieces loaded`));
        return;
      }
      const figure = group.children.map((child, n) => [child, pic.parts[n]]).filter(([, [file]]) => data.figure.parts.includes(file));
      asFigure(figure.map(([child, [, colour]]) => [child, colour]));
      group.children.filter(child => !figure.some(([f]) => f === child)).forEach(asBooklet);
      group.children.forEach((child, n) => {
        const [, , , unit, lift] = pic.parts[n];
        child.userData.unit = unit;
        child.userData.drawn = child.position.clone();
        child.userData.rest = lift ? child.position.clone().sub(new THREE.Vector3(...lift)) : child.position.clone();
      });
      prepare(group, pic.outlined);
      resolve(group);
    }, reject)));
  }
  return built.get(i);
}

async function load(number) {
  const id = ++loadId;
  $('loading').classList.remove('gone');
  const fresh = new LDrawLoader();
  fresh.setConditionalLineMaterial(LDrawConditionalLineMaterial);
  fresh.smoothNormals = true;
  const [json] = await Promise.all([
    fetch(`${number}.json`).then(r => r.json()),
    fresh.loadAsync(`${number}.mpd`),   // its files fill the loader's caches: every picture's parts are in it
  ]);
  if (id !== loadId) return;
  data = json;
  loader = fresh;
  built.clear();
  stage.clear();
  shownCamera = '';
  $('loading').classList.add('gone');
  if (SHOT) return;
  const wanted = parseInt(location.hash.split('/')[1], 10) - 1;
  show(Number.isFinite(wanted) ? Math.max(0, Math.min(wanted, data.steps.length - 1)) : 0, false);
}

function bookletView(pic) {
  // the booklet camera, and what of its picture fills the screen: the whole picture for a shot, else the box its
  // pieces cover (fit), in LDU across and up, and that box's middle off the picture's (dx right, dy up)
  const cam = pic.camera;
  const target = fromLDraw(cam.target), position = fromLDraw(cam.position);
  const perPx = THREE.MathUtils.degToRad(cam.fov) * position.distanceTo(target) / cam.size[1];
  const [w, h] = cam.size;
  const [x0, y0, x1, y1] = SHOT ? [0, 0, w, h] : pic.fit;
  const k = SHOT ? 1 : FIT_MARGIN;
  return { target, offset: position.sub(target), up: fromLDraw(cam.up).normalize(), perPx,
    width: (x1 - x0) * perPx * k, height: (y1 - y0) * perPx * k,
    dx: ((x0 + x1) / 2 - w / 2) * perPx, dy: (h / 2 - (y0 + y1) / 2) * perPx };
}

function usable() {
  // the part of the screen between the header and chips and the footer, in CSS px: the picture is fitted in it
  const w = window.innerWidth, h = window.innerHeight;
  if (SHOT) return { w, h, top: 0, bottom: h };
  const top = Math.max($('chips').getBoundingClientRect().bottom, document.querySelector('header').getBoundingClientRect().bottom);
  const bottom = document.querySelector('footer').getBoundingClientRect().top;
  return bottom - top > h * 0.3 ? { w, h, top, bottom } : { w, h, top: 0, bottom: h };
}

function frustum(v) {
  // the booklet picture's whole width and height fit the usable part of the screen, its middle in that part's middle
  const u = usable();
  const s = Math.max(v.width / u.w, v.height / (u.bottom - u.top));   // LDU per CSS px
  const mid = (u.top + u.bottom) / 2;
  camera.left = v.dx - u.w / 2 * s; camera.right = v.dx + u.w / 2 * s;
  camera.top = v.dy + mid * s; camera.bottom = v.dy - (u.h - mid) * s;
  camera.updateProjectionMatrix();
  // the booklet's line width (NUMBER.json's line, px of a picture) the same share of the picture: px on the screen,
  // which the reader's zoom leaves as they are
  if (!data) return;
  const k = v.perPx / s * renderer.getPixelRatio();   // device px a picture's px
  const buffer = renderer.getDrawingBufferSize(new THREE.Vector2());
  setLines(data.line * k, buffer);
  setOutline(data.outline, k, buffer);
}

function placeCamera(pic) {
  const key = JSON.stringify([pic.camera, pic.fit]);
  if (key === shownCamera) return;
  const to = bookletView(pic);
  const first = shownCamera === '';
  shownCamera = key;
  if (first || SHOT) {
    cameraTween = null;
    view = to;
    camera.zoom = 1;
    camera.up.copy(to.up);
    controls.target.copy(to.target);
    camera.position.copy(to.target).add(to.offset);
    frustum(to);
    return;
  }
  const from = { target: controls.target.clone(), offset: camera.position.clone().sub(controls.target),
    width: view.width / camera.zoom, height: view.height / camera.zoom, dx: view.dx, dy: view.dy, perPx: view.perPx };
  view = to;
  camera.zoom = 1;
  cameraTween = { from, to, t0: performance.now() };
}

function pose(group, how) {
  // how: 'drawn' as the page draws it, 'built' every piece in its place, 'start' ready to move ('drawn', the new
  // pieces not drawn apart above their places)
  for (const child of group.children) {
    const { unit, drawn, rest } = child.userData;
    child.position.copy(how === 'built' ? rest : drawn);
    if (how === 'start' && unit >= 0 && drawn.equals(rest)) child.position.y -= DROP_LDU;
  }
}

async function show(i, animate = true) {
  const forward = i === at + 1;
  at = i;
  const pic = data.steps[i];
  label(i, pic);
  const group = await picture(i);
  if (at !== i) return;
  stage.clear();
  stage.add(group);
  shown = group;
  placeCamera(pic);
  moves = [];
  pose(group, animate && forward ? 'start' : 'built');
  if (animate && forward) move(group);
  outlineFades = Math.max(performance.now() + HOLD_MS, ...moves.map(m => m.t0 + DROP_MS));
  controls.autoRotate = pic.kind === 'finale';
  controls.autoRotateSpeed = FINALE_SPIN;
}

function move(group) {
  const t0 = performance.now() + HOLD_MS;
  for (const child of group.children) {
    const { unit, rest } = child.userData;
    if (unit < 0) continue;
    moves.push({ child, from: child.position.clone(), to: rest, t0: t0 + STAGGER_MS * unit });
  }
}

function label(i, pic) {
  const total = data.steps.length - 1;
  const finale = pic.kind === 'finale';
  $('num').textContent = finale ? '★' : i + 1;
  $('page').textContent = finale ? 'Valmis kaivinkone' : `sivut ${pic.pages[0]}–${pic.pages[1]}`;
  $('caption').textContent = pic.caption;
  $('progress').style.width = `${100 * Math.min(i, total) / total}%`;
  $('build').hidden = !pic.build;
  $('build').textContent = pic.build ? `Rakenna: ${pic.build}` : '';
  $('copies').hidden = !(pic.copies > 1);
  $('copies').textContent = `×${pic.copies}`;
  $('turn').hidden = !pic.turn;
  $('turn').textContent = pic.turn ? `↻ ${pic.turn}` : '';
  $('done').hidden = !finale;
  $('prev').disabled = i === 0;
  $('next').disabled = finale;
  history.replaceState(null, '', `#${data.number}/${i + 1}`);
}

function step(by) {
  if (!data) return;
  const i = at + by;
  if (i >= 0 && i < data.steps.length) show(i).catch(fail);
}

function tick(now) {
  moves = moves.filter(({ child, from, to, t0 }) => {
    const t = Math.min(1, Math.max(0, (now - t0) / DROP_MS));
    child.position.lerpVectors(from, to, ease(t));
    return t < 1;
  });
  if (cameraTween) {
    const t = Math.min(1, (now - cameraTween.t0) / CAMERA_MS);
    const k = t * t * (3 - 2 * t);
    const { from, to } = cameraTween;
    controls.target.lerpVectors(from.target, to.target, k);
    const len = THREE.MathUtils.lerp(from.offset.length(), to.offset.length(), k);
    const dir = from.offset.clone().normalize();
    dir.applyQuaternion(new THREE.Quaternion().slerp(
      new THREE.Quaternion().setFromUnitVectors(dir, to.offset.clone().normalize()), k));
    camera.position.copy(controls.target).addScaledVector(dir, len);
    camera.up.copy(to.up);
    const mix = name => THREE.MathUtils.lerp(from[name], to[name], k);
    frustum({ width: mix('width'), height: mix('height'), dx: mix('dx'), dy: mix('dy'), perPx: mix('perPx') });
    if (t >= 1) cameraTween = null;
  }
  controls.update();
  renderer.render(scene, camera);
  drawOutline(renderer, scene, camera, shown, Math.min(1, 1 - (now - outlineFades) / FADE_MS));
  if (!SHOT) requestAnimationFrame(tick);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  if (view) frustum(view);
}

// tools/compare3d.py: picture i as its page draws it, filling the window (sized as the picture), on nothing. mode
// 'all': as the page draws it, its new pieces outlined; 'new': only where its new pieces show, glass too, drawn whole,
// the older ones hiding what is behind them but drawn in nothing, older glass not (as the booklet's key: ADR-0066); 'ids': each piece's faces in one unlit colour that numbers it (idColour()),
// without lines; 'curves': white where a face is curved, black where flat, without lines (look.js curves); 'outline':
// the outline alone (outline.js)
const hidden = new THREE.MeshBasicMaterial({ colorWrite: false });
const whole = new THREE.MeshBasicMaterial({ toneMapped: false });
const ID_LEVELS = 16;    // levels a channel of an id colour takes, 255 / 15 apart: far apart enough to survive rounding

function idColour(n) {
  // piece n (from 0) as the colour compare3d.piece_labels() reads back: n + 1 in base ID_LEVELS, red the highest digit
  const step = 255 / (ID_LEVELS - 1);
  const digits = [Math.floor((n + 1) / ID_LEVELS ** 2), Math.floor((n + 1) / ID_LEVELS) % ID_LEVELS, (n + 1) % ID_LEVELS];
  return new THREE.Color().setRGB(...digits.map(d => d * step / 255), THREE.SRGBColorSpace);
}

function shotLook(group, mode) {
  // swaps the pieces' materials for the shot's mode: the list of [object, material, visible] to put back
  const swapped = [];
  group.children.forEach((child, n) => {
    if (mode === 'all' || mode === 'outline') return;
    const isNew = mode === 'new' && child.userData.unit >= 0;
    const id = { ids: () => new THREE.MeshBasicMaterial({ color: idColour(n), toneMapped: false }), curves: () => curves,
      new: () => (isNew ? whole : hidden) }[mode]();
    child.traverse(o => {
      if (!o.material) return;
      swapped.push([o, o.material, o.visible]);
      const glass = isGlass(o);
      if (o.isMesh && !o.isLineSegments2) {
        o.material = id;
        if (mode === 'new' && !isNew && glass) o.visible = false;
      } else if (!isNew) o.visible = false;
    });
  });
  return swapped;
}

window.shot = async (i, mode = 'all') => {
  while (!data) await new Promise(r => setTimeout(r, 50));
  at = i;
  shownCamera = '';
  const group = await picture(i);
  stage.clear();
  stage.add(group);
  pose(group, 'drawn');
  const swapped = shotLook(group, mode);
  resize();
  placeCamera(data.steps[i]);
  controls.update();
  renderer.render(scene, camera);
  if (mode === 'outline') renderer.clear();
  if (mode === 'all' || mode === 'outline') drawOutline(renderer, scene, camera, group, 1);
  for (const [o, material, visible] of swapped) { o.material = material; o.visible = visible; }
  return data.steps.length;
};

$('prev').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
window.addEventListener('keydown', e => {
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); step(1); }
  if (e.key === 'ArrowLeft') step(-1);
});
window.addEventListener('resize', resize);
$('set').addEventListener('change', e => {
  history.replaceState(null, '', `#${e.target.value}/1`);
  at = -1;
  load(e.target.value).catch(fail);
});
window.addEventListener('hashchange', () => {
  const [number, n] = location.hash.slice(1).split('/');
  if (data && number !== data.number && [...$('set').options].some(o => o.value === number)) {
    $('set').value = number;
    at = -1;
    load(number).catch(fail);
  } else if (data && Number.isFinite(parseInt(n, 10)) && parseInt(n, 10) - 1 !== at) {
    show(Math.max(0, Math.min(parseInt(n, 10) - 1, data.steps.length - 1)), false).catch(fail);
  }
});

function fail(err) {
  console.error(err);
  $('loading').classList.remove('gone');
  $('loading').textContent = 'Mallin lataus ei onnistunut. Could not load the model.';
}

async function start() {
  if (!(await lockState()).open) {
    location.replace(`../${location.search}`);
    return;
  }
  const sets = await fetch('sets.json').then(r => r.json());
  for (const { number, label } of sets) $('set').add(new Option(label, number));
  const asked = new URLSearchParams(location.search).get('set') || location.hash.slice(1).split('/')[0];
  const first = sets.some(s => s.number === asked) ? asked : sets[0].number;
  $('set').value = first;
  $('set').hidden = sets.length < 2;
  await load(first);
}

resize();
if (!SHOT) requestAnimationFrame(tick);
start().catch(fail);
