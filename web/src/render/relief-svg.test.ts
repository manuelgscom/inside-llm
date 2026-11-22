import { describe, expect, it } from 'vitest';
import { hexToLinear, linearToHex, patchColor, sceneSvg, worldX, worldZ, type Project, type SceneInput } from './relief-svg';

// An oblique projection from the +z side, like the camera: x to the right,
// y up the screen, the front (+z) lower on it and nearer (less depth).
const project: Project = (x, y, z) => [300 + x * 8, 200 - y * 12 + z * 4, 50 - z];

function scene(over: Partial<SceneInput> = {}): SceneInput {
  const cols = 6;
  const rows = 4;
  const front = new Float32Array(cols * rows);
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) front[c * rows + r] = r === 0 ? 0.9 : 0.1 * r;
  return {
    cols,
    rows,
    front,
    back: null,
    doubt: new Float32Array(cols),
    div: new Float32Array(cols),
    tone: new Uint8Array(cols),
    backSlot: 1,
    hues: ['#3dd6ff', '#ffb547'],
    width: 30,
    depth: 6,
    height: 4,
    span: 64,
    backFirst: true,
    selected: -1,
    pinned: false,
    project,
    ...over,
  };
}

const polygons = (svg: string): number => (svg.match(/<polygon points="[^"]+" fill="#[0-9a-f]{6}" stroke=/g) ?? []).length;

describe('colours', () => {
  it('round-trips sRGB through linear light', () => {
    for (const hex of ['#3dd6ff', '#ffb547', '#060812', '#ffffff']) expect(linearToHex(hexToLinear(hex))).toBe(hex);
  });

  const look = { hue: hexToLinear('#3dd6ff'), h: 0.5, top: 0.5, ny: 1, diffuse: 0.8, doubt: 0, div: 0 };
  const lum = (hex: string): number => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);

  it('is near black on flat ground and brighter with height', () => {
    expect(lum(patchColor({ ...look, h: 0 }))).toBeLessThan(lum(patchColor({ ...look, h: 0.5 })));
    expect(lum(patchColor({ ...look, h: 0.5 }))).toBeLessThan(lum(patchColor({ ...look, h: 1, top: 1 })));
  });

  it('turns a hesitant crest near white', () => {
    const c = patchColor({ ...look, h: 0.9, top: 1, doubt: 1 });
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    expect(Math.min(r, g, b)).toBeGreaterThan(190);
  });

  it('pulls a diverging patch towards magenta', () => {
    const c = patchColor({ ...look, h: 0.9, top: 1, div: 1 });
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(g);
    expect(b).toBeGreaterThan(g);
  });
});

describe('world coordinates', () => {
  it('centres column c at (c + 0.5) / span of the width', () => {
    expect(worldX(0, 30, 60)).toBeCloseTo(-14.75, 10);
    expect(worldX(59, 30, 60)).toBeCloseTo(14.75, 10);
  });

  it('puts row 0 at the back, or at the front', () => {
    expect(worldZ(0, 4, 6, true)).toBe(-3);
    expect(worldZ(3, 4, 6, true)).toBe(3);
    expect(worldZ(0, 4, 6, false)).toBe(3);
  });
});

describe('sceneSvg', () => {
  it('draws one polygon per cell', () => {
    const out = sceneSvg(scene());
    expect(out.quads).toBe(5 * 3);
    expect(polygons(out.svg)).toBe(15);
    expect(out.stride).toBe(1);
  });

  it('paints from the far cells to the near ones', () => {
    const all = [...sceneSvg(scene()).svg.matchAll(/<polygon points="([^"]+)" fill="#/g)].map((m) => {
      const ys = m[1].split(' ').map((p) => Number(p.split(',')[1]));
      return ys.reduce((a, b) => a + b, 0) / ys.length;
    });
    // The back row is higher on the screen than the front one, and drawn first.
    expect(all[0]).toBeLessThan(all[all.length - 1]);
  });

  it('thins the surface beyond the cap', () => {
    const out = sceneSvg(scene({ maxQuads: 6 }));
    expect(out.stride).toBeGreaterThan(1);
    expect(out.quads).toBeLessThanOrEqual(15);
  });

  it('skips cells that cannot be projected', () => {
    // Columns 0 to 2 lie left of the cut; cells touching a later column are dropped.
    const out = sceneSvg(scene({ project: (x, y, z) => (x > -13.5 ? null : project(x, y, z)) }));
    expect(out.quads).toBe(2 * 3);
  });

  it('adds the other model as faint row lines', () => {
    const rows = 4;
    const back = new Float32Array(6 * rows).fill(0.5);
    const out = sceneSvg(scene({ back }));
    expect((out.svg.match(/<polyline/g) ?? []).length).toBe(rows);
    expect(out.svg).toContain('#ffb547');
  });

  it('draws the plane and the cut only for a selected column', () => {
    expect(sceneSvg(scene()).svg).not.toContain('stroke-width="1.6"');
    const out = sceneSvg(scene({ selected: 2, pinned: true }));
    expect(out.svg).toContain('stroke-width="1.6"');
    expect(out.svg).toContain('fill-opacity="0.07"');
  });

  it('draws nothing for a single column, but still the floor', () => {
    const out = sceneSvg(scene({ cols: 1 }));
    expect(out.quads).toBe(0);
    expect(out.svg).toContain('<path d="M');
  });
});
