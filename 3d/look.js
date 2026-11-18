// The cover's gloss look on the 3D page (ADR-0069), as renderer/src/gloss.rs lights it: a soft key light from behind the
// camera, up and to its left, which follows the camera as the reader turns the model; the sky and the ground's fill;
// the studio round the model mirrored, more the more a face is seen edge on; the key light box's highlight (GGX); and
// the brightness rolled off as the renderer's tone curve does. No dark lines: an edge between faces at an angle is a
// rim, a soft band lit as a small rounded bevel catches the light (gloss.rs Lights::rim, mesh.rs rims()), drawn only
// on its own piece. Glass filters what is behind it and adds its reflections. The constants are ldrender's
// (NUMBER.json's look.gloss, `ldrender --gloss`). The model's shadow on itself and the occlusion of nearby pieces come
// from light.js (ADR-0070), and so does the model's shadow on the ground, which is drawn here (ADR-0076).
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { SOLID, ground, groundGlsl, groundUniforms, glsl as lightGlsl, setLight, uniforms as lightUniforms, updateLight }
  from './light.js';

const OFFSET_WIDTHS = 1.0;   // faces are pushed back by their depth across this many rim widths, so a rim lies on them
const OFFSET_UNITS = 1.0;    // and this many of the depth buffer's steps, so a face square to the eye lies behind too
const RIM_ORDER = 1;         // rims are drawn after the faces, which they lie on
const GLASS_TINT_ORDER = -1; // glass's own colour over nothing, before any glass face filters what is behind it
const GLASS_ADD_ORDER = 2;   // glass's reflections are added after what it filters
const TINT_FLOOR = 1e-4;     // the least a channel of glass's colour is divided by: a channel it lets none of through
const PIECE_IDS = 255;       // the stencil's values: a rim is drawn where its own piece is, its id one of these
const WELD = 0.01;           // LDU: corners closer than this are one (mesh.rs WELD)
const SAME_FACE = 0.999;     // two normals closer than this cosine are one face beside a line (mesh.rs SAME_FACE)
const SMOOTH_COS = 0.707;    // faces meeting less sharply than this are one smooth surface, no rim (mesh.rs SMOOTH_COS)
const CELL = 20.0;           // LDU: the grid cells a part's triangles are found by (mesh.rs CELL)

let look = null;             // NUMBER.json's look
let shared = null;           // the GLSL and uniforms every material shares, made from the look (setLook())
// the finishes in the look's roughness's order, gloss.rs Finish's (web3d.look())
const finishes = () => Object.keys(look.roughness);
let widthPx = 1;             // a rim's width, device px
const resolution = new THREE.Vector2(1, 1);   // the drawing buffer's size, px
const faces = new Map();     // a loader's face material and the finish -> its gloss materials
const rimLooks = new Map();  // a rim's colour and finish -> its material
const rimSets = new WeakMap();   // a part's face geometry -> its rims, by the material index of the face they take

const vec3 = v => `vec3(${v.map(x => x.toFixed(6)).join(', ')})`;

// The GLSL of gloss.rs: lit() is Lights::light_reflecting() plus its reflections, encode() its encode(); in view space,
// where an orthographic camera's eye is along +z
function chunk(g) {
  return /* glsl */`
  uniform vec3 keyDir;
  uniform vec3 upDir;
  const vec3 TO_EYE = vec3(0.0, 0.0, 1.0);
  const float PI = 3.141592653589793;
  const float WRAP = ${g.wrap.toFixed(6)};
  const float KEY = ${g.key.toFixed(6)};
  const vec3 SKY = ${vec3(g.sky)};
  const vec3 GROUND = ${vec3(g.ground)};
  const float WHITE = ${g.white.toFixed(6)};
  const float SHOULDER = ${g.shoulder.toFixed(6)};
  const float KEY_SPECULAR = ${g.keySpecular.toFixed(6)};
  const float KEY_CORE = ${g.keyCore.toFixed(6)};
  const vec3 SURROUND_ABOVE = ${vec3(g.surroundAbove)};
  const vec3 GLASS_SURROUND_ABOVE = ${vec3(g.glassSurroundAbove)};
  const vec3 SURROUND_BELOW = ${vec3(g.surroundBelow)};
  const float SQUARE_ON = ${g.squareOn.toFixed(6)};
  const float GRAZING = ${g.grazing.toExponential(6)};
  const float FACES_CROSSED = ${g.facesCrossed.toFixed(6)};
  const float SHADOW_FADE = ${g.shadowFade.toFixed(6)};
  ${lightGlsl(g.occlusion)}
  #define ARC_STEPS ${g.arcSteps}
  // the material's finish, as its index in the look's roughness (gloss.rs Finish's order)
  uniform float finish;
  const float GLASS = ${finishes().indexOf('glass')}.0;
  const float RUBBER = ${finishes().indexOf('rubber')}.0;

  float lum709(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }   // Rec. 709's, of linear light
  float toSrgb(float v) { return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055; }   // IEC 61966-2-1
  vec3 toSrgb(vec3 v) { return vec3(toSrgb(v.r), toSrgb(v.g), toSrgb(v.b)); }
  float tone(float x) { x = clamp(x, 0.0, WHITE); return x * (WHITE + SHOULDER) / (WHITE * (x + SHOULDER)); }

  vec3 encode(vec3 lit) { return toSrgb(vec3(tone(lit.r), tone(lit.g), tone(lit.b))); }

  // the surround mirrored, the key box's highlight, and how much light gets through to the colour (gloss.rs specular())
  void specular(vec3 n, float rough, out vec3 surround, out float highlight, out float through) {
    float nv = max(dot(n, TO_EYE), GRAZING);
    float fresnel = SQUARE_ON + (max(1.0 - rough, SQUARE_ON) - SQUARE_ON) * pow(1.0 - nv, 5.0);
    vec3 mirror = n * 2.0 * nv - TO_EYE;
    vec3 above = finish == GLASS ? GLASS_SURROUND_ABOVE : SURROUND_ABOVE;
    surround = fresnel * mix(SURROUND_BELOW, above, (dot(mirror, upDir) + 1.0) / 2.0);
    float wide = min(rough * rough + KEY_CORE, 1.0);
    float nl = dot(n, keyDir);
    highlight = 0.0;
    if (nl > 0.0 && finish != RUBBER) {
      vec3 h = normalize(keyDir + TO_EYE);
      float nh = max(dot(n, h), 0.0);
      float a2 = wide * wide;
      float d = a2 / (PI * pow(nh * nh * (a2 - 1.0) + 1.0, 2.0));
      float k = wide / 2.0;
      float g = nl / (nl * (1.0 - k) + k) * nv / (nv * (1.0 - k) + k);
      float f = SQUARE_ON + (1.0 - SQUARE_ON) * pow(1.0 - max(dot(keyDir, h), 0.0), 5.0);
      highlight = KEY_SPECULAR * d * g * f / (4.0 * nv);
    }
    through = 1.0 - fresnel;
  }

  // the light a surface of linear colour base with unit normal n sends to the eye, reflecting the studio as given:
  // open the share of the sky and key it sees past nearby pieces, seen the share of the key box past the model (gloss.rs
  // Lit::encoded()); a face turned from the key keeps its wrapped light whatever the shadow says
  vec3 litReflecting(vec3 base, vec3 n, vec3 surround, float through, float rough, float open, float seen) {
    vec3 s; float highlight, t;
    specular(n, rough, s, highlight, t);
    float towards = dot(n, keyDir);
    float key = KEY * max((towards + WRAP) / (1.0 + WRAP), 0.0);
    float unshadowed = 1.0 - clamp(towards / SHADOW_FADE, 0.0, 1.0);
    float keyed = unshadowed + (1.0 - unshadowed) * seen;
    vec3 fill = through * base * mix(GROUND, SKY, (dot(n, upDir) + 1.0) / 2.0);
    return surround + keyed * highlight + open * (fill + keyed * through * base * key);
  }

  vec3 lit(vec3 base, vec3 n, float rough, float open, float seen) {
    vec3 surround; float highlight, through;
    specular(n, rough, surround, highlight, through);
    return litReflecting(base, n, surround, through, rough, open, seen);
  }`;
}

// The faces' vertex shader: the smooth normal and the view position, which the face's own normal is found from
const FACE_VERTEX = /* glsl */`
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalMatrix * normal;
    vView = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }`;

// The normal turned to the side of its face the eye sees (gloss.rs facing(): LDraw's windings can't always be trusted)
const FACING = /* glsl */`
  varying vec3 vNormal;
  varying vec3 vView;
  vec3 facing() {
    vec3 face = normalize(cross(dFdx(vView), dFdy(vView)));
    if (dot(face, TO_EYE) < 0.0) face = -face;
    vec3 n = normalize(vNormal);
    return dot(n, face) < 0.0 ? -n : n;
  }`;

// Sets the look (NUMBER.json's): the materials are made from it
export function setLook(given) {
  if (shared && JSON.stringify(given.gloss) === JSON.stringify(look.gloss)) { look = given; return; }
  look = given;
  setLight(given.gloss);
  shared = { glsl: chunk(given.gloss), keyDir: { value: new THREE.Vector3(0, 0, 1) }, upDir: { value: new THREE.Vector3(0, 1, 0) } };
  faces.clear();
  rimLooks.clear();
  ground.material.dispose();
  ground.material = groundMaterial(given.gloss);
}

// The ground as the traced cover's shadow catcher shows it (trace.rs caught(), pixel()): the paper's white times the
// share of the light it keeps, tone mapped, laid on the page as black of the opacity that darkens white paper to it,
// none fainter than the catcher's haze: over the page's blue, it darkens the blue as much
function groundMaterial(g) {
  return new THREE.ShaderMaterial({
    uniforms: groundUniforms,
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `${shared.glsl}
      ${groundGlsl(g.catcher)}
      const float HAZE = ${g.catcher.haze.toFixed(6)};
      varying vec3 vWorld;
      void main() {
        vec3 shown = encode(vec3(WHITE * groundShare(vWorld)));
        float alpha = 1.0 - min(shown.r, min(shown.g, shown.b));
        gl_FragColor = vec4(0.0, 0.0, 0.0, alpha < HAZE ? 0.0 : alpha);
      }`,
    transparent: true, depthWrite: false, toneMapped: false,
  });
}

function finish(m, tyre) {
  // a material's finish: glass and rubber by the colour's LDConfig name, a tyre rubber whatever its colour
  if (tyre || m.name.startsWith(look.gloss.rubber)) return 'rubber';
  return m.name.startsWith(look.gloss.glass) ? 'glass' : 'plastic';
}

function uniforms(m, done) {
  return { base: { value: new THREE.Vector3(m.color.r, m.color.g, m.color.b) }, rough: { value: look.roughness[done] },
    finish: { value: finishes().indexOf(done) },
    keyDir: shared.keyDir, upDir: shared.upDir, ...lightUniforms };
}

function opaque(m, done) {
  const material = new THREE.ShaderMaterial({
    uniforms: uniforms(m, done), vertexShader: FACE_VERTEX,
    fragmentShader: `${shared.glsl}
      ${FACING}
      uniform vec3 base;
      uniform float rough;
      void main() {
        vec3 n = facing();
        gl_FragColor = vec4(encode(lit(base, n, rough, open(), shade())), 1.0);
      }`,
    side: m.side, toneMapped: false, polygonOffset: true, polygonOffsetFactor: OFFSET_WIDTHS * widthPx,
    polygonOffsetUnits: OFFSET_UNITS,
    // each piece's faces mark the stencil with its id (marked()), where its rims may go
    stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
  });
  material.userData = { ...m.userData };
  return material;
}

// Glass as a filter (gloss.rs glass()), in three passes. First, where nothing is behind it (the canvas is transparent),
// the glass's colour as the filter of white paper (gloss.rs Glass::over()): that colour less its least channel,
// premultiplied, divided by the colour, as the multiply that follows takes it back to the colour; and its least
// channel let through, so that the page behind shows tinted by it rather than darkened (#237). Each glass face lays
// one; over a piece the canvas is opaque and it lays nothing. Then what is behind is multiplied by what the glass
// lets through of its colour, and its own reflections are added. Exact over white for one face and for clear glass;
// a piece seen through several faces comes out a little deeper than their product.
function glass(m, done) {
  const pass = (name, out, blend) => {
    const material = new THREE.ShaderMaterial({
      uniforms: uniforms(m, done), vertexShader: FACE_VERTEX,
      fragmentShader: `${shared.glsl}
        ${FACING}
        uniform vec3 base;
        uniform float rough;
        void main() {
          vec3 n = facing();
          vec3 surround; float highlight, through;
          specular(n, rough, surround, highlight, through);
          vec3 filtered = through * pow(base, vec3(1.0 / FACES_CROSSED));
          ${out}
        }`,
      side: THREE.DoubleSide, transparent: true, depthWrite: false, toneMapped: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, ...blend,
    });
    material.userData = { ...m.userData, glassPass: name };
    return material;
  };
  // the multiply first, which the piece's own mesh draws; the others are drawn in their order (asGloss())
  return [
    pass('filter', 'gl_FragColor = vec4(toSrgb(filtered), 0.0);',
      { blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor, blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor }),
    pass('tint', `vec3 tint = toSrgb(filtered);
          float least = min(tint.r, min(tint.g, tint.b));
          gl_FragColor = vec4(1.0 - least / max(tint, vec3(${TINT_FLOOR.toExponential(6)})), 1.0 - least);`,
      { blendSrc: THREE.OneMinusDstAlphaFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneMinusDstAlphaFactor,
        blendDstAlpha: THREE.OneFactor }),
    pass('reflect', 'gl_FragColor = vec4(surround + highlight, 0.0);',
      { blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor }),
  ];
}

function faceLook(m, tyre) {
  const done = finish(m, tyre);
  const key = `${m.id} ${done}`;
  if (!faces.has(key)) faces.set(key, m.transparent ? glass(m, done) : [opaque(m, done)]);
  return faces.get(key);
}

// ---------------------------------------------------------------------------------------------------- rims

const weld = p => p.map(v => Math.round(v / WELD)).join(',');
const sub = (a, b) => a.map((v, k) => v - b[k]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };

function onSegment(p, a, b) {
  // whether p lies on the segment a-b, within WELD (mesh.rs on_segment())
  const ab = sub(b, a), len2 = dot(ab, ab);
  const t = len2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / len2)) : 0;
  return Math.hypot(...sub(p, a.map((v, k) => v + ab[k] * t))) < WELD;
}

function onFace(p, q, n) {
  // whether p, in triangle q's plane (unit normal n), lies inside its edges, within WELD (mesh.rs on_face())
  const side = (a, b) => dot(cross(sub(b, a), sub(p, a)), n) / Math.max(Math.hypot(...sub(b, a)), WELD);
  const s = [side(q[0], q[1]), side(q[1], q[2]), side(q[2], q[0])];
  return s.every(v => v >= -WELD) || s.every(v => v <= WELD);
}

function triangles(geometry) {
  // [{q: corners, n: unit normal outward, as the loader's smooth normals say, group: its material index}]
  const pos = geometry.attributes.position.array, nor = geometry.attributes.normal.array;
  const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: pos.length / 3, materialIndex: 0 }];
  const out = [];
  for (const { start, count, materialIndex } of groups) {
    const end = Math.min(start + count, pos.length / 3);   // a group's count may run past the vertices (Infinity)
    for (let v = start; v + 2 < end; v += 3) {
      const q = [0, 1, 2].map(k => Array.from(pos.subarray((v + k) * 3, (v + k) * 3 + 3)));
      let n = unit(cross(sub(q[1], q[0]), sub(q[2], q[0])));
      const sum = [0, 1, 2].map(k => nor[v * 3 + k] + nor[(v + 1) * 3 + k] + nor[(v + 2) * 3 + k]);
      if (dot(n, sum) < 0) n = n.map(x => -x);
      out.push({ q, n, group: materialIndex });
    }
  }
  return out;
}

function standsOnAFace(cells, tris, a, b, beside) {
  // whether the line a-b lies across a face's surface, not along its edge: a stud's foot on a brick's top, written as
  // one face under it, is an inside corner, though only the stud's side is found beside it (mesh.rs stands_on_a_face())
  const middle = a.map((v, k) => (v + b[k]) / 2);
  return (cells.get(middle.map(v => Math.floor(v / CELL)).join(',')) ?? []).some(t => {
    const { q, n } = tris[t];
    const inPlane = p => Math.abs(dot(sub(p, q[0]), n)) <= WELD;
    return Math.abs(dot(n, beside)) < SAME_FACE && inPlane(a) && inPlane(b) && onFace(middle, q, n);
  });
}

function grid(tris) {
  // the triangles by the CELL-wide cells their boxes cover
  const cells = new Map();
  tris.forEach(({ q }, t) => {
    const c = q.map(p => p.map(v => Math.floor(v / CELL)));
    const lo = [0, 1, 2].map(k => Math.min(...c.map(p => p[k]))), hi = [0, 1, 2].map(k => Math.max(...c.map(p => p[k])));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const key = `${x},${y},${z}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(t);
    }
  });
  return cells;
}

// A part's rims (mesh.rs rims()): each edge line with the faces along it, a face whose edge lies along it, one a
// direction; two at an angle sharper than smoothing joins, at an outside corner, make a rim; one makes one unless the
// line lies on another face; a face on both sides of the line, none. {material index: [a, b, n0, n1] each}
export function rimsOf(faceGeometry, lineGeometry) {
  const tris = triangles(faceGeometry);
  const pos = lineGeometry.attributes.position.array;
  const lines = [];
  for (let v = 0; v + 1 < pos.length / 3; v += 2) lines.push([Array.from(pos.subarray(v * 3, v * 3 + 3)), Array.from(pos.subarray(v * 3 + 3, v * 3 + 6))]);
  const byEnd = new Map();
  lines.forEach((l, k) => l.forEach(p => {
    const key = weld(p);
    if (!byEnd.has(key)) byEnd.set(key, []);
    byEnd.get(key).push(k);
  }));
  const beside = lines.map(() => []), across = lines.map(() => false);
  for (const tri of tris) {
    const { q, n } = tri;
    for (let e = 0; e < 3; e++) {
      const [a, b, off] = [q[e], q[(e + 1) % 3], q[(e + 2) % 3]];
      const near = new Set([...(byEnd.get(weld(a)) ?? []), ...(byEnd.get(weld(b)) ?? [])]);
      for (const k of near) {
        const [la, lb] = lines[k];
        if (!(onSegment(a, la, lb) && onSegment(b, la, lb))) continue;
        const side = p => dot(cross(sub(lb, la), sub(p, la)), n) > 0;
        const same = beside[k].find(f => Math.abs(dot(f.n, n)) > SAME_FACE);
        if (same) across[k] ||= side(same.off) !== side(off);
        else beside[k].push({ n, off, group: tri.group });
      }
    }
  }
  let cells = null;
  const out = {};
  lines.forEach(([a, b], k) => {
    const by = beside[k];
    let rim = null;
    if (across[k] || !by.length) rim = null;
    else if (by.length === 1) {
      cells ??= grid(tris);
      if (!standsOnAFace(cells, tris, a, b, by[0].n)) rim = { n: [by[0].n, by[0].n], group: by[0].group };
    } else {
      const [f0, f1] = by;
      const outsideOf = (n, off) => dot(sub(off, a), n) > 0;
      const smooth = dot(f0.n, f1.n) > SMOOTH_COS;
      const inside = outsideOf(f0.n, f1.off) && outsideOf(f1.n, f0.off);
      if (!smooth && !inside) rim = { n: [f0.n, f1.n], group: f0.group };
    }
    if (rim) (out[rim.group] ??= []).push([a, b, ...rim.n]);
  });
  return out;
}

function rimGeometries(faceGeometry, lineGeometry) {
  // a LineSegmentsGeometry of a part's rims for each material index of the faces they take their colour from
  if (!rimSets.has(faceGeometry)) {
    const rims = rimsOf(faceGeometry, lineGeometry);
    const made = Object.entries(rims).map(([group, list]) => {
      const geometry = new LineSegmentsGeometry().setPositions(list.flatMap(([a, b]) => [...a, ...b]));
      for (const [name, at] of [['instanceN0', 2], ['instanceN1', 3]]) {
        geometry.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(list.flatMap(r => r[at])), 3));
      }
      return [geometry, Number(group)];
    });
    rimSets.set(faceGeometry, made);
  }
  return rimSets.get(faceGeometry);
}

function rimLook(m, tyre) {
  // a rim's material: LineMaterial's band, a rim width wide, lit as a bevel turning from one face's normal to the other's
  const done = finish(m, tyre);
  const key = `${m.color.getHexString()} ${done}`;
  if (!rimLooks.has(key)) {
    const material = new LineMaterial({ linewidth: widthPx, transparent: true, depthWrite: false, toneMapped: false });
    material.resolution = resolution;
    material.uniforms.base = { value: new THREE.Vector3(m.color.r, m.color.g, m.color.b) };
    material.uniforms.rough = { value: look.roughness[done] };
    material.uniforms.finish = { value: finishes().indexOf(done) };
    material.uniforms.keyDir = shared.keyDir;
    material.uniforms.upDir = shared.upDir;
    Object.assign(material.uniforms, lightUniforms);
    material.vertexShader = material.vertexShader
      .replace('attribute vec3 instanceEnd;', `attribute vec3 instanceEnd;
        attribute vec3 instanceN0;
        attribute vec3 instanceN1;
        varying vec3 vN0;
        varying vec3 vN1;`)
      .replace('float aspect = resolution.x / resolution.y;', `float aspect = resolution.x / resolution.y;
        vN0 = normalize(normalMatrix * instanceN0);
        vN1 = normalize(normalMatrix * instanceN1);`);
    material.fragmentShader = `${shared.glsl}
      uniform vec3 base;
      uniform float rough;
      varying vec2 vUv;
      varying vec3 vN0;
      varying vec3 vN1;
      void main() {
        // how far across the band, 0 on the edge to 1 at its side, round at its ends as the renderer's is
        float a = vUv.x;
        float b = abs(vUv.y) > 1.0 ? (vUv.y > 0.0 ? vUv.y - 1.0 : vUv.y + 1.0) : 0.0;
        float off = sqrt(a * a + b * b);
        if (off >= 1.0) discard;
        // it reflects the studio as the face beside it seen most squarely does (gloss.rs rim())
        vec3 square = dot(vN0, TO_EYE) >= dot(vN1, TO_EYE) ? vN0 : vN1;
        vec3 surround; float highlight, through;
        specular(square, rough, surround, highlight, through);
        float keyed = shade();   // the share of the key box the face under the rim sees (gloss.rs rim())
        vec3 best = vec3(0.0);
        for (int k = 0; k <= ARC_STEPS; k++) {
          vec3 arc = normalize(mix(vN0, vN1, float(k) / float(ARC_STEPS)));
          vec3 c = encode(litReflecting(base, arc, surround, through, rough, 1.0, keyed));
          if (lum709(c) > lum709(best)) best = c;
        }
        gl_FragColor = vec4(best, 1.0 - off);
      }`;
    // drawn only where its own piece's faces are (marked())
    Object.assign(material, { stencilWrite: true, stencilFunc: THREE.EqualStencilFunc, stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp, stencilWriteMask: 0 });
    rimLooks.set(key, material);
  }
  return rimLooks.get(key);
}

function marked(o, id) {
  // the stencil value of a piece's faces and rims, set as each is drawn: their materials are shared between pieces
  o.onBeforeRender = (renderer, scene, camera, geometry, material) => { material.stencilRef = id; };
}

// Draws piece (the loader's group of one part) in the gloss look: n numbers it in its picture, tyre whether it is a
// tyre (NUMBER.json's look.tyres), rubber whatever its colour
export function asGloss(piece, n, tyre) {
  const id = n % PIECE_IDS + 1;
  const meshes = [], lines = [];
  piece.traverse(o => {
    if (o.isMesh) meshes.push(o);
    else if (o.isLineSegments) lines.push(o);
  });
  for (const o of meshes) {
    const original = [o.material].flat();
    const materials = original.map(m => faceLook(m, tyre));
    const multi = Array.isArray(o.material);
    o.material = multi ? materials.map(([first]) => first) : materials[0][0];
    if (!multi) {
      // glass's other passes: its colour over nothing, before what it filters, and its reflections, after
      for (const [material, order] of [[materials[0][1], GLASS_TINT_ORDER], [materials[0][2], GLASS_ADD_ORDER]]) {
        if (!material) continue;
        const later = new THREE.Mesh(o.geometry, material);
        later.renderOrder = order;
        later.userData.glassPass = true;
        o.add(later);
      }
    }
    marked(o, id);
    if (!original.some(m => m.transparent)) o.layers.enable(SOLID);   // it casts a shadow and hides the sky
    const edges = lines.find(l => !l.isConditionalLine && l.parent === o.parent && l.matrix.equals(o.matrix));
    if (!edges) continue;
    for (const [geometry, group] of rimGeometries(o.geometry, edges.geometry)) {
      const m = original[group] ?? original[0];
      if (m.transparent) continue;   // glass gets no rims (render.rs rims())
      const rim = new LineSegments2(geometry, rimLook(m, tyre));
      rim.renderOrder = RIM_ORDER;
      rim.position.copy(o.position);
      rim.quaternion.copy(o.quaternion);
      rim.scale.copy(o.scale);
      marked(rim, id);
      o.parent.add(rim);
    }
  }
  for (const o of lines) o.removeFromParent();
}

// Whether a piece's mesh is glass: it doesn't hide a new piece behind it (picture.keyed())
export function isGlass(o) {
  return [o.material].flat().some(m => m.transparent);
}

// The key light and the sky's direction in the camera's view, as gloss.rs Lights::new() places them: the key behind the
// camera, to its left and above (NUMBER.json's look.light), the sky up the world
export function setCamera(camera) {
  if (!shared) return;
  camera.updateMatrixWorld();
  const view = camera.matrixWorldInverse;
  const up = new THREE.Vector3(0, 1, 0).transformDirection(view);
  const toEye = new THREE.Vector3(0, 0, 1);
  const left = new THREE.Vector3().crossVectors(toEye, up).normalize();
  const [behind, fromLeft, above] = look.light;
  shared.upDir.value.copy(up);
  shared.keyDir.value.copy(toEye.multiplyScalar(behind).addScaledVector(left, fromLeft).addScaledVector(up, above).normalize());
}

// Works out the shadow and occlusion of the picture shown (group), the key where setCamera() put it (light.js): whether
// it drew them (they hadn't moved)
export function lightUp(renderer, scene, camera, group) {
  return shared ? updateLight(renderer, scene, camera, group, shared.keyDir.value) : false;
}

// A rim's width in device px, and the drawing buffer's size, which LineMaterial measures it in
export function setRims(px, buffer) {
  widthPx = px;
  resolution.copy(buffer);
  for (const m of rimLooks.values()) {
    m.linewidth = px;
    m.resolution = buffer;
  }
  for (const [m] of faces.values()) if (!m.transparent) m.polygonOffsetFactor = OFFSET_WIDTHS * px;
}
