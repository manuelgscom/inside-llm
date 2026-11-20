// JSON export of a whole session: every frame decoded, plus what the panels
// derive from them (the viewed paths, the six metric series, the heights of
// the 3D relief in both of its modes, the timeline). It is built by replaying
// the frames into a private Store, so the numbers are the ones the page shows.
//
// Conventions: a token is {id, text}; text is the UTF-8 decoding of its bytes
// and `bytes_hex` is added only where the bytes are not valid UTF-8 (a token
// can end mid-character). NaN and Infinity have no JSON form and become null.
// Relief grids are arrays of columns (one per position of the path), each an
// array of rows, as the 3D view reads them.

import { PathMetrics, M_CONFIDENCE, M_LATENCY, M_MARGIN, M_PERPLEXITY, M_SPEED, M_SURPRISE } from '../render/metrics-data';
import { ReliefData, type ReliefSource } from '../render/relief-data';
import { Store, type EvalData, type Slot } from '../store/store';
import {
  FRAME_CONFIG,
  FRAME_CURSOR,
  FRAME_HELLO,
  FRAME_STOP,
  NONE,
  PAIR_APPROX,
  PAIR_SAME_PICK,
  PAIR_SAME_TOP,
  ATTR_CONTROL,
  ATTR_EOG,
  type Config,
  type Frame,
  type PairFrame,
} from './frames';

export const EXPORT_FORMAT = 'inside-llm-session-json';
export const EXPORT_VERSION = 1;

const ORIGIN_NAMES = ['prompt', 'model', 'user'] as const;
const STOP_NAMES = ['end_of_generation', 'max_tokens', 'context_full'] as const;
const SLOT_NAMES = ['A', 'B', 'both'] as const;
const METRICS: readonly [string, number][] = [
  ['confidence', M_CONFIDENCE],
  ['surprise_bits', M_SURPRISE],
  ['perplexity', M_PERPLEXITY],
  ['margin', M_MARGIN],
  ['speed_tokens_per_s', M_SPEED],
  ['latency_ms', M_LATENCY],
];

const decoder = new TextDecoder('utf-8', { fatal: false });

interface TokenText {
  id: number;
  text: string;
  bytes_hex?: string;
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function num(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

function nums(a: ArrayLike<number>): (number | null)[] {
  return Array.from(a, num);
}

function nodeRef(id: number): number | null {
  return id === NONE ? null : id;
}

class Exporter {
  private readonly store = new Store();

  constructor(private readonly frames: readonly Frame[]) {
    for (const f of frames) this.store.apply(f);
  }

  private tok(id: number): TokenText {
    const v = this.store.vocab.get(id);
    if (!v) return { id, text: '' };
    const text = decoder.decode(v.bytes);
    return text.includes('�') ? { id, text, bytes_hex: hex(v.bytes) } : { id, text };
  }

  private text(ids: readonly number[]): string {
    return ids.map((n) => this.tok(this.store.token[n]).text).join('');
  }

  private decision(d: EvalData): object {
    const n = d.tokens.length;
    const gates = d.config?.gates ?? [];
    const lens = d.lens;
    return {
      node: d.node,
      t_ms: d.t,
      n_raw: d.nRaw,
      n_extra: d.nExtra,
      pick: d.pick,
      picked: this.tok(d.tokens[d.pick]),
      entropy_bits: num(d.entropy),
      raw_mass: num(d.rawMass),
      decode_ms: num(d.decodeMs),
      candidates: Array.from(d.tokens, (t, i) => ({ ...this.tok(t), p_raw: num(d.pRaw[i]), extra: i >= d.nRaw })),
      gates: Array.from(d.survivors, (survivors, g) => ({
        config: gates[g] ?? null,
        survivors,
        p_after: nums(d.stageP.subarray(g * n, (g + 1) * n)),
      })),
      lens: lens
        ? Array.from(lens.topId, (id, l) => ({
            layer: this.store.hello?.lens.layers[l] ?? l,
            top: this.tok(id),
            top_p: num(lens.topP[l]),
            answer_p: num(lens.answerP[l]),
            entropy_bits: num(lens.entropy[l]),
          }))
        : null,
    };
  }

  private pair(p: PairFrame): object {
    return {
      node: p.node,
      t_ms: p.t,
      js_bits: num(p.js),
      kl_a_vs_b_bits: num(p.klAB),
      kl_b_vs_a_bits: num(p.klBA),
      rank_of_a_top_in_b: p.rankAInB === NONE ? null : p.rankAInB,
      rank_of_b_top_in_a: p.rankBInA === NONE ? null : p.rankBInA,
      same_top: (p.flags & PAIR_SAME_TOP) !== 0,
      same_pick: (p.flags & PAIR_SAME_PICK) !== 0,
      approximate: (p.flags & PAIR_APPROX) !== 0,
    };
  }

  private relief(source: ReliefSource): object {
    const r = new ReliefData();
    r.update(this.store, source);
    const cols = (a: Float32Array): (number | null)[][] =>
      Array.from({ length: r.cols }, (_, c) => nums(a.subarray(c * r.rows, (c + 1) * r.rows)));
    return {
      source: r.source,
      rows: r.rows,
      columns: r.cols,
      row_meaning:
        r.source === 'layers' ? 'logit-lens layer, in HELLO lens.layers order' : 'candidate rank, most likely first',
      height_meaning: 'sqrt(p), 0..1; p is p_raw (alternatives) or answer_p (layers)',
      front: cols(r.front),
      back: cols(r.back),
      doubt: nums(r.doubt.subarray(0, r.cols)),
      divergence: nums(r.div.subarray(0, r.cols)),
      tone_slot: Array.from(r.tone.subarray(0, r.cols), (s) => SLOT_NAMES[s]),
    };
  }

  // Everything the page shows for one model in front: the viewed path, the
  // per-position values, the metric strip, the timeline and both reliefs.
  private view(front: Slot): object {
    const s = this.store;
    s.setFront(front);
    const metrics = new PathMetrics();
    metrics.sync(s);
    const two = s.twoModels;
    const path = [...s.path];
    const hello = s.hello;

    const positions = path.map((node, i) => {
      const d = s.decision(i);
      const pr = s.pairAt(i);
      return {
        index: i,
        node,
        token: this.tok(s.token[node]),
        origin: ORIGIN_NAMES[s.origin[node]] ?? s.origin[node],
        decision_node: nodeRef(s.decisionNode(i)),
        p: s.probability(i) ?? null,
        entropy_bits: d ? num(d.entropy) : null,
        entropy_a_bits: num(s.decisionOf(i, 0)?.entropy ?? NaN),
        entropy_b_bits: two ? num(s.decisionOf(i, 1)?.entropy ?? NaN) : null,
        js_bits: pr ? num(pr.js) : null,
        disagrees: s.disagrees(i),
      };
    });

    const series = (k: 0 | 1): object => {
      const out: Record<string, (number | null)[]> = {};
      for (const [name, m] of METRICS) out[name] = nums(metrics.slots[k].v[m].subarray(0, metrics.length));
      return out;
    };

    return {
      front: SLOT_NAMES[front],
      following_cursor: s.follow,
      path_nodes: path,
      text: this.text(path),
      prompt_length: s.promptLength,
      first_disagreement_index: s.firstDisagreement(),
      lane: s.lane.length > 0 ? { split_index: s.split, nodes: [...s.lane], text: this.text(s.lane) } : null,
      positions,
      metrics: { first_generated_index: metrics.first, A: series(0), B: two ? series(1) : null },
      relief_3d: {
        alternatives: this.relief('alternatives'),
        layers: hello?.lens.enabled ? this.relief('layers') : null,
      },
    };
  }

  build(): object {
    const s = this.store;
    const two = s.twoModels;
    const originalFront = s.front;
    const used = new Set<number>(s.vocab.keys());

    const nodes = Array.from({ length: s.nodeCount }, (_, id) => ({
      id,
      parent: nodeRef(s.parent[id]),
      token: this.tok(s.token[id]),
      depth: s.depth[id],
      origin: ORIGIN_NAMES[s.origin[id]] ?? s.origin[id],
      children: s.children[id] ?? [],
      stop: s.stops.has(id)
        ? { slot: SLOT_NAMES[s.stops.get(id)!.slot], reason: STOP_NAMES[s.stops.get(id)!.reason] }
        : null,
    }));

    const leaves = nodes
      .filter((n) => n.children.length === 0)
      .map((n) => {
        const chain: number[] = [];
        for (let c: number = n.id; c !== NONE; c = s.parent[c]) chain.push(c);
        chain.reverse();
        return { node: n.id, depth: n.depth, text: this.text(chain) };
      });

    const decisions = (slot: Slot): object[] =>
      s.evals[slot].filter((d): d is EvalData => d !== undefined).map((d) => this.decision(d));

    const views = two ? [this.view(0), this.view(1)] : [this.view(0)];
    s.setFront(originalFront);

    return {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exported_at: new Date().toISOString(),
      hello: s.hello,
      configs: this.frames.filter((f) => f.type === FRAME_CONFIG).map((f) => ({ t_ms: f.t, config: (f as { config: Config }).config })),
      vocab: Object.fromEntries(
        [...used].map((id) => {
          const v = s.vocab.get(id)!;
          const { id: _id, ...rest } = this.tok(id);
          return [id, { ...rest, control: (v.attr & ATTR_CONTROL) !== 0, end_of_generation: (v.attr & ATTR_EOG) !== 0 }];
        }),
      ),
      nodes,
      leaves,
      decisions: { A: decisions(0), B: two ? decisions(1) : [] },
      pairs: s.pairs.filter((p): p is PairFrame => p !== undefined).map((p) => this.pair(p)),
      cursors: this.frames
        .filter((f) => f.type === FRAME_CURSOR)
        .map((f) => ({ t_ms: f.t, node_a: nodeRef((f as { nodeA: number }).nodeA), node_b: nodeRef((f as { nodeB: number }).nodeB) })),
      stops: this.frames
        .filter((f) => f.type === FRAME_STOP)
        .map((f) => {
          const st = f as { node: number; slot: number; reason: number };
          return { t_ms: f.t, node: st.node, slot: SLOT_NAMES[st.slot], reason: STOP_NAMES[st.reason] };
        }),
      splits: s.splits,
      views,
      frame_log: this.frames.map((f) => ({ type: f.type, t_ms: f.t })),
      hello_count: this.frames.filter((f) => f.type === FRAME_HELLO).length,
    };
  }
}

// The session as a JSON document (a plain object, ready for JSON.stringify).
export function buildSessionJson(frames: readonly Frame[]): object {
  return new Exporter(frames).build();
}

// JSON text of the session. Compact: the relief grids make it large.
export function sessionJsonText(frames: readonly Frame[]): string {
  return JSON.stringify(buildSessionJson(frames));
}
