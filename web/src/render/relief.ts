// Relief (three.js, WebGL2): a surface whose height is a probability.
// Loaded with import() after the rest of the page, so three.js stays in a
// chunk of its own.
//
//              y: height = probability (0..1 → 0..H)
//              ▲
//              │      ▲ crest: the model is sure
//              │   ▁▂█▂▁        ▂▃▂▂ plateau: it hesitates
//   z: rows    └──────────────────────────► x: position of the viewed path,
//   (back = -z)                               the same axis as the Timeline
//
// Rows, along z (the camera starts on the +z side, so -z is the back):
//   Alternatives: candidate 0 (the most likely) at the back, the less likely
//                 ones in front of it, so the crest does not hide the plateau.
//   Layers:       the first lens layer in front, the last at the back.
//
// Geometry: a grid of `capacity × rows` vertices per surface, written in grid
// units (x = column + 0.5, y = height 0..1, z = row) and mapped to the world by
// the transform of one group, so the axis can compress as the path grows
// without touching the buffers. Index buffers are fixed for the capacity and
// `setDrawRange` shows the columns in use. Only the y of the changed columns
// and their tones are uploaded.
//
// Look: almost black by default, lit only where there is something to see.
// Heights are sqrt(p) (relief-data.ts). Each vertex carries its model's
// colour, the doubt and the divergence of its column (0..1) and the height
// of the column's crest; the surface shader paints, from the height h:
//
//   ground    near black; the model's hue grows on the slopes (h^2.2, up
//             to about half of it on the crests),
//             shaded by a fixed light from the screen-space normal (no
//             normal buffer to keep up to date)
//   isolines  thin topographic lines every 0.1 of height, in the hue, fading
//             where the slope is too steep for them
//   doubt     the crest of a hesitant column turns near white, over 1, so
//             the bloom picks it up; a sure column's crest stays in its hue
//   magenta   a column where the models parted: a faint magenta trench and a
//             magenta crest, over 1 where they picked different tokens
//
// The other model's surface (Alternatives, two models) is only its isolines
// over a faint fill, so the front one shows through. The bloom's threshold
// is high: only white and magenta crests, the cut of the selected column and
// the light plane's edges glow. The floor is one quad whose shader draws a
// fine grid that fades away from the relief; the background is a faint radial
// glow over the panel colour, and a light fog dims what lies far from the
// camera.
//
//        background: COLOR.bg at the edges, a little lighter behind the relief
//      ┌───────────────────────────────────────────────┐
//      │            ░░▒▒▓▓ surface ▓▓▒▒░░              │
//      │   ·  ·  · ─┴──────────────────────┴─ ·  ·  ·  │  floor grid, fading
//      └───────────────────────────────────────────────┘
//
// Paints only when something changes (data, selection, size, the camera,
// animation 4) and only while the panel is visible. Nothing is allocated per
// frame, except the label styles.
//
// Framing (relief-data.ts reliefShape, fitDistance): the box's depth, height
// and the camera's elevation follow the panel's aspect; the camera looks at
// the box's centre from the distance where all its corners fit, at the front
// and at both ends of the automatic swing. It is fitted again on resize, on
// a change of source and on resetView(). Until the user takes the camera, a
// new fit also restores the default elevation and zoom of the new shape. The
// mouse can turn it up to ±60°, tilt it between almost top-down and almost
// level, and zoom within a range around the fitted distance.

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  EdgesGeometry,
  Fog,
  Group,
  HalfFloatType,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { Slot, Store } from '../store/store';
import { showWhitespace, tokenLabel } from '../store/text';
import type { View } from '../store/view';
import { modelFigures, pairFigures, pctShort } from './compare';
import { downloadBlob, downloadText, stamp, svgDocument, svgToPngBlob } from './export';
import { decisionLayer, finalTop } from './lens-data';
import {
  CHIP_GAP,
  estimateWidth,
  notesSvg,
  rulerTicks,
  spreadChips,
  strideRows,
  tickPositions,
  cardSize,
  type CardNote,
  type Measure,
  type Notes,
  type Part,
} from './relief-notes';
import {
  AMBIENT,
  CLIFF_DIM,
  DIS_GAIN,
  DIS_LOW,
  DIS_MIX,
  GROUND,
  LIGHT_DIR,
  PLANE_RISE,
  RAMP,
  RIM,
  sceneSvg,
  STEEP,
  TOP,
  WHITE,
  WHITE_FROM,
  WHITE_MIX,
} from './relief-svg';
import {
  fitDistance,
  growDuration,
  growFactor,
  pOf,
  RELIEF_W,
  ReliefData,
  reliefShape,
  type ReliefSource,
} from './relief-data';
import { Pace } from './pace';
import { COLOR, FONT, FONT_UI, MODEL_COLOR } from './theme';
import { axisSpan } from './timeline';

// World size of the relief: x across the positions, z across the rows, y up.
// The width is fixed; depth and height follow the shape of the panel (see
// reshape), so a long strip gets a low relief and the full screen a tall one.
const W = RELIEF_W;
// Horizontal field of view, degrees. The vertical one follows from the shape
// of the panel: fixing it instead would make a long strip a fisheye. Narrow
// enough that the far edge is not much shorter than the near one, so the
// relief fills a wide dock instead of shrinking to a trapezoid.
const FOV_X = 36;
// The fitted box takes this much of the view: less in height, so the axis
// labels under the front edge stay inside the panel.
const MARGIN_X = 0.94;
const MARGIN_Y = 0.86;
// The camera orbits by itself, slowly, swinging around the front between
// -sway and sway: seen from its end the relief is a sliver. The swing is
// short on a wide strip and wide on a tall panel (reliefShape).
// The swing eases out towards each end and back, like a pendulum; its
// speed follows its width, so a short swing is not a jitter.
const ORBIT_MIN = 0.008; // rad/s at the middle of the swing
const ORBIT_MAX = 0.026;
const ORBIT_EASE = 0.8; // how much slower at the ends
// What the mouse may do, so the view never gets lost.
const AZIMUTH_LIMIT = Math.PI / 3; // ±60° around the front
const POLAR_MIN = 0.22; // almost top-down
const POLAR_MAX = Math.PI / 2 - 0.05; // almost level, never under the floor
const ZOOM_IN = 0.07; // distance limits, times the fitted distance: close enough to read one column
const ZOOM_OUT = 2.6;
const RESET_MS = 520;
const LABEL_CHARS = 14;

// The surface's colours (heights to hue, shading, doubt, cliffs, divergence)
// are the constants of relief-svg.ts, shared with the vector export; see
// there for what each one does.
const LIGHT = new Vector3(...LIGHT_DIR);
// Isolines: ISO_STEPS per unit of height, added as ISO_GAIN of the hue (under
// the bloom). Lines that would be wider than ISO_FADE of their spacing per
// pixel (a cliff) fade out; none on the flat ground under ISO_MIN.
const ISO_STEPS = 10;
const ISO_GAIN = 0.22;
const ISO_FADE = [0.12, 0.3] as const;
const ISO_MIN = 0.02;
// The divergence's magenta, for the shader.
const DIS = new Color(COLOR.dis);
// The other model's surface: its isolines, over a fill this opaque.
const BACK_FILL = 0.06;
const BACK_LINE = 0.7;
// Bloom: strength, radius, luminance threshold. Over the threshold: white
// and magenta crests, the cut of the selected column and the plane's edges.
const BLOOM = [0.48, 0.35, 0.9] as const;

// ------------------------------------------------------------- shaders

// GLSL float literal.
const f = (v: number): string => (Number.isInteger(v) ? v.toFixed(1) : String(v));

// Attributes, per vertex but equal along a column: tone (rgb: the model's
// colour, linear; a: the column's doubt) and mark (x: the column's
// divergence; y: the height of its crest). LINES_ONLY: the other model's
// surface, isolines over a faint fill, without doubt or magenta.
const SURFACE_VERT = /* glsl */ `
attribute vec4 tone;
attribute vec2 mark;
varying vec4 vTone;
varying vec2 vMark;
varying float vH;
varying vec3 vWorld;
#include <common>
#include <fog_pars_vertex>
void main() {
  vTone = tone;
  vMark = mark;
  vH = position.y; // grid units: the height, growth included
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const SURFACE_FRAG = /* glsl */ `
varying vec4 vTone;
varying vec2 vMark;
varying float vH;
varying vec3 vWorld;
#include <common>
#include <fog_pars_fragment>
// Thin lines every 1 / ISO_STEPS of height, about a pixel wide.
float isolines(float h) {
  float v = h * ${f(ISO_STEPS)};
  float w = fwidth(v);
  float d = abs(fract(v - 0.5) - 0.5) / max(w, 1e-5);
  return (1.0 - smoothstep(0.0, 1.0, d)) * (1.0 - smoothstep(${f(ISO_FADE[0])}, ${f(ISO_FADE[1])}, w)) * step(${f(ISO_MIN)}, h);
}
void main() {
  float h = clamp(vH, 0.0, 1.0);
  vec3 hue = vTone.rgb;
  float iso = isolines(h);
#ifdef LINES_ONLY
  vec3 c = hue * (0.35 + 0.65 * iso);
  float a = ${f(BACK_FILL)} + ${f(BACK_LINE)} * iso;
#else
  // Normal from the screen-space slope; a height field faces up.
  vec3 cr = cross(dFdx(vWorld), dFdy(vWorld));
  float len = length(cr);
  vec3 n = len > 1e-12 ? cr / len : vec3(0.0, 1.0, 0.0);
  if (n.y < 0.0) n = -n;
  float diffuse = max(dot(n, vec3(${f(LIGHT.x)}, ${f(LIGHT.y)}, ${f(LIGHT.z)})), 0.0);
  float shade = ${f(AMBIENT)} + ${f(1 - AMBIENT)} * diffuse;
  // Height relative to the column's crest: 1 on the crest.
  float top = vMark.y > 1e-3 ? clamp(h / vMark.y, 0.0, 1.0) : 0.0;
  float level = smoothstep(${f(STEEP[0])}, ${f(STEEP[1])}, n.y);
  float cliff = mix(mix(${f(CLIFF_DIM)}, 1.0, smoothstep(${f(RIM)}, 1.0, top)), 1.0, level);
  vec3 c = hue * (${f(GROUND)} + ${f(TOP - GROUND)} * pow(h, ${f(RAMP)})) * shade * cliff;
  float white = smoothstep(${f(WHITE_FROM)}, 1.0, top) * vTone.a;
  c = mix(c, vec3(${f(WHITE)}), white * ${f(WHITE_MIX)});
  c += hue * ${f(ISO_GAIN)} * iso * level; // on a cliff they would read as a fence
  vec3 dis = vec3(${f(DIS.r)}, ${f(DIS.g)}, ${f(DIS.b)}) * (${f(DIS_LOW)} + ${f(DIS_GAIN)} * vMark.x * top) * cliff;
  c = mix(c, dis, vMark.x * ${f(DIS_MIX)});
  float a = 1.0;
#endif
  gl_FragColor = vec4(c, a);
  #include <fog_fragment>
}
`;

// Floor: a fine grid, square cells of `cell` world units with a stronger line
// every fourth, aligned on the relief's front-left corner. Lines that crowd
// together in the distance fade out instead of shimmering, and the whole grid
// fades with the distance from the relief's outline.
const FLOOR_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FLOOR_FRAG = /* glsl */ `
uniform vec2 halfSize;
uniform float cell;
uniform float fade;
uniform vec3 minor;
uniform vec3 major;
uniform vec3 glow;
varying vec3 vWorld;
float lines(vec2 q) {
  vec2 w = max(fwidth(q), vec2(1e-5));
  vec2 g = abs(fract(q - 0.5) - 0.5) / w; // px to the nearest line
  vec2 keep = 1.0 - smoothstep(0.12, 0.3, w);
  vec2 v = (1.0 - min(g, 1.0)) * keep;
  return max(v.x, v.y);
}
void main() {
  vec2 p = vWorld.xz;
  vec2 q = vec2(p.x + halfSize.x, p.y - halfSize.y) / cell;
  float mi = lines(q);
  float ma = lines(q * 0.25);
  vec2 o = max(abs(p) - halfSize, 0.0);
  float away = 1.0 - smoothstep(0.0, fade, length(o));
  float la = max(mi * 0.32, ma * 0.6) * away;
  vec3 lc = mix(minor, major, step(mi * 0.32, ma * 0.6));
  // A faint pool of light under the relief.
  vec2 r = p / (halfSize + vec2(fade * 0.5));
  float pa = 0.07 * exp(-2.2 * dot(r, r));
  float a = la + pa * (1.0 - la);
  vec3 c = (lc * la + glow * pa * (1.0 - la)) / max(a, 1e-4);
  gl_FragColor = vec4(c, a);
}
`;

// Light plane: a veil, brighter near the floor; its edges are lines.
const PLANE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const PLANE_FRAG = /* glsl */ `
uniform vec3 color;
uniform float fill;
varying vec2 vUv;
void main() {
  float up = 1.0 - vUv.y;
  gl_FragColor = vec4(color, fill * (0.15 + 0.85 * up * up));
}
`;

function surfaceMaterial(linesOnly: boolean, offset: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: UniformsUtils.merge([UniformsLib.fog]),
    vertexShader: SURFACE_VERT,
    fragmentShader: SURFACE_FRAG,
    defines: linesOnly ? { LINES_ONLY: '' } : {},
    fog: true,
    side: DoubleSide,
    transparent: linesOnly,
    depthWrite: !linesOnly,
    // Pushed back so the lines on it never flicker; the other model's
    // further back still: where both coincide the front one shows, and the
    // other model shows where it stands above.
    polygonOffset: true,
    polygonOffsetFactor: offset,
    polygonOffsetUnits: offset,
  });
}

// A faint radial glow behind the relief, over the panel's colour: the edges
// are exactly COLOR.bg, so the canvas melts into the panel.
function backdrop(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = COLOR.bg;
    ctx.fillRect(0, 0, 256, 128);
    const g = ctx.createRadialGradient(128, 52, 0, 128, 52, 132);
    g.addColorStop(0, '#0d1730');
    g.addColorStop(0.45, '#0a1124');
    g.addColorStop(1, COLOR.bg);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 128);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export class Relief {
  private readonly renderer: WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV_X, 1, 0.5, 400);
  private readonly controls: OrbitControls;
  private readonly observer: ResizeObserver;
  private readonly reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly data = new ReliefData();
  private readonly fog = new Fog(COLOR.bg, 30, 60);

  // Grid units → world: x by the axis span, y by the height, z by the rows.
  private readonly grid = new Group();
  private readonly frontMat: ShaderMaterial;
  private readonly backMat: ShaderMaterial;
  private readonly lineMat: LineBasicMaterial;
  private readonly front: Mesh;
  private readonly back: Mesh;
  private readonly lines: LineSegments;
  private readonly profile: Line; // the selected column's cut, on the front surface
  private readonly outline: LineSegments;
  private readonly floor: Mesh;
  private readonly floorMat: ShaderMaterial;
  private readonly plane: Mesh; // the light plane at the selected position
  private readonly planeMat: ShaderMaterial;
  private readonly edgeMat: LineBasicMaterial;
  private readonly statics: { dispose(): void }[] = []; // geometries, materials, textures and passes

  // Buffers of the current layout (capacity × rows).
  private cap = 0;
  private rows = 0;
  private posF = new Float32Array(0);
  private toneF = new Float32Array(0);
  private posB = new Float32Array(0);
  private toneB = new Float32Array(0);
  private mark = new Float32Array(0); // shared by both surfaces
  private prof = new Float32Array(0);
  private attrs: BufferAttribute[] = []; // posF, toneF, posB, toneB, mark

  private readonly tones = MODEL_COLOR.map((c) => new Color(c));
  private backTone = 1;
  private span = 1;
  private d = 4; // world depth (z) and height (y) of the relief
  private hh = 3;
  private elevation = 0.4; // default camera angle above the floor
  private sway = 0.1; // half the swing of the automatic orbit, radians
  private orbitSpeed = 0.1; // its speed at the middle, OrbitControls units
  private orbitDir = 1; // 1: towards -sway, -1: towards +sway
  private fitDist = 30; // fitted camera distance (0 until the first fit)
  private fitted = false;
  private user = false; // the user has moved the camera since the last default view
  private backFirst = true; // row 0 at the back (Alternatives)
  private shownSource: ReliefSource | null = null;

  // resetView(): the camera moving back to the fitted default.
  private resetT0 = -1; // -1: not moving
  private readonly from = { r: 0, phi: 0, theta: 0 };

  private key = '';
  private sel = -2;
  private pinned = false;
  private needs = true;
  private lost = false;
  private w = 0;
  private h = 0;
  private lastNow = 0;

  // Animation 4: the column growing from zero, or -1.
  private growCol = -1;
  private growK = 1;
  private growT0 = 0;
  private growDur = 0;
  private readonly pace = new Pace();

  // The annotations over the canvas (see relief-notes.ts): one SVG, rewritten
  // whenever the picture is.
  private readonly notesEl: SVGSVGElement;
  private info = true; // ticks, ruler, info card, legend and hover card
  private disagreements = 0; // positions of the viewed path where the models picked differently
  private readonly home = new Vector3(); // the camera's target at the default view
  private readonly fromTarget = new Vector3();
  private readonly v = new Vector3();
  private readonly v2 = new Vector3();
  private readonly ray = new Raycaster();
  private readonly ndc = new Vector2();
  private hover: { col: number; row: number; x: number; y: number } | null = null;
  private down: { x: number; y: number } | null = null; // pointer at the press, to tell a click from a drag
  private measureCtx: CanvasRenderingContext2D | null = null;
  private lastNotes = '';
  private pickStale = true; // the surface moved: its bounds must be computed again
  private pending: PointerEvent | null = null; // the last pointer move not yet handled
  private pickFrame = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    labelBox: HTMLElement,
    private readonly store: Store,
    private readonly view: View,
    private readonly source: () => ReliefSource,
  ) {
    // Throws without WebGL2; the caller leaves the panel empty then.
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(pr);
    const bg = backdrop();
    this.scene.background = bg;
    this.scene.fog = this.fog;
    this.statics.push(bg);

    // Bloom: only the bright crests glow. The render target keeps
    // multisampling, which the composer would otherwise lose.
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.setPixelRatio(pr);
    const passes = [
      new RenderPass(this.scene, this.camera),
      new UnrealBloomPass(new Vector2(1, 1), BLOOM[0], BLOOM[1], BLOOM[2]),
      new OutputPass(),
    ];
    for (const pass of passes) this.composer.addPass(pass);
    this.statics.push(...passes);

    this.frontMat = surfaceMaterial(false, 1);
    this.backMat = surfaceMaterial(true, 2);
    // Row lines on the front surface: a faint mesh that shows the rows.
    this.lineMat = new LineBasicMaterial({ color: COLOR.high, transparent: true, opacity: 0.06, depthWrite: false });
    this.front = new Mesh(new BufferGeometry(), this.frontMat);
    this.back = new Mesh(new BufferGeometry(), this.backMat);
    this.lines = new LineSegments(new BufferGeometry(), this.lineMat);
    // The cut of the selected column: a bright line over the surface, well
    // over 1 so the bloom makes it glow.
    const profMat = new LineBasicMaterial({ color: new Color(COLOR.high).multiplyScalar(2), transparent: true, depthWrite: false });
    this.profile = new Line(new BufferGeometry(), profMat);
    this.statics.push(profMat);
    this.back.renderOrder = 1;
    this.profile.renderOrder = 3;
    for (const o of [this.front, this.back, this.lines, this.profile]) {
      o.frustumCulled = false; // bounds change with every step
      o.visible = false; // until there is data (refresh)
      this.grid.add(o);
    }
    this.scene.add(this.grid);

    // The floor: a quad under the relief and well beyond it, a little under
    // y = 0 so the flat ground of the surface never fights it. Scaled by
    // reshape; drawn before everything else.
    const floorGeo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.floorMat = new ShaderMaterial({
      uniforms: {
        halfSize: { value: new Vector2(W / 2, 2) },
        cell: { value: W / 40 },
        fade: { value: W * 0.22 },
        minor: { value: new Color(COLOR.lineStrong) },
        major: { value: new Color(COLOR.lineStrong).lerp(new Color(COLOR.muted), 0.35) },
        glow: { value: new Color(COLOR.a).lerp(new Color(COLOR.surface3), 0.6) },
      },
      vertexShader: FLOOR_VERT,
      fragmentShader: FLOOR_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.floor = new Mesh(floorGeo, this.floorMat);
    this.floor.position.y = -0.02;
    this.floor.renderOrder = -1;
    this.scene.add(this.floor);

    // The outline of the whole axis, as wide as the Timeline's: discreet.
    const outGeo = new BufferGeometry();
    const fx = 0.5; // a unit square, scaled by reshape
    const fz = 0.5;
    outGeo.setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([-fx, 0, -fz, fx, 0, -fz, fx, 0, -fz, fx, 0, fz, fx, 0, fz, -fx, 0, fz, -fx, 0, fz, -fx, 0, -fz]),
        3,
      ),
    );
    const outMat = new LineBasicMaterial({
      color: new Color(COLOR.lineStrong).lerp(new Color(COLOR.muted), 0.25),
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });
    this.outline = new LineSegments(outGeo, outMat);
    this.scene.add(this.outline);

    // The light plane: vertical, across the rows, a veil with glowing edges.
    const planeGeo = new PlaneGeometry(1, 1);
    const edgeGeo = new EdgesGeometry(planeGeo);
    this.planeMat = new ShaderMaterial({
      uniforms: {
        color: { value: new Color(COLOR.high) },
        fill: { value: 0.02 },
      },
      vertexShader: PLANE_VERT,
      fragmentShader: PLANE_FRAG,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
    });
    this.edgeMat = new LineBasicMaterial({
      // Over 1, so the bloom gives the edges a halo.
      color: new Color(COLOR.high).multiplyScalar(1.5),
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    });
    this.plane = new Mesh(planeGeo, this.planeMat);
    this.plane.add(new LineSegments(edgeGeo, this.edgeMat));
    this.plane.rotation.y = Math.PI / 2; // its local x runs along z
    this.plane.renderOrder = 2;
    this.plane.visible = false;
    this.scene.add(this.plane);
    this.statics.push(floorGeo, this.floorMat, outGeo, outMat, planeGeo, edgeGeo, this.edgeMat);

    // The annotations: ticks, row labels, chips, cards.
    const ns = 'http://www.w3.org/2000/svg';
    this.notesEl = document.createElementNS(ns, 'svg');
    this.notesEl.setAttribute('width', '100%');
    this.notesEl.setAttribute('height', '100%');
    this.notesEl.setAttribute('aria-hidden', 'true');
    this.notesEl.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none';
    labelBox.append(this.notesEl);

    // Camera: slow auto-orbit, turned and zoomed with the mouse, within
    // limits (see the header).
    this.camera.position.setFromSphericalCoords(30, Math.PI / 2 - this.elevation, 0);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = true; // right button, or two fingers: to read one column up close
    this.controls.zoomToCursor = true; // the wheel zooms where the pointer is
    this.controls.zoomSpeed = 1.2;
    this.controls.minAzimuthAngle = -AZIMUTH_LIMIT;
    this.controls.maxAzimuthAngle = AZIMUTH_LIMIT;
    this.controls.minPolarAngle = POLAR_MIN;
    this.controls.maxPolarAngle = POLAR_MAX;
    this.controls.autoRotate = !this.reduced.matches;
    this.controls.addEventListener('change', this.onChange);
    this.controls.addEventListener('start', this.onStart);
    this.reduced.addEventListener('change', this.onReduced);

    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);

    this.observer = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1].contentRect;
      this.resize(r.width, r.height);
    });
    this.observer.observe(canvas);
  }

  // The token at `index` has just been appended to the viewed path
  // (animation 4). Never queued: a new token ends the previous growth.
  born(now: number): void {
    const interval = this.pace.next(now);
    this.endGrowth();
    if (this.reduced.matches) return;
    const dur = growDuration(interval);
    if (dur <= 0) return;
    this.growCol = this.store.path.length - 1;
    this.growK = 0;
    this.growT0 = now;
    this.growDur = dur;
  }

  // The path was replaced: no growth.
  cancel(): void {
    this.endGrowth();
  }

  // Called every animation frame; `dirty` is store.dirty.relief.
  paint(now: number, dirty: boolean): void {
    const dt = this.lastNow > 0 ? Math.min(now - this.lastNow, 250) : 16;
    this.lastNow = now;
    if (dirty) this.sync(); // CPU side only: safe while the context is lost
    if (this.growCol >= 0) this.stepGrowth(now);
    if (this.lost || this.w < 1 || this.h < 1) return;
    // Hidden (the other tab of the dock): nothing moves and nothing is
    // drawn; the first visible frame renders.
    if (!this.visible()) {
      this.needs = true;
      return;
    }
    const c = this.controls;
    if (this.resetT0 >= 0) this.stepReset(now);
    // The automatic orbit turns back at each end of its swing, slowing
    // down near them. Far outside it (the user turned the camera) it only
    // drifts back.
    const az = c.getAzimuthalAngle();
    if (az > this.sway) this.orbitDir = 1;
    else if (az < -this.sway) this.orbitDir = -1;
    const u = Math.min(1, Math.abs(az) / this.sway);
    c.autoRotateSpeed = this.orbitDir * this.orbitSpeed * (1 - ORBIT_EASE * u * u);
    if (c.update(dt / 1000)) this.needs = true;
    if (!this.needs) return;
    this.needs = false;
    this.composer.render();
    this.drawNotes();
  }

  // Back to the fitted default view, then the automatic orbit again: a
  // short glide, or at once with prefers-reduced-motion.
  resetView(): void {
    if (!this.fitted || this.w < 1 || this.h < 1) {
      this.fitted = false; // the next resize starts from the default
      this.user = false;
      return;
    }
    const c = this.controls;
    this.fromTarget.copy(c.target);
    this.from.r = this.camera.position.distanceTo(c.target);
    this.from.phi = c.getPolarAngle();
    this.from.theta = c.getAzimuthalAngle();
    if (this.reduced.matches) {
      c.target.copy(this.home);
      this.lookFrom(this.fitDist, Math.PI / 2 - this.elevation, 0);
      this.endReset();
      return;
    }
    c.autoRotate = false;
    this.resetT0 = this.lastNow > 0 ? this.lastNow : performance.now();
    this.needs = true;
  }

  dispose(): void {
    this.observer.disconnect();
    this.controls.removeEventListener('change', this.onChange);
    this.controls.removeEventListener('start', this.onStart);
    this.controls.dispose();
    this.reduced.removeEventListener('change', this.onReduced);
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    for (const o of [this.front, this.back, this.lines, this.profile]) o.geometry.dispose();
    for (const m of [this.frontMat, this.backMat, this.lineMat, this.planeMat]) m.dispose();
    for (const s of this.statics) s.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    if (this.pickFrame !== 0) cancelAnimationFrame(this.pickFrame);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.notesEl.remove();
  }

  // ----------------------------------------------------------- internal

  // The target may be panned, but never out of the box: the view cannot get lost.
  private readonly onChange = (): void => {
    const t = this.controls.target;
    const x = Math.min(Math.max(t.x, -W / 2), W / 2);
    const y = Math.min(Math.max(t.y, 0), this.hh * PLANE_RISE);
    const z = Math.min(Math.max(t.z, -this.d / 2), this.d / 2);
    if (x !== t.x || y !== t.y || z !== t.z) {
      this.camera.position.add(this.v.set(x - t.x, y - t.y, z - t.z));
      t.set(x, y, z);
    }
    this.needs = true;
  };

  // The user takes the camera: a reset in course stops where it is, and
  // later fits keep the user's angles and zoom.
  private readonly onStart = (): void => {
    this.user = true;
    if (this.resetT0 >= 0) this.endReset();
  };

  private readonly onReduced = (): void => {
    this.controls.autoRotate = !this.reduced.matches && this.resetT0 < 0;
    if (this.reduced.matches) this.endGrowth();
    this.needs = true;
  };

  private readonly onLost = (): void => {
    this.lost = true;
    console.warn('Relief: the WebGL context was lost; the panel stays empty until it comes back.');
  };

  // three.js uploads every buffer and texture again from its array.
  private readonly onRestored = (): void => {
    this.lost = false;
    this.needs = true;
  };

  private resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    if (w < 1 || h < 1) return;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.fov = (2 * Math.atan(Math.tan((FOV_X * Math.PI) / 360) / this.camera.aspect) * 180) / Math.PI;
    this.reshape();
    this.fit();
    this.needs = true;
  }

  // Depth, height, default elevation and swing for the shape of the panel
  // (reliefShape): a wide strip gets a shallow relief seen from higher up,
  // the full screen a deep and tall one.
  private reshape(): void {
    const shape = reliefShape(this.camera.aspect);
    this.d = shape.depth;
    this.hh = shape.height;
    this.elevation = shape.elevation;
    this.sway = shape.sway;
    const omega = Math.min(Math.max(shape.sway / 5, ORBIT_MIN), ORBIT_MAX); // rad/s
    this.orbitSpeed = (omega * 60) / (2 * Math.PI); // OrbitControls: turns per minute
    this.outline.scale.set(W, 1, this.d);
    // The floor reaches `fade` beyond the outline on every side.
    const fade = this.floorMat.uniforms.fade.value as number;
    this.floor.scale.set(W + 2 * fade, 1, this.d + 2 * fade);
    (this.floorMat.uniforms.halfSize.value as Vector2).set(W / 2, this.d / 2);
    this.plane.scale.set(this.d + 0.6, this.hh * PLANE_RISE, 1);
    this.plane.position.y = (this.hh * PLANE_RISE) / 2;
    this.place();
  }

  // Grid units → world. Column c is centred at (c + 0.5) / span of the width,
  // as on the Timeline.
  private place(): void {
    const g = this.grid;
    const dz = this.d / Math.max(this.rows - 1, 1);
    g.scale.set(W / this.span, this.hh, this.backFirst ? dz : -dz);
    g.position.set(-W / 2, 0, this.backFirst ? -this.d / 2 : this.d / 2);
  }

  // The fitted distance: the whole box (light plane included) in view from
  // the default elevation, at the front and at both ends of the swing. The
  // camera looks at the box's centre. Until the user moves the camera, a fit
  // puts it at the default elevation and distance (keeping where the
  // automatic orbit is); after that, it keeps the user's angles and zoom
  // relative to the fitted distance.
  private fit(): void {
    const c = this.controls;
    const tan = Math.tan((FOV_X * Math.PI) / 360);
    const tx = tan * MARGIN_X;
    const ty = (tan * MARGIN_Y) / this.camera.aspect;
    const hy = (this.hh * PLANE_RISE) / 2;
    const hz = this.d / 2 + 0.3;
    const phi = Math.PI / 2 - this.elevation;
    let dist = 0;
    for (const theta of [-this.sway, 0, this.sway]) {
      dist = Math.max(dist, fitDistance(W / 2, hy, hz, theta, phi, tx, ty));
    }
    const prev = this.fitDist;
    const keep = this.fitted && this.user;
    const pan = keep ? this.v.copy(c.target).sub(this.home) : this.v.set(0, 0, 0);
    const zoom = keep ? this.camera.position.distanceTo(c.target) / prev : 1;
    const polar = keep ? c.getPolarAngle() : phi;
    const az = this.fitted ? c.getAzimuthalAngle() : 0;
    const azimuth = keep ? az : Math.min(Math.max(az, -this.sway), this.sway);
    this.fitDist = dist;
    this.home.set(0, hy, 0);
    c.target.copy(this.home).add(pan);
    c.minDistance = dist * ZOOM_IN;
    c.maxDistance = dist * ZOOM_OUT;
    this.camera.near = Math.max(0.1, dist * 0.01);
    this.camera.far = dist * ZOOM_OUT + 4 * W;
    this.camera.updateProjectionMatrix();
    // Fog: nothing at the relief's front, a little at its back, and the far
    // floor fades into the background.
    this.fog.near = dist * 0.92;
    this.fog.far = dist * 2.4;
    this.lookFrom(dist * Math.min(Math.max(zoom, ZOOM_IN), ZOOM_OUT), polar, azimuth);
    this.fitted = true;
  }

  // Puts the camera at distance `r`, polar angle `phi` and azimuth `theta`
  // around the target.
  private lookFrom(r: number, phi: number, theta: number): void {
    const c = this.controls;
    this.camera.position.setFromSphericalCoords(r, phi, theta).add(c.target);
    this.camera.lookAt(c.target);
    c.update();
    this.needs = true;
  }

  // One frame of resetView(): eased from where the camera was to the
  // default view.
  private stepReset(now: number): void {
    const k = Math.min(1, Math.max(0, (now - this.resetT0) / RESET_MS));
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // ease in-out cubic
    const fr = this.from;
    const phi = Math.PI / 2 - this.elevation;
    this.controls.target.lerpVectors(this.fromTarget, this.home, e);
    this.lookFrom(fr.r + (this.fitDist - fr.r) * e, fr.phi + (phi - fr.phi) * e, fr.theta * (1 - e));
    if (k >= 1) this.endReset();
  }

  private endReset(): void {
    this.resetT0 = -1;
    this.user = false;
    this.controls.autoRotate = !this.reduced.matches;
    this.needs = true;
  }

  // Whether the canvas can be seen: not under visibility: hidden (the other
  // tab of the dock). Browsers without checkVisibility always draw.
  private visible(): boolean {
    const c = this.canvas;
    return typeof c.checkVisibility !== 'function' || c.checkVisibility({ visibilityProperty: true });
  }

  // Data and selection, after dirty.relief.
  private sync(): void {
    const s = this.store;
    const source = this.source();
    const key = `${s.pathEpoch}:${s.path.length}:${s.framesApplied}:${s.front}:${s.twoModels}:${source}`;
    let moved = false;
    if (key !== this.key) {
      this.key = key;
      this.refresh(source);
      moved = true;
      // A new source is a new view: frame it again.
      if (this.shownSource !== null && this.data.source !== this.shownSource) this.resetView();
      this.shownSource = this.data.source;
    }
    const sel = this.view.selected();
    const pinned = this.view.pinnedIndex() !== null;
    if (moved || sel !== this.sel || pinned !== this.pinned) {
      this.sel = sel;
      this.pinned = pinned;
      this.placePlane();
      this.needs = true;
    }
  }

  // Heights from the store; uploads only the columns that changed.
  private refresh(source: ReliefSource): void {
    const s = this.store;
    const d = this.data;
    d.update(s, source);
    this.span = axisSpan(s.path.length, s.branches());
    this.disagreements = 0;
    if (s.twoModels) for (let i = 1; i < s.path.length; i++) if (s.disagrees(i)) this.disagreements++;
    this.backTone = s.other;
    this.backFirst = d.source === 'alternatives';
    if (d.capacity !== this.cap || d.rows !== this.rows) {
      this.layout(d.capacity, d.rows);
      this.write(0, d.cols);
    } else if (d.to > d.from) {
      this.write(d.from, d.to);
    }

    const cols = d.cols;
    const rows = d.rows;
    const quads = cols > 1 && rows > 1 ? (cols - 1) * (rows - 1) * 6 : 0;
    this.front.geometry.setDrawRange(0, quads);
    this.back.geometry.setDrawRange(0, quads);
    this.lines.geometry.setDrawRange(0, cols > 1 ? (cols - 1) * rows * 2 : 0);
    // Fewer than two rows or columns make no surface.
    this.front.visible = this.lines.visible = quads > 0;
    this.back.visible = quads > 0 && s.twoModels && d.source === 'alternatives';

    this.place();
    this.needs = true;
  }

  // New buffers for `cap` columns of `rows` rows. x and z never change.
  private layout(cap: number, rows: number): void {
    this.cap = cap;
    this.rows = rows;
    const n = cap * rows;
    this.posF = new Float32Array(n * 3);
    this.posB = new Float32Array(n * 3);
    this.toneF = new Float32Array(n * 4);
    this.toneB = new Float32Array(n * 4);
    this.mark = new Float32Array(n * 2);
    for (let c = 0; c < cap; c++) {
      for (let r = 0; r < rows; r++) {
        const v = (c * rows + r) * 3;
        this.posF[v] = this.posB[v] = c + 0.5;
        this.posF[v + 2] = this.posB[v + 2] = r;
      }
    }

    // Two triangles per cell, and a line along each row between columns,
    // both column by column so that the first columns are a prefix.
    const cells = Math.max(cap - 1, 0) * Math.max(rows - 1, 0);
    const tri = new Uint32Array(cells * 6);
    let k = 0;
    for (let c = 0; c + 1 < cap; c++) {
      for (let r = 0; r + 1 < rows; r++) {
        const a = c * rows + r;
        const b = a + rows; // same row, next column
        tri[k++] = a;
        tri[k++] = b;
        tri[k++] = a + 1;
        tri[k++] = a + 1;
        tri[k++] = b;
        tri[k++] = b + 1;
      }
    }
    const seg = new Uint32Array(Math.max(cap - 1, 0) * rows * 2);
    k = 0;
    for (let c = 0; c + 1 < cap; c++) {
      for (let r = 0; r < rows; r++) {
        seg[k++] = c * rows + r;
        seg[k++] = (c + 1) * rows + r;
      }
    }

    const dyn = (a: Float32Array, size: number): BufferAttribute => new BufferAttribute(a, size).setUsage(DynamicDrawUsage);
    const pf = dyn(this.posF, 3);
    const tf = dyn(this.toneF, 4);
    const pb = dyn(this.posB, 3);
    const tb = dyn(this.toneB, 4);
    const mk = dyn(this.mark, 2);
    const triIndex = new BufferAttribute(tri, 1);
    this.attrs = [pf, tf, pb, tb, mk];

    const front = new BufferGeometry();
    front.setAttribute('position', pf);
    front.setAttribute('tone', tf);
    front.setAttribute('mark', mk);
    front.setIndex(triIndex);
    const back = new BufferGeometry();
    back.setAttribute('position', pb);
    back.setAttribute('tone', tb);
    back.setAttribute('mark', mk); // unused by its shader; shared, no upload of its own
    back.setIndex(triIndex);
    const lines = new BufferGeometry();
    lines.setAttribute('position', pf); // on the front surface
    lines.setIndex(new BufferAttribute(seg, 1));
    this.prof = new Float32Array(rows * 3);
    const profile = new BufferGeometry();
    profile.setAttribute('position', new BufferAttribute(this.prof, 3).setUsage(DynamicDrawUsage));

    this.front.geometry.dispose();
    this.back.geometry.dispose();
    this.lines.geometry.dispose();
    this.profile.geometry.dispose();
    this.front.geometry = front;
    this.pickStale = true;
    this.back.geometry = back;
    this.lines.geometry = lines;
    this.profile.geometry = profile;
  }

  // Writes heights, tones and marks of columns [from, to) into the buffers.
  private write(from: number, to: number): void {
    const d = this.data;
    const rows = this.rows;
    to = Math.min(to, d.cols, this.cap);
    if (to <= from || rows === 0) return;
    const bt = this.tones[this.backTone];
    for (let c = from; c < to; c++) {
      const k = c === this.growCol ? this.growK : 1;
      const ft = this.tones[d.tone[c]];
      const doubt = d.doubt[c];
      const div = d.div[c];
      let crest = 0;
      for (let r = 0; r < rows; r++) crest = Math.max(crest, d.front[c * rows + r]);
      crest *= k;
      for (let r = 0; r < rows; r++) {
        const i = c * rows + r;
        const v = i * 3;
        this.posF[v + 1] = d.front[i] * k;
        this.posB[v + 1] = d.back[i] * k;
        tint(this.toneF, i * 4, ft, doubt);
        tint(this.toneB, i * 4, bt, 0);
        this.mark[i * 2] = div;
        this.mark[i * 2 + 1] = crest;
      }
    }
    for (const a of this.attrs) {
      a.addUpdateRange(from * rows * a.itemSize, (to - from) * rows * a.itemSize);
      a.needsUpdate = true;
    }
    this.pickStale = true;
    if (this.sel >= from && this.sel < to) this.writeProfile();
    this.needs = true;
  }

  private stepGrowth(now: number): void {
    const c = this.growCol;
    this.growK = growFactor(now - this.growT0, this.growDur);
    this.write(c, c + 1);
    if (this.growK >= 1) this.growCol = -1;
    this.needs = true;
  }

  // Ends the growth at once, with the column at its full height.
  private endGrowth(): void {
    const c = this.growCol;
    if (c < 0) return;
    this.growCol = -1;
    this.growK = 1;
    this.write(c, c + 1);
  }

  // World x of the centre of position `i`.
  private xOf(i: number): number {
    return -W / 2 + ((i + 0.5) * W) / this.span;
  }

  // World z of row `r`.
  private zOf(r: number): number {
    const dz = this.d / Math.max(this.rows - 1, 1);
    return this.backFirst ? -this.d / 2 + r * dz : this.d / 2 - r * dz;
  }

  // The light plane: moved in the same frame as the selection of the Stream
  // (animation 5), with the cut of the surface at that position.
  private placePlane(): void {
    const sel = this.sel;
    this.plane.visible = sel >= 0 && sel < this.data.cols;
    this.profile.visible = this.plane.visible && this.front.visible;
    if (!this.plane.visible) return;
    this.plane.position.x = this.xOf(sel);
    const u = this.planeMat.uniforms;
    u.fill.value = this.pinned ? 0.035 : 0.015;
    this.edgeMat.opacity = this.pinned ? 0.7 : 0.35;
    this.writeProfile();
  }

  // The front surface's heights at the selected column, in grid units.
  private writeProfile(): void {
    const sel = this.sel;
    const d = this.data;
    const rows = this.rows;
    if (sel < 0 || sel >= d.cols || this.prof.length < rows * 3) return;
    const k = sel === this.growCol ? this.growK : 1;
    const p = this.prof;
    for (let r = 0; r < rows; r++) {
      p[r * 3] = sel + 0.5;
      p[r * 3 + 1] = d.front[sel * rows + r] * k;
      p[r * 3 + 2] = r;
    }
    const a = this.profile.geometry.getAttribute('position') as BufferAttribute;
    a.needsUpdate = true;
    this.profile.geometry.setDrawRange(0, rows);
  }

  // ----------------------------------------------------- zoom and export

  // Moves the camera towards (factor > 1) or away from the point it looks
  // at, within the zoom limits.
  zoomBy(factor: number): void {
    const c = this.controls;
    const off = this.camera.position.clone().sub(c.target);
    const r = Math.min(Math.max(off.length() / factor, c.minDistance), c.maxDistance);
    this.camera.position.copy(c.target).add(off.setLength(r));
    this.user = true;
    c.update();
    this.needs = true;
  }

  // Ticks, ruler, info card, legend and hover card on or off.
  setInfo(on: boolean): void {
    this.info = on;
    this.needs = true;
  }

  // The relief as an SVG document of the panel's size: the surface as shaded
  // polygons, sorted back to front, from the camera as it is now, with the
  // same annotations as on screen. Throws without anything to draw.
  exportSvg(): string {
    this.requireDrawn();
    this.endGrowth(); // a column still growing would be saved part-way
    this.camera.updateMatrixWorld();
    const d = this.data;
    const scene = sceneSvg({
      cols: d.cols,
      rows: d.rows,
      front: d.front,
      back: this.back.visible ? d.back : null,
      doubt: d.doubt,
      div: d.div,
      tone: d.tone,
      backSlot: this.backTone,
      hues: MODEL_COLOR,
      width: W,
      depth: this.d,
      height: this.hh,
      span: this.span,
      backFirst: this.backFirst,
      selected: this.sel >= 0 && this.sel < d.cols ? this.sel : -1,
      pinned: this.pinned,
      project: this.project,
    });
    const defs =
      '<radialGradient id="bg" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="#0d1730"/>' +
      `<stop offset="0.45" stop-color="#0a1124"/><stop offset="1" stop-color="${COLOR.bg}"/></radialGradient>`;
    const body = `<rect width="${this.w}" height="${this.h}" fill="url(#bg)"/>` + scene.svg + notesSvg(this.buildNotes(), this.measure);
    return svgDocument(this.w, this.h, body, {
      defs,
      background: COLOR.bg,
      title: `inside-llm relief (${d.source}): ${d.cols} positions, ${d.rows} rows`,
    });
  }

  // The relief as a PNG: the WebGL picture rendered again at `scale` times the
  // panel's size (within what the GPU allows), with the annotations over it.
  async exportPng(scale = 2): Promise<Blob> {
    this.requireDrawn();
    const w = this.w;
    const h = this.h;
    const pr0 = this.renderer.getPixelRatio();
    const limit = Math.min(this.renderer.capabilities.maxTextureSize, 8192) / Math.max(w, h);
    const pr = Math.max(1, Math.min(Math.max(pr0, 1) * scale, limit));
    const resize = (ratio: number): void => {
      this.renderer.setPixelRatio(ratio);
      this.composer.setPixelRatio(ratio);
      this.composer.setSize(w, h);
      this.renderer.setSize(w, h, false);
    };
    this.camera.updateMatrixWorld();
    let snapshot: Promise<ImageBitmap>;
    resize(pr);
    try {
      this.composer.render();
      snapshot = createImageBitmap(this.canvas); // a copy of the picture as it is now
    } finally {
      resize(pr0);
      this.needs = true;
    }
    const under = await snapshot;
    try {
      const notes = svgDocument(w, h, notesSvg(this.buildNotes(), this.measure), { background: null });
      return await svgToPngBlob(notes, w, h, pr, under);
    } finally {
      under.close();
    }
  }

  // Saves the relief: "svg" or "png", named by time.
  async save(kind: 'svg' | 'png'): Promise<void> {
    const name = `inside-llm-relief-${this.data.source}-${stamp()}`;
    if (kind === 'svg') downloadText(this.exportSvg(), `${name}.svg`);
    else downloadBlob(await this.exportPng(), `${name}.png`);
  }

  private requireDrawn(): void {
    if (this.w < 1 || this.h < 1 || !this.front.visible) throw new Error('the relief has nothing to export yet');
  }

  // ------------------------------------------------------------- pointer

  // The cell of the surface under a point of the canvas, if any: its column
  // (position) and nearest row.
  private pick(ex: number, ey: number): { col: number; row: number } | null {
    const d = this.data;
    if (!this.front.visible || this.w < 1 || this.h < 1 || d.cols < 1) return null;
    this.ndc.set((ex / this.w) * 2 - 1, -(ey / this.h) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    const geo = this.front.geometry;
    if (this.pickStale) {
      geo.boundingSphere = null; // the heights changed since the last pick
      geo.boundingBox = null;
      this.pickStale = false;
    }
    this.grid.updateMatrixWorld(true); // place() may have moved it since the last frame
    const hit = this.ray.intersectObject(this.front, false)[0];
    if (!hit) return null;
    const col = Math.min(Math.max(Math.floor(((hit.point.x + W / 2) * this.span) / W), 0), d.cols - 1);
    const dz = this.d / Math.max(d.rows - 1, 1);
    const k = this.backFirst ? (hit.point.z + this.d / 2) / dz : (this.d / 2 - hit.point.z) / dz;
    return { col, row: Math.min(Math.max(Math.round(k), 0), d.rows - 1) };
  }

  // Over the surface the Stream and the Timeline follow, as when sweeping
  // either of them; a card says what is under the pointer.
  // Position of a pointer event in CSS px of the canvas, from its box (not
  // offsetX, which follows the target's own transforms).
  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.buttons !== 0) {
      // Dragging: the camera, not the inspection.
      this.pending = null;
      if (this.hover) {
        this.hover = null;
        this.needs = true;
      }
      return;
    }
    // One pick per frame, for the last position: a raycast over the whole
    // surface is not free.
    this.pending = e;
    if (this.pickFrame === 0) this.pickFrame = requestAnimationFrame(this.inspect);
  };

  private readonly inspect = (): void => {
    this.pickFrame = 0;
    const e = this.pending;
    this.pending = null;
    if (!e) return;
    const at = this.local(e);
    const hit = this.pick(at.x, at.y);
    const had = this.hover !== null;
    this.hover = hit ? { ...hit, x: at.x, y: at.y } : null;
    this.view.setHover(hit ? hit.col : null);
    if (hit || had) this.needs = true;
  };

  private readonly onPointerLeave = (): void => {
    this.down = null;
    this.pending = null;
    if (this.hover) {
      this.hover = null;
      this.needs = true;
    }
    this.view.setHover(null);
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    // A second finger (a pinch) is not a click.
    this.down = e.button === 0 && e.isPrimary ? this.local(e) : null;
  };

  // A click that did not drag pins the position, like on the Timeline.
  private readonly onPointerUp = (e: PointerEvent): void => {
    const down = this.down;
    this.down = null;
    const at = this.local(e);
    if (!down || !e.isPrimary || e.button !== 0 || Math.hypot(at.x - down.x, at.y - down.y) > 4) return;
    const hit = this.pick(at.x, at.y);
    if (!hit) return;
    if (this.view.pinnedIndex() === hit.col) this.view.unpin();
    else this.view.pin(hit.col);
  };

  // ---------------------------------------------------------- annotations

  // Text widths are asked for on every frame the camera moves: measured once.
  private readonly widths = new Map<string, number>();

  private readonly measure: Measure = (text, size, mono) => {
    const key = `${size}${mono ? 'm' : 'u'}${text}`;
    let w = this.widths.get(key);
    if (w === undefined) {
      this.measureCtx ??= document.createElement('canvas').getContext('2d');
      const ctx = this.measureCtx;
      if (ctx) {
        ctx.font = `${size}px ${mono ? FONT : FONT_UI}`;
        w = ctx.measureText(text).width;
      } else {
        w = estimateWidth(text, size, mono);
      }
      if (this.widths.size > 2000) this.widths.clear();
      this.widths.set(key, w);
    }
    return w;
  };

  // World → CSS px of the panel, with the distance from the camera; null
  // behind the camera.
  private readonly project = (x: number, y: number, z: number): readonly [number, number, number] | null => {
    this.v.set(x, y, z);
    const depth = this.v2.copy(this.v).sub(this.camera.position).length();
    this.v.project(this.camera);
    if (this.v.z > 1 || this.v.z < -1) return null;
    return [((this.v.x + 1) / 2) * this.w, ((1 - this.v.y) / 2) * this.h, depth];
  };

  private drawNotes(): void {
    const svg = notesSvg(this.buildNotes(), this.measure);
    if (svg === this.lastNotes) return; // a still camera: nothing to parse again
    this.lastNotes = svg;
    this.notesEl.innerHTML = svg;
  }

  private tokenText(id: number, max = LABEL_CHARS): string {
    const v = this.store.vocab.get(id);
    const text = v ? showWhitespace(tokenLabel(v.bytes)) : `#${id}`;
    const chars = Array.from(text);
    return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : text;
  }

  // Everything that lies over the picture, for the camera as it is.
  private buildNotes(): Notes {
    const notes: Notes = { w: this.w, h: this.h, words: [], ticks: [], chips: [], cards: [] };
    if (!this.front.visible || this.w < 1 || this.h < 1) return notes;
    const s = this.store;
    const d = this.data;
    const P = this.project;
    const layers = d.source === 'layers';
    const ids = s.hello?.lens.layers ?? [];
    const rows = d.rows;
    const cols = d.cols;
    const left = -W / 2;
    const front = this.d / 2;
    const inside = (p: readonly number[] | null): p is readonly [number, number, number] =>
      p !== null && p[0] > -20 && p[0] < this.w + 20 && p[1] > -20 && p[1] < this.h + 20;

    // What the rows are, along the left edge: the two ends say what they
    // mean, the others only their number or layer.
    const rowText = (r: number): string => {
      const id = layers ? `L${ids[r] ?? r}` : `#${r + 1}`;
      if (r === 0) return `${id} ${layers ? 'first layer' : 'most likely'}`;
      if (r === rows - 1) return `${id} ${layers ? 'last layer' : 'least likely'}`;
      return id;
    };
    for (let r = 0; r < rows; r++) {
      const end = r === 0 || r === rows - 1;
      if (!end && (rows > 24 || !this.info)) continue;
      const p = P(left, 0, this.zOf(r));
      if (!inside(p)) continue;
      const text = rowText(r);
      notes.words.push({
        x: Math.max(p[0] - 10, this.measure(text, end ? 11 : 9.5, false) + 6),
        y: p[1],
        text,
        anchor: 'end',
        size: end ? 11 : 9.5,
        color: end ? COLOR.muted : COLOR.low,
        opacity: 0.9,
      });
    }

    // Position ticks along the front edge, and the axis word at its end.
    const first = P(this.xOf(0), 0, front);
    const last = P(this.xOf(Math.max(cols - 1, 0)), 0, front);
    if (this.info && cols > 0 && first && last) {
      const across = Math.max(Math.abs(last[0] - first[0]), 1);
      for (const i of tickPositions(0, cols - 1, across, 52).slice(0, 80)) {
        const p = P(this.xOf(i), 0, front);
        if (!inside(p)) continue;
        const y = Math.min(p[1], this.h - 18);
        notes.ticks.push({ x1: p[0], y1: y + 1, x2: p[0], y2: y + 5 });
        notes.words.push({ x: p[0], y: y + 13, text: `${i}`, anchor: 'middle', size: 9.5, mono: true, color: COLOR.unlikely });
      }
    }
    const end = P(W / 2, 0, front);
    if (inside(end)) {
      notes.words.push({ x: end[0], y: Math.min(end[1] + (this.info ? 27 : 14), this.h - 8), text: 'position →', anchor: 'end', size: 11, color: COLOR.muted, opacity: 0.85 });
    }

    // The probability ruler up the front-left corner: a height is sqrt(p).
    if (this.info) {
      const base = P(left, 0, front);
      const topP = P(left, this.hh, front);
      if (inside(base) && inside(topP)) {
        notes.ticks.push({ x1: base[0], y1: base[1], x2: topP[0], y2: topP[1] });
        // Row labels have the left edge first: a ruler label lying on one waits.
        const rowWords = notes.words.filter((w) => w.anchor === 'end');
        for (const t of rulerTicks()) {
          const p = P(left, t.h * this.hh, front);
          if (!inside(p)) continue;
          if (rowWords.some((w) => Math.abs(w.y - p[1]) < 11 && Math.abs(w.x - p[0]) < 90)) continue;
          notes.ticks.push({ x1: p[0] - 5, y1: p[1], x2: p[0], y2: p[1] });
          notes.words.push({ x: p[0] - 8, y: p[1], text: t.label, anchor: 'end', size: 9.5, mono: true, color: COLOR.low });
        }
        notes.words.push({ x: topP[0] - 8, y: topP[1] - 13, text: layers ? 'answer probability' : 'probability', anchor: 'end', size: 10, color: COLOR.muted });
      }
    }

    this.chipNotes(notes, ids);

    if (this.info && this.h >= 200) {
      const y = document.fullscreenElement ? 56 : 10;
      notes.cards.push(this.infoCard(y, ids));
      if (this.w >= 520 && this.h >= 360) notes.cards.push(this.legendCard(y));
    }
    const tip = this.info ? this.tooltipCard(ids) : null;
    if (tip) notes.cards.push(tip);
    return notes;
  }

  // One chip per row at the selected position, at that row's height: the
  // layer or rank, the token, its probability and, with two models, the
  // other's. Chips that would overlap are spread; with too many rows only
  // every k-th keeps its chip.
  private chipNotes(notes: Notes, ids: readonly number[]): void {
    const s = this.store;
    const d = this.data;
    const sel = this.sel;
    if (sel < 0 || sel >= d.cols) return;
    const dec = s.decision(sel);
    if (!dec) return;
    const layers = d.source === 'layers';
    const lens = layers ? dec.lens : null;
    const count = layers ? (lens ? Math.min(lens.topId.length, d.rows) : 0) : Math.min(d.rows, dec.nRaw);
    if (count === 0) return;
    const slot = d.tone[sel] as Slot;
    const color = MODEL_COLOR[slot];
    const otherSlot: Slot = slot === 0 ? 1 : 0;
    const otherDec = !layers && s.twoModels && s.decisionOf(sel, slot) ? s.decisionOf(sel, otherSlot) : undefined;
    const k = sel === this.growCol ? this.growK : 1;
    const x = this.xOf(sel);
    const kept = strideRows(count, this.h);
    const pts: { r: number; x: number; y: number }[] = [];
    for (const r of kept) {
      const p = this.project(x, d.front[sel * d.rows + r] * k * this.hh, this.zOf(r));
      if (p) pts.push({ r, x: p[0], y: p[1] });
    }
    const ys = spreadChips(
      pts.map((p) => p.y),
      this.h,
      CHIP_GAP,
    );
    pts.forEach((p, i) => {
      const r = p.r;
      const parts: Part[] = [];
      if (lens) {
        parts.push({ text: `L${ids[r] ?? r}`, color: COLOR.muted, size: 10.5, bold: true });
        parts.push({ text: this.tokenText(lens.topId[r]), color: COLOR.high, mono: true, size: 12 });
        parts.push({ text: `${Math.round(lens.topP[r] * 100)}%`, color, size: 10.5, bold: true });
      } else {
        const token = dec.tokens[r];
        parts.push({ text: `#${r + 1}`, color: COLOR.muted, size: 10.5, bold: true });
        parts.push({ text: this.tokenText(token), color: COLOR.high, mono: true, size: 12 });
        parts.push({ text: pctShort(dec.pRaw[r]), color, size: 10.5, bold: true });
        if (otherDec) parts.push({ text: `${otherSlot === 0 ? 'A' : 'B'} ${pctShort(pOf(otherDec, token))}`, color: MODEL_COLOR[otherSlot], size: 10.5 });
      }
      notes.chips.push({ x: p.x, y: ys[i], parts });
    });
  }

  // The selected position: its token, the figures of each model, how the two
  // compare and, in Layers, where the answer settles. Without a selection, a
  // summary of the path.
  private infoCard(y: number, ids: readonly number[]): CardNote {
    const s = this.store;
    const d = this.data;
    const sel = this.sel;
    const small = (text: string, color: string = COLOR.muted): Part => ({ text, color, size: 10.5 });
    const mono = (text: string, color: string = COLOR.muted): Part => ({ text, color, size: 10.5, mono: true });
    const lines: CardNote['lines'] = [];
    if (sel >= 0 && sel < d.cols) {
      const title: Part[] = [
        { text: `#${sel}`, color: COLOR.low, mono: true, size: 11 },
        { text: `"${this.tokenText(s.token[s.path[sel]], 24)}"`, color: COLOR.high, mono: true, size: 11 },
      ];
      if (this.pinned) title.push(small('pinned', COLOR.low));
      for (const slot of s.twoModels ? ([0, 1] as const) : ([0] as const)) {
        const e = s.decisionOf(sel, slot);
        if (e) lines.push({ swatch: MODEL_COLOR[slot], parts: [mono(modelFigures(e))] });
      }
      const pair = s.pairAt(sel);
      if (pair) {
        const [a, b] = pairFigures(pair);
        lines.push({ parts: [mono(a)] }, { parts: [mono(b)] });
        if (s.disagrees(sel)) lines.push({ parts: [small('the models picked differently', COLOR.dis)] });
      }
      const e = s.decision(sel);
      if (d.source === 'layers' && e?.lens) {
        const at = decisionLayer(e.lens.topId, finalTop(e));
        lines.push({ parts: [small(at >= 0 ? `the answer settles at L${ids[at] ?? at}` : 'the answer never settles')] });
      }
      return { x: 12, y, title, lines };
    }
    const generated = Math.max(0, s.path.length - s.promptLength);
    lines.push({ parts: [mono(`${s.path.length} positions · ${s.promptLength} prompt · ${generated} generated`)] });
    if (s.twoModels) lines.push({ parts: [mono(`${this.disagreements} where the picks differ`, this.disagreements > 0 ? COLOR.dis : COLOR.muted)] });
    lines.push({ parts: [small('Hover the surface to inspect, click to pin.', COLOR.low)] });
    return { x: 12, y, title: [{ text: 'Relief', color: COLOR.high, size: 11, bold: true }, small(d.source === 'layers' ? 'layers' : 'alternatives', COLOR.low)], lines };
  }

  private legendCard(y: number): CardNote {
    const s = this.store;
    const name = (slot: number): string => {
      const m = s.hello?.models[slot];
      const text = m ? `${m.name || m.file} ${m.quant}`.trim() : `model ${slot === 0 ? 'A' : 'B'}`;
      const chars = Array.from(text);
      return `${slot === 0 ? 'A' : 'B'} ${chars.length > 26 ? chars.slice(0, 25).join('') + '…' : text}`;
    };
    const small = (text: string, color: string = COLOR.muted): Part => ({ text, color, size: 10.5 });
    const lines: CardNote['lines'] = [{ swatch: COLOR.a, parts: [small(name(0))] }];
    if (s.twoModels) lines.push({ swatch: COLOR.b, parts: [small(name(1))] });
    lines.push({ swatch: COLOR.high, parts: [small('white crest: the model hesitated')] });
    if (s.twoModels) lines.push({ swatch: COLOR.dis, parts: [small('magenta: the models parted')] });
    lines.push({ parts: [small(this.data.source === 'layers' ? 'height = √ answer probability' : 'height = √ probability', COLOR.low)] });
    return { x: this.w - 12, y, align: 'end', lines };
  }

  // Under the pointer: the position, the row and the figures of that cell.
  private tooltipCard(ids: readonly number[]): CardNote | null {
    const h = this.hover;
    const d = this.data;
    if (!h || h.col >= d.cols) return null;
    const s = this.store;
    const dec = s.decision(h.col);
    const small = (text: string, color: string = COLOR.muted): Part => ({ text, color, size: 10.5 });
    const mono = (text: string, color: string = COLOR.high): Part => ({ text, color, size: 11, mono: true });
    const lines: CardNote['lines'] = [];
    if (dec && d.source === 'layers' && dec.lens && h.row < dec.lens.topId.length) {
      const l = dec.lens;
      lines.push({ parts: [small(`layer L${ids[h.row] ?? h.row}:`), mono(`"${this.tokenText(l.topId[h.row])}"`), small(`${pctShort(l.topP[h.row])}`)] });
      lines.push({ parts: [small(`p of the final answer ${pctShort(l.answerP[h.row])} · ${l.entropy[h.row].toFixed(2)} bits`)] });
    } else if (dec && h.row < dec.nRaw) {
      lines.push({ parts: [small(`#${h.row + 1}`), mono(`"${this.tokenText(dec.tokens[h.row])}"`), small(pctShort(dec.pRaw[h.row]))] });
      const picked = dec.tokens[dec.pick];
      lines.push({ parts: [small(`picked "${this.tokenText(picked)}" ${pctShort(dec.pRaw[dec.pick])} · H ${dec.entropy.toFixed(2)} bits`)] });
    }
    const card: CardNote = {
      x: h.x + 14,
      y: h.y + 14,
      title: [
        { text: `#${h.col}`, color: COLOR.low, mono: true, size: 11 },
        { text: `"${this.tokenText(s.token[s.path[h.col]], 20)}"`, color: COLOR.high, mono: true, size: 11 },
      ],
      lines,
    };
    const size = cardSize(card, this.measure);
    if (card.x + size.w > this.w - 6) card.x = Math.max(6, h.x - 14 - size.w);
    if (card.y + size.h > this.h - 6) card.y = Math.max(6, h.y - 14 - size.h);
    return card;
  }
}

// Writes the tone of a vertex at offset `v` (4 floats): the model's colour,
// in linear light, and the column's doubt.
function tint(out: Float32Array, v: number, tone: Color, doubt: number): void {
  out[v] = tone.r;
  out[v + 1] = tone.g;
  out[v + 2] = tone.b;
  out[v + 3] = doubt;
}
