// Timeline (Canvas 2D): traces along the viewed path, and under them the tree
// of branches. Moving the pointer over it selects the position (the sweep,
// animation 5); a click pins. It fills whatever box its container gives it:
// the traces grow with the height up to a cap and are centred beyond it
// (compare.ts traceBox); the tree takes a row per level of overlapping
// branches, up to a cap.
//
// One model: the entropy of A, growing up.
// Two models: three bands on the same horizontal axis.
//
//   ▮ picks differ  ◇ your branch                hover to inspect · click to pin
//   entropy A    ▁▂▁▃▅▂▁▁▂▁▃▂▁   ╭──────────────────────╮   cyan, up from its base
//   ───────────────────────────  │ #57 "reuses"  pinned │
//   divergence   ▁▁▂▁▃▇▂▁▁▁▂▁▁   │ A 1.75 B 2.00 JS 0.03│   white, js of PAIR, 0–1 bit
//                     ▮ ▮     ▮  ╰──────────────────────╯   magenta: disagreements
//   ───────────────────────────
//   entropy B    ▔▔▔▔▔▔▔▔▔▔▔▔▔                              amber, down: the mirror of A
//                0    10    20    30                        positions
//   branches     ━━━━━━┯━━━━━━━━━●   the tree (render/minimap.ts): the viewed
//                      ╰─◇──────|    path, the branches curving out of it,
//                                    a dot per cursor, why each one stopped
//
// The traces and the tree are drawn into an offscreen canvas only when the
// data changes, so sweeping costs a blit, a marker and the readout, not a
// redraw of the whole path. Hovering a branch lights it and previews its
// text; a click makes it the viewed path (local: no command to the engine).
//
// Zoom: the wheel (or a pinch) zooms the position axis around the pointer,
// shift+wheel pans; the window is timeline-zoom.ts. Everything on the axis
// (traces, prompt, ticks, tree, selection) is laid out through xOf(), which
// knows the window, and clipped to the plot area. exportSvg() / exportPng()
// save what is on screen (timeline-svg.ts).

import { ORIGIN_USER, type VocabEntry } from '../source/frames';
import type { Branch, Slot, Store } from '../store/store';
import { showWhitespace, tokenLabel } from '../store/text';
import type { View } from '../store/view';
import { MARK_STRIP, jsFigure, timelineBands, traceBox, type Bands } from './compare';
import { drawIcon } from './icons';
import {
  assignRows,
  branchNodes,
  CURVE_W,
  hitBranch,
  maxRows,
  previewText,
  ROW_H,
  rowsUsed,
  STOP_WORDS,
  stopGlyph,
  TREE_GAP,
  treeHeight,
  type MapLine,
  type StopGlyph,
} from './minimap';
import { svgToPngBlob } from './export';
import { Surface } from './surface';
import { fillTabular, tabularWidth } from './tabular';
import { COLOR, MODEL_COLOR, SIZE, font, rgba, roundRect, uiFont } from './theme';
import { buildTimelineSvg, type SvgBandLabel, type SvgLegendItem, type SvgSeries, type SvgTree } from './timeline-svg';
import { FIT, panWindow, resolveWindow, tickEvery, tickIndices, zoomWindow, type ZoomWindow } from './timeline-zoom';

const PAD_X = 14;
const HEAD_Y = 12; // the header line
const TOP = 28; // the traces never start above this
const AXIS_H = 14; // position labels under the traces
const MIN_TRACES = 84; // least height the traces keep when the tree grows
const MAX_ONE = 280; // most px the traces take: one model, two models
const MAX_TWO = 440;
const END_ROOM = 10; // after the last position: room for a stop glyph
const TICK_MIN_PX = 64; // least room between two position labels
const READOUT_CHARS = 18;
const PREVIEW_CHARS = 60;
const PREVIEW_TOKENS = 96; // tokens read for a preview: enough for 60 characters
const DIS_GAP = 3; // least px between two disagreement ticks
export const MIN_SPAN = 64; // positions the axis holds before it starts to compress

// Colours with alpha, built once: painting builds no strings.
const SEL_GLOW = rgba(COLOR.high, 0.16);
const PROMPT_FILL = rgba(COLOR.high, 0.022);
const CHIP_SHADOW = rgba(COLOR.bg, 0.55);
const GLOW: Record<string, string> = {
  [COLOR.a]: rgba(COLOR.a, 0.22),
  [COLOR.b]: rgba(COLOR.b, 0.22),
  [COLOR.high]: rgba(COLOR.high, 0.18),
  [COLOR.dis]: rgba(COLOR.dis, 0.28),
};
const DASH: number[] = [2, 4];
const NO_DASH: number[] = [];

// The part of animation 3 (the split) drawn here: a magenta pulse across the
// bands at a position of the viewed path.
export interface Pulse {
  index: number;
  alpha: number; // 0..1
}

// A piece of the readout's second line.
interface Part {
  text: string;
  color: string;
  ui: boolean; // in the UI face (words), else monospaced (figures)
  w: number;
}

export class TimelinePanel {
  private readonly surface: Surface;
  private readonly trace = document.createElement('canvas');
  private traceKey = '';
  private scaleBits = 4;
  private left = PAD_X; // x where the traces start; the band labels sit before it
  private two = false; // layout of the last trace
  private top = TOP; // the box of the traces, as last laid out
  private bottom = TOP;
  private bands: Bands = timelineBands(0, TOP, 0);
  private span = MIN_SPAN; // positions across the axis: the path and the branch tips
  private win: ZoomWindow = FIT; // what the user asked for
  private winEpoch = -1; // the store's pathEpoch the window belongs to
  private lo = 0; // the window as laid out: axis units at the left edge
  private vis = MIN_SPAN; // and the positions across it
  // What the last trace drew, kept for exportSvg().
  private bandLabels: SvgBandLabel[] = [];
  private guideYs = { solid: [] as number[], dotted: [] as number[] };
  private seriesRecs: SeriesRec[] = [];
  private legend: SvgLegendItem[] = [];
  private tree: SvgTree = emptyTree(0, '');
  // The halo of the selection line, centred on x = 0 (built once).
  private readonly selGlow: CanvasGradient;

  // The tree as last drawn, for the pointer: the main line's y and, per
  // branch, its line and what it is.
  private mapY = 0;
  private mapLines: MapLine[] = [];
  private mapBranches: Branch[] = [];
  private pointerX = -1; // where the pointer is, -1 outside
  private pointerY = -1;
  // The branch under the pointer (index in mapLines), lit, and its chip.
  private hoverBranch = -1;
  private hoverPath: Path2D | null = null;
  private hoverText = '';
  private hoverInfo = '';
  private hoverW = 0; // width of the chip

  // The readout of the selected position, rebuilt when it changes.
  private roSel = -1;
  private roKey = '';
  private roPinned = false;
  private roIndex = '';
  private roLabel = '';
  private roIndexW = 0;
  private roLabelW = 0;
  private roW = 0;
  private readonly labels = new WeakMap<VocabEntry, string>();
  private readonly parts: Part[] = [];

  constructor(
    canvas: HTMLCanvasElement,
    private readonly store: Store,
    private readonly view: View,
  ) {
    this.surface = new Surface(canvas, () => (store.dirty.timeline = true));
    const g = this.surface.ctx.createLinearGradient(-7, 0, 7, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, SEL_GLOW);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    this.selGlow = g;

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.surface.h : 1;
        const dx = e.deltaX * unit;
        const dy = e.deltaY * unit;
        if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
          this.pan((Math.abs(dx) > Math.abs(dy) ? dx : dy) / (this.step() || 1));
        } else {
          this.zoomBy(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), e.offsetX);
        }
      },
      { passive: false },
    );
    canvas.addEventListener('mousemove', (e) => {
      this.pointerX = e.offsetX;
      this.pointerY = e.offsetY;
      if (this.updateHover()) store.dirty.timeline = true;
      canvas.style.cursor = this.hoverBranch >= 0 ? 'pointer' : '';
      const i = this.indexAt(e.offsetX);
      if (i !== null) this.view.setHover(i);
    });
    canvas.addEventListener('mouseleave', () => {
      this.pointerX = -1;
      this.pointerY = -1;
      canvas.style.cursor = '';
      if (this.updateHover()) store.dirty.timeline = true;
      this.view.setHover(null);
    });
    canvas.addEventListener('click', (e) => {
      const b = this.mapBranches[hitBranch(this.mapLines, e.offsetX, e.offsetY, this.mapY)];
      if (b) {
        this.store.viewNode(b.tip); // looking does not move the engine
        canvas.style.cursor = '';
        return;
      }
      const i = this.indexAt(e.offsetX);
      if (i === null) return;
      if (this.view.pinnedIndex() === i) this.view.unpin();
      else this.view.pin(i);
    });
  }

  paint(pulse: Pulse | null = null): void {
    const sf = this.surface;
    if (!sf.begin(null)) return;
    const ctx = sf.ctx;
    const s = this.store;
    const n = s.path.length;

    this.refresh();
    ctx.drawImage(this.trace, 0, 0, sf.w, sf.h);

    // The branch under the pointer, lit: it is what a click would view.
    if (this.hoverPath) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = COLOR.high;
      ctx.globalAlpha = 0.16;
      ctx.lineWidth = 6;
      ctx.stroke(this.hoverPath);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.75;
      ctx.stroke(this.hoverPath);
    }

    if (pulse && pulse.alpha > 0 && pulse.index >= 0 && pulse.index < n) this.drawPulse(pulse);
    const sel = this.view.selected();
    if (sel >= 0 && sel < n && this.bottom > this.top) {
      const pinned = this.view.pinnedIndex() !== null;
      const x = Math.round(this.xOf(sel)) + 0.5;
      if (x >= this.left - 1 && x <= this.plotRight() + 1) this.selection(sel, pinned, x);
    }
    if (this.hoverBranch >= 0) this.branchChip();
  }

  // Zooms the position axis by `factor` (above 1 in, below 1 out) around
  // `anchorX` (CSS px; the middle of the plot by default).
  zoomBy(factor: number, anchorX?: number): void {
    const w = this.axisW();
    const frac = anchorX === undefined || !(w > 0) ? 0.5 : (anchorX - this.left) / w;
    this.setWindow(zoomWindow(this.win, this.span, factor, frac));
  }

  // Back to the whole axis.
  zoomFit(): void {
    this.setWindow(FIT);
  }

  // How far the axis is zoomed in: 1 is the whole axis.
  get zoomLevel(): number {
    return this.span / this.vis;
  }

  // The Timeline as it is on screen, as a self-contained SVG document.
  exportSvg(): string {
    const sf = this.surface;
    if (sf.w < 1 || sf.h < 1) throw new Error('The Timeline has no size yet: open its tab first.');
    this.refresh();
    const s = this.store;
    const n = s.path.length;
    const series: SvgSeries[] = this.seriesRecs.map((r) => ({
      id: r.id,
      color: r.color,
      base: r.base,
      far: r.far,
      areaAlpha: r.color === COLOR.high ? 0.22 : 0.36,
      y: Array.from({ length: n }, (_, i) => {
        const v = r.value(i);
        return v === undefined ? undefined : r.y(v);
      }),
    }));
    const disagreements: number[] = [];
    if (this.two) for (let i = 1; i < n; i++) if (s.disagrees(i)) disagreements.push(i);
    const a = Math.max(0, Math.floor(this.lo));
    const b = Math.max(a, Math.min(n - 1, Math.ceil(this.lo + this.vis) - 1));
    const range = n > 0 ? `positions ${a} to ${b} of ${n}` : 'no positions yet';
    const models = (s.hello?.models ?? []).map((m) => `${m.slot}: ${m.name}`);
    const zoom = this.zoomLevel > 1.005 ? ` · zoom ${this.zoomLevel.toFixed(1)}x` : '';
    return buildTimelineSvg({
      width: sf.w,
      height: sf.h,
      title: 'inside-llm timeline',
      desc: `Entropy and divergence per position of the viewed path, and its tree of branches. ${models.join(', ')}. ${range}${zoom}.`,
      caption: [...models, range].join(' · ') + zoom,
      padX: PAD_X,
      left: this.left,
      right: this.plotRight(),
      top: this.top,
      bottom: this.bottom,
      lo: this.lo,
      vis: this.vis,
      step: this.step(),
      span: this.span,
      count: n,
      promptLength: s.promptLength,
      markY: this.bands.markY,
      tickEvery: tickEvery(this.step(), TICK_MIN_PX),
      tickY: this.bottom + AXIS_H / 2 + 3,
      bandLabels: this.bandLabels,
      guides: this.guideYs,
      series,
      disagreements,
      legend: this.legend,
      tree: this.tree,
    });
  }

  // The same, rasterised at `scale` times its CSS size.
  exportPng(scale = 2): Promise<Blob> {
    const svg = this.exportSvg();
    return svgToPngBlob(svg, this.surface.w, this.surface.h, scale);
  }

  dispose(): void {
    this.surface.dispose();
  }

  // ----------------------------------------------------------- internal

  // Lays the trace out again when what it is drawn from has changed.
  private refresh(): void {
    const s = this.store;
    const sf = this.surface;
    // A new path (another session, a branch, a new run) starts from the whole axis:
    // a window left over from the old one could show only its last few positions.
    if (s.pathEpoch !== this.winEpoch) {
      this.winEpoch = s.pathEpoch;
      this.win = FIT;
    }
    const w = this.win;
    const key = `${s.pathEpoch}:${s.path.length}:${s.framesApplied}:${s.front}:${s.twoModels}:${s.follow}:${sf.canvas.width}:${sf.canvas.height}:${w.vis}:${w.lo}:${w.atEnd}`;
    if (key === this.traceKey) return;
    this.traceKey = key;
    this.drawTrace();
  }

  private setWindow(w: ZoomWindow): void {
    if (w === this.win) return;
    this.win = w;
    this.store.dirty.timeline = true;
  }

  private pan(units: number): void {
    this.setWindow(panWindow(this.win, this.span, units));
  }

  // The selection: its line, the dots on the traces and the readout.
  private selection(sel: number, pinned: boolean, x: number): void {
    const ctx = this.surface.ctx;
    const n = this.store.path.length;
    if (sel >= 0 && sel < n && this.bottom > this.top) {
      this.selectionLine(x, pinned);
      if (this.two) this.selectionTwo(sel, x);
      else this.selectionOne(sel, x);
      // Where the selection is on the tree's main line.
      ctx.fillStyle = COLOR.high;
      ctx.beginPath();
      ctx.arc(x, this.mapY, 2.25, 0, Math.PI * 2);
      ctx.fill();
      this.readout(sel, pinned, x);
    }
  }

  // A white line across the traces with a soft halo; brighter when pinned.
  private selectionLine(x: number, pinned: boolean): void {
    const ctx = this.surface.ctx;
    const y = this.top - 6;
    const h = this.bottom - this.top + 10;
    ctx.save();
    ctx.translate(x, 0);
    ctx.fillStyle = this.selGlow;
    ctx.globalAlpha = pinned ? 1 : 0.7;
    ctx.fillRect(-7, y, 14, h);
    ctx.restore();
    ctx.fillStyle = COLOR.high;
    ctx.globalAlpha = pinned ? 0.95 : 0.6;
    ctx.fillRect(x - 0.5, y, 1, h);
    ctx.globalAlpha = 1;
  }

  private selectionOne(sel: number, x: number): void {
    const d = this.store.decision(sel);
    if (d) dot(this.surface.ctx, x, this.yOf(d.entropy), COLOR.a);
  }

  // A dot on each trace with a value at the selected position.
  private selectionTwo(sel: number, x: number): void {
    const ctx = this.surface.ctx;
    const s = this.store;
    const dA = s.decisionOf(sel, 0);
    const dB = s.decisionOf(sel, 1);
    const p = s.pairAt(sel);
    if (dA) dot(ctx, x, this.yEntropy(0, dA.entropy), COLOR.a);
    if (p) dot(ctx, x, this.yDivergence(p.js), COLOR.high);
    if (dB) dot(ctx, x, this.yEntropy(1, dB.entropy), COLOR.b);
  }

  // The figures of the selected position in a chip beside its line:
  //   #57  "reuses"  pinned
  //   A 1.75 bits  B 2.00 bits  JS 0.031  picks differ
  // Rebuilt only when the position, its data or the pin change.
  private readout(sel: number, pinned: boolean, x: number): void {
    const ctx = this.surface.ctx;
    if (sel !== this.roSel || pinned !== this.roPinned || this.roKey !== this.traceKey) this.buildReadout(sel, pinned);
    const w = this.surface.w;
    const bw = this.roW;
    const bh = 42;
    let bx = x + 12;
    if (bx + bw > w - PAD_X) bx = x - 12 - bw;
    if (bx < 2) bx = Math.max(2, Math.min(w - bw - 2, x + 12)); // too narrow either way
    const by = this.top + 2;
    chip(ctx, bx, by, bw, bh);

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    let px = bx + 10;
    ctx.font = font(SIZE.small);
    ctx.fillStyle = COLOR.low;
    ctx.fillText(this.roIndex, px, by + 13);
    px += this.roIndexW + 8;
    ctx.fillStyle = COLOR.high;
    ctx.fillText(this.roLabel, px, by + 13);
    px += this.roLabelW + 8;
    if (pinned) {
      ctx.fillStyle = COLOR.surface3;
      roundRect(ctx, px, by + 5, 40, 16, 8);
      ctx.fill();
      ctx.font = uiFont(10, 500);
      ctx.fillStyle = COLOR.muted;
      ctx.textAlign = 'center';
      ctx.fillText('pinned', px + 20, by + 13.5);
      ctx.textAlign = 'left';
    }
    px = bx + 10;
    for (const p of this.parts) {
      ctx.font = p.ui ? uiFont(10.5, 500) : font(SIZE.small);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, px, by + 30);
      px += p.w + 10;
    }
  }

  private buildReadout(sel: number, pinned: boolean): void {
    const ctx = this.surface.ctx;
    const s = this.store;
    this.roSel = sel;
    this.roPinned = pinned;
    this.roKey = this.traceKey;

    // First line: the position and its token.
    const tok = s.token[s.path[sel]];
    const v = s.vocab.get(tok);
    let label = v ? this.labels.get(v) : undefined;
    if (label === undefined) {
      const full = v ? showWhitespace(tokenLabel(v.bytes)) : `#${tok}`;
      const chars = Array.from(full);
      label = `"${chars.length <= READOUT_CHARS ? full : chars.slice(0, READOUT_CHARS - 1).join('') + '…'}"`;
      if (v) this.labels.set(v, label);
    }
    this.roIndex = `#${sel}`;
    this.roLabel = label;
    ctx.font = font(SIZE.small);
    this.roIndexW = ctx.measureText(this.roIndex).width;
    this.roLabelW = ctx.measureText(label).width;

    // Second line: the figures, each in its colour.
    const parts = this.parts;
    parts.length = 0;
    const add = (text: string, color: string, ui = false): void => {
      ctx.font = ui ? uiFont(10.5, 500) : font(SIZE.small);
      parts.push({ text, color, ui, w: ctx.measureText(text).width });
    };
    if (this.two) {
      const dA = s.decisionOf(sel, 0);
      const dB = s.decisionOf(sel, 1);
      const p = s.pairAt(sel);
      if (dA) add(`A ${dA.entropy.toFixed(2)} bits`, COLOR.a);
      if (dB) add(`B ${dB.entropy.toFixed(2)} bits`, COLOR.b);
      if (p) add(jsFigure(p), COLOR.high); // "≈" when approximate
      if (s.disagrees(sel)) add('picks differ', COLOR.dis, true);
    } else {
      const d = s.decision(sel);
      if (d) add(`entropy ${d.entropy.toFixed(2)} bits`, COLOR.a);
    }
    if (parts.length === 0) add('prompt token', COLOR.low, true);

    let partsW = (parts.length - 1) * 10;
    for (const p of parts) partsW += p.w;
    const headW = this.roIndexW + 8 + this.roLabelW + (pinned ? 8 + 40 : 0);
    this.roW = Math.ceil(Math.max(headW, partsW) + 20);
  }

  // The chip of the branch under the pointer: the start of its text, then
  // where it hangs, its length and why it stopped. Above the tree, near the
  // pointer.
  private branchChip(): void {
    const ctx = this.surface.ctx;
    const w = this.surface.w;
    const bw = Math.min(this.hoverW, w - 4);
    const bh = 42;
    const bx = Math.max(2, Math.min(w - bw - 2, this.pointerX - 24));
    const by = Math.max(2, this.mapY - bh - 10);
    chip(ctx, bx, by, bw, bh);
    ctx.save();
    ctx.beginPath();
    ctx.rect(bx, by, bw, bh);
    ctx.clip();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = font(SIZE.small);
    ctx.fillStyle = COLOR.high;
    ctx.fillText(this.hoverText, bx + 10, by + 13);
    drawIcon(ctx, 'branch', bx + 9, by + 24, 12, COLOR.muted);
    ctx.font = uiFont(10.5);
    ctx.fillStyle = COLOR.low;
    fillTabular(ctx, this.hoverInfo, bx + 26, by + 30);
    ctx.restore();
  }

  // Finds the branch under the pointer and, when it changes, builds its lit
  // line and its chip. Returns whether anything changed.
  private updateHover(): boolean {
    const i = this.pointerX < this.left ? -1 : hitBranch(this.mapLines, this.pointerX, this.pointerY, this.mapY);
    if (i === this.hoverBranch) return false;
    this.hoverBranch = i;
    this.hoverPath = null;
    const l = this.mapLines[i];
    const b = this.mapBranches[i];
    if (!l || !b) return true;

    this.hoverPath = branchPath(l, this.mapY);
    const s = this.store;
    const nodes = branchNodes(s.parent, b.child, b.tip);
    const bytes: Uint8Array[] = [];
    for (let k = 0; k < nodes.length && k < PREVIEW_TOKENS; k++) {
      const v = s.vocab.get(s.token[nodes[k]]);
      if (v) bytes.push(v.bytes);
    }
    const text = previewText(bytes, PREVIEW_CHARS);
    this.hoverText = text === '' ? '(no text)' : text;
    const count = b.tipDepth - b.fromIndex;
    const user = s.origin[b.child] === ORIGIN_USER;
    const stop = stopGlyph(s.stops.get(b.tip)?.reason);
    this.hoverInfo =
      `${user ? 'Your branch' : 'Branch'} at #${b.fromIndex + 1} · ${count} ${count === 1 ? 'token' : 'tokens'}` +
      (stop ? ` · ${STOP_WORDS[stop]}` : '') +
      ' · click to view';
    const ctx = this.surface.ctx;
    ctx.font = font(SIZE.small);
    const tw = ctx.measureText(this.hoverText).width;
    ctx.font = uiFont(10.5);
    const iw = tabularWidth(ctx, this.hoverInfo) + 16;
    this.hoverW = Math.ceil(Math.max(tw, iw) + 20);
    return true;
  }

  // A magenta line across the bands with a soft halo (animation 3).
  private drawPulse(pulse: Pulse): void {
    const ctx = this.surface.ctx;
    const x = Math.round(this.xOf(pulse.index));
    if (x < this.left - 6 || x > this.plotRight() + 6) return;
    const y = this.top - 4;
    const h = this.bottom - this.top + 8;
    ctx.fillStyle = COLOR.dis;
    ctx.globalAlpha = 0.18 * pulse.alpha;
    ctx.fillRect(x - 6, y, 13, h);
    ctx.globalAlpha = pulse.alpha;
    ctx.shadowColor = COLOR.dis;
    ctx.shadowBlur = 10;
    ctx.fillRect(x - 1, y, 2, h);
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.globalAlpha = 1;
  }

  // Width of the axis, and where the plot area ends (the axis stops
  // END_ROOM before it, for a stop glyph).
  private axisW(): number {
    return Math.max(0, this.surface.w - PAD_X - END_ROOM - this.left);
  }

  private plotRight(): number {
    return this.surface.w - PAD_X;
  }

  private step(): number {
    return this.axisW() / this.vis;
  }

  private xOf(i: number): number {
    return this.left + (i + 0.5 - this.lo) * this.step();
  }

  // Keeps what follows inside the plot area, off the band labels.
  private clipPlot(ctx: CanvasRenderingContext2D): void {
    ctx.beginPath();
    ctx.rect(this.left, 0, this.plotRight() - this.left, this.surface.h);
    ctx.clip();
  }

  // One model: entropy over the whole box.
  private yOf(bits: number): number {
    return this.bottom - (Math.min(Math.max(bits, 0), this.scaleBits) / this.scaleBits) * (this.bottom - this.top);
  }

  // Two models: entropy of A up from its base, of B down from its base.
  private yEntropy(slot: Slot, bits: number): number {
    const b = this.bands;
    const k = Math.min(Math.max(bits, 0), this.scaleBits) / this.scaleBits;
    return slot === 0 ? b.aBase - k * (b.aBase - b.aTop) : b.bBase + k * (b.bBottom - b.bBase);
  }

  // Two models: divergence on its fixed 0–1 bit scale.
  private yDivergence(js: number): number {
    const b = this.bands;
    return b.dBase - Math.min(Math.max(js, 0), 1) * (b.dBase - b.dTop);
  }

  private indexAt(x: number): number | null {
    const n = this.store.path.length;
    if (n === 0) return null;
    const step = this.step();
    if (!(step > 0)) return null;
    const i = Math.floor((x - this.left) / step + this.lo);
    return Math.max(0, Math.min(n - 1, i));
  }

  private drawTrace(): void {
    const sf = this.surface;
    const t = this.trace;
    t.width = sf.canvas.width;
    t.height = sf.canvas.height;
    const ctx = t.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(t.width / sf.w, 0, 0, t.height / sf.h, 0, 0);
    ctx.clearRect(0, 0, sf.w, sf.h);
    const s = this.store;
    this.two = s.twoModels;
    // The axis holds the path and every branch tip, at the same x for both.
    const branches = s.branches();
    this.span = axisSpan(s.path.length, branches);
    const win = resolveWindow(this.win, this.span);
    this.lo = win.lo;
    this.vis = win.vis;
    this.bandLabels = [];
    this.seriesRecs = [];
    this.legend = [];
    // Band labels in a column on the left; the traces start after it.
    ctx.font = uiFont(11);
    this.left = Math.ceil(PAD_X + 8 + ctx.measureText('divergence').width + 14);

    // The tree's rows first: its height takes from the traces. They are
    // assigned on the whole axis, so zooming does not move the layout.
    const fitStep = this.axisW() / this.span;
    const fitX = (i: number): number => this.left + (i + 0.5) * fitStep;
    const fitSpans = branches.map((b) => {
      const x0 = fitX(b.fromIndex);
      return [x0, Math.max(fitX(b.tipDepth), x0 + CURVE_W)] as const;
    });
    const spans = branches.map((b) => {
      const x0 = this.xOf(b.fromIndex);
      return [x0, Math.max(this.xOf(b.tipDepth), x0 + CURVE_W)] as const;
    });
    const room = sf.h - TOP - AXIS_H - MIN_TRACES;
    const rows = assignRows(fitSpans, maxRows(room), 4);
    const treeH = treeHeight(rowsUsed(rows));

    const box = traceBox(sf.h, TOP, AXIS_H + treeH, this.two ? MAX_TWO : MAX_ONE);
    this.top = box.top;
    this.bottom = box.bottom;
    this.bands = timelineBands(box.bottom, box.top, 0);

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    this.header(ctx, branches);
    if (this.two) this.drawTwo(ctx);
    else this.drawOne(ctx);
    this.drawTicks(ctx);
    this.drawTree(ctx, branches, spans, rows);
    // The axis may have rescaled under a still pointer: what it is on now is
    // selected, and the branch under it found again (it may have grown).
    this.hoverBranch = -2;
    this.updateHover();
    if (this.pointerX >= 0) {
      const i = this.indexAt(this.pointerX);
      if (i !== null) this.view.setHover(i);
    }
  }

  // What the marks mean, and what the pointer does.
  private header(ctx: CanvasRenderingContext2D, branches: Branch[]): void {
    const w = this.surface.w;
    const s = this.store;
    ctx.font = uiFont(11);
    let x = PAD_X;
    if (this.two) {
      disTick(ctx, x + 1, HEAD_Y + 4);
      ctx.fillStyle = COLOR.muted;
      ctx.fillText('picks differ', x + 8, HEAD_Y);
      this.legend.push({ kind: 'differ', x: x + 1, y: HEAD_Y, text: 'picks differ' });
      x += 8 + ctx.measureText('picks differ').width + 18;
    }
    if (branches.some((b) => s.origin[b.child] === ORIGIN_USER) || s.path.some((n) => s.origin[n] === ORIGIN_USER)) {
      diamond(ctx, x + 4, HEAD_Y);
      ctx.fillStyle = COLOR.muted;
      ctx.fillText('your branch', x + 13, HEAD_Y);
      this.legend.push({ kind: 'user', x, y: HEAD_Y, text: 'your branch' });
      x += 13 + ctx.measureText('your branch').width + 18;
    }
    const hint =
      this.vis < this.span - 1e-6
        ? `zoom ${(this.span / this.vis).toFixed(1)}x · wheel to zoom, shift+wheel to pan`
        : 'Hover to inspect · click to pin · click a branch to view it';
    const hw = ctx.measureText(hint).width;
    if (w - PAD_X - hw - 18 > x + 24) {
      ctx.fillStyle = COLOR.low;
      ctx.textAlign = 'right';
      ctx.fillText(hint, w - PAD_X, HEAD_Y);
      ctx.textAlign = 'left';
      drawIcon(ctx, 'pointer', w - PAD_X - hw - 17, HEAD_Y - 6.5, 12, COLOR.low);
    }
  }

  // A band's name and scale in the left column, with a glowing swatch.
  private bandLabel(ctx: CanvasRenderingContext2D, y0: number, y1: number, swatch: string, name: string, scale: string): void {
    this.bandLabels.push({ y0, y1, color: swatch, name, scale });
    const mid = (y0 + y1) / 2;
    const tall = y1 - y0 >= 30;
    const sh = tall ? 22 : 10;
    ctx.fillStyle = GLOW[swatch] ?? swatch;
    roundRect(ctx, PAD_X - 1.5, mid - sh / 2 - 1.5, 6, sh + 3, 3);
    ctx.fill();
    ctx.fillStyle = swatch;
    roundRect(ctx, PAD_X, mid - sh / 2, 3, sh, 1.5);
    ctx.fill();
    ctx.font = uiFont(11, 500);
    ctx.fillStyle = COLOR.muted;
    ctx.fillText(name, PAD_X + 9, tall ? mid - 6 : mid);
    if (tall) {
      ctx.font = uiFont(10);
      ctx.fillStyle = COLOR.low;
      ctx.fillText(scale, PAD_X + 9, mid + 8);
    }
  }

  // Thin guides across the traces: solid at the bases, dotted at half scale.
  private guides(ctx: CanvasRenderingContext2D, solid: readonly number[], dotted: readonly number[]): void {
    this.guideYs = { solid: [...solid], dotted: [...dotted] };
    const x0 = this.left;
    const x1 = this.surface.w - PAD_X;
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLOR.line;
    ctx.beginPath();
    for (const y of solid) {
      ctx.moveTo(x0, Math.round(y) + 0.5);
      ctx.lineTo(x1, Math.round(y) + 0.5);
    }
    ctx.stroke();
    ctx.setLineDash(DASH);
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    for (const y of dotted) {
      ctx.moveTo(x0, Math.round(y) + 0.5);
      ctx.lineTo(x1, Math.round(y) + 0.5);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash(NO_DASH);
  }

  // The prompt, barely shaded behind the traces, with a dotted edge and a
  // quiet label in its top corner.
  private drawPrompt(ctx: CanvasRenderingContext2D): void {
    const prompt = this.store.promptLength;
    if (prompt <= 0) return;
    const step = this.step();
    const x0 = this.left - this.lo * step; // the clip keeps what is left of the plot out
    const x1 = Math.round(this.left + (prompt - this.lo) * step) + 0.5;
    ctx.fillStyle = PROMPT_FILL;
    ctx.fillRect(x0, this.top, x1 - x0, this.bottom - this.top);
    ctx.strokeStyle = COLOR.lineStrong;
    ctx.lineWidth = 1;
    ctx.setLineDash(DASH);
    ctx.beginPath();
    ctx.moveTo(x1, this.top);
    ctx.lineTo(x1, this.bottom);
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    if (Math.min(x1, this.plotRight()) - Math.max(x0, this.left) > 60) {
      ctx.font = uiFont(10.5, 500);
      ctx.fillStyle = COLOR.unlikely;
      ctx.fillText('prompt', Math.max(x0, this.left) + 8, this.top + 10);
    }
  }

  // Position labels under the traces, at a round step with room between.
  private drawTicks(ctx: CanvasRenderingContext2D): void {
    const step = this.step();
    if (!(step > 0) || this.bottom <= this.top) return;
    const every = tickEvery(step, TICK_MIN_PX);
    const y = this.bottom + AXIS_H / 2 + 3;
    ctx.font = font(10);
    ctx.textAlign = 'center';
    for (const i of tickIndices(this.lo, this.vis, every, this.span)) {
      const x = this.xOf(i);
      if (x < this.left || x > this.plotRight()) continue;
      ctx.fillStyle = COLOR.lineStrong;
      ctx.fillRect(Math.round(x), this.bottom + 1, 1, 3);
      ctx.fillStyle = COLOR.unlikely;
      ctx.fillText(`${i}`, x, y);
    }
    ctx.textAlign = 'left';
  }

  // The tree under the position labels: the viewed path as a bright main
  // line, each branch curving out of its fork to its own row, a diamond
  // where the user chose a token, the stop glyph at each end and a dot per
  // cursor.
  private drawTree(ctx: CanvasRenderingContext2D, branches: Branch[], spans: (readonly [number, number])[], rows: number[]): void {
    const s = this.store;
    const n = s.path.length;
    const y = Math.round(this.bottom + AXIS_H + TREE_GAP) + 0.5;
    this.mapY = y;
    this.mapLines = [];
    this.mapBranches = branches;

    ctx.font = uiFont(10.5, 500);
    ctx.fillStyle = COLOR.muted;
    const count = branches.length;
    const label = count === 0 ? 'path' : count === 1 ? '1 branch' : `${count} branches`;
    fillTabular(ctx, label, PAD_X + 9, y);
    this.tree = emptyTree(y, label);
    if (n === 0) return;

    ctx.save();
    this.clipPlot(ctx);
    // The branches, dim: a curve out of the fork, then straight to the tip.
    const all = new Path2D();
    for (let k = 0; k < branches.length; k++) {
      // Deeper rows get wider curves, so every branch leaves at the same slope.
      const c = CURVE_W + rows[k] * ROW_H;
      const l: MapLine = { x0: spans[k][0], x1: Math.max(spans[k][1], spans[k][0] + c), y: y + ROW_H * (rows[k] + 1), c };
      this.mapLines.push(l);
      all.addPath(branchPath(l, y));
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = COLOR.low;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1.25;
    ctx.stroke(all);
    ctx.globalAlpha = 1;

    // The viewed path: the prompt quiet, what was generated bright, on a glow.
    const x0 = this.xOf(0);
    const xp = this.xOf(Math.max(0, s.promptLength - 1));
    const xe = this.xOf(n - 1);
    ctx.strokeStyle = COLOR.high;
    ctx.globalAlpha = 0.1;
    ctx.lineWidth = 6;
    line(ctx, xp, xe, y);
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2;
    line(ctx, xp, xe, y);
    ctx.strokeStyle = COLOR.lineStrong;
    ctx.globalAlpha = 1;
    line(ctx, x0, xp, y);

    // What the export draws again, collected as it is drawn here.
    const forks: number[] = [];
    const branchStops: { glyph: StopGlyph; x: number; y: number }[] = [];
    const userMain: number[] = [];
    const userBranch: { x: number; y: number }[] = [];
    const cursors: { x: number; y: number; color: string; ring: boolean }[] = [];

    // Forks: a small knot on the main line where branches hang.
    ctx.fillStyle = COLOR.muted;
    let lastFork = -1;
    for (const b of branches) {
      if (b.fromIndex === lastFork) continue;
      lastFork = b.fromIndex;
      const fx = this.xOf(b.fromIndex);
      forks.push(fx);
      ctx.beginPath();
      ctx.arc(fx, y, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Why each line stopped, after its end (and after a cursor sitting there).
    const marks = s.cursorMarks(branches);
    const past = (branch: number, depth: number): number =>
      marks.some((m) => m.branch === branch && m.depth === depth) ? 10 : 5;
    const endPath = stopGlyph(s.stops.get(s.path[n - 1])?.reason);
    let pathStop: { glyph: StopGlyph; x: number } | null = null;
    if (endPath) {
      pathStop = { glyph: endPath, x: xe + past(-1, n - 1) };
      stopMark(ctx, endPath, pathStop.x, y, COLOR.high);
    }
    for (let k = 0; k < branches.length; k++) {
      const g = stopGlyph(s.stops.get(branches[k].tip)?.reason);
      const l = this.mapLines[k];
      if (!g) continue;
      const gx = l.x1 + past(k, branches[k].tipDepth);
      branchStops.push({ glyph: g, x: gx, y: l.y });
      stopMark(ctx, g, gx, l.y, COLOR.muted);
    }

    // The tokens the user chose: on the path, and at the start of a branch.
    for (let i = 1; i < n; i++) {
      if (s.origin[s.path[i]] !== ORIGIN_USER) continue;
      userMain.push(this.xOf(i));
      diamond(ctx, this.xOf(i), y);
    }
    for (let k = 0; k < branches.length; k++) {
      if (s.origin[branches[k].child] !== ORIGIN_USER) continue;
      const l = this.mapLines[k];
      userBranch.push({ x: l.x0 + l.c, y: l.y });
      diamond(ctx, l.x0 + l.c, l.y);
    }

    // The cursors, the other model's first so the one in front is on top;
    // where both share a spot, the other is a ring around it.
    marks.sort((a, b) => (a.slot === s.front ? 1 : 0) - (b.slot === s.front ? 1 : 0));
    const at = marks.map((m) => [this.xOf(m.depth), m.branch < 0 ? y : this.mapLines[m.branch].y]);
    const shared = marks.length > 1 && at[0][0] === at[1][0] && at[0][1] === at[1][1];
    for (let k = 0; k < marks.length; k++) {
      const [cx, cy] = at[k];
      const color = MODEL_COLOR[marks[k].slot];
      if (shared && k === 0) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
        ctx.stroke();
        cursors.push({ x: cx, y: cy, color, ring: true });
      } else {
        dot(ctx, cx, cy, color);
        cursors.push({ x: cx, y: cy, color, ring: false });
      }
    }
    ctx.restore();
    this.tree = { y, label, branches: this.mapLines, start: x0, prompt: xp, end: xe, forks, pathStop, branchStops, userMain, userBranch, cursors };
  }

  private drawOne(ctx: CanvasRenderingContext2D): void {
    const s = this.store;
    const n = s.path.length;
    const { top, bottom } = this;

    // Scale: the next power of two above the largest entropy, at least 4 bits.
    let max = 0;
    for (let i = 1; i < n; i++) {
      const d = s.decision(i);
      if (d && d.entropy > max) max = d.entropy;
    }
    this.scaleBits = scaleFor(max);
    if (bottom <= top) return;

    this.bandLabel(ctx, top, bottom, COLOR.a, 'entropy', `0–${this.scaleBits} bits`);
    this.guides(ctx, [bottom], [top, (top + bottom) / 2]);
    if (n === 0) return;

    ctx.save();
    this.clipPlot(ctx);
    this.drawPrompt(ctx);
    // The trace breaks where there is no decision (the prompt).
    this.series(
      ctx,
      (i) => s.decision(i)?.entropy,
      (v) => this.yOf(v),
      bottom,
      top,
      COLOR.a,
      'e',
    );
    ctx.restore();
  }

  private drawTwo(ctx: CanvasRenderingContext2D): void {
    const s = this.store;
    const n = s.path.length;
    const b = this.bands;

    // One entropy scale for both, so that the two traces mirror each other.
    let max = 0;
    for (let i = 1; i < n; i++) {
      const dA = s.decisionOf(i, 0);
      const dB = s.decisionOf(i, 1);
      if (dA && dA.entropy > max) max = dA.entropy;
      if (dB && dB.entropy > max) max = dB.entropy;
    }
    this.scaleBits = scaleFor(max);
    if (this.bottom <= this.top) return;

    const bits = `0–${this.scaleBits} bits`;
    this.bandLabel(ctx, b.aTop, b.aBase, COLOR.a, 'entropy A', bits);
    this.bandLabel(ctx, b.aBase, b.bBase, COLOR.high, 'divergence', '0–1 bit');
    this.bandLabel(ctx, b.bBase, b.bBottom, COLOR.b, 'entropy B', bits);

    this.guides(ctx, [b.aBase, b.bBase], [b.aTop, b.bBottom, (b.aTop + b.aBase) / 2, (b.bBase + b.bBottom) / 2]);
    if (n === 0) return;

    ctx.save();
    this.clipPlot(ctx);
    this.drawPrompt(ctx);

    // Each trace breaks where its model did not evaluate the node.
    this.series(
      ctx,
      (i) => s.decisionOf(i, 0)?.entropy,
      (v) => this.yEntropy(0, v),
      b.aBase,
      b.aTop,
      MODEL_COLOR[0],
      'a',
    );
    this.series(
      ctx,
      (i) => s.decisionOf(i, 1)?.entropy,
      (v) => this.yEntropy(1, v),
      b.bBase,
      b.bBottom,
      MODEL_COLOR[1],
      'b',
    );
    this.series(
      ctx,
      (i) => s.pairAt(i)?.js,
      (v) => this.yDivergence(v),
      b.dBase,
      b.dTop,
      COLOR.high,
      'd',
    );

    // Disagreements: a slim magenta tick standing on the mark line, like a
    // rug plot. Where they are closer than DIS_GAP only the first of each
    // run is drawn, so many of them read as a row instead of a smear.
    let lastX = -Infinity;
    const ticks = new Path2D();
    const [from, to] = this.visibleRange(n);
    for (let i = Math.max(1, from); i <= to; i++) {
      if (!s.disagrees(i)) continue;
      const x = Math.round(this.xOf(i));
      if (x - lastX < DIS_GAP) continue;
      lastX = x;
      ticks.rect(x - 0.75, b.markY - Math.min(7, MARK_STRIP - 2), 1.5, Math.min(7, MARK_STRIP - 2));
    }
    ctx.strokeStyle = GLOW[COLOR.dis];
    ctx.lineWidth = 2.5;
    ctx.stroke(ticks);
    ctx.fillStyle = COLOR.dis;
    ctx.fill(ticks);
    ctx.restore();
  }

  // The positions to draw for a window: those on screen and one more each
  // side, so a line still enters and leaves it.
  private visibleRange(n: number): [number, number] {
    return [Math.max(0, Math.floor(this.lo) - 1), Math.min(n - 1, Math.ceil(this.lo + this.vis) + 1)];
  }

  // A trace with a soft area down (or up) to `base`, fading from the trace's
  // full scale at `far` to nothing at the base; broken where `value` has
  // none. A segment of a single point is drawn as a small square.
  private series(
    ctx: CanvasRenderingContext2D,
    value: (i: number) => number | undefined,
    y: (v: number) => number,
    base: number,
    far: number,
    color: string,
    id: string,
  ): void {
    this.seriesRecs.push({ id, color, value, y, base, far });
    const n = this.store.path.length;
    const line = new Path2D();
    const area = new Path2D();
    let run = -1; // start index of the current segment, -1 outside one
    let lastX = 0;
    let lastY = 0;
    const dots: number[] = []; // segments of a single point: x, y pairs
    const closeArea = (): void => {
      if (run < 0) return;
      if (this.xOf(run) === lastX) dots.push(lastX, lastY);
      area.lineTo(lastX, base);
      area.lineTo(this.xOf(run), base);
      area.closePath();
      run = -1;
    };
    const [from, to] = this.visibleRange(n);
    for (let i = from; i <= to; i++) {
      const v = value(i);
      if (v === undefined) {
        closeArea();
        continue;
      }
      const px = this.xOf(i);
      const py = y(v);
      if (run < 0) {
        run = i;
        line.moveTo(px, py);
        area.moveTo(px, py);
      } else {
        line.lineTo(px, py);
        area.lineTo(px, py);
      }
      lastX = px;
      lastY = py;
    }
    closeArea();
    if (far !== base) {
      const g = ctx.createLinearGradient(0, far, 0, base);
      g.addColorStop(0, rgba(color, color === COLOR.high ? 0.22 : 0.36));
      g.addColorStop(0.6, rgba(color, 0.08));
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.fill(area);
    }
    // Wide faint strokes under a crisp one: a soft glow without shadows.
    ctx.strokeStyle = color;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.08;
    ctx.lineWidth = 6;
    ctx.stroke(line);
    ctx.globalAlpha = 0.18;
    ctx.lineWidth = 3;
    ctx.stroke(line);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5;
    ctx.stroke(line);
    ctx.fillStyle = color;
    for (let k = 0; k < dots.length; k += 2) ctx.fillRect(dots[k] - 1, dots[k + 1] - 1, 2, 2);
  }
}

// A trace as it was drawn, to draw it again for the export: the figure of
// each position and how it maps to y.
interface SeriesRec {
  id: string;
  color: string;
  value: (i: number) => number | undefined;
  y: (v: number) => number;
  base: number;
  far: number;
}

function emptyTree(y: number, label: string): SvgTree {
  return { y, label, branches: [], start: NaN, prompt: NaN, end: NaN, forks: [], pathStop: null, branchStops: [], userMain: [], userBranch: [], cursors: [] };
}

// Positions across the horizontal axis, shared with the relief: the viewed
// path and every branch tip, at least MIN_SPAN. Position i is centred at
// (i + 0.5) / span of the axis.
export function axisSpan(pathLength: number, branches: readonly Pick<Branch, 'tipDepth'>[]): number {
  let span = Math.max(pathLength, MIN_SPAN);
  for (const b of branches) span = Math.max(span, b.tipDepth + 1);
  return span;
}

// The next power of two above the largest entropy, at least 4 bits.
function scaleFor(max: number): number {
  return Math.max(4, Math.pow(2, Math.ceil(Math.log2(Math.max(max, 1)))));
}

// A branch line: out of the main line at x0 with an S curve onto its row,
// then straight to its end.
function branchPath(l: MapLine, mainY: number): Path2D {
  const p = new Path2D();
  const mid = l.x0 + l.c / 2;
  p.moveTo(l.x0, mainY);
  p.bezierCurveTo(mid, mainY, mid, l.y, l.x0 + l.c, l.y);
  p.lineTo(Math.max(l.x1, l.x0 + l.c), l.y);
  return p;
}

function line(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(Math.max(x1, x0 + 0.5), y);
  ctx.stroke();
}

// A value on a trace or a cursor on the tree: a dot in its colour on a soft
// halo, ringed in the background colour so it stands off the line.
function dot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.fillStyle = GLOW[color] ?? color;
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = COLOR.bg;
  ctx.beginPath();
  ctx.arc(x, y, 4.25, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 3, 0, Math.PI * 2);
  ctx.fill();
}

// A floating chip: a soft shadow, the raised surface and a hairline edge.
function chip(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = CHIP_SHADOW;
  roundRect(ctx, x - 1, y + 1, w + 2, h + 3, 10);
  ctx.fill();
  ctx.fillStyle = COLOR.surface2;
  ctx.globalAlpha = 0.95;
  roundRect(ctx, x, y, w, h, 8);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = COLOR.lineStrong;
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 8);
  ctx.stroke();
}

// A token the user chose: a hollow white diamond.
function diamond(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const r = 4;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fillStyle = COLOR.surface;
  ctx.fill();
  ctx.strokeStyle = COLOR.high;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// A disagreement tick as the legend shows it, standing on `base`.
function disTick(ctx: CanvasRenderingContext2D, x: number, base: number): void {
  ctx.fillStyle = GLOW[COLOR.dis];
  ctx.fillRect(x - 1.75, base - 9, 3.5, 10);
  ctx.fillStyle = COLOR.dis;
  ctx.fillRect(x - 0.75, base - 8, 1.5, 8);
}

// Why a line stopped, drawn just after its end at height y:
//   end   a bar across the line (end of generation)
//   cut   two slashes (max tokens reached)
//   full  a filled square (context full)
function stopMark(ctx: CanvasRenderingContext2D, g: StopGlyph, x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  if (g === 'end') {
    ctx.fillRect(x - 0.75, y - 4, 1.75, 8);
  } else if (g === 'cut') {
    ctx.lineWidth = 1.25;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - 1, y + 3.5);
    ctx.lineTo(x + 2, y - 3.5);
    ctx.moveTo(x + 3, y + 3.5);
    ctx.lineTo(x + 6, y - 3.5);
    ctx.stroke();
  } else {
    ctx.fillRect(x - 0.5, y - 2.5, 5, 5);
  }
}
