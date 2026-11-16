// The booklet's look on the 3D page (ADR-0065): every piece but the figure's drawn as renderer/src/render.rs draws the
// LEGO look. Its faces unlit in their colour, a curved surface shaded by how far its smooth normal turns from the
// surface's mean (a flat face stays its colour exactly, as LEGO's booklets draw it: 6617226); the faces pushed back behind the
// lines a line's width; and lines a set number of screen pixels wide, which WebGL's own lines can't be (LineMaterial),
// a conditional line drawn only where the outline of its curve is, as LDrawConditionalLineMaterial tests it.
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

// A curved face's colour is its own plus CURVE_LEVELS (of 255, each channel, whatever its colour) times how much more
// (or less) of the light its smooth normal takes than its surface's on average (reference()): LEGO's (6617226) curved
// surfaces rise 5 to 25 levels across, flat faces under 2; the most turned of ours, a cylinder's side, rises 25 (ADR-0065)
const CURVE_LEVELS = 23;
const LIGHT = new THREE.Vector3(-0.4, 0.8, 0.45).normalize();   // from the eye, up and left, as LEGO's booklets light
const OFFSET_WIDTHS = 1.0;   // faces are pushed back by their depth across this many line widths (render.rs)
const OFFSET_UNITS = 1.0;    // and this many of the depth buffer's steps, so a face square to the eye lies behind too
const GLASS_OFFSET = [0.25, 0.1];   // glass's factor and units instead, as render.rs's TRANSLUCENT_OFFSET
const LINE_ORDER = 1;        // lines are drawn after the faces, which they lie on

const faces = new Map();     // a loader's face material -> its booklet look
const lines = new Map();     // a loader's edge material (and whether conditional) -> its LineMaterial
let widthPx = 1;             // the lines' width, device px
const resolution = new THREE.Vector2(1, 1);   // the drawing buffer's size, px

// A colour's sRGB values, which the faces are drawn in as they are: the shading is in the page's levels, as LEGO's
// was measured, and a flat face's pixels are its colour exactly (the renderer's output is sRGB)
function srgb(color) {
  const out = {};
  color.getRGB(out, THREE.SRGBColorSpace);
  return new THREE.Vector3(out.r, out.g, out.b);
}

const QUANTUM = 100;   // a corner's place (LDU) and normal are compared rounded to a hundredth
// The faces' vertex shader: the smooth normal, and the view position the fragment shader finds the face's normal from
const FACE_VERTEX = /* glsl */`
  attribute vec3 reference;
  varying vec3 vNormal;
  varying vec3 vReference;
  varying vec3 vViewPosition;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalMatrix * normal;
    vReference = normalMatrix * reference;
    vViewPosition = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }`;

function surfaces(pos, nor) {
  // the surface (a triangle's index) each triangle is on: triangles joined by edges whose corners share their smooth
  // normals, as the loader smooths across an edge without a line
  const tris = pos.length / 9;
  const parent = Int32Array.from({ length: tris }, (_, t) => t);
  const root = t => { while (parent[t] !== t) t = parent[t] = parent[parent[t]]; return t; };
  const corner = v => Array.from({ length: 6 }, (_, k) => Math.round((k < 3 ? pos : nor)[v * 3 + k % 3] * QUANTUM)).join(',');
  const edges = new Map();
  for (let t = 0; t < tris; t++) {
    const keys = [0, 1, 2].map(k => corner(t * 3 + k));
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const edge = keys[a] < keys[b] ? `${keys[a]}|${keys[b]}` : `${keys[b]}|${keys[a]}`;
      if (edges.has(edge)) parent[root(t)] = root(edges.get(edge));
      else edges.set(edge, t);
    }
  }
  return Array.from({ length: tris }, (_, t) => root(t));
}

function reference(geometry) {
  // Each corner's surface's mean normal (area-weighted, not unit length). A flat face's is its own normal, so it stays
  // its colour; a curved surface's is its middle's, so it is shaded across its whole width, not facet by facet (a ramp
  // a facet would stripe a cylinder), and its colour on average is its own
  const pos = geometry.attributes.position.array, nor = geometry.attributes.normal.array;
  const surface = surfaces(pos, nor);
  const sums = new Map();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < surface.length; t++) {
    a.fromArray(pos, t * 9); b.fromArray(pos, t * 9 + 3); c.fromArray(pos, t * 9 + 6);
    const n = b.sub(a).cross(c.sub(a));   // the face's normal, its length twice its area
    if (n.dot(new THREE.Vector3().fromArray(nor, t * 9)) < 0) n.negate();
    const sum = sums.get(surface[t]) ?? sums.set(surface[t], new THREE.Vector4()).get(surface[t]);
    sum.x += n.x; sum.y += n.y; sum.z += n.z; sum.w += n.length();
  }
  const out = new Float32Array(pos.length);
  for (let t = 0; t < surface.length; t++) {
    const sum = sums.get(surface[t]);
    for (let k = 0; k < 3; k++) out.set([sum.x / sum.w, sum.y / sum.w, sum.z / sum.w], (t * 3 + k) * 3);
  }
  geometry.setAttribute('reference', new THREE.BufferAttribute(out, 3));
}

function faceMaterial(m) {
  if (!faces.has(m)) {
    const look = new THREE.ShaderMaterial({
      uniforms: { diffuse: { value: srgb(m.color) }, opacity: { value: m.opacity }, light: { value: LIGHT },
        gain: { value: CURVE_LEVELS / 255 } },
      vertexShader: FACE_VERTEX,
      fragmentShader: /* glsl */`
        uniform vec3 diffuse;
        uniform float opacity;
        uniform vec3 light;
        uniform float gain;
        varying vec3 vNormal;
        varying vec3 vReference;
        varying vec3 vViewPosition;
        void main() {
          // the normals as the side seen faces, whichever way the part's triangles wind
          vec3 face = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
          float seen = dot(vNormal, face) < 0.0 ? -1.0 : 1.0;
          float more = seen * (dot(light, normalize(vNormal)) - dot(light, vReference));
          gl_FragColor = vec4(clamp(diffuse + gain * more, 0.0, 1.0), opacity);
        }`,
      transparent: m.transparent, depthWrite: m.depthWrite, side: m.side, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: m.transparent ? GLASS_OFFSET[0] : OFFSET_WIDTHS * widthPx,
      polygonOffsetUnits: m.transparent ? GLASS_OFFSET[1] : OFFSET_UNITS,
    });
    look.userData = { ...m.userData, booklet: true };
    faces.set(m, look);
  }
  return faces.get(m);
}

// LineMaterial's vertex shader, with the conditional line's test: both control points on the same side of the line,
// on the screen, or the line's quad collapses to nothing (renderer/src/render.rs conditional(), which draws on 0 too):
// every corner of it at one point past the far plane (z 2 > w 1), which clipping drops
function conditional(material) {
  material.vertexShader = material.vertexShader
    .replace('attribute vec3 instanceEnd;', 'attribute vec3 instanceEnd;\nattribute vec3 instanceControl0;\nattribute vec3 instanceControl1;')
    .replace('gl_Position = clip;', `gl_Position = clip;
      vec4 q0 = projectionMatrix * modelViewMatrix * vec4(instanceControl0, 1.0);
      vec4 q1 = projectionMatrix * modelViewMatrix * vec4(instanceControl1, 1.0);
      vec2 along = ndcEnd.xy - ndcStart.xy;
      vec2 across = vec2(-along.y, along.x);
      if (dot(across, q0.xy / q0.w - ndcStart.xy) * dot(across, q1.xy / q1.w - ndcStart.xy) < 0.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);`);
  return material;
}

function lineMaterial(m, isConditional) {
  const key = `${m.id} ${isConditional}`;
  if (!lines.has(key)) {
    const look = new LineMaterial({ color: m.color, linewidth: widthPx, transparent: m.transparent, opacity: m.opacity,
      toneMapped: false });
    look.resolution = resolution;
    look.userData = { ...m.userData, booklet: true };
    lines.set(key, isConditional ? conditional(look) : look);
  }
  return lines.get(key);
}

function wide(segments) {
  // a LineSegments2 for each material group: LineSegmentsGeometry has one material
  const g = segments.geometry, pos = g.attributes.position.array;
  const materials = [segments.material].flat();
  const groups = g.groups.length ? g.groups : [{ start: 0, count: g.attributes.position.count, materialIndex: 0 }];
  return groups.map(({ start, count, materialIndex }) => {
    const n = Math.min(count, g.attributes.position.count - start);
    const geometry = new LineSegmentsGeometry().setPositions(pos.subarray(start * 3, (start + n) * 3));
    if (segments.isConditionalLine) {
      for (const [from, to] of [['control0', 'instanceControl0'], ['control1', 'instanceControl1']]) {
        const all = g.attributes[from].array, one = new Float32Array(n / 2 * 3);
        for (let s = 0; s < n / 2; s++) one.set(all.subarray((start + 2 * s) * 3, (start + 2 * s) * 3 + 3), s * 3);
        geometry.setAttribute(to, new THREE.InstancedBufferAttribute(one, 3));
      }
    }
    const line = new LineSegments2(geometry, lineMaterial(materials[materialIndex], !!segments.isConditionalLine));
    line.renderOrder = LINE_ORDER;
    return line;
  });
}

export function asBooklet(piece) {
  const narrow = [];
  piece.traverse(o => {
    if (!o.isMesh) {
      if (o.isLineSegments) narrow.push(o);
      return;
    }
    if (!o.geometry.attributes.reference) reference(o.geometry);
    o.material = Array.isArray(o.material) ? o.material.map(faceMaterial) : faceMaterial(o.material);
  });
  for (const o of narrow) {
    for (const line of wide(o)) {
      line.position.copy(o.position);
      line.quaternion.copy(o.quaternion);
      line.scale.copy(o.scale);
      o.parent.add(line);
    }
    o.removeFromParent();
  }
}

// Draws a shot's piece: white where its faces are curved, so that tools/compare3d.py knows which faces should be
// shaded, black where they are flat: where the smooth normal turns from one pixel to the next by over CURVED_TURN
// (radians), a flat face's being one normal throughout
const CURVED_TURN = 1e-3;
export const curves = new THREE.ShaderMaterial({
  uniforms: { least: { value: CURVED_TURN } },
  vertexShader: FACE_VERTEX,
  fragmentShader: /* glsl */`
    uniform float least;
    varying vec3 vNormal;
    void main() {
      vec3 n = normalize(vNormal);
      gl_FragColor = vec4(vec3(length(dFdx(n)) + length(dFdy(n)) > least ? 1.0 : 0.0), 1.0);
    }`,
  toneMapped: false,
});

// Whether a piece's mesh is glass: it doesn't hide a new piece behind it (picture.keyed())
export function isGlass(o) {
  return [o.material].flat().some(m => m.transparent);
}

// The lines' width in device px, and the drawing buffer's size, which LineMaterial measures it in
export function setLines(px, buffer) {
  widthPx = px;
  resolution.copy(buffer);
  for (const m of lines.values()) {
    m.linewidth = px;
    m.resolution = buffer;
  }
  for (const m of faces.values()) if (!m.transparent) m.polygonOffsetFactor = OFFSET_WIDTHS * px;
}
