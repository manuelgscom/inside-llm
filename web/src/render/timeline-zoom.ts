// The horizontal zoom of the Timeline, as arithmetic: no DOM, no canvas.
//
// The axis holds `span` positions, position i centred at i + 0.5 (see
// axisSpan in timeline.ts). The window is the part of it on screen:
// [lo, lo + vis]. Fitted (zoom 1) is the whole axis, as before zooming
// existed; zoomed in, fewer positions fill the same width.
//
// The window keeps its number of positions (vis), not its zoom factor, when
// the axis grows while a session is generating: the figures stay as big as
// the user left them. Pinned to the right end (atEnd) it follows the
// newest position; anywhere else it stays where it is.

// The most a window may be zoomed in: about this many positions across.
export const MIN_VISIBLE = 4;

export interface ZoomWindow {
  vis: number | null; // positions across; null: the whole axis (fitted)
  lo: number; // axis units at the left edge, ignored while atEnd
  atEnd: boolean; // the right edge sits at the end of the axis
}

export const FIT: ZoomWindow = { vis: null, lo: 0, atEnd: true };

export interface ResolvedWindow {
  lo: number;
  vis: number;
  zoom: number; // span / vis, at least 1
}

const EPS = 1e-6;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

export function minVisible(span: number): number {
  return Math.min(MIN_VISIBLE, Math.max(span, 1));
}

// The largest zoom factor of an axis of `span` positions; at least 1.
export function maxZoom(span: number): number {
  return span > 0 ? Math.max(1, span / minVisible(span)) : 1;
}

// The window for an axis of `span` positions: every field clamped into it.
export function resolveWindow(w: ZoomWindow, span: number): ResolvedWindow {
  if (!(span > 0)) return { lo: 0, vis: 1, zoom: 1 };
  const vis = w.vis === null ? span : clamp(w.vis, minVisible(span), span);
  const maxLo = span - vis;
  const lo = w.atEnd ? maxLo : clamp(w.lo, 0, maxLo);
  return { lo, vis, zoom: span / vis };
}

// Zooms by `factor` (above 1 in, below 1 out) keeping the axis unit at
// `frac` (0 left edge, 1 right edge of the window) where it is on screen.
// Zooming out to the whole axis gives FIT.
export function zoomWindow(w: ZoomWindow, span: number, factor: number, frac: number): ZoomWindow {
  if (!(factor > 0) || !Number.isFinite(factor) || !(span > 0)) return w;
  const r = resolveWindow(w, span);
  const vis = clamp(r.vis / factor, minVisible(span), span);
  if (vis >= span - EPS) return FIT;
  const f = clamp(frac, 0, 1);
  const lo = clamp(r.lo + f * r.vis - f * vis, 0, span - vis);
  return { vis, lo, atEnd: lo >= span - vis - EPS };
}

// Moves the window by `units` of the axis (positive: towards the end).
export function panWindow(w: ZoomWindow, span: number, units: number): ZoomWindow {
  if (!Number.isFinite(units)) return w;
  const r = resolveWindow(w, span);
  if (r.vis >= span - EPS) return w;
  const lo = clamp(r.lo + units, 0, span - r.vis);
  return { vis: r.vis, lo, atEnd: lo >= span - r.vis - EPS };
}

// Distance between two position labels, in positions: the first round step
// that leaves `minPx` between them.
const STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

export function tickEvery(stepPx: number, minPx: number): number {
  let every = 1;
  for (const k of STEPS) {
    every = k;
    if (k * stepPx >= minPx) break;
  }
  return every;
}

// The positions labelled in the window [lo, lo + vis], multiples of `every`
// whose centre is inside it, below `span`.
export function tickIndices(lo: number, vis: number, every: number, span: number): number[] {
  const out: number[] = [];
  if (!(every > 0)) return out;
  const first = Math.max(0, Math.ceil((lo - 0.5) / every - EPS) * every);
  for (let i = first; i < span && i + 0.5 <= lo + vis + EPS; i += every) out.push(i);
  return out;
}
