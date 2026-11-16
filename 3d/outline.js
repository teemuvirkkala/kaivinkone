// The booklet's green outline round a step's new pieces (ADR-0066), drawn as instr.highlighted() draws it: a ring grown
// from where the new pieces show (an older piece in front hides them, older glass doesn't) to the outline's widths
// (NUMBER.json's outline, px of a picture) with square filters, cut where an older piece stands in front of the new
// pieces (ADR-0050) or of their copies grown toward the camera (NUMBER.json's outlined: ADR-0055, ADR-0058), softened
// and laid over the picture. Where the pieces show and what stands in front come from depth pictures of the older
// pieces, the new ones and the grown copies, each its own layer; the ring is grown and softened in shaders, a row and
// then a column at a time.
import * as THREE from 'three';
import { isGlass } from './look.js';

const OLDER = 1, NEWER = 2, GROWN = 3;   // the depth pictures' layers: older opaque pieces, outlined ones, their copies
const TIE_LDU = 0.5;    // an older piece nearer than an outlined one by less than this (LDU) is level with it, not in front
const MOST_PX = 255;    // a distance (px) stored in a byte's channel: this one means none within reach, so a reach is less
const SPREAD = 3;       // a softening reaches this many of its standard deviations
const LEAST_SIGMA = 1e-3;   // px: a softening's standard deviation at least, which the shader divides by

const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const QUAD_VERTEX = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

let widths = { inner: 0, outer: 0, sigma: 0 };   // device px: the ring's square filters' reaches, and its softening
let colour = new THREE.Vector3();
let targets = null;

function odd(px) {
  // the odd whole number nearest px, as instr.odd(): a filter of even size would shift the ring half a pixel
  return 2 * Math.round((px - 1) / 2) + 1;
}

function ldrawMatrix(m) {
  return new THREE.Matrix4().set(m[3], m[4], m[5], m[0], m[6], m[7], m[8], m[1], m[9], m[10], m[11], m[2], 0, 0, 0, 1);
}

// A picture's pieces (group, as built from its parts) sorted into the depth pictures' layers, each outlined piece with
// its grown copy (outlined: [[index, placement]]) as a child, so that the copy moves with it
export function prepare(group, outlined) {
  const grown = new Map(outlined);
  group.userData.outlined = grown.size > 0;
  group.children.forEach((child, n) => {
    child.updateMatrix();
    child.updateMatrixWorld(true);
    const meshes = [];
    child.traverse(o => { if (o.isMesh && !o.isLineSegments2) meshes.push(o); });
    for (const o of meshes) {
      if (grown.has(n)) o.layers.enable(NEWER);
      else if (!isGlass(o)) o.layers.enable(OLDER);
    }
    if (!grown.has(n)) return;
    const toCopy = child.matrix.clone().invert().multiply(ldrawMatrix(grown.get(n)));   // the piece -> its copy
    const fromPiece = child.matrixWorld.clone().invert();
    for (const o of meshes) {
      const copy = new THREE.Mesh(o.geometry, depthOnly);
      copy.matrixAutoUpdate = false;
      copy.matrix.copy(toCopy).multiply(fromPiece.clone().multiply(o.matrixWorld));
      copy.layers.set(GROWN);
      child.add(copy);
    }
  });
}

// The outline's look (NUMBER.json's outline) at k device px a picture's px, and the drawing buffer's size
export function setOutline(look, k, size) {
  widths = { inner: (odd(look.inner * k) - 1) / 2, outer: Math.min((odd(look.outer * k) - 1) / 2, MOST_PX - 1),
    sigma: look.blur * k };
  colour = new THREE.Vector3(...[1, 3, 5].map(i => parseInt(look.colour.slice(i, i + 2), 16) / 255));
  if (targets && targets.size.equals(size)) return;
  if (targets) for (const t of targets.all) t.dispose();
  const depth = () => new THREE.WebGLRenderTarget(size.x, size.y, { depthTexture: new THREE.DepthTexture(size.x, size.y, THREE.FloatType) });
  const flat = () => new THREE.WebGLRenderTarget(size.x, size.y, { depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const [older, newer, grown, rows, rings] = [depth(), depth(), depth(), flat(), flat()];
  targets = { size: size.clone(), older, newer, grown, rows, rings, all: [older, newer, grown, rows, rings] };
}

function pass(fragmentShader, uniforms, blended = false) {
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader: QUAD_VERTEX, fragmentShader, depthTest: false,
    depthWrite: false, transparent: blended, toneMapped: false });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  return { scene, uniforms: material.uniforms };
}

// Where the new pieces show: drawn in front of the older ones, or level with them
const SHOWS = /* glsl */`
  uniform sampler2D older;
  uniform sampler2D newer;
  uniform float tie;
  bool shows(vec2 uv) { float n = texture2D(newer, uv).r; return n < 1.0 && n <= texture2D(older, uv).r + tie; }`;

// Each pixel's distance (px) along its row to the nearest where the new pieces show, within reach
const across = pass(/* glsl */`${SHOWS}
  uniform vec2 texel;
  uniform int reach;
  varying vec2 vUv;
  void main() {
    float best = ${MOST_PX}.0;
    for (int d = -reach; d <= reach; d++) if (shows(vUv + vec2(float(d) * texel.x, 0.0))) best = min(best, abs(float(d)));
    gl_FragColor = vec4(best / ${MOST_PX}.0, 0.0, 0.0, 1.0);
  }`, { older: { value: null }, newer: { value: null }, tie: { value: 0 }, texel: { value: new THREE.Vector2() }, reach: { value: 0 } });

// The ring: the square distance (the larger of the row's and the column's) past inner and within reach, where no older
// piece stands in front of the new pieces or their grown copies
const ring = pass(/* glsl */`
  uniform sampler2D rows;
  uniform sampler2D older;
  uniform sampler2D newer;
  uniform sampler2D grown;
  uniform float tie;
  uniform vec2 texel;
  uniform int reach;
  uniform float inner;
  varying vec2 vUv;
  bool before(float o, float d) { return d < 1.0 && o < d - tie; }
  void main() {
    float best = ${MOST_PX}.0;
    for (int d = -reach; d <= reach; d++) {
      float row = texture2D(rows, vUv + vec2(0.0, float(d) * texel.y)).r * ${MOST_PX}.0;
      best = min(best, max(abs(float(d)), row));
    }
    float o = texture2D(older, vUv).r;
    bool cut = before(o, texture2D(newer, vUv).r) || before(o, texture2D(grown, vUv).r);
    gl_FragColor = vec4(best > inner && best <= float(reach) && !cut ? 1.0 : 0.0, 0.0, 0.0, 1.0);
  }`, { rows: { value: null }, older: { value: null }, newer: { value: null }, grown: { value: null }, tie: { value: 0 },
  texel: { value: new THREE.Vector2() }, reach: { value: 0 }, inner: { value: 0 } });

// The ring softened along one axis (step: a pixel along it); the second time laid over the picture in its colour
const SOFTEN = /* glsl */`
  uniform sampler2D source;
  uniform vec2 step;
  uniform float sigma;
  uniform int reach;
  varying vec2 vUv;
  float soft() {
    if (reach == 0) return texture2D(source, vUv).r;
    float sum = 0.0, weight = 0.0;
    for (int d = -reach; d <= reach; d++) {
      float w = exp(-float(d * d) / (2.0 * sigma * sigma));
      sum += w * texture2D(source, vUv + float(d) * step).r;
      weight += w;
    }
    return sum / weight;
  }`;
const softUniforms = () => ({ source: { value: null }, step: { value: new THREE.Vector2() }, sigma: { value: 1 }, reach: { value: 0 } });
const soften = pass(`${SOFTEN}
  void main() { gl_FragColor = vec4(soft(), 0.0, 0.0, 1.0); }`, softUniforms());
const lay = pass(`${SOFTEN}
  uniform vec3 colour;
  uniform float opacity;
  void main() { gl_FragColor = vec4(colour, soft() * opacity); }`, { ...softUniforms(), colour: { value: null }, opacity: { value: 1 } }, true);

function depthPicture(renderer, scene, camera, layer, target) {
  camera.layers.set(layer);
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);
}

// Lays the outline of the picture shown (group, prepared) over what the renderer last drew of scene from camera, at
// opacity (0 to 1)
export function drawOutline(renderer, scene, camera, group, opacity) {
  if (!targets || !group?.userData.outlined || opacity <= 0) return;
  const { older, newer, grown, rows, rings, size } = targets;
  const mask = camera.layers.mask, autoClear = renderer.autoClear, background = scene.background;
  const clearColour = renderer.getClearColor(new THREE.Color()), clearAlpha = renderer.getClearAlpha();
  scene.overrideMaterial = depthOnly;
  scene.background = null;
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  depthPicture(renderer, scene, camera, OLDER, older);
  depthPicture(renderer, scene, camera, NEWER, newer);
  depthPicture(renderer, scene, camera, GROWN, grown);
  camera.layers.mask = mask;
  scene.overrideMaterial = null;
  scene.background = background;
  const texel = new THREE.Vector2(1 / size.x, 1 / size.y);
  const tie = TIE_LDU / (camera.far - camera.near);   // depth is linear in LDU: the camera is orthographic
  const depths = { older: older.depthTexture, newer: newer.depthTexture, grown: grown.depthTexture };
  const run = (step, target, values) => {
    for (const [name, value] of Object.entries(values)) step.uniforms[name].value = value;
    renderer.setRenderTarget(target);
    if (target) renderer.clear();
    renderer.render(step.scene, quadCamera);
  };
  run(across, rows, { older: depths.older, newer: depths.newer, tie, texel, reach: widths.outer });
  run(ring, rings, { ...depths, rows: rows.texture, tie, texel, reach: widths.outer, inner: widths.inner });
  const reach = Math.ceil(SPREAD * widths.sigma), sigma = Math.max(widths.sigma, LEAST_SIGMA);
  // the rows' distances are done with: their target holds the softening along the rows
  run(soften, rows, { source: rings.texture, step: new THREE.Vector2(texel.x, 0), sigma, reach });
  run(lay, null, { source: rows.texture, step: new THREE.Vector2(0, texel.y), sigma, reach, colour, opacity });
  renderer.setClearColor(clearColour, clearAlpha);
  renderer.autoClear = autoClear;
}
