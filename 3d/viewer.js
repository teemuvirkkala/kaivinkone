// The 3D instructions: the booklet's steps (NUMBER.json, tools/web3d.py) built up in the model packed with its parts
// (NUMBER.mpd). Each step shows the sub-model being built on its own, as the booklet does, its new pieces dropping
// into place, and the camera where the booklet's is, until the reader turns the model round themselves.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from 'three/addons/materials/LDrawConditionalLineMaterial.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { lockState } from '../lock.js';

const FOV_DEG = 22;          // the booklet's camera (tools/instr.py camera_for)
const MARGIN = 1.10;         // instr.camera_for's room round the model
const BARS_PX = 230;         // the header, chips and footer: the model is framed in the height between them
const DROP_LDU = 72;         // a new piece starts this far from its place, three bricks
const DROP_MS = 650;
const STAGGER_MS = 120;      // between the drops of one step's pieces
const CAMERA_MS = 800;
const FINALE_SPIN = 1.2;     // OrbitControls autoRotateSpeed on the finished model

const $ = id => document.getElementById(id);
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.NeutralToneMapping;

const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.9;
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(0.5, 1, 0.8);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 1, 20000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = false;
controls.addEventListener('start', () => { cameraTween = null; controls.autoRotate = false; });

// LDraw's y points down: turned over, the model stands the right way up in three.js
const stage = new THREE.Group();
stage.rotation.x = Math.PI;
scene.add(stage);

let data = null;         // NUMBER.json
let subs = {};           // file name -> its group, with each child's step in userData.step
let at = -1;             // the step shown; data.steps.length is the finished model
let shownKey = '';       // what the camera was last placed for: a new one moves it
let drops = [];
let cameraTween = null;
let loadId = 0;

function ease(t) {        // out-back: overshoots a little and settles, like a piece clicking on
  const c = 1.4;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}

function numberSteps(group) {
  let step = 0;
  group.children.forEach((child, n) => {
    if (n > 0 && child.userData.startingBuildingStep) step++;
    child.userData.step = step;
    child.userData.rest = child.position.clone();
  });
}

function prepare(model) {
  const files = new Set(data.steps.map(s => s.file));
  const out = {};
  for (const file of files) {
    if (file === data.main) continue;
    const found = model.getObjectByName(file);
    if (!found) throw new Error(`${file} is not in the model`);
    const own = found.clone();
    own.position.set(0, 0, 0);
    own.quaternion.identity();
    own.visible = true;
    numberSteps(own);
    out[file] = own;
  }
  numberSteps(model);
  out[data.main] = model;
  return out;
}

async function load(number) {
  const id = ++loadId;
  $('loading').classList.remove('gone');
  const loader = new LDrawLoader();
  loader.setConditionalLineMaterial(LDrawConditionalLineMaterial);
  loader.smoothNormals = true;
  const [json, model] = await Promise.all([
    fetch(`${number}.json`).then(r => r.json()),
    loader.loadAsync(`${number}.mpd`),
  ]);
  if (id !== loadId) return;
  data = json;
  subs = prepare(model);
  stage.clear();
  shownKey = '';
  $('loading').classList.add('gone');
  const wanted = parseInt(location.hash.split('/')[1], 10) - 1;
  show(Number.isFinite(wanted) ? Math.max(0, Math.min(wanted, data.steps.length)) : 0, false);
}

function current(i) {
  if (i < data.steps.length) return data.steps[i];
  const mains = data.steps.filter(s => s.file === data.main);
  const last = mains[mains.length - 1];
  return { ...last, step: Infinity, frame: Infinity, finale: true, turn: null, build: null, copies: 1 };
}

function viewDirection([lat, lon]) {
  // instr.camera_for's direction from the model to the camera, in LDraw axes turned over as the stage is
  const la = THREE.MathUtils.degToRad(lat), lo = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
}

function frameCamera(group, st) {
  // instr.camera_for: back off along the view until every corner of the framed pieces' boxes fits
  stage.updateMatrixWorld(true);
  const corners = [];
  for (const child of group.children) {
    if (child.userData.step > st.frame) continue;
    const box = new THREE.Box3().setFromObject(child);
    for (let i = 0; i < 8; i++) {
      corners.push(new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    }
  }
  const centre = new THREE.Box3().setFromPoints(corners).getCenter(new THREE.Vector3());
  const d = viewDirection(st.view);
  const right = new THREE.Vector3().crossVectors(d.clone().negate(), new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, d.clone().negate());
  const usable = Math.max(0.4, 1 - BARS_PX / window.innerHeight);
  const tv = Math.tan(THREE.MathUtils.degToRad(FOV_DEG) / 2) * usable, th = Math.tan(THREE.MathUtils.degToRad(FOV_DEG) / 2) * camera.aspect;
  let dist = 0;
  for (const q of corners) {
    const r = q.clone().sub(centre);
    const z = r.dot(d);
    dist = Math.max(dist, z + Math.abs(r.dot(up)) * MARGIN / tv, z + Math.abs(r.dot(right)) * MARGIN / th);
  }
  const to = { target: centre, offset: d.multiplyScalar(dist) };
  if (shownKey === '') {
    cameraTween = null;
    controls.target.copy(to.target);
    camera.position.copy(to.target).add(to.offset);
    return;
  }
  const from = { target: controls.target.clone(), offset: camera.position.clone().sub(controls.target) };
  cameraTween = { from, to, t0: performance.now() };
}

function show(i, animate = true) {
  const forward = i === at + 1;
  at = i;
  const st = current(i);
  const group = subs[st.file];
  if (stage.children[0] !== group) {
    stage.clear();
    stage.add(group);
  }
  for (const child of group.children) {
    child.visible = child.userData.step <= st.step;
    child.position.copy(child.userData.rest);
  }
  const key = `${data.number}|${st.file}|${st.view}|${st.frame}`;
  if (key !== shownKey) {
    frameCamera(group, st);
    shownKey = key;
  }
  drops = [];
  if (animate && forward) drop(group, st);
  controls.autoRotate = !!st.finale;
  controls.autoRotateSpeed = FINALE_SPIN;
  label(i, st);
}

function drop(group, st) {
  const now = performance.now();
  const lastMain = data.steps.filter(s => s.file === data.main).at(-1).step;
  const dir = st.view[0] < 0 ? 1 : -1;   // pieces come from the camera's side: from below on a model turned over
  const fresh = group.children.filter(c => c.visible && (st.finale ? c.userData.step > lastMain : c.userData.step === st.step));
  fresh.forEach((child, n) => {
    drops.push({ child, t0: now + STAGGER_MS * n, dir });
    child.position.y += dir * DROP_LDU;
  });
}

function label(i, st) {
  const total = data.steps.length;
  $('num').textContent = st.finale ? '★' : i + 1;
  $('page').textContent = st.finale ? 'Valmis kaivinkone' : `sivut ${st.pages[0]}–${st.pages[1]}`;
  $('caption').textContent = st.finale ? 'Finished!' : st.caption;
  $('progress').style.width = `${100 * i / total}%`;
  $('build').hidden = !st.build;
  $('build').textContent = st.build ? `Rakenna: ${st.build}` : '';
  $('copies').hidden = !(st.copies > 1);
  $('copies').textContent = `×${st.copies}`;
  $('turn').hidden = !st.turn;
  $('turn').textContent = st.turn ? `↻ ${st.turn}` : '';
  $('done').hidden = !st.finale;
  $('prev').disabled = i === 0;
  $('next').disabled = !!st.finale;
  history.replaceState(null, '', `#${data.number}/${i + 1}`);
}

function step(by) {
  if (!data) return;
  const i = at + by;
  if (i >= 0 && i <= data.steps.length) show(i);
}

function tick(now) {
  drops = drops.filter(({ child, t0, dir }) => {
    const t = Math.min(1, Math.max(0, (now - t0) / DROP_MS));
    child.position.y = child.userData.rest.y + dir * DROP_LDU * (1 - ease(t));
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
    if (t >= 1) cameraTween = null;
  }
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

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
  } else if (data && Number.isFinite(parseInt(n, 10))) {
    show(Math.max(0, Math.min(parseInt(n, 10) - 1, data.steps.length)), false);
  }
});

function fail(err) {
  console.error(err);
  $('loading').textContent = 'Mallin lataus ei onnistunut. Could not load the model.';
}

async function start() {
  if (!(await lockState()).open) {
    location.replace(`../${location.search}`);
    return;
  }
  const sets = await fetch('sets.json').then(r => r.json());
  for (const { number, label } of sets) $('set').add(new Option(label, number));
  const asked = location.hash.slice(1).split('/')[0];
  const first = sets.some(s => s.number === asked) ? asked : sets[0].number;
  $('set').value = first;
  await load(first);
}

resize();
requestAnimationFrame(tick);
start().catch(fail);
