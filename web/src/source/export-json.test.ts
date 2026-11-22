// The JSON export over the synthetic sessions of sessions/golden/: every
// frame decoded, the viewed path, the metric series and both relief grids.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSessionJson, EXPORT_FORMAT, sessionJsonText } from './export-json';
import { decodeSession } from './recorded';

interface Doc {
  format: string;
  hello: { models: unknown[]; lens: { enabled: boolean; layers: number[] }; n_raw: number };
  nodes: { id: number; token: { text: string } }[];
  decisions: { A: { candidates: unknown[]; lens: unknown[] | null }[]; B: unknown[] };
  pairs: unknown[];
  views: {
    front: string;
    text: string;
    positions: unknown[];
    metrics: { A: Record<string, unknown[]>; B: unknown };
    relief_3d: {
      alternatives: { rows: number; columns: number; front: number[][] };
      layers: { rows: number; columns: number; front: number[][] } | null;
    };
  }[];
}

async function load(name: string): Promise<Doc> {
  const file = readFileSync(resolve(import.meta.dirname, `../../../sessions/golden/${name}.ils`));
  const frames = await decodeSession(new Uint8Array(file));
  return JSON.parse(sessionJsonText(frames)) as Doc;
}

describe('JSON export', () => {
  it('writes the format marker and survives a JSON round trip', async () => {
    const doc = await load('single');
    expect(doc.format).toBe(EXPORT_FORMAT);
    expect(doc.nodes.length).toBeGreaterThan(0);
    expect(doc.views).toHaveLength(1);
    expect(doc.views[0].positions).toHaveLength(doc.views[0].relief_3d.alternatives.columns);
  });

  it('exports a view per model and the pairs of a two-model session', async () => {
    const doc = await load('pair');
    expect(doc.views.map((v) => v.front)).toEqual(['A', 'B']);
    expect(doc.pairs.length).toBeGreaterThan(0);
    expect(doc.views[0].metrics.B).not.toBeNull();
    expect(doc.views[0].relief_3d.alternatives.rows).toBe(doc.hello.n_raw);
  });

  it('exports the lens layers and the layers relief', async () => {
    const doc = await load('lens');
    const layers = doc.views[0].relief_3d.layers;
    expect(layers).not.toBeNull();
    expect(layers!.rows).toBe(doc.hello.lens.layers.length);
    expect(doc.decisions.A.some((d) => d.lens !== null)).toBe(true);
    for (const col of layers!.front) for (const h of col) expect(h === null || (h >= 0 && h <= 1)).toBe(true);
  });

  it('exports every branch of a branching session', async () => {
    const doc = await load('branches');
    const file = readFileSync(resolve(import.meta.dirname, '../../../sessions/golden/branches.ils'));
    const plain = buildSessionJson(await decodeSession(new Uint8Array(file))) as { leaves: unknown[] };
    expect(plain.leaves.length).toBeGreaterThan(1);
    expect(doc.nodes.length).toBeGreaterThan(plain.leaves.length);
  });

  it('exports the six metric series, as long as the path', async () => {
    const doc = await load('gates');
    const m = doc.views[0].metrics.A;
    expect(Object.keys(m)).toHaveLength(6);
    for (const series of Object.values(m)) expect(series).toHaveLength(doc.views[0].positions.length);
  });
});
