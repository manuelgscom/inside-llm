import { describe, expect, it } from 'vitest';
import { FIT, MIN_VISIBLE, maxZoom, panWindow, resolveWindow, tickEvery, tickIndices, zoomWindow, type ZoomWindow } from './timeline-zoom';

const SPAN = 200;

describe('resolveWindow', () => {
  it('fitted shows the whole axis', () => {
    expect(resolveWindow(FIT, SPAN)).toEqual({ lo: 0, vis: SPAN, zoom: 1 });
  });

  it('clamps lo and vis into the axis', () => {
    expect(resolveWindow({ vis: 50, lo: 999, atEnd: false }, SPAN).lo).toBe(150);
    expect(resolveWindow({ vis: 50, lo: -5, atEnd: false }, SPAN).lo).toBe(0);
    expect(resolveWindow({ vis: 1, lo: 0, atEnd: false }, SPAN).vis).toBe(MIN_VISIBLE);
    expect(resolveWindow({ vis: 5000, lo: 0, atEnd: false }, SPAN).vis).toBe(SPAN);
  });

  it('atEnd follows a growing axis and keeps its width', () => {
    const w: ZoomWindow = { vis: 40, lo: 160, atEnd: true };
    expect(resolveWindow(w, 200)).toMatchObject({ lo: 160, vis: 40 });
    expect(resolveWindow(w, 300)).toMatchObject({ lo: 260, vis: 40 });
  });

  it('not at the end it stays put while the axis grows', () => {
    const w: ZoomWindow = { vis: 40, lo: 20, atEnd: false };
    expect(resolveWindow(w, 300).lo).toBe(20);
  });

  it('survives an empty axis', () => {
    expect(resolveWindow(FIT, 0)).toEqual({ lo: 0, vis: 1, zoom: 1 });
  });
});

describe('zoomWindow', () => {
  it('keeps the axis unit under the anchor where it is', () => {
    for (const frac of [0, 0.25, 0.5, 0.8, 1]) {
      const a = resolveWindow(FIT, SPAN);
      const unit = a.lo + frac * a.vis;
      const z = zoomWindow(FIT, SPAN, 4, frac);
      const r = resolveWindow(z, SPAN);
      expect(r.lo + frac * r.vis).toBeCloseTo(unit, 6);
      expect(r.vis).toBeCloseTo(SPAN / 4, 6);
    }
  });

  it('anchors inside an already zoomed window', () => {
    const w: ZoomWindow = { vis: 80, lo: 60, atEnd: false };
    const before = resolveWindow(w, SPAN);
    const z = resolveWindow(zoomWindow(w, SPAN, 2, 0.3), SPAN);
    expect(z.vis).toBeCloseTo(40, 6);
    expect(z.lo + 0.3 * z.vis).toBeCloseTo(before.lo + 0.3 * before.vis, 6);
  });

  it('stops at about MIN_VISIBLE positions', () => {
    let w: ZoomWindow = FIT;
    for (let k = 0; k < 40; k++) w = zoomWindow(w, SPAN, 2, 0.5);
    const r = resolveWindow(w, SPAN);
    expect(r.vis).toBe(MIN_VISIBLE);
    expect(r.zoom).toBeCloseTo(maxZoom(SPAN), 6);
  });

  it('zooming out far enough fits again', () => {
    let w = zoomWindow(FIT, SPAN, 8, 0.5);
    w = zoomWindow(w, SPAN, 1 / 100, 0.5);
    expect(w).toBe(FIT);
  });

  it('zooming in at the right edge sticks to the end', () => {
    const w = zoomWindow(FIT, SPAN, 4, 1);
    expect(w.atEnd).toBe(true);
    expect(resolveWindow(w, SPAN + 50).lo).toBeCloseTo(SPAN + 50 - SPAN / 4, 6);
  });

  it('ignores a factor that is not a positive number', () => {
    const w: ZoomWindow = { vis: 80, lo: 60, atEnd: false };
    expect(zoomWindow(w, SPAN, 0, 0.5)).toBe(w);
    expect(zoomWindow(w, SPAN, NaN, 0.5)).toBe(w);
    expect(zoomWindow(w, SPAN, -2, 0.5)).toBe(w);
  });
});

describe('panWindow', () => {
  it('moves within the axis and clamps', () => {
    const w: ZoomWindow = { vis: 50, lo: 40, atEnd: false };
    expect(resolveWindow(panWindow(w, SPAN, 10), SPAN).lo).toBe(50);
    expect(resolveWindow(panWindow(w, SPAN, -100), SPAN).lo).toBe(0);
    const end = panWindow(w, SPAN, 1000);
    expect(end.atEnd).toBe(true);
    expect(resolveWindow(end, SPAN).lo).toBe(150);
  });

  it('leaves a fitted window alone', () => {
    expect(panWindow(FIT, SPAN, 25)).toBe(FIT);
  });

  it('panning away from the end releases it', () => {
    const w: ZoomWindow = { vis: 50, lo: 150, atEnd: true };
    expect(panWindow(w, SPAN, -10).atEnd).toBe(false);
  });
});

describe('ticks', () => {
  it('tickEvery takes the first round step with room', () => {
    expect(tickEvery(100, 64)).toBe(1);
    expect(tickEvery(10, 64)).toBe(10);
    expect(tickEvery(3, 64)).toBe(50);
  });

  it('tickIndices lists multiples inside the window only', () => {
    expect(tickIndices(0, 20, 5, 64)).toEqual([0, 5, 10, 15]);
    expect(tickIndices(32.4, 20, 10, 100)).toEqual([40, 50]);
    expect(tickIndices(0, 100, 10, 30)).toEqual([0, 10, 20]);
  });

  it('every position when zoomed far in', () => {
    expect(tickIndices(10, 4, 1, 64)).toEqual([10, 11, 12, 13]);
  });
});
