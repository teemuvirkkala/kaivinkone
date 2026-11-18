// The gloss look's shadow and occlusion on the 3D page (ADR-0070), as ldrender works them out for the cover's look:
// the model's shadow from the key light (renderer/src/shadow.rs: a shadow map along the key, its edge softened by
// percentage-closer filtering over a disc that grows with how far a point is behind what shadows it, compared on the
// point's own face's plane), which takes the key's light and highlight; and its ambient occlusion
// (renderer/src/occlusion.rs: rays marched into the half of the sky a face's normal faces, hidden where a step along
// one is behind the picture's surface there, blurred over a tile within a face), which takes the light its colour gives
// back of the key and the sky. Both are worked out again only when the camera or a piece moves. The constants are
// ldrender's (NUMBER.json's look.gloss.shadow and .occlusion, `ldrender --gloss`).
import * as THREE from 'three';

export const SOLID = 4;      // the layer of the pieces' opaque faces: what casts a shadow and hides the sky (glass doesn't)
const PAGE_MAX_SIDE = 2048;  // texels: the shadow map's side at most on the page, a phone's memory (ldrender: 4096)
const LIGHT_ROOM = 2.0;      // the light's camera stands this many times the model's radius from its middle

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

const asInt = v => Math.round(v);
const f = v => Number(v).toFixed(6);

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
  const shadow = nearest(1, 1, true);
  targets = { shadow, normal: null, raw: null, open: null, passes: occlusionPasses(gloss.occlusion, gloss.shadow), all: [shadow],
    prepass: normals(), depthOnly: new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }) };
  signature = '';
}

function occlusionTargets(w, h) {
  if (targets.normal && targets.normal.width === w && targets.normal.height === h) return;
  for (const t of [targets.normal, targets.raw, targets.open]) t?.dispose();
  targets.normal = nearest(w, h, true);
  targets.raw = nearest(w, h, false);
  targets.open = nearest(w, h, false);
  targets.all = [targets.shadow, targets.normal, targets.raw, targets.open];
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
  // what the shadow and occlusion depend on: the camera, where the pieces are and the screen's size
  const places = [];
  group.traverse(o => { if (o.parent === group) places.push(o.position.x, o.position.y, o.position.z); });
  group.updateWorldMatrix(true, false);
  return [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements, ...group.matrixWorld.elements, ...places,
    buffer.x, buffer.y].map(v => v.toFixed(3)).join();
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
  castShadow(renderer, scene, camera, group, keyView);
  lighting(renderer, scene, camera, buffer);
  renderer.setRenderTarget(target);
  renderer.setClearColor(clear, alpha);
  return true;
}
