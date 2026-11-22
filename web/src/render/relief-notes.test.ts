import { describe, expect, it } from 'vitest';
import { CHIP_GAP, notesSvg, rulerTicks, spreadChips, strideRows, tickPositions, type Notes } from './relief-notes';

describe('tickPositions', () => {
  it('keeps the labels a round step apart with room between them', () => {
    const t = tickPositions(0, 99, 1000);
    expect(t[0]).toBe(0);
    const step = t[1] - t[0];
    expect([1, 2, 5, 10, 20, 50, 100]).toContain(step);
    expect(step * (1000 / 100)).toBeGreaterThanOrEqual(56);
    for (let i = 1; i < t.length; i++) expect(t[i] - t[i - 1]).toBe(step);
  });

  it('labels every position when they are far apart', () => {
    expect(tickPositions(0, 3, 1000)).toEqual([0, 1, 2, 3]);
  });

  it('starts at the first multiple inside the range', () => {
    const t = tickPositions(13, 60, 1000, 100);
    expect(t.every((i) => i >= 13 && i <= 60)).toBe(true);
  });

  it('returns nothing without positions or room', () => {
    expect(tickPositions(5, 4, 100)).toEqual([]);
    expect(tickPositions(0, 9, 0)).toEqual([]);
  });
});

describe('rulerTicks', () => {
  it('stands at sqrt(p), the height of a probability', () => {
    for (const t of rulerTicks()) expect(t.h).toBeCloseTo(Math.sqrt(t.p), 10);
    expect(rulerTicks()[0]).toEqual({ p: 1, h: 1, label: '100%' });
  });
});

describe('spreadChips', () => {
  it('leaves chips that do not overlap where they are', () => {
    expect(spreadChips([20, 80, 140], 300)).toEqual([20, 80, 140]);
  });

  it('pushes overlapping chips apart, keeping their order', () => {
    const ys = [100, 101, 102, 103];
    const out = spreadChips(ys, 400);
    for (let i = 1; i < out.length; i++) expect(out[i] - out[i - 1]).toBeGreaterThanOrEqual(CHIP_GAP);
  });

  it('keeps a crowded column inside the panel', () => {
    const out = spreadChips([280, 285, 290, 295, 299], 300);
    expect(Math.max(...out)).toBeLessThanOrEqual(300);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(CHIP_GAP / 2 - 0.001);
  });

  it('handles no chips', () => {
    expect(spreadChips([], 100)).toEqual([]);
  });
});

describe('strideRows', () => {
  it('keeps every row when they fit', () => {
    expect(strideRows(5, 400)).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps every k-th row, the last always', () => {
    const kept = strideRows(24, 100);
    expect(kept[kept.length - 1]).toBe(23);
    expect(kept.length).toBeLessThan(24);
  });
});

describe('notesSvg', () => {
  const base: Notes = { w: 400, h: 300, words: [], ticks: [], chips: [], cards: [] };

  it('is an empty group without notes', () => {
    expect(notesSvg(base)).toMatch(/^<g [^>]*><\/g>$/);
  });

  it('writes words, ticks, chips and cards, escaping text', () => {
    const svg = notesSvg({
      ...base,
      words: [{ x: 10, y: 20, text: 'a<b & "c"', anchor: 'end' }],
      ticks: [{ x1: 0, y1: 0, x2: 5, y2: 5 }],
      chips: [{ x: 100, y: 50, parts: [{ text: '#1' }, { text: '"the"', mono: true }] }],
      cards: [{ x: 8, y: 8, title: [{ text: 'T' }], lines: [{ swatch: '#3dd6ff', parts: [{ text: 'model A' }] }] }],
    });
    expect(svg).toContain('a&lt;b &amp; &quot;c&quot;');
    expect(svg).toContain('text-anchor="end"');
    expect(svg).toContain('M0 0L5 5');
    expect(svg).toContain('&quot;the&quot;');
    expect(svg).toContain('model A');
    expect(svg).toContain('fill="#3dd6ff"');
    expect((svg.match(/<g/g) ?? []).length).toBe((svg.match(/<\/g>/g) ?? []).length);
  });

  it('puts the right edge of an end-aligned card at x', () => {
    const svg = notesSvg({ ...base, cards: [{ x: 300, y: 10, align: 'end', lines: [{ parts: [{ text: 'hello' }] }] }] });
    const m = /<rect x="([\d.]+)" y="10" width="([\d.]+)"/.exec(svg);
    expect(m).not.toBeNull();
    expect(Number(m![1]) + Number(m![2])).toBeCloseTo(300, 0);
  });
});
