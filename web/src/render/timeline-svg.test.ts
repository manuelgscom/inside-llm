import { describe, expect, it } from 'vitest';
import { buildTimelineSvg, type SvgSeries, type SvgTree, type TimelineSvgInput } from './timeline-svg';
import { COLOR } from './theme';

// The tags of an XML fragment, checked to nest properly (no parser in node).
function balanced(xml: string): boolean {
  const stack: string[] = [];
  for (const m of xml.matchAll(/<(\/?)([A-Za-z][\w:-]*)([^>]*?)(\/?)>/g)) {
    const [, close, name, , self] = m;
    if (self) continue;
    if (close) {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

const EMPTY_TREE: SvgTree = {
  y: 300.5,
  label: 'path',
  branches: [],
  start: NaN,
  prompt: NaN,
  end: NaN,
  forks: [],
  pathStop: null,
  branchStops: [],
  userMain: [],
  userBranch: [],
  cursors: [],
};

function series(id: string, color: string, y: (number | undefined)[]): SvgSeries {
  return { id, color, y, base: 200, far: 100, areaAlpha: 0.36 };
}

function input(over: Partial<TimelineSvgInput> = {}): TimelineSvgInput {
  const ys = Array.from({ length: 64 }, (_, i) => (i === 10 ? undefined : 150 + (i % 7) * 5));
  return {
    width: 800,
    height: 340,
    title: 'inside-llm timeline',
    desc: 'test',
    caption: 'A: model · positions 0 to 63 of 64',
    padX: 14,
    left: 100,
    right: 786,
    top: 40,
    bottom: 200,
    lo: 0,
    vis: 64,
    step: 10,
    span: 64,
    count: 64,
    promptLength: 8,
    markY: 198,
    tickEvery: 10,
    tickY: 210,
    bandLabels: [{ y0: 40, y1: 200, color: COLOR.a, name: 'entropy', scale: '0–4 bits' }],
    guides: { solid: [200], dotted: [40, 120] },
    series: [series('e', COLOR.a, ys)],
    disagreements: [],
    legend: [],
    tree: EMPTY_TREE,
    ...over,
  };
}

const pointsOf = (svg: string): number => (svg.match(/<path d="M[^"]*" fill="none" stroke="#3dd6ff" stroke-width="1.5"/)?.[0].match(/[ML]/g) ?? []).length;

describe('buildTimelineSvg', () => {
  it('is one balanced svg document with the band labels', () => {
    const svg = buildTimelineSvg(input());
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(balanced(svg)).toBe(true);
    expect(svg).toContain('entropy');
    expect(svg).toContain('0–4 bits');
    expect(svg).toContain('<title>inside-llm timeline</title>');
    expect(svg).toContain('clip-path="url(#tl-plot)"');
  });

  it('draws one point per visible position and breaks where there is none', () => {
    const svg = buildTimelineSvg(input());
    // 64 positions, one missing: two runs, 63 points.
    expect(pointsOf(svg)).toBe(63);
    const runsDrawn = (svg.match(/M\d/g) ?? []).length;
    expect(runsDrawn).toBeGreaterThanOrEqual(2);
  });

  it('draws only the window and one position each side when zoomed', () => {
    const svg = buildTimelineSvg(input({ lo: 20, vis: 8, step: 80 }));
    // positions 19 to 29 (the window is 20 to 28, plus one each side)
    expect(pointsOf(svg)).toBe(11);
    expect(balanced(svg)).toBe(true);
  });

  it('labels the positions at the tick step, inside the plot', () => {
    const svg = buildTimelineSvg(input());
    for (const label of ['>0<', '>10<', '>20<', '>50<']) expect(svg).toContain(label);
    expect(svg).not.toContain('>5<');
    const zoomed = buildTimelineSvg(input({ lo: 20, vis: 8, step: 80, tickEvery: 1 }));
    expect(zoomed).toContain('>22<');
    expect(zoomed).not.toContain('>40<');
  });

  it('two models: three traces, the legend and disagreement ticks', () => {
    const two = input({
      series: [series('a', COLOR.a, [150, 160, 155]), series('b', COLOR.b, [250, 260, 255]), series('d', COLOR.high, [190, 180, 170])],
      count: 3,
      disagreements: [1, 2],
      legend: [{ kind: 'differ', x: 15, y: 12, text: 'picks differ' }],
      bandLabels: [
        { y0: 40, y1: 100, color: COLOR.a, name: 'entropy A', scale: '0–4 bits' },
        { y0: 100, y1: 140, color: COLOR.high, name: 'divergence', scale: '0–1 bit' },
        { y0: 140, y1: 200, color: COLOR.b, name: 'entropy B', scale: '0–4 bits' },
      ],
    });
    const svg = buildTimelineSvg(two);
    expect(balanced(svg)).toBe(true);
    for (const t of ['entropy A', 'entropy B', 'divergence', 'picks differ']) expect(svg).toContain(t);
    expect(svg).toContain('url(#tl-g-a)');
    expect(svg).toContain('url(#tl-g-b)');
    expect(svg).toContain('url(#tl-g-d)');
    expect(svg).toContain(`fill="${COLOR.dis}"`);
  });

  it('an empty path draws the frame and the tree label only', () => {
    const svg = buildTimelineSvg(input({ count: 0, series: [series('e', COLOR.a, [])], promptLength: 0 }));
    expect(balanced(svg)).toBe(true);
    expect(svg).toContain('>path<');
    expect(svg).not.toContain('stroke-width="1.5" stroke-linejoin');
  });

  it('draws the tree: branches, forks, stop glyphs, diamonds and cursors', () => {
    const tree: SvgTree = {
      y: 300.5,
      label: '2 branches',
      branches: [
        { x0: 200, x1: 400, y: 311.5, c: 12 },
        { x0: 300, x1: 330, y: 322.5, c: 23 },
      ],
      start: 105,
      prompt: 175,
      end: 700,
      forks: [200, 300],
      pathStop: { glyph: 'end', x: 705 },
      branchStops: [{ glyph: 'cut', x: 405, y: 311.5 }],
      userMain: [450],
      userBranch: [{ x: 212, y: 311.5 }],
      cursors: [
        { x: 700, y: 300.5, color: COLOR.a, ring: true },
        { x: 700, y: 300.5, color: COLOR.b, ring: false },
      ],
    };
    const svg = buildTimelineSvg(input({ tree }));
    expect(balanced(svg)).toBe(true);
    expect(svg).toContain('>2 branches<');
    expect((svg.match(/<polygon/g) ?? []).length).toBe(2);
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toMatch(/<circle cx="700" cy="300.5" r="5.5" fill="none"/);
  });

  it('escapes text from the data', () => {
    const svg = buildTimelineSvg(input({ caption: 'A: <b>"x" & y</b>', desc: 'a < b' }));
    expect(svg).toContain('A: &lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;');
    expect(svg).toContain('<desc>a &lt; b</desc>');
    expect(balanced(svg)).toBe(true);
  });

  it('never prints NaN or Infinity', () => {
    const svg = buildTimelineSvg(input());
    expect(svg).not.toMatch(/NaN|Infinity/);
  });
});
