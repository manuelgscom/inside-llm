// The Relief as vector graphics: the surface of heights drawn as depth-sorted
// polygons (painter's algorithm) through a projection the panel provides, with
// the shading of the WebGL shader worked out on the CPU, plus the floor grid,
// the outline, the other model's row lines, the light plane and the cut at the
// selected position. Pure: no DOM, no three.js. The look constants below are
// the single source of the shader's (relief.ts imports them), so the two
// cannot drift apart. What it cannot reproduce is the bloom's glow.

import { n } from './export';
import { COLOR } from './theme';

// ----------------------------------------------------------- the look

// Colours in linear light, from the height h (0..1):
// hue × (GROUND + (TOP - GROUND)·h^RAMP).
export const GROUND = 0.03;
export const TOP = 0.55;
export const RAMP = 2.2;
// Shading: an ambient floor plus a light from up, front and left.
export const AMBIENT = 0.5;
export const LIGHT_DIR: readonly [number, number, number] = (() => {
  const v: [number, number, number] = [-0.35, 0.85, 0.45];
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
})();
// Doubt: from WHITE_FROM of the column's crest up, mixed towards WHITE by up
// to WHITE_MIX times the column's doubt.
export const WHITE_FROM = 0.78;
export const WHITE = 1.35;
export const WHITE_MIX = 0.8;
// Cliffs: where the normal's y is under STEEP[1] the surface is dimmed to
// CLIFF_DIM except near the column's crest (from RIM of it).
export const STEEP = [0.2, 0.6] as const;
export const CLIFF_DIM = 0.12;
export const RIM = 0.9;
// Divergence d: the colour moves towards magenta by DIS_MIX·d, to DIS_LOW of
// it in the trench and DIS_LOW + DIS_GAIN·d at the crest.
export const DIS_LOW = 0.12;
export const DIS_GAIN = 2.9;
export const DIS_MIX = 0.85;
// The light plane stands this much above height 1.
export const PLANE_RISE = 1.08;

// ------------------------------------------------------------ colours

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v: number): number {
  const c = Math.min(Math.max(v, 0), 1);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export type Rgb = readonly [number, number, number];

export function hexToLinear(hex: string): Rgb {
  const p = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return [srgbToLinear(p[0]), srgbToLinear(p[1]), srgbToLinear(p[2])];
}

export function linearToHex(c: Rgb): string {
  return '#' + c.map((v) => Math.round(linearToSrgb(v) * 255).toString(16).padStart(2, '0')).join('');
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const DIS_LIN = hexToLinear(COLOR.dis);

export interface PatchLook {
  hue: Rgb; // the model's colour, linear
  h: number; // mean height of the patch, 0..1
  top: number; // h relative to the column's crest, 0..1
  ny: number; // y of the unit normal (1: flat)
  diffuse: number; // max(n·L, 0)
  doubt: number; // 0..1
  div: number; // 0..1
}

// The fill of one patch of the surface, as the fragment shader works it out
// (without the isolines and the bloom), as "#rrggbb".
export function patchColor(p: PatchLook): string {
  const shade = AMBIENT + (1 - AMBIENT) * p.diffuse;
  const level = smoothstep(STEEP[0], STEEP[1], p.ny);
  const cliff = mix(mix(CLIFF_DIM, 1, smoothstep(RIM, 1, p.top)), 1, level);
  const base = GROUND + (TOP - GROUND) * Math.pow(p.h, RAMP);
  const white = smoothstep(WHITE_FROM, 1, p.top) * p.doubt * WHITE_MIX;
  const dis = (DIS_LOW + DIS_GAIN * p.div * p.top) * cliff;
  const out: number[] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    let c = p.hue[k] * base * shade * cliff;
    c = mix(c, WHITE, white);
    c = mix(c, DIS_LIN[k] * dis, p.div * DIS_MIX);
    out[k] = c;
  }
  return linearToHex([out[0], out[1], out[2]]);
}

// ------------------------------------------------------------ scene

// A projected point: CSS px and the distance from the camera, or null where
// it cannot be drawn (behind the camera).
export type Project = (x: number, y: number, z: number) => readonly [number, number, number] | null;

export interface SceneInput {
  cols: number;
  rows: number;
  front: ArrayLike<number>; // heights 0..1, index column * rows + row
  back: ArrayLike<number> | null; // the other model's, same layout
  doubt: ArrayLike<number>; // per column, 0..1
  div: ArrayLike<number>; // per column, 0..1
  tone: ArrayLike<number>; // per column: slot whose hue paints the front surface
  backSlot: number;
  hues: readonly string[]; // hex colour per slot
  width: number; // world width W
  depth: number; // world depth d
  height: number; // world height of probability 1
  span: number; // positions across the axis
  backFirst: boolean; // row 0 at the back
  selected: number; // column of the plane, or -1
  pinned: boolean;
  project: Project;
  maxQuads?: number; // thinning beyond this many quads
}

export interface Scene {
  svg: string; // a <g>
  quads: number; // drawn
  stride: number; // columns skipped between quads (1: none)
}

// A polygon costs about 120 bytes: 60k cells keep the file near 7 MB.
export const MAX_QUADS = 60_000;

// World x of the centre of column c, z of row r.
export function worldX(c: number, width: number, span: number): number {
  return -width / 2 + ((c + 0.5) * width) / span;
}

export function worldZ(r: number, rows: number, depth: number, backFirst: boolean): number {
  const dz = depth / Math.max(rows - 1, 1);
  return backFirst ? -depth / 2 + r * dz : depth / 2 - r * dz;
}

interface Quad {
  depth: number;
  points: string;
  fill: string;
}

export function sceneSvg(s: SceneInput): Scene {
  const { cols, rows } = s;
  const hues = s.hues.map(hexToLinear);
  const wx = (c: number): number => worldX(c, s.width, s.span);
  const wz = (r: number): number => worldZ(r, rows, s.depth, s.backFirst);
  const out: string[] = [];

  // Floor: the outline and a grid of square cells, fading outwards.
  out.push(floorSvg(s));

  let quads = 0;
  let stride = 1;
  if (cols > 1 && rows > 1) {
    const cap = s.maxQuads ?? MAX_QUADS;
    stride = Math.max(1, Math.ceil(((cols - 1) * (rows - 1)) / cap));

    // The crest of each column, for the "height relative to the crest".
    const crest = new Float32Array(cols);
    for (let c = 0; c < cols; c++) {
      let m = 0;
      for (let r = 0; r < rows; r++) m = Math.max(m, s.front[c * rows + r]);
      crest[c] = m;
    }

    // The other model: a line along each row, faint, under the surface.
    if (s.back) {
      const bh = hexToLinear(s.hues[s.backSlot] ?? COLOR.b);
      const stroke = linearToHex(bh);
      const parts: string[] = [];
      for (let r = 0; r < rows; r++) {
        const pts: string[] = [];
        for (let c = 0; c < cols; c += stride) {
          const p = s.project(wx(c), s.back[c * rows + r] * s.height, wz(r));
          if (p) pts.push(`${n(p[0])},${n(p[1])}`);
        }
        if (pts.length > 1) parts.push(`<polyline points="${pts.join(' ')}"/>`);
      }
      out.push(`<g fill="none" stroke="${stroke}" stroke-opacity="0.55" stroke-width="0.8" stroke-linejoin="round">${parts.join('')}</g>`);
    }

    const list: Quad[] = [];
    const L = LIGHT_DIR;
    for (let c = 0; c < cols - 1; c += stride) {
      const c1 = Math.min(c + stride, cols - 1);
      for (let r = 0; r + 1 < rows; r++) {
        const h00 = s.front[c * rows + r];
        const h10 = s.front[c1 * rows + r];
        const h01 = s.front[c * rows + r + 1];
        const h11 = s.front[c1 * rows + r + 1];
        const pts = [
          s.project(wx(c), h00 * s.height, wz(r)),
          s.project(wx(c1), h10 * s.height, wz(r)),
          s.project(wx(c1), h11 * s.height, wz(r + 1)),
          s.project(wx(c), h01 * s.height, wz(r + 1)),
        ];
        if (pts.some((p) => p === null)) continue;
        const q = pts as readonly (readonly [number, number, number])[];

        // Normal of the patch: the cross product of its two edges, up.
        const ax = wx(c1) - wx(c);
        const ay = (h10 - h00) * s.height;
        const bz = wz(r + 1) - wz(r);
        const by = (h01 - h00) * s.height;
        let nx = ay * bz; // a × b, with a = (ax, ay, 0) and b = (0, by, bz)
        let ny = -ax * bz;
        let nz = ax * by;
        if (ny < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;

        const h = (h00 + h10 + h01 + h11) / 4;
        const cr = Math.max(crest[c], crest[c1]);
        const fill = patchColor({
          hue: hues[s.tone[c]] ?? hues[0],
          h,
          top: cr > 1e-3 ? Math.min(h / cr, 1) : 0,
          ny,
          diffuse: Math.max(nx * L[0] + ny * L[1] + nz * L[2], 0),
          doubt: s.doubt[c],
          div: s.div[c],
        });
        list.push({
          depth: (q[0][2] + q[1][2] + q[2][2] + q[3][2]) / 4,
          points: q.map((p) => `${n(p[0])},${n(p[1])}`).join(' '),
          fill,
        });
      }
    }
    list.sort((a, b) => b.depth - a.depth);
    quads = list.length;
    const body = list.map((q) => `<polygon points="${q.points}" fill="${q.fill}" stroke="${q.fill}"/>`).join('');
    out.push(`<g stroke-width="0.6" stroke-linejoin="round">${body}</g>`);
  }

  out.push(planeSvg(s));
  return { svg: `<g>${out.join('')}</g>`, quads, stride };
}

// -------------------------------------------------------- floor, plane

function floorSvg(s: SceneInput): string {
  const hw = s.width / 2;
  const hd = s.depth / 2;
  const cell = s.width / 40;
  const reach = s.width * 0.1; // the grid goes a little beyond the outline
  const lines: string[] = [];
  const add = (x0: number, z0: number, x1: number, z1: number, major: boolean): void => {
    const a = s.project(x0, 0, z0);
    const b = s.project(x1, 0, z1);
    if (a && b) lines.push(`<path d="M${n(a[0])} ${n(a[1])}L${n(b[0])} ${n(b[1])}" ${major ? 'stroke-opacity="0.5"' : 'stroke-opacity="0.22"'}/>`);
  };
  let k = 0;
  for (let x = -hw - reach; x <= hw + reach + 1e-6; x += cell, k++) add(x, -hd - reach, x, hd + reach, k % 4 === 0);
  k = 0;
  for (let z = -hd - reach; z <= hd + reach + 1e-6; z += cell, k++) add(-hw - reach, z, hw + reach, z, k % 4 === 0);
  const corners = [
    s.project(-hw, 0, -hd),
    s.project(hw, 0, -hd),
    s.project(hw, 0, hd),
    s.project(-hw, 0, hd),
  ];
  const outline = corners.every((p) => p !== null)
    ? `<polygon points="${corners.map((p) => `${n(p![0])},${n(p![1])}`).join(' ')}" fill="none" stroke="${COLOR.muted}" stroke-opacity="0.6" stroke-width="1"/>`
    : '';
  return `<g stroke="${COLOR.lineStrong}" stroke-width="0.7" fill="none">${lines.join('')}</g>${outline}`;
}

// The light plane at the selected column and the cut of the surface on it.
function planeSvg(s: SceneInput): string {
  const c = s.selected;
  if (c < 0 || c >= s.cols) return '';
  const x = worldX(c, s.width, s.span);
  const hd = s.depth / 2 + 0.3;
  const top = s.height * PLANE_RISE;
  const q = [s.project(x, 0, -hd), s.project(x, 0, hd), s.project(x, top, hd), s.project(x, top, -hd)];
  let out = '';
  if (q.every((p) => p !== null)) {
    const pts = q.map((p) => `${n(p![0])},${n(p![1])}`).join(' ');
    out += `<polygon points="${pts}" fill="${COLOR.high}" fill-opacity="${s.pinned ? 0.07 : 0.035}" stroke="${COLOR.high}" stroke-opacity="${s.pinned ? 0.7 : 0.35}"/>`;
  }
  const cut: string[] = [];
  for (let r = 0; r < s.rows; r++) {
    const p = s.project(x, s.front[c * s.rows + r] * s.height, worldZ(r, s.rows, s.depth, s.backFirst));
    if (p) cut.push(`${n(p[0])},${n(p[1])}`);
  }
  if (cut.length > 1) out += `<polyline points="${cut.join(' ')}" fill="none" stroke="${COLOR.high}" stroke-width="1.6" stroke-linejoin="round"/>`;
  return out;
}
