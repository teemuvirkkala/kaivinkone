// The 3D instructions: the booklet's pictures (NUMBER.json, tools/web3d.py), each built from the pieces as its page
// draws them (turned over, posed, apart) and seen from its camera, the parts packed in its model file (web3d.MODEL). A
// picture opens as the page shows it, its new pieces outlined (outline.js); then the pieces drawn apart go to their
// places and the other new ones drop into theirs, the outline fading once they are in place, until the reader turns the
// model round themselves. From one picture to the next the page changes as the paper does (#220, ADR-0068): nothing
// moves where the camera is the same; a picture turned (its badge) turns the model in the reader's hands, about its
// middle; another sub-model is a short fade, as a page turns; else the camera moves there once. ?shot opens a bare
// picture for tools/compare3d.py (window.shot); window.track, an array, gets each frame's middle of the model on the
// screen (tools/moves3d.cjs). ?esittely shows only the cover's model (NUMBER.json's cover), for the index page's
// opening view (tools/website.py, ADR-0071): it can't be turned by hand, tells the page round it when its first frame
// is drawn, turns round when that page says 'turn' and stops drawing while it says 'pause' (scrolled out of sight).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from 'three/addons/materials/LDrawConditionalLineMaterial.js';
import { lockState } from '../lock.js';
import { asGloss, isGlass, lightUp, setCamera, setLook, setRims } from './look.js';
import { drawOutline, prepare, setOutline } from './outline.js';
import { gpuTimer, showTimes } from './ajat.js';

const HOLD_MS = 700;         // a picture stays as the page draws it this long before its pieces move
const CAMERA_MS = 800;       // a camera move, or a turn of the model in the hands
const CUT_MS = 200;          // a fade to another sub-model: out, then in
const CUT_SWAP = 0.5;        // the share of a cut at which the screen is blank and the next picture goes on
const FADE_MS = 600;         // the new pieces' outline fades out this long once they are in place
const IDLE_MS = 1000;        // the next picture is built when the page is idle, or after this long at most
const FINALE_SPIN = 1.2;     // OrbitControls autoRotateSpeed on the finished model
const SHOT = new URLSearchParams(location.search).has('shot');
const SHOW = new URLSearchParams(location.search).has('esittely');

const $ = id => document.getElementById(id);
// Each phase's end as a performance mark, '3d:' and its name, which tools/time3d.cjs reads (#219)
const mark = name => performance.mark(`3d:${name}`);
const canvas = $('view');
// a stencil, where each piece's rims may go (look.js)
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, stencil: true, preserveDrawingBuffer: SHOT });
renderer.setPixelRatio(SHOT ? 1 : Math.min(window.devicePixelRatio, 2));
if (SHOT) document.body.classList.add('shot');
if (SHOW) document.body.classList.add('esittely');

const scene = new THREE.Scene();

// The booklet's cameras are orthographic (renderer/src/render.rs): a picture sees the fov's arc at the target
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -20000, 20000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = false;
controls.enabled = !SHOW;
controls.addEventListener('start', () => {
  if (change) settle(change, true);
  controls.autoRotate = false;
});

// LDraw's y points down: turned over, the model stands the right way up in three.js. The hands hold it: a picture
// turned from the one before turns there, about the model's middle, the camera still
const hands = new THREE.Group();
scene.add(hands);
const stage = new THREE.Group();
stage.rotation.x = Math.PI;
stage.updateMatrix();
hands.add(stage);
const fromLDraw = ([x, y, z]) => new THREE.Vector3(x, -y, -z);

let data = null;         // NUMBER.json
let loader = null;       // holds the parts of the model file once loaded
const built = new Map(); // picture index -> its group (a promise while it is built)
let at = -1;             // the picture asked for
let onStage = -1;        // the picture on the stage: the same camera as the next leaves the reader's view as it is
let view = null;         // the view on the screen (bookletView()), the reader's zoom aside
let moves = [];
let change = null;       // the change under way from the picture on the stage to the next (begin())
let loadId = 0;
let shown = null;        // the picture's group on the stage
let outlineFades = 0;    // when (performance.now()) its outline starts fading out
let drawn = -1;          // a picture just put on the stage, marked once it is drawn
let turning = false;     // ?esittely: the page round it has said 'turn'
let paused = false;      // ?esittely: and then 'pause', no frames drawn till the next 'turn'
let stopped = false;     // the frames stopped, paused: the next 'turn' starts them again, once

function ease(t) {
  // smootherstep: still at both ends, its speed and acceleration rising and falling without a jolt, and never past
  // its end, where the piece would sink into the one it goes on (ADR-0072)
  return t * t * t * (t * (6 * t - 15) + 10);
}

function ldrawText(pic) {
  const lines = pic.parts.map(([file, colour, m]) => `1 ${colour} ${m.join(' ')} ${file}`);
  return `0 Picture\n${data.colours}${lines.join('\n')}\n`;
}

function picture(i) {
  if (!built.has(i)) {
    const pic = data.steps[i];
    built.set(i, new Promise((resolve, reject) => loader.parse(ldrawText(pic), group => {
      if (group.children.length !== pic.parts.length) {
        reject(new Error(`picture ${i + 1}: ${group.children.length} of ${pic.parts.length} pieces loaded`));
        return;
      }
      group.userData.waits = pic.waits ?? {};   // the cover (?esittely) has neither: nothing of it moves
      const tyres = new Set(data.look.tyres);
      group.children.forEach((child, n) => asGloss(child, n, tyres.has(pic.parts[n][0].toLowerCase())));
      group.children.forEach((child, n) => {
        const [, , , unit, lift] = pic.parts[n];
        child.userData.unit = unit;
        child.userData.index = n;
        child.userData.drawn = child.position.clone();
        child.userData.rest = lift ? child.position.clone().sub(new THREE.Vector3(...lift)) : child.position.clone();
        // where it starts from: its way (NUMBER.json's, tools/insertion.py) back from its place, along which it
        // slides on through no piece; a piece drawn apart, from where it is drawn. None for an older piece
        const way = pic.ways?.[unit];
        child.userData.start = way ? child.userData.rest.clone().addScaledVector(new THREE.Vector3(...way), way[3]) : null;
      });
      pose(group, 'built');
      // each piece's middle from its origin, in the group's frame: a piece only slides, so it stays
      for (const child of group.children) child.userData.centre = (middle([child]) ?? child.position.clone()).sub(child.position);
      group.userData.middle = middle(group.children);
      group.userData.older = middle(group.children.filter(child => child.userData.unit < 0)) ?? group.userData.middle;
      pose(group, 'drawn');   // where the grown copies' places (outlined) are given from
      prepare(group, pic.outlined);
      // the picture's rotation (NUMBER.json's): its sub-model turned over as drawn, its pieces in the sub-model's places
      const turn = new THREE.Group();
      const r = pic.rotation;
      turn.quaternion.setFromRotationMatrix(new THREE.Matrix4().set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1));
      turn.updateMatrix();
      turn.add(group);
      mark(`built ${i + 1}`);
      resolve(group);
    }, reject)));
  }
  return built.get(i);
}

// A set's NUMBER.json and model file (files: index.html's setFiles()), shown once open (a promise) is true
async function load(number, files = window.setFiles(number), open = Promise.resolve(true)) {
  const id = ++loadId;
  $('loading').classList.remove('gone');
  const [json, text] = await Promise.all([files.json, files.model]);
  mark('fetched');
  if (id !== loadId || !(await open)) return;
  const fresh = new LDrawLoader();
  fresh.setConditionalLineMaterial(LDrawConditionalLineMaterial);
  fresh.smoothNormals = true;
  fresh.setMaterials([]);
  // The packed files go in the loader's parse cache (LDrawLoader r170's), read but not built: a picture builds the
  // parts it uses, each once, rather than the whole model built before the first picture (#219)
  fresh.partsCache.parseCache.parse(text);
  mark('parsed');
  data = SHOW ? { ...json, steps: [json.cover] } : json;
  setLook(data.look);
  loader = fresh;
  built.clear();
  stage.clear();
  onStage = -1;
  change = null;
  shown = null;
  canvas.style.opacity = '';
  hands.position.set(0, 0, 0);
  hands.quaternion.identity();
  $('loading').classList.add('gone');
  if (SHOT) return;
  const wanted = parseInt(location.hash.split('/')[1], 10) - 1;
  show(Number.isFinite(wanted) ? Math.max(0, Math.min(wanted, data.steps.length - 1)) : 0, false);
}

function middle(pieces) {
  // the middle of pieces' box, in their group's frame, or null for none
  const box = new THREE.Box3();
  for (const piece of pieces) box.expandByObject(piece);
  return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
}

function bookletView(pic) {
  // the booklet camera, and what of its picture fills the screen: the whole picture for a shot, else the box its
  // pieces cover (fit), in LDU across and up. The camera looks at that box's middle, moved off the picture's in the
  // world, so that a move between two cameras doesn't carry the model off the screen's middle (#220)
  const cam = pic.camera;
  const centre = fromLDraw(cam.target), position = fromLDraw(cam.position);
  const distance = position.distanceTo(centre);
  const perPx = THREE.MathUtils.degToRad(cam.fov) * distance / cam.size[1];
  const [w, h] = cam.size;
  const [x0, y0, x1, y1] = SHOT ? [0, 0, w, h] : pic.fit;
  const k = SHOT ? 1 : data.margin;
  const up = fromLDraw(cam.up).normalize();
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(position, centre, up));
  const off = new THREE.Vector3(((x0 + x1) / 2 - w / 2) * perPx, (h / 2 - (y0 + y1) / 2) * perPx, 0);
  return { target: centre.add(off.applyQuaternion(quaternion)), quaternion, up, distance, perPx,
    width: (x1 - x0) * perPx * k, height: (y1 - y0) * perPx * k, area: usable() };
}

function viewKey(pic) {
  return JSON.stringify([pic.camera, pic.fit, pic.rotation]);
}

function currentView() {
  // the view on the screen now, the reader's turning and zoom in it
  return { target: controls.target.clone(), quaternion: camera.quaternion.clone(), up: camera.up.clone(),
    distance: camera.position.distanceTo(controls.target), perPx: view.perPx,
    width: view.width / camera.zoom, height: view.height / camera.zoom, area: view.area };
}

function mixed(a, b, k) {
  // between views a and b: the whole orientation slerped, up and all, the target moved in the world, the zoom by
  // ratio, so it changes as fast at each end, and the part of the screen it fills (the header's chips change with
  // the step) moved as smoothly
  const quaternion = a.quaternion.clone().slerp(b.quaternion, k);
  const ratio = name => a[name] * (b[name] / a[name]) ** k;
  return { target: a.target.clone().lerp(b.target, k), quaternion, up: new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion),
    distance: THREE.MathUtils.lerp(a.distance, b.distance, k), perPx: ratio('perPx'), width: ratio('width'), height: ratio('height'),
    area: { ...b.area, top: THREE.MathUtils.lerp(a.area.top, b.area.top, k), bottom: THREE.MathUtils.lerp(a.area.bottom, b.area.bottom, k) } };
}

function place(v) {
  view = v;
  camera.zoom = 1;
  camera.quaternion.copy(v.quaternion);
  camera.up.copy(v.up);
  camera.position.set(0, 0, v.distance).applyQuaternion(v.quaternion).add(v.target);
  camera.updateMatrixWorld();
  controls.target.copy(v.target);
  frustum(v);
}

function cameraMatrix(v) {
  return new THREE.Matrix4().compose(new THREE.Vector3(0, 0, v.distance).applyQuaternion(v.quaternion).add(v.target),
    v.quaternion, new THREE.Vector3(1, 1, 1));
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
  // the booklet picture's whole width and height fit the usable part of the screen (v.area, usable()), its middle in
  // that part's middle
  const u = v.area;
  const s = Math.max(v.width / u.w, v.height / (u.bottom - u.top));   // LDU per CSS px
  const mid = (u.top + u.bottom) / 2;
  camera.left = -u.w / 2 * s; camera.right = u.w / 2 * s;
  camera.top = mid * s; camera.bottom = -(u.h - mid) * s;
  camera.updateProjectionMatrix();
  // the rims' width (NUMBER.json's look.rim, px of a picture) the same share of the picture as on paper: px on the
  // screen, which the reader's zoom leaves as they are
  if (!data) return;
  const k = v.perPx / s * renderer.getPixelRatio();   // device px a picture's px
  const buffer = renderer.getDrawingBufferSize(new THREE.Vector2());
  setRims(data.look.rim * k, buffer);
  setOutline(data.outline, k, buffer);
}

function pose(group, how) {
  // how: 'drawn' as the page draws it, 'built' every piece in its place, 'start' ready to move (the new pieces
  // where they start from, the older ones in place)
  for (const child of group.children) {
    const { drawn, rest, start } = child.userData;
    child.position.copy(how === 'built' ? rest : how === 'start' ? start ?? rest : drawn);
  }
}

async function show(i, animate = true) {
  const forward = i === at + 1;
  at = i;
  const pic = data.steps[i];
  label(i, pic);
  const group = await picture(i);
  if (at !== i) return;
  begin(changeTo(i), i, group, animate && forward);
}

function changeTo(i) {
  // how the screen changes from the picture on the stage to picture i (ADR-0068)
  if (onStage < 0 || SHOT) return 'place';
  const was = data.steps[onStage], pic = data.steps[i];
  if (!change && viewKey(was) === viewKey(pic)) return 'none';
  if (i === onStage) return 'move';   // back, before the change from it ended: back to its own view
  const subject = p => [p.file, p.kind === 'finale'].join();   // the finished model is posed: another subject
  if (subject(was) !== subject(pic) || Math.abs(i - onStage) !== 1) return 'cut';
  return data.steps[Math.max(i, onStage)].turn ? 'turn' : 'move';
}

function begin(kind, i, group, drop) {
  const to = bookletView(data.steps[i]);
  if (kind === 'none') { put(i, group, drop); return; }
  if (kind === 'place') { settle({ i, group, drop, to }, true); return; }
  const now = performance.now();
  const from = currentView();
  place(from);
  if (kind === 'cut') {
    change = { kind, i, group, drop, to, t0: now, ms: CUT_MS, opacity: Number(canvas.style.opacity || 1) };
    return;
  }
  canvas.style.opacity = '';
  // the end: the camera at to's, or still for a turn (its zoom and area to's); the hands hold the picture on the stage where
  // the end camera sees it as to's camera sees the next, so that they swap unseen
  const end = kind === 'turn' ? { ...from, perPx: to.perPx, width: to.width, height: to.height, area: to.area } : to;
  const old = shown.parent.matrix, next = group.parent.matrix;
  hands.updateMatrix();
  const handsEnd = cameraMatrix(end).multiply(cameraMatrix(to).invert()).multiply(stage.matrix).multiply(next)
    .multiply(old.clone().invert()).multiply(stage.matrix.clone().invert());
  const centre = shown.userData.middle.clone().applyMatrix4(old).applyMatrix4(stage.matrix);   // in the hands' frame
  change = { kind, i, group, drop, to, from, end, t0: now, ms: CAMERA_MS, handsFrom: hands.matrix.clone(), handsEnd, centre };
}

function advance(c, now) {
  const t = Math.min(1, Math.max(0, (now - c.t0) / c.ms));
  if (c.kind === 'cut') {
    if (t >= CUT_SWAP && !c.swapped) {
      c.swapped = true;
      settle(c, false);
    }
    canvas.style.opacity = t < CUT_SWAP ? c.opacity * (1 - t / CUT_SWAP) : (t - CUT_SWAP) / (1 - CUT_SWAP);
    if (t >= 1) { canvas.style.opacity = ''; change = null; }
    return;
  }
  const k = t * t * (3 - 2 * t);
  place(mixed(c.from, c.end, k));
  turnHands(c, k);
  if (t >= 1) settle(c, true);
}

function turnHands(c, k) {
  // the hands between where they were and their end, turned by slerp about the model's middle, which moves straight
  const [p0, q0, p1, q1] = [new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3(), new THREE.Quaternion()];
  c.handsFrom.decompose(p0, q0, new THREE.Vector3());
  c.handsEnd.decompose(p1, q1, new THREE.Vector3());
  hands.quaternion.copy(q0.slerp(q1, k));
  const a = c.centre.clone().applyMatrix4(c.handsFrom), b = c.centre.clone().applyMatrix4(c.handsEnd);
  hands.position.copy(a.lerp(b, k).sub(c.centre.clone().applyQuaternion(hands.quaternion)));
}

function settle(c, done) {
  // the next picture on the stage, seen from its camera, the hands empty; done: the change is over
  hands.position.set(0, 0, 0);
  hands.quaternion.identity();
  place(c.to);
  if (done) { change = null; canvas.style.opacity = ''; }
  if (onStage !== c.i || shown !== c.group) put(c.i, c.group, c.drop);
}

function put(i, group, drop) {
  stage.clear();
  stage.add(group.parent);
  shown = group;
  onStage = i;
  drawn = i;
  moves = [];
  pose(group, drop ? 'start' : 'built');
  if (drop) move(group);
  outlineFades = Math.max(performance.now() + HOLD_MS, ...moves.map(m => m.t0 + data.motion.ms));
  ahead(i + 1, outlineFades + FADE_MS - performance.now());
  controls.autoRotate = data.steps[i].kind === 'finale' || (SHOW && turning);
  controls.autoRotateSpeed = FINALE_SPIN;
}

function ahead(i, after) {
  // builds picture i while the reader looks at the one before (#219), once its pieces have settled (after, ms), when
  // the page has nothing else to do; a failure shows if the reader goes there
  const id = loadId;
  const idle = window.requestIdleCallback ?? (f => f());
  setTimeout(() => idle(() => {
    if (id === loadId && i < data.steps.length) picture(i).catch(() => {});
  }, { timeout: IDLE_MS }), Math.max(0, after));
}

function move(group) {
  // each unit a moment after the one before, or once the units it waits for (NUMBER.json's waits: stacked on them,
  // it would meet them on the way) have landed: the times NUMBER.json's motion gives, which tools/insertion.py's
  // replayed() steps through to check the frames
  const starts = new Map();
  const units = [...new Set(group.children.map(c => c.userData.unit).filter(u => u >= 0))].sort((a, b) => a - b);
  const t0 = performance.now() + HOLD_MS;
  for (const unit of units) {
    const after = (group.userData.waits[unit] ?? []).map(v => starts.get(v) + data.motion.ms);
    starts.set(unit, Math.max(t0 + data.motion.stagger * unit, ...after));
  }
  for (const child of group.children) {
    const { unit, rest } = child.userData;
    if (unit >= 0) moves.push({ child, from: child.position.clone(), to: rest, t0: starts.get(unit) });
  }
}

function label(i, pic) {
  const total = data.steps.length - 1;
  const finale = pic.kind === 'finale';
  $('num').textContent = finale ? '★' : i + 1;
  $('page').textContent = pic.pages ? `sivut ${pic.pages[0]}–${pic.pages[1]}` : 'Valmis kaivinkone';
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
  if (i < 0 || i >= data.steps.length) return;
  mark(`asked ${i + 1}`);
  show(i).catch(fail);
}

function tick(now) {
  moves = moves.filter(({ child, from, to, t0 }) => {
    const t = Math.min(1, Math.max(0, (now - t0) / data.motion.ms));
    child.position.lerpVectors(from, to, ease(t));
    return t < 1;
  });
  if (change) advance(change, now);
  else controls.update();
  setCamera(camera);
  if (timer) {
    timer.time('valo', () => lightUp(renderer, scene, camera, shown));
    timer.time('kuva', () => renderer.render(scene, camera));
  } else {
    lightUp(renderer, scene, camera, shown);
    renderer.render(scene, camera);
  }
  drawOutline(renderer, scene, camera, shown, Math.min(1, 1 - (now - outlineFades) / FADE_MS));
  if (drawn >= 0) {
    mark(`shown ${drawn + 1}`);
    if (SHOW) window.parent.postMessage('3d:shown', location.origin);
    drawn = -1;
  }
  if (Array.isArray(window.track) && shown) window.track.push(tracked(now));
  if (SHOT) return;
  if (paused) stopped = true;
  else requestAnimationFrame(tick);
}

function tracked(now) {
  // this frame for tools/moves3d.cjs: the middle (CSS px) of the picture's pieces in place, and of its older ones
  const onScreen = p => projected(p.clone().applyMatrix4(shown.matrixWorld));
  // and for tools/drops3d.cjs, each new piece's offset (LDU, its sub-model's frame) from its place and its
  // middle on the screen as it moves, and how many pieces are still moving
  const pieces = shown.children.filter(c => c.userData.unit >= 0).map(c => {
    const off = c.position.clone().sub(c.userData.rest);
    return [c.userData.index, off.x, off.y, off.z, ...onScreen(c.position.clone().add(c.userData.centre))];
  });
  return { t: now, picture: onStage, middle: onScreen(shown.userData.middle), older: onScreen(shown.userData.older),
    opacity: Number(canvas.style.opacity || 1), change: change?.kind ?? null, pieces, moving: moves.length };
}

function projected(world) {
  // a point of the world on the screen, CSS px
  const s = world.clone().project(camera);
  return [(s.x + 1) / 2 * window.innerWidth, (1 - s.y) / 2 * window.innerHeight];
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  for (const v of [view, change?.from, change?.end, change?.to]) if (v) v.area = usable();
  if (view) frustum(view);
}

// tools/compare3d.py: picture i as its page draws it, filling the window (sized as the picture), on nothing. mode
// 'all': as the page draws it, its new pieces outlined; 'new': only where its new pieces show, glass too, drawn whole,
// the older ones hiding what is behind them but drawn in nothing, older glass not (as the booklet's key: ADR-0066); 'ids': each piece's faces in one unlit colour that numbers it (idColour()),
// without rims; 'outline': the outline alone (outline.js)
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
    const id = { ids: () => new THREE.MeshBasicMaterial({ color: idColour(n), toneMapped: false }),
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
  const group = await picture(i);
  stage.clear();
  stage.add(group.parent);
  pose(group, 'drawn');
  const swapped = shotLook(group, mode);
  resize();
  place(bookletView(data.steps[i]));
  controls.update();
  setCamera(camera);
  lightUp(renderer, scene, camera, group);
  renderer.render(scene, camera);
  if (mode === 'outline') renderer.clear();
  if (mode === 'all' || mode === 'outline') drawOutline(renderer, scene, camera, group, 1);
  for (const [o, material, visible] of swapped) { o.material = material; o.visible = visible; }
  return data.steps.length;
};

window.addEventListener('message', e => {
  if (!SHOW || e.origin !== location.origin || e.source !== window.parent) return;
  if (e.data === 'turn') {
    turning = true;
    controls.autoRotate = true;
    paused = false;
    if (stopped) requestAnimationFrame(tick);
    stopped = false;
  } else if (e.data === 'pause') paused = true;
});
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
  const open = lockState(window.unlock).then(state => {
    mark('lock');
    if (!state.open) {
      loadId++;
      if (!SHOW) location.replace(`../${location.search}`);
    }
    return state.open;
  });
  const { sets, number, files } = window.first;
  mark('started');
  for (const set of sets) $('set').add(new Option(set.label, set.number));
  $('set').value = number;
  $('set').hidden = sets.length < 2;
  await load(number, files, open);
}

resize();
// ?ajat: the timings on the screen, the GPU's too where the browser times it
const timer = !SHOT && new URLSearchParams(location.search).has('ajat') ? gpuTimer(renderer.getContext()) : null;
if (!SHOT && new URLSearchParams(location.search).has('ajat')) showTimes();
if (!SHOT) requestAnimationFrame(tick);
start().catch(fail);
