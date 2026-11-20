// The gloss look's shadow and occlusion on the 3D page (ADR-0070), as ldrender works them out for the cover's look:
// the model's shadow from the key light (renderer/src/shadow.rs: a shadow map along the key, its edge softened by
// percentage-closer filtering over a disc that grows with how far a point is behind what shadows it, compared on the
// point's own face's plane), which takes the key's light and highlight; and its ambient occlusion
// (renderer/src/occlusion.rs: rays marched into the half of the sky a face's normal faces, hidden where a step along
// one is behind the picture's surface there, blurred over a tile within a face), which takes the light its colour gives
// back of the key and the sky. Both are worked out again only when the camera or a piece moves. And the model's shadow
// on the ground (ADR-0076), as the traced cover's shadow catcher has it (renderer/src/trace.rs World::caught()): the
// share of the sun's and the sky's light the model hides from each point of the ground at its lowest point, from rays
// marched through the model's top and bottom seen straight down and up; the sky's worked out again when a piece moves,
// the sun's when the camera does too, as it follows the camera. look.js draws the ground as a darkening of the page.
// The constants are ldrender's (NUMBER.json's look.gloss.shadow, .occlusion and .catcher, `ldrender --gloss`).
import * as THREE from 'three';

export const SOLID = 4;      // the layer of the pieces' opaque faces: what casts a shadow and hides the sky (glass doesn't)
const PAGE_MAX_SIDE = 2048;  // texels: the shadow map's side at most on the page, a phone's memory (ldrender: 4096)
const LIGHT_ROOM = 2.0;      // the light's camera stands this many times the model's radius from its middle
const GROUND_REACH = 3.0;    // the ground's shares are worked out this many model radii round where its shadow falls:
                             // past it the model hides less of the sky than the catcher's haze shows
const GROUND_SIDE = 128;     // texels: a side of the ground's shares, which change slowly over it
const HEIGHT_SIDE = 256;     // texels: a side of the model's top and bottom seen straight down and up
const SKY_RAYS = 64;         // rays a point of the ground sends into the sky, cosine weighted (trace.rs caught())
const SUN_RAYS = 32;         // and into the sun's disc, uniform over it (trace.rs Sun::sample())
const STEPS = 32;            // steps along each ray, closer together near the ground
const HEIGHT_ROOM = 1.0;     // LDU: the top and bottom cameras stand this far beyond the model
const GROUND_ORDER = -2;     // the ground is darkened before glass lays its tint over it (look.js GLASS_TINT_ORDER)

const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const QUAD_VERTEX = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// What every face's and rim's shader reads: the occlusion (red) and the shadow (green) a CSS px, the depths they were
// worked out at, and the screen's size
export const uniforms = { lightMap: { value: null }, lightDepthMap: { value: null }, lightMapSize: { value: new THREE.Vector2(1, 1) },
  bufferSize: { value: new THREE.Vector2(1, 1) }, depthRange: { value: 1 }, lightOn: { value: 0 } };

let constants = null;   // NUMBER.json's look.gloss
let targets = null;
let signature = '';
let skySignature = '';

// The ground under the model, facing up (seen only from above), as large as the shares worked out over it: look.js
// gives it its material (groundMaterial()), from these uniforms and groundGlsl()
const plane = new THREE.PlaneGeometry(2, 2);
plane.rotateX(-Math.PI / 2);
export const ground = new THREE.Mesh(plane);
ground.renderOrder = GROUND_ORDER;
ground.visible = false;
export const groundUniforms = { skyTex: { value: null }, sunTex: { value: null }, worldToSky: { value: new THREE.Matrix4() },
  worldToSun: { value: new THREE.Matrix4() }, sunLight: { value: 0 } };

const asInt = v => Math.round(v);
const f = v => Number(v).toFixed(6);
// the sky's radiance as one grey (Rec. 709's luminance of linear light): the ground is drawn as a darkening, not a tint
const grey = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// GLSL for the ground's shader: groundShare(), the share of the paper's light the ground keeps at a world point, as
// trace.rs caught() weighs the sun's and the sky's shares the model leaves it by their light
export function groundGlsl(c) {
  return /* glsl */`
  uniform sampler2D skyTex;
  uniform sampler2D sunTex;
  uniform mat4 worldToSky;
  uniform mat4 worldToSun;
  uniform float sunLight;     // the sun's irradiance on the open ground
  const float SKY_LIGHT = ${f(Math.PI * grey(c.sky))};   // a cosine-weighted sky brings pi times its radiance
  float shareAt(sampler2D tex, mat4 toTex, vec3 world) {
    vec4 p = toTex * vec4(world, 1.0);
    vec2 uv = p.xy / p.w * 0.5 + 0.5;
    return uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 ? 1.0 : texture2D(tex, uv).r;
  }
  float groundShare(vec3 world) {
    float sun = shareAt(sunTex, worldToSun, world), sky = shareAt(skyTex, worldToSky, world);
    return (sunLight * sun + SKY_LIGHT * sky) / (sunLight + SKY_LIGHT);
  }`;
}

// GLSL of the shadow (shadow.rs Shadow::share()): seen(), the share of the key box a point p with normal n (the view's
// axes) sees past the model, its taps turned by the pixel at px
function shadowGlsl(s) {
  return /* glsl */`
  uniform sampler2D shadowMap;
  uniform mat4 viewToLight;
  uniform vec2 lightSize;     // LDU across the map
  uniform vec2 lightDepth;    // the light camera's near and far, LDU
  uniform float shadowTexels; // texels a LDU
  const float SHADOW_REACH = ${f(s.reach)};
  const float SHADOW_SPREAD = ${f(s.spread)};
  const float SHADOW_BIAS = ${f(s.bias)};
  const float NORMAL_OFFSET = ${f(s.normalOffset)};
  const float MAX_SLOPE = ${f(s.maxSlope)};
  #define SEARCH_TAPS ${asInt(s.searchTaps)}
  #define FILTER_TAPS ${asInt(s.filterTaps)}
  const float GOLDEN = 2.399963229728653;   // the golden angle, radians: PI (3 - sqrt 5)
  const float TAU = 6.283185307179586;

  // a turn (0 to 1) for a pixel: interleaved gradient noise (Jimenez 2014), as shadow.rs turn()
  float turnAt(vec2 px) { return fract(52.982918 * fract(dot(floor(px), vec2(0.06711056, 0.00583715)))); }

  vec2 disc(int k, int count, float turn, float radius) {
    float r = radius * sqrt((float(k) + 0.5) / float(count));
    float a = GOLDEN * float(k) + TAU * turn;
    return r * vec2(cos(a), sin(a));
  }

  // LDU from the light to the nearest face at a place (LDU across the map), very far off the map or where none is
  float mapDepth(vec2 at) {
    vec2 uv = at / lightSize + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return 1e9;
    float d = texture2D(shadowMap, uv).r;
    return d >= 1.0 ? 1e9 : mix(lightDepth.x, lightDepth.y, d);
  }

  float seen(vec3 p, vec3 n, vec2 px) {
    vec3 ln = normalize(mat3(viewToLight) * n);
    vec3 q = (viewToLight * vec4(p + n * NORMAL_OFFSET / shadowTexels, 1.0)).xyz;
    float depth = -q.z;     // the light camera looks down its -z: along the light
    float along = -ln.z;
    float facing = max(abs(along), 1.0 / MAX_SLOPE);
    vec2 slope = clamp(-ln.xy / facing * sign(along), -MAX_SLOPE, MAX_SLOPE);
    float turn = turnAt(px);
    float gap = 0.0, blockers = 0.0;
    for (int k = 0; k < SEARCH_TAPS; k++) {
      vec2 o = disc(k, SEARCH_TAPS, turn, SHADOW_REACH);
      float plane = depth + dot(slope, o) - SHADOW_BIAS;
      float d = mapDepth(q.xy + o);
      if (d < plane) { gap += plane - d; blockers += 1.0; }
    }
    if (blockers == 0.0) return 1.0;
    float radius = clamp(gap / blockers * SHADOW_SPREAD, 1.0 / shadowTexels, SHADOW_REACH);
    float open = 0.0;
    for (int k = 0; k < FILTER_TAPS; k++) {
      vec2 o = disc(k, FILTER_TAPS, turn, radius);
      if (mapDepth(q.xy + o) >= depth + dot(slope, o) - SHADOW_BIAS) open += 1.0;
    }
    return open / float(FILTER_TAPS);
  }`;
}

// GLSL for the faces' and rims' shaders: light(), the share of the sky the pixel's face sees (x) and of the key box
// (y), as the light's screen passes worked them out a CSS px (lighting()), read back at the screen's own pixels from
// the four nearest by their distance, those on another surface (EDGE_DEPTH nearer or farther) left out: joint
// bilateral upsampling (Kopf et al. 2007), so a piece's outline doesn't take its neighbour's light
export function glsl(o) {
  return /* glsl */`
  uniform sampler2D lightMap;
  uniform sampler2D lightDepthMap;
  uniform vec2 lightMapSize;
  uniform vec2 bufferSize;
  uniform float depthRange;   // LDU from the camera's near to its far
  uniform float lightOn;
  vec2 light() {
    if (lightOn < 0.5) return vec2(1.0);
    vec2 at = gl_FragCoord.xy / bufferSize * lightMapSize - 0.5;
    vec2 corner = floor(at), t = at - corner;
    vec2 sum = vec2(0.0);
    float weight = 0.0;
    for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
      vec2 uv = (corner + vec2(float(i), float(j)) + 0.5) / lightMapSize;
      float w = (i == 0 ? 1.0 - t.x : t.x) * (j == 0 ? 1.0 - t.y : t.y);
      if (abs(texture2D(lightDepthMap, uv).r - gl_FragCoord.z) * depthRange < ${f(o.edgeDepth)}) {
        sum += w * texture2D(lightMap, uv).rg;
        weight += w;
      }
    }
    return weight > 0.0 ? sum / weight : texture2D(lightMap, gl_FragCoord.xy / bufferSize).rg;
  }
  float open() { return light().x; }
  float shade() { return light().y; }`;
}

// The prepass: each opaque face's normal, turned to the eye, in the view's axes, as colour; its depth in the target's
function normals() {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */`
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalMatrix * normal;
        vView = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec3 face = normalize(cross(dFdx(vView), dFdy(vView)));
        if (face.z < 0.0) face = -face;
        vec3 n = normalize(vNormal);
        if (dot(n, face) < 0.0) n = -n;
        gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
      }`,
    side: THREE.DoubleSide,
  });
}

function pass(fragmentShader, extra) {
  const material = new THREE.ShaderMaterial({ uniforms: extra, vertexShader: QUAD_VERTEX, fragmentShader,
    depthTest: false, depthWrite: false });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  return { scene, uniforms: material.uniforms };
}

// The light's screen passes: a pixel's occlusion rays (occlusion.rs) and its shadow (shadow.rs), which only a face
// turned towards the key takes, then both blurred over a tile within its face: ldrender evens its shadow's turned taps
// out over a pixel's samples, the page over the tile's pixels
function occlusionPasses(o, shadow) {
  const common = /* glsl */`
    uniform sampler2D normalTex;
    uniform sampler2D depthTex;
    uniform mat4 projection;
    uniform mat4 projectionInverse;
    uniform vec2 size;
    varying vec2 vUv;
    const float RADIUS = ${f(o.radius)};
    const float THICKNESS = ${f(o.thickness)};
    const float BIAS = ${f(o.bias)};
    const float EDGE_DEPTH = ${f(o.edgeDepth)};
    const float EDGE_COSINE = ${f(o.edgeCosine)};
    #define RAYS ${asInt(o.rays)}
    #define STEPS ${asInt(o.steps)}
    #define TILE ${asInt(o.tile)}
    bool lit(vec2 uv) { return texture2D(depthTex, uv).r < 1.0; }
    vec3 viewAt(vec2 uv) {
      vec4 p = projectionInverse * vec4(uv * 2.0 - 1.0, texture2D(depthTex, uv).r * 2.0 - 1.0, 1.0);
      return p.xyz / p.w;
    }
    vec3 normalAt(vec2 uv) { return normalize(texture2D(normalTex, uv).xyz * 2.0 - 1.0); }`;
  const bayer = o.bayer.map(b => b.toFixed(1)).join(', ');
  const directions = o.directions.map(d => `vec3(${d.map(f).join(', ')})`).join(', ');
  const rays = pass(/* glsl */`${common}
    ${shadowGlsl(shadow)}
    uniform vec3 keyView;
    const float BAYER[${o.bayer.length}] = float[](${bayer});
    const vec3 DIRECTIONS[RAYS] = vec3[](${directions});
    bool hidden(vec3 s) {
      vec4 c = projection * vec4(s, 1.0);
      vec2 uv = c.xy / c.w * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x >= 1.0 || uv.y >= 1.0 || !lit(uv)) return false;
      float before = viewAt(uv).z - s.z;   // how far behind the surface there s is, LDU (the view looks down -z)
      return before > BIAS && before < THICKNESS;
    }
    void main() {
      if (!lit(vUv)) { gl_FragColor = vec4(1.0); return; }
      vec3 p = viewAt(vUv), n = normalAt(vUv);
      ivec2 px = ivec2(gl_FragCoord.xy);
      int turn = (px.y % TILE) * TILE + px.x % TILE;
      vec3 other = abs(n.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
      vec3 a = normalize(cross(n, other)), b = cross(n, a);
      float angle = 6.283185307179586 * BAYER[turn] / float(TILE * TILE);
      vec3 tx = a * cos(angle) + b * sin(angle), ty = b * cos(angle) - a * sin(angle);
      float start = BAYER[(turn * 5) % (TILE * TILE)] / float(TILE * TILE);
      float blocked = 0.0;
      for (int r = 0; r < RAYS; r++) {
        vec3 d = DIRECTIONS[r];
        vec3 along = tx * d.x + ty * d.y + n * d.z;
        for (int k = 0; k < STEPS; k++) {
          if (hidden(p + along * RADIUS * (float(k) + start) / float(STEPS))) { blocked += 1.0; break; }
        }
      }
      float shade = dot(n, keyView) > 0.0 ? seen(p, n, gl_FragCoord.xy) : 1.0;
      gl_FragColor = vec4(1.0 - blocked / float(RAYS), shade, 1.0, 1.0);
    }`, { normalTex: { value: null }, depthTex: { value: null }, projection: { value: new THREE.Matrix4() },
    projectionInverse: { value: new THREE.Matrix4() }, size: { value: new THREE.Vector2() },
    keyView: { value: new THREE.Vector3() }, shadowMap: { value: null }, viewToLight: { value: new THREE.Matrix4() },
    lightSize: { value: new THREE.Vector2(1, 1) }, lightDepth: { value: new THREE.Vector2(0, 1) }, shadowTexels: { value: 1 } });
  const blur = pass(/* glsl */`${common}
    uniform sampler2D raw;
    void main() {
      if (!lit(vUv)) { gl_FragColor = vec4(1.0); return; }
      float z = viewAt(vUv).z;
      vec3 n = normalAt(vUv);
      vec2 sum = vec2(0.0);
      float count = 0.0;
      for (int v = -TILE / 2; v < TILE - TILE / 2; v++) {
        for (int u = -TILE / 2; u < TILE - TILE / 2; u++) {
          vec2 at = vUv + vec2(float(u), float(v)) / size;
          if (!lit(at)) continue;
          if (abs(viewAt(at).z - z) < EDGE_DEPTH && dot(normalAt(at), n) > EDGE_COSINE) {
            sum += texture2D(raw, at).rg;
            count += 1.0;
          }
        }
      }
      gl_FragColor = vec4(count > 0.0 ? sum / count : vec2(1.0), 1.0, 1.0);
    }`, { normalTex: { value: null }, depthTex: { value: null }, projection: { value: new THREE.Matrix4() },
    projectionInverse: { value: new THREE.Matrix4() }, size: { value: new THREE.Vector2() }, raw: { value: null } });
  return { rays, blur };
}

// A share of the ground's light the model leaves each point of a square of the ground (squareToWorld: from the square's
// clip space), from rays marched through the model's top and bottom (inside(): below its top and above its bottom
// there) where they cross its bounding cylinder: the sky's, drawn cosine weighted, or the sun's, drawn uniform over its
// disc round sunDir and weighted by its cosine on the ground
function groundPass(rays, direction, weight) {
  return pass(/* glsl */`
    uniform sampler2D topDepth;
    uniform sampler2D bottomDepth;
    uniform mat4 worldToTop;
    uniform mat4 worldToBottom;
    uniform mat4 squareToWorld;
    uniform vec2 heights;      // the top and bottom cameras' heights, world y
    uniform vec2 heightDepth;  // their near and far, LDU
    uniform float groundY;
    uniform vec2 centre;       // the model's middle, world x and z
    uniform float radius;      // LDU: its bounding sphere's
    uniform vec3 sunDir;       // world, towards the sun
    uniform float sunCos;      // the cosine of the sun's radius
    varying vec2 vUv;
    const float GOLDEN = 2.399963229728653;
    const float STEEP = 1e-3;  // a ray spreading less than this across the ground is taken as straight up
    #define RAYS ${rays}
    #define STEPS ${STEPS}
    // LDU from a camera to the model along its look at world point q, or -1 where none is
    float seenAt(sampler2D depth, mat4 toCamera, vec3 q) {
      vec4 c = toCamera * vec4(q, 1.0);
      vec2 uv = c.xy / c.w * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return -1.0;
      float d = texture2D(depth, uv).r;
      return d >= 1.0 ? -1.0 : mix(heightDepth.x, heightDepth.y, d);
    }
    bool inside(vec3 q) {
      float top = seenAt(topDepth, worldToTop, q), bottom = seenAt(bottomDepth, worldToBottom, q);
      return top >= 0.0 && bottom >= 0.0 && q.y <= heights.x - top && q.y >= heights.y + bottom;
    }
    vec3 around(vec3 axis, float cosine, float a) {
      vec3 other = abs(axis.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      vec3 x = normalize(cross(axis, other)), y = cross(axis, x);
      float sine = sqrt(max(1.0 - cosine * cosine, 0.0));
      return axis * cosine + (x * cos(a) + y * sin(a)) * sine;
    }
    void main() {
      vec4 w = squareToWorld * vec4(vUv * 2.0 - 1.0, 0.0, 1.0);
      vec3 g = vec3(w.x / w.w, groundY, w.z / w.w);
      float rise = heights.x - groundY;
      vec2 from = g.xz - centre;
      float open = 0.0, all = 0.0;
      for (int k = 0; k < RAYS; k++) {
        float u = (float(k) + 0.5) / float(RAYS), a = GOLDEN * float(k);
        vec3 d = ${direction};
        if (d.y <= 0.0) continue;
        // only where the ray is within the model's bounding cylinder and below its top can the model hide it
        float r2 = dot(d.xz, d.xz), b = dot(from, d.xz), c = dot(from, from) - radius * radius;
        float enter = 0.0, leave = rise / d.y;
        if (r2 > STEEP * STEEP) {
          float disc = b * b - r2 * c;
          if (disc < 0.0) leave = 0.0;
          else {
            enter = max((-b - sqrt(disc)) / r2, 0.0);
            leave = min((-b + sqrt(disc)) / r2, leave);
          }
        } else if (c > 0.0) leave = 0.0;
        bool hidden = false;
        for (int s = 0; s < STEPS && enter < leave; s++) {
          float t = (float(s) + 0.5) / float(STEPS);
          if (inside(g + d * mix(enter, leave, t * t))) { hidden = true; break; }
        }
        all += ${weight};
        if (!hidden) open += ${weight};
      }
      gl_FragColor = vec4(all > 0.0 ? open / all : 1.0, 0.0, 0.0, 1.0);
    }`, { topDepth: { value: null }, bottomDepth: { value: null }, worldToTop: { value: new THREE.Matrix4() },
    worldToBottom: { value: new THREE.Matrix4() }, squareToWorld: { value: new THREE.Matrix4() },
    heights: { value: new THREE.Vector2() }, heightDepth: { value: new THREE.Vector2() }, groundY: { value: 0 },
    centre: { value: new THREE.Vector2() }, radius: { value: 1 }, sunDir: { value: new THREE.Vector3(0, 1, 0) },
    sunCos: { value: 1 } });
}

function nearest(w, h, depth) {
  const t = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: depth, depthTexture: depth ? new THREE.DepthTexture(w, h, THREE.UnsignedIntType) : null });
  if (depth) t.depthTexture.minFilter = t.depthTexture.magFilter = THREE.NearestFilter;
  return t;
}

// Sets ldrender's constants (NUMBER.json's look.gloss): the passes are made from them
export function setLight(gloss) {
  if (constants && JSON.stringify(constants) === JSON.stringify(gloss)) return;
  constants = gloss;
  if (targets) for (const t of targets.all) t.dispose();
  const shadow = nearest(1, 1, true), top = nearest(HEIGHT_SIDE, HEIGHT_SIDE, true), bottom = nearest(HEIGHT_SIDE, HEIGHT_SIDE, true);
  const share = () => new THREE.WebGLRenderTarget(GROUND_SIDE, GROUND_SIDE, { depthBuffer: false });
  const sky = share(), sun = share();
  const kept = [shadow, top, bottom, sky, sun];
  targets = { shadow, top, bottom, sky, sun, kept, normal: null, raw: null, open: null, all: kept,
    passes: { ...occlusionPasses(gloss.occlusion, gloss.shadow),
      // the sky cosine weighted; the sun's disc uniform in solid angle, as trace.rs Sun::sample() draws it
      sky: groundPass(SKY_RAYS, 'vec3(sqrt(u) * cos(a), sqrt(1.0 - u), sqrt(u) * sin(a))', '1.0'),
      sun: groundPass(SUN_RAYS, 'around(sunDir, 1.0 - u * (1.0 - sunCos), a)', 'd.y') },
    prepass: normals(), depthOnly: new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }) };
  groundUniforms.skyTex.value = sky.texture;
  groundUniforms.sunTex.value = sun.texture;
  signature = skySignature = '';
}

function occlusionTargets(w, h) {
  if (targets.normal && targets.normal.width === w && targets.normal.height === h) return;
  for (const t of [targets.normal, targets.raw, targets.open]) t?.dispose();
  targets.normal = nearest(w, h, true);
  targets.raw = nearest(w, h, false);
  targets.open = nearest(w, h, false);
  targets.all = [...targets.kept, targets.normal, targets.raw, targets.open];
}

function drawn(renderer, scene, camera, target, material) {
  const mask = camera.layers.mask, background = scene.background, override = scene.overrideMaterial;
  camera.layers.set(SOLID);
  scene.background = null;
  scene.overrideMaterial = material;
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, camera);
  camera.layers.mask = mask;
  scene.background = background;
  scene.overrideMaterial = override;
}

function stateOf(camera, group, buffer) {
  // what the shadow and occlusion depend on: the camera, where the pieces are (and whether they're shown: brick by
  // brick hides the ones still to come, ADR-0092) and the screen's size
  const places = [];
  group.traverse(o => { if (o.parent === group) places.push(o.position.x, o.position.y, o.position.z, Number(o.visible)); });
  group.updateWorldMatrix(true, false);
  return [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements, ...group.matrixWorld.elements, ...places,
    buffer.x, buffer.y].map(v => v.toFixed(3)).join();
}

function placesOf(group) {
  // what the sky's share of the ground depends on: where the pieces are
  const places = [];
  group.traverse(o => { if (o.parent === group) places.push(o.position.x, o.position.y, o.position.z, Number(o.visible)); });
  group.updateWorldMatrix(true, true);
  return [...group.matrixWorld.elements, ...places].map(v => v.toFixed(3)).join();
}

function shownIn(o, group) {
  // whether o is drawn: it and each of its parents up to group visible
  for (let p = o; p && p !== group; p = p.parent) if (!p.visible) return false;
  return true;
}

function solidBox(group) {
  // the box round the opaque faces (what stands on the ground and hides the light), world
  const box = new THREE.Box3(), part = new THREE.Box3();
  group.traverse(o => {
    if (!o.isMesh || !o.layers.isEnabled(SOLID) || !shownIn(o, group)) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    box.union(part.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld));
  });
  return box;
}

function looking(camera, from, to, up) {
  camera.position.copy(from);
  camera.up.copy(up);
  camera.lookAt(to);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

const toCamera = c => new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
const NORTH = new THREE.Vector3(0, 0, -1);   // the top of the pictures taken straight down or up

function square(at, y, half) {
  // a square of the ground round at (x, z), as a camera straight down on it sees it
  const c = new THREE.OrthographicCamera(-half, half, half, -half, 0, 1);
  return looking(c, new THREE.Vector3(at.x, y + 1, at.z), new THREE.Vector3(at.x, y, at.z), NORTH);
}

function drawShare(renderer, step, target, place) {
  const u = step.uniforms, g = ground.userData;
  u.topDepth.value = targets.top.depthTexture;
  u.bottomDepth.value = targets.bottom.depthTexture;
  u.worldToTop.value.copy(g.worldToTop);
  u.worldToBottom.value.copy(g.worldToBottom);
  u.squareToWorld.value.copy(place).invert();
  u.heights.value.copy(g.heights);
  u.heightDepth.value.copy(g.heightDepth);
  u.groundY.value = g.box.min.y;
  u.centre.value.set(g.sphere.center.x, g.sphere.center.z);
  u.radius.value = g.sphere.radius;
  renderer.setRenderTarget(target);
  renderer.render(step.scene, quadCamera);
}

function catchSky(renderer, scene, group) {
  // the ground at the model's lowest point, the model's top and bottom over it, and the sky's share of the ground round
  // the model; no ground where there is no model
  const box = solidBox(group);
  ground.visible = !box.isEmpty();
  if (!ground.visible) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere()), c = sphere.center, r = sphere.radius;
  const depth = box.max.y - box.min.y + 2 * HEIGHT_ROOM;
  const top = looking(new THREE.OrthographicCamera(-r, r, r, -r, 0, depth), new THREE.Vector3(c.x, box.max.y + HEIGHT_ROOM, c.z),
    new THREE.Vector3(c.x, box.min.y, c.z), NORTH);
  const bottom = looking(new THREE.OrthographicCamera(-r, r, r, -r, 0, depth), new THREE.Vector3(c.x, box.min.y - HEIGHT_ROOM, c.z),
    new THREE.Vector3(c.x, box.max.y, c.z), NORTH);
  drawn(renderer, scene, top, targets.top, targets.depthOnly);
  drawn(renderer, scene, bottom, targets.bottom, targets.depthOnly);
  const sky = toCamera(square(c, box.min.y, r * GROUND_REACH));
  Object.assign(ground.userData, { box, sphere, worldToTop: toCamera(top), worldToBottom: toCamera(bottom),
    heights: new THREE.Vector2(top.position.y, bottom.position.y), heightDepth: new THREE.Vector2(0, depth) });
  drawShare(renderer, targets.passes.sky, targets.sky, sky);
  groundUniforms.worldToSky.value.copy(sky);
}

function catchSun(renderer, camera, keyView) {
  // the sun's share of the ground, round where the model's shadow falls along the key, which follows the camera; and
  // the ground as large as both shares
  if (!ground.visible) return;
  const { box, sphere } = ground.userData;
  const key = keyView.clone().transformDirection(camera.matrixWorld);
  const reach = sphere.radius * GROUND_REACH;
  const rise = sphere.center.y - box.min.y;
  // where the key casts the model's middle, at most reach from under it
  const fall = new THREE.Vector2(-key.x, -key.z).multiplyScalar(rise / Math.max(key.y, rise / reach));
  const at = new THREE.Vector3(sphere.center.x + fall.x, 0, sphere.center.z + fall.y);
  const sun = toCamera(square(at, box.min.y, reach));
  const step = targets.passes.sun;
  step.uniforms.sunDir.value.copy(key);
  step.uniforms.sunCos.value = Math.cos(THREE.MathUtils.degToRad(constants.catcher.sunDiameter / 2));
  drawShare(renderer, step, targets.sun, sun);
  groundUniforms.worldToSun.value.copy(sun);
  groundUniforms.sunLight.value = constants.catcher.sunIrradiance * Math.max(key.y, 0);
  const middle = new THREE.Vector3(sphere.center.x + fall.x / 2, box.min.y, sphere.center.z + fall.y / 2);
  ground.position.copy(middle);
  ground.scale.setScalar(reach + fall.length() / 2);
  ground.updateMatrixWorld();
}

function castShadow(renderer, scene, camera, group, keyView) {
  // the shadow map along the key light (shadow.rs Shadow::new()), over the model's bounding sphere and REACH round it
  const s = constants.shadow;
  const sphere = new THREE.Box3().setFromObject(group).getBoundingSphere(new THREE.Sphere());
  const half = sphere.radius + s.reach;
  const side = Math.min(PAGE_MAX_SIDE, s.maxSide, Math.ceil(2 * half / s.texel));
  if (targets.shadow.width !== side) targets.shadow.setSize(side, side);
  const key = keyView.clone().transformDirection(camera.matrixWorld);
  const light = new THREE.OrthographicCamera(-half, half, half, -half, 0, 2 * LIGHT_ROOM * sphere.radius + 2 * s.reach);
  light.position.copy(sphere.center).addScaledVector(key, LIGHT_ROOM * sphere.radius + s.reach);
  light.up.set(Math.abs(key.y) < 0.9 ? 0 : 1, Math.abs(key.y) < 0.9 ? 1 : 0, 0);
  light.lookAt(sphere.center);
  light.updateMatrixWorld();
  light.updateProjectionMatrix();
  drawn(renderer, scene, light, targets.shadow, targets.depthOnly);
  const u = targets.passes.rays.uniforms;
  u.shadowMap.value = targets.shadow.depthTexture;
  u.viewToLight.value.multiplyMatrices(light.matrixWorldInverse, camera.matrixWorld);
  u.lightSize.value.set(2 * half, 2 * half);
  u.lightDepth.value.set(light.near, light.far);
  u.shadowTexels.value = side / (2 * half);
  u.keyView.value.copy(keyView);
}

function lighting(renderer, scene, camera, buffer) {
  // the occlusion and the shadow at a pixel a CSS px (ldrender works each out once a pixel of its supersampled
  // picture), after the shadow map (castShadow())
  const k = renderer.getPixelRatio();
  const w = Math.max(1, Math.round(buffer.x / k)), h = Math.max(1, Math.round(buffer.y / k));
  occlusionTargets(w, h);
  drawn(renderer, scene, camera, targets.normal, targets.prepass);
  const { rays, blur } = targets.passes;
  for (const step of [rays, blur]) {
    step.uniforms.normalTex.value = targets.normal.texture;
    step.uniforms.depthTex.value = targets.normal.depthTexture;
    step.uniforms.projection.value.copy(camera.projectionMatrix);
    step.uniforms.projectionInverse.value.copy(camera.projectionMatrixInverse);
    step.uniforms.size.value.set(w, h);
  }
  blur.uniforms.raw.value = targets.raw.texture;
  renderer.setRenderTarget(targets.raw);
  renderer.render(rays.scene, quadCamera);
  renderer.setRenderTarget(targets.open);
  renderer.render(blur.scene, quadCamera);
  uniforms.lightMap.value = targets.open.texture;
  uniforms.lightDepthMap.value = targets.normal.depthTexture;
  uniforms.lightMapSize.value.set(w, h);
  uniforms.depthRange.value = camera.far - camera.near;
  uniforms.lightOn.value = 1;
}

// Works out the shadow and occlusion of the picture shown (group) as the camera sees it, when either has moved since:
// keyView is the key light's direction in the view (look.js); whether it drew them
export function updateLight(renderer, scene, camera, group, keyView) {
  if (!constants || !group) return false;
  const buffer = renderer.getDrawingBufferSize(new THREE.Vector2());
  uniforms.bufferSize.value.copy(buffer);
  const now = stateOf(camera, group, buffer) + keyView.toArray().join();
  if (now === signature) return false;
  signature = now;
  const target = renderer.getRenderTarget(), clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
  const places = placesOf(group);
  if (places !== skySignature) {
    skySignature = places;
    catchSky(renderer, scene, group);
  }
  catchSun(renderer, camera, keyView);
  castShadow(renderer, scene, camera, group, keyView);
  lighting(renderer, scene, camera, buffer);
  renderer.setRenderTarget(target);
  renderer.setClearColor(clear, alpha);
  return true;
}
