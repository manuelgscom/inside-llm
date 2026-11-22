// The Timeline as an SVG document, from a plain description of what the
// panel has laid out: no DOM, no canvas, so it is tested with Vitest alone.
// timeline.ts collects the input from its own geometry and the store; the
// picture is what the canvas shows (the zoom window included) minus the
// pointer's readouts: bands with their scales, guides, prompt, traces with
// their soft areas, disagreement ticks, position labels and the tree.
//
// Coordinates are the panel's CSS px, so a PNG at scale 2 is the canvas at
// twice its size. Position i is centred at left + (i + 0.5 - lo) * step.

import { n as num, svgDocument, xmlEscape, SVG_FONT_MONO } from './export';
import type { StopGlyph } from './minimap';
import { COLOR } from './theme';
import { tickIndices } from './timeline-zoom';

// One trace: y in px per position of the path, undefined where the model
// has no decision (the trace breaks there).
export interface SvgSeries {
  id: string;
  color: string;
  y: readonly (number | undefined)[];
  base: number; // where the soft area ends
  far: number; // where it is strongest; equal to base: no area
  areaAlpha: number; // opacity of the area at `far`
}

export interface SvgBandLabel {
  y0: number;
  y1: number;
  color: string;
  name: string;
  scale: string;
}

// What the panel recorded while drawing the tree (see drawTree).
export interface SvgTree {
  y: number; // the main line
  label: string; // "path", "2 branches"
  branches: readonly { x0: number; x1: number; y: number; c: number }[];
  start: number; // x of position 0
  prompt: number; // x of the last prompt token
  end: number; // x of the last position; NaN without a path
  forks: readonly number[];
  pathStop: { glyph: StopGlyph; x: number } | null;
  branchStops: readonly { glyph: StopGlyph; x: number; y: number }[];
  userMain: readonly number[]; // x of the tokens the user chose on the path
  userBranch: readonly { x: number; y: number }[];
  cursors: readonly { x: number; y: number; color: string; ring: boolean }[];
}

export interface SvgLegendItem {
  kind: 'differ' | 'user';
  x: number;
  y: number;
  text: string;
}

export interface TimelineSvgInput {
  width: number;
  height: number;
  title: string;
  desc: string;
  caption: string; // top right: models and visible range
  padX: number;
  left: number; // plot area: x from left to right, y from top to bottom
  right: number;
  top: number;
  bottom: number;
  lo: number; // window, in axis units
  vis: number;
  step: number; // px per position
  span: number;
  count: number; // positions in the path
  promptLength: number;
  markY: number; // base of the disagreement ticks (two models)
  tickEvery: number;
  tickY: number;
  bandLabels: readonly SvgBandLabel[];
  guides: { solid: readonly number[]; dotted: readonly number[] };
  series: readonly SvgSeries[];
  disagreements: readonly number[]; // positions where the picks differ
  legend: readonly SvgLegendItem[];
  tree: SvgTree;
}

const GLOW: Record<string, number> = { [COLOR.a]: 0.22, [COLOR.b]: 0.22, [COLOR.high]: 0.18, [COLOR.dis]: 0.28 };
const HEAD_Y = 12;
const MARK_TICK = 7;

function fill(color: string, opacity?: number): string {
  return opacity === undefined || opacity >= 1 ? `fill="${color}"` : `fill="${color}" fill-opacity="${num(opacity)}"`;
}

function stroke(color: string, width: number, opacity = 1, extra = ''): string {
  return `stroke="${color}" stroke-width="${num(width)}"${opacity < 1 ? ` stroke-opacity="${num(opacity)}"` : ''}${extra}`;
}

function text(x: number, y: number, s: string, color: string, size: number, opts: { anchor?: 'start' | 'middle' | 'end'; weight?: number; mono?: boolean } = {}): string {
  const anchor = opts.anchor && opts.anchor !== 'start' ? ` text-anchor="${opts.anchor}"` : '';
  const weight = opts.weight ? ` font-weight="${opts.weight}"` : '';
  const family = opts.mono ? ` font-family="${SVG_FONT_MONO}"` : '';
  return `<text x="${num(x)}" y="${num(y)}" fill="${color}" font-size="${size}"${weight}${family}${anchor} dominant-baseline="central">${xmlEscape(s)}</text>`;
}

function line(x0: number, y0: number, x1: number, y1: number, attrs: string): string {
  return `<line x1="${num(x0)}" y1="${num(y0)}" x2="${num(x1)}" y2="${num(y1)}" ${attrs}/>`;
}

function diamond(x: number, y: number): string {
  const r = 4;
  const pts = `${num(x)},${num(y - r)} ${num(x + r)},${num(y)} ${num(x)},${num(y + r)} ${num(x - r)},${num(y)}`;
  return `<polygon points="${pts}" fill="${COLOR.surface}" ${stroke(COLOR.high, 1.5)}/>`;
}

function stopMark(glyph: StopGlyph, x: number, y: number, color: string): string {
  if (glyph === 'end') return `<rect x="${num(x - 0.75)}" y="${num(y - 4)}" width="1.75" height="8" ${fill(color)}/>`;
  if (glyph === 'cut') {
    const d = `M${num(x - 1)} ${num(y + 3.5)}L${num(x + 2)} ${num(y - 3.5)}M${num(x + 3)} ${num(y + 3.5)}L${num(x + 6)} ${num(y - 3.5)}`;
    return `<path d="${d}" fill="none" ${stroke(color, 1.25, 1, ' stroke-linecap="round"')}/>`;
  }
  return `<rect x="${num(x - 0.5)}" y="${num(y - 2.5)}" width="5" height="5" ${fill(color)}/>`;
}

function dot(x: number, y: number, color: string): string {
  return (
    `<circle cx="${num(x)}" cy="${num(y)}" r="7" ${fill(color, GLOW[color] ?? 0.22)}/>` +
    `<circle cx="${num(x)}" cy="${num(y)}" r="4.25" ${fill(COLOR.bg)}/>` +
    `<circle cx="${num(x)}" cy="${num(y)}" r="3" ${fill(color)}/>`
  );
}

// The segments of `y` between first and last (inclusive): runs of positions
// that have a value, as [x, y] points.
function runs(y: readonly (number | undefined)[], first: number, last: number, xOf: (i: number) => number): [number, number][][] {
  const out: [number, number][][] = [];
  let cur: [number, number][] | null = null;
  for (let i = first; i <= last; i++) {
    const v = y[i];
    if (v === undefined) {
      cur = null;
      continue;
    }
    if (cur === null) {
      cur = [];
      out.push(cur);
    }
    cur.push([xOf(i), v]);
  }
  return out;
}

function pointsPath(pts: readonly [number, number][]): string {
  return pts.map(([x, y], k) => `${k === 0 ? 'M' : 'L'}${num(x)} ${num(y)}`).join('');
}

function gradient(s: SvgSeries): string {
  const c = s.color;
  return (
    `<linearGradient id="tl-g-${s.id}" gradientUnits="userSpaceOnUse" x1="0" y1="${num(s.far)}" x2="0" y2="${num(s.base)}">` +
    `<stop offset="0" stop-color="${c}" stop-opacity="${s.areaAlpha}"/>` +
    `<stop offset="0.6" stop-color="${c}" stop-opacity="0.08"/>` +
    `<stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient>`
  );
}

function seriesSvg(s: SvgSeries, first: number, last: number, xOf: (i: number) => number): string {
  const segs = runs(s.y, first, last, xOf);
  let area = '';
  let lines = '';
  let dots = '';
  for (const pts of segs) {
    if (pts.length === 1) {
      dots += `<rect x="${num(pts[0][0] - 1)}" y="${num(pts[0][1] - 1)}" width="2" height="2" ${fill(s.color)}/>`;
      continue;
    }
    const d = pointsPath(pts);
    lines += d;
    const [x1] = pts[pts.length - 1];
    area += `${d}L${num(x1)} ${num(s.base)}L${num(pts[0][0])} ${num(s.base)}Z`;
  }
  let out = '';
  if (s.far !== s.base && area !== '') out += `<path d="${area}" fill="url(#tl-g-${s.id})"/>`;
  if (lines !== '') {
    const j = ' stroke-linejoin="round" stroke-linecap="round"';
    out += `<path d="${lines}" fill="none" ${stroke(s.color, 6, 0.08, j)}/>`;
    out += `<path d="${lines}" fill="none" ${stroke(s.color, 3, 0.18, j)}/>`;
    out += `<path d="${lines}" fill="none" ${stroke(s.color, 1.5, 1, j)}/>`;
  }
  return out + dots;
}

function bandLabel(b: SvgBandLabel, padX: number): string {
  const mid = (b.y0 + b.y1) / 2;
  const tall = b.y1 - b.y0 >= 30;
  const sh = tall ? 22 : 10;
  return (
    `<rect x="${num(padX - 1.5)}" y="${num(mid - sh / 2 - 1.5)}" width="6" height="${num(sh + 3)}" rx="3" ${fill(b.color, GLOW[b.color] ?? 0.22)}/>` +
    `<rect x="${num(padX)}" y="${num(mid - sh / 2)}" width="3" height="${num(sh)}" rx="1.5" ${fill(b.color)}/>` +
    text(padX + 9, tall ? mid - 6 : mid, b.name, COLOR.muted, 11, { weight: 500 }) +
    (tall ? text(padX + 9, mid + 8, b.scale, COLOR.low, 10) : '')
  );
}

function treeSvg(t: SvgTree, padX: number, drawn: boolean): { label: string; body: string } {
  const label = text(padX + 9, t.y, t.label, COLOR.muted, 10.5, { weight: 500 });
  if (!drawn) return { label, body: '' };
  const cap = ' stroke-linecap="round" stroke-linejoin="round"';
  let body = '';
  let all = '';
  for (const l of t.branches) {
    const c = Math.max(l.x1, l.x0 + l.c);
    const mid = l.x0 + l.c / 2;
    all += `M${num(l.x0)} ${num(t.y)}C${num(mid)} ${num(t.y)} ${num(mid)} ${num(l.y)} ${num(l.x0 + l.c)} ${num(l.y)}L${num(c)} ${num(l.y)}`;
  }
  if (all !== '') body += `<path d="${all}" fill="none" ${stroke(COLOR.low, 1.25, 0.75, cap)}/>`;
  const seg = (x0: number, x1: number, attrs: string): string => line(x0, t.y, Math.max(x1, x0 + 0.5), t.y, attrs);
  body += seg(t.prompt, t.end, `${stroke(COLOR.high, 6, 0.1, cap)}`);
  body += seg(t.prompt, t.end, `${stroke(COLOR.high, 2, 0.9, cap)}`);
  body += seg(t.start, t.prompt, `${stroke(COLOR.lineStrong, 2, 1, cap)}`);
  for (const x of t.forks) body += `<circle cx="${num(x)}" cy="${num(t.y)}" r="2" ${fill(COLOR.muted)}/>`;
  if (t.pathStop) body += stopMark(t.pathStop.glyph, t.pathStop.x, t.y, COLOR.high);
  for (const s of t.branchStops) body += stopMark(s.glyph, s.x, s.y, COLOR.muted);
  for (const x of t.userMain) body += diamond(x, t.y);
  for (const d of t.userBranch) body += diamond(d.x, d.y);
  for (const c of t.cursors) {
    body += c.ring ? `<circle cx="${num(c.x)}" cy="${num(c.y)}" r="5.5" fill="none" ${stroke(c.color, 1.5)}/>` : dot(c.x, c.y, c.color);
  }
  return { label, body };
}

function legendSvg(items: readonly SvgLegendItem[]): string {
  let out = '';
  for (const it of items) {
    if (it.kind === 'differ') {
      const base = it.y + 4;
      out += `<rect x="${num(it.x - 1.75)}" y="${num(base - 9)}" width="3.5" height="10" ${fill(COLOR.dis, 0.28)}/>`;
      out += `<rect x="${num(it.x - 0.75)}" y="${num(base - 8)}" width="1.5" height="8" ${fill(COLOR.dis)}/>`;
      out += text(it.x + 7, it.y, it.text, COLOR.muted, 11);
    } else {
      out += diamond(it.x + 4, it.y);
      out += text(it.x + 13, it.y, it.text, COLOR.muted, 11);
    }
  }
  return out;
}

// The whole document.
export function buildTimelineSvg(inp: TimelineSvgInput): string {
  const xOf = (i: number): number => inp.left + (i + 0.5 - inp.lo) * inp.step;
  const first = Math.max(0, Math.floor(inp.lo) - 1);
  const last = Math.min(inp.count - 1, Math.ceil(inp.lo + inp.vis) + 1);
  const withPath = inp.count > 0 && inp.bottom > inp.top;

  const defs =
    `<clipPath id="tl-plot"><rect x="${num(inp.left)}" y="0" width="${num(Math.max(0, inp.right - inp.left))}" height="${num(inp.height)}"/></clipPath>` +
    inp.series.filter((s) => s.far !== s.base).map(gradient).join('');

  let body = `<desc>${xmlEscape(inp.desc)}</desc>`;
  body += legendSvg(inp.legend);
  if (inp.caption !== '') body += text(inp.width - inp.padX, HEAD_Y, inp.caption, COLOR.low, 11, { anchor: 'end' });
  for (const b of inp.bandLabels) body += bandLabel(b, inp.padX);

  if (inp.bottom > inp.top) {
    const g = inp.guides;
    const solid = g.solid.map((y) => line(inp.left, Math.round(y) + 0.5, inp.right, Math.round(y) + 0.5, stroke(COLOR.line, 1))).join('');
    const dotted = g.dotted.map((y) => line(inp.left, Math.round(y) + 0.5, inp.right, Math.round(y) + 0.5, stroke(COLOR.line, 1, 0.7, ' stroke-dasharray="2 4"'))).join('');
    body += solid + dotted;
  }

  let plot = '';
  if (withPath) {
    const prompt = inp.promptLength;
    if (prompt > 0) {
      const x0 = inp.left - inp.lo * inp.step;
      const x1 = Math.round(inp.left + (prompt - inp.lo) * inp.step) + 0.5;
      plot += `<rect x="${num(x0)}" y="${num(inp.top)}" width="${num(Math.max(0, x1 - x0))}" height="${num(inp.bottom - inp.top)}" ${fill(COLOR.high, 0.022)}/>`;
      plot += line(x1, inp.top, x1, inp.bottom, stroke(COLOR.lineStrong, 1, 1, ' stroke-dasharray="2 4"'));
      const visible = Math.min(x1, inp.right) - Math.max(x0, inp.left);
      if (visible > 60) plot += text(Math.max(x0, inp.left) + 8, inp.top + 10, 'prompt', COLOR.unlikely, 10.5, { weight: 500 });
    }
    for (const s of inp.series) plot += seriesSvg(s, first, last, xOf);
    let lastX = -Infinity;
    let ticks = '';
    for (const i of inp.disagreements) {
      if (i < first || i > last) continue;
      const x = Math.round(xOf(i));
      if (x - lastX < 3) continue;
      lastX = x;
      const h = Math.min(MARK_TICK, 8);
      ticks += `<rect x="${num(x - 0.75)}" y="${num(inp.markY - h)}" width="1.5" height="${h}"/>`;
    }
    if (ticks !== '') {
      plot += `<g ${fill(COLOR.dis)} ${stroke(COLOR.dis, 2.5, 0.28)} paint-order="stroke">${ticks}</g>`;
    }
  }

  if (inp.bottom > inp.top) {
    for (const i of tickIndices(inp.lo, inp.vis, inp.tickEvery, inp.span)) {
      const x = xOf(i);
      if (x < inp.left || x > inp.right) continue;
      plot += `<rect x="${num(Math.round(x))}" y="${num(inp.bottom + 1)}" width="1" height="3" ${fill(COLOR.lineStrong)}/>`;
      plot += text(x, inp.tickY, String(i), COLOR.unlikely, 10, { anchor: 'middle', mono: true });
    }
  }

  const tree = treeSvg(inp.tree, inp.padX, inp.count > 0);
  body += tree.label;
  body += `<g clip-path="url(#tl-plot)">${plot}${tree.body}</g>`;

  return svgDocument(inp.width, inp.height, body, { defs, title: inp.title });
}
