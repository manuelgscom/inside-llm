// The annotations of the Relief: what lies over the 3D picture and says what
// it is. Axis words, position ticks, the probability ruler, row labels, the
// chips at the selected position, the info card, the legend and the hover
// tooltip. The panel projects the 3D points to CSS pixels and fills a Notes;
// this file lays it out and writes it as SVG. The same SVG is shown over the
// canvas (every frame the camera moves) and baked into the SVG and PNG
// exports, so what is saved is what is on screen. No DOM, no three.js.

import { n, SVG_FONT_MONO, SVG_FONT_UI, xmlEscape } from './export';
import { COLOR } from './theme';

// Measures a text in CSS px: the canvas's measureText in the browser, an
// estimate in tests.
export type Measure = (text: string, size: number, mono: boolean) => number;

export const estimateWidth: Measure = (text, size, mono) => Array.from(text).length * size * (mono ? 0.6 : 0.56);

// A piece of a line of text.
export interface Part {
  text: string;
  color?: string;
  mono?: boolean;
  bold?: boolean;
  size?: number;
}

export interface WordNote {
  x: number;
  y: number;
  text: string;
  anchor?: 'start' | 'middle' | 'end';
  color?: string;
  size?: number;
  mono?: boolean;
  opacity?: number;
}

export interface TickNote {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// A chip beside the plane at the selected position: a short leader on its
// left, then its parts. (x, y) is the left end of the leader's target, the
// chip is centred on y.
export interface ChipNote {
  x: number;
  y: number;
  parts: Part[];
}

// A floating card. (x, y) is its top-left corner, or its top-right when
// `align` is 'end'. A swatch before a line is optional.
export interface CardNote {
  x: number;
  y: number;
  align?: 'start' | 'end';
  title?: Part[];
  lines: { parts: Part[]; swatch?: string }[];
}

export interface Notes {
  w: number;
  h: number;
  words: WordNote[];
  ticks: TickNote[];
  chips: ChipNote[];
  cards: CardNote[];
}

export const CHIP_H = 18;
export const CHIP_GAP = 21; // between the centres of two chips
export const LEADER = 8;
const CARD_PAD = 9;
const CARD_LINE = 15;

// ------------------------------------------------------------ geometry

// Positions to label along an axis that shows [first, last] positions in
// `px` pixels: a round step (1, 2, 5, 10, 20, ...) with at least `minPx`
// between two labels.
export function tickPositions(first: number, last: number, px: number, minPx = 56): number[] {
  const count = Math.max(0, last - first + 1);
  if (count === 0 || !(px > 0)) return [];
  const perPosition = px / count;
  let every = 1;
  for (const m of [1, 2, 5]) {
    for (let k = 1; k <= 1e7; k *= 10) {
      every = m * k;
      if (every * perPosition >= minPx) {
        const out: number[] = [];
        for (let i = Math.ceil(first / every) * every; i <= last; i += every) out.push(i);
        return out;
      }
    }
  }
  return [];
}

// The probability ruler: heights are sqrt(p), so a gridline at probability p
// stands at height sqrt(p) of the box.
export const RULER_PROBS = [1, 0.5, 0.25, 0.1] as const;

export function rulerTicks(): { p: number; h: number; label: string }[] {
  return RULER_PROBS.map((p) => ({ p, h: Math.sqrt(p), label: `${Math.round(p * 100)}%` }));
}

// Chips that lie close on the screen are spread, top to bottom, so none
// covers another. Input: y of each chip in px; output: the adjusted y of
// each, same order. When the column would run past the bottom it moves up,
// but not past the top.
export function spreadChips(ys: readonly number[], height: number, gap = CHIP_GAP): number[] {
  const order = ys.map((_, i) => i).sort((a, b) => ys[a] - ys[b]);
  const out = ys.slice();
  for (let i = 1; i < order.length; i++) out[order[i]] = Math.max(out[order[i]], out[order[i - 1]] + gap);
  if (order.length > 0) {
    const last = out[order[order.length - 1]] - (height - gap / 2);
    const over = Math.min(last, out[order[0]] - gap / 2);
    if (over > 0) for (const i of order) out[i] -= over;
  }
  return out;
}

// With more rows than fit in the height, only every k-th keeps its chip, the
// last always. Returns the indices kept.
export function strideRows(rows: number, height: number, gap = CHIP_GAP): number[] {
  const fit = Math.max(1, Math.floor((height - 8) / gap));
  const stride = Math.ceil(rows / fit);
  const out: number[] = [];
  for (let r = 0; r < rows; r++) if ((rows - 1 - r) % stride === 0) out.push(r);
  return out;
}

// ----------------------------------------------------------------- SVG

function textEl(t: WordNote): string {
  const size = t.size ?? 11;
  return (
    `<text x="${n(t.x)}" y="${n(t.y)}" font-size="${size}" fill="${t.color ?? COLOR.muted}"` +
    (t.anchor && t.anchor !== 'start' ? ` text-anchor="${t.anchor}"` : '') +
    (t.mono ? ` font-family="${SVG_FONT_MONO}"` : '') +
    (t.opacity !== undefined ? ` opacity="${n(t.opacity)}"` : '') +
    ` dominant-baseline="central">${xmlEscape(t.text)}</text>`
  );
}

function partWidth(p: Part, measure: Measure): number {
  return measure(p.text, p.size ?? 11, p.mono ?? false) + (p.bold ? 0.5 : 0);
}

function partsWidth(parts: readonly Part[], measure: Measure, gap: number): number {
  let w = 0;
  for (const p of parts) w += partWidth(p, measure) + gap;
  return Math.max(0, w - gap);
}

// Parts laid out left to right from x, centred on y.
function partsSvg(parts: readonly Part[], x: number, y: number, measure: Measure, gap: number): string {
  let out = '';
  let px = x;
  for (const p of parts) {
    out +=
      `<text x="${n(px)}" y="${n(y)}" font-size="${p.size ?? 11}" fill="${p.color ?? COLOR.high}"` +
      (p.mono ? ` font-family="${SVG_FONT_MONO}"` : '') +
      (p.bold ? ' font-weight="600"' : '') +
      ` dominant-baseline="central" xml:space="preserve">${xmlEscape(p.text)}</text>`;
    px += partWidth(p, measure) + gap;
  }
  return out;
}

function chipSvg(c: ChipNote, measure: Measure): string {
  const w = partsWidth(c.parts, measure, 6) + 15;
  const x = c.x + LEADER + 2;
  return (
    `<line x1="${n(c.x + 1)}" y1="${n(c.y)}" x2="${n(x)}" y2="${n(c.y)}" stroke="${COLOR.muted}" stroke-opacity="0.55"/>` +
    `<rect x="${n(x)}" y="${n(c.y - CHIP_H / 2)}" width="${n(w)}" height="${CHIP_H}" rx="8" fill="${COLOR.surface}" fill-opacity="0.94" stroke="${COLOR.lineStrong}" stroke-opacity="0.9"/>` +
    partsSvg(c.parts, x + 7, c.y, measure, 6)
  );
}

export function cardSize(card: CardNote, measure: Measure): { w: number; h: number } {
  let w = card.title ? partsWidth(card.title, measure, 6) : 0;
  for (const l of card.lines) w = Math.max(w, partsWidth(l.parts, measure, 8) + (l.swatch ? 14 : 0));
  const rows = card.lines.length + (card.title ? 1 : 0);
  return { w: Math.ceil(w + 2 * CARD_PAD), h: rows * CARD_LINE + 2 * CARD_PAD - 4 };
}

function cardSvg(card: CardNote, measure: Measure): string {
  const { w, h } = cardSize(card, measure);
  const x0 = card.align === 'end' ? card.x - w : card.x;
  let out =
    `<rect x="${n(x0)}" y="${n(card.y)}" width="${n(w)}" height="${n(h)}" rx="8" fill="${COLOR.surface}" fill-opacity="0.9" stroke="${COLOR.lineStrong}" stroke-opacity="0.9"/>`;
  let y = card.y + CARD_PAD + 3;
  if (card.title) {
    out += partsSvg(card.title, x0 + CARD_PAD, y + 4, measure, 6);
    y += CARD_LINE;
  }
  for (const l of card.lines) {
    let x = x0 + CARD_PAD;
    if (l.swatch) {
      out += `<rect x="${n(x)}" y="${n(y + 1)}" width="8" height="8" rx="2" fill="${l.swatch}"/>`;
      x += 14;
    }
    out += partsSvg(l.parts, x, y + 5, measure, 8);
    y += CARD_LINE;
  }
  return out;
}

// The annotations as an SVG fragment (a <g>), in CSS px of the panel.
export function notesSvg(notes: Notes, measure: Measure = estimateWidth): string {
  let out = `<g font-family="${SVG_FONT_UI}">`;
  if (notes.ticks.length > 0) {
    out += `<path d="${notes.ticks.map((t) => `M${n(t.x1)} ${n(t.y1)}L${n(t.x2)} ${n(t.y2)}`).join('')}" stroke="${COLOR.lineStrong}" fill="none"/>`;
  }
  for (const w of notes.words) out += textEl(w);
  for (const c of notes.chips) out += chipSvg(c, measure);
  for (const c of notes.cards) out += cardSvg(c, measure);
  return out + '</g>';
}
