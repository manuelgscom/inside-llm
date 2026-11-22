// The small reactive state the Svelte panels read: things that change
// rarely (models, status, connection, notices) or are sampled a few times per
// second (replay clock, debug figures). Per-step data never comes through
// here: it stays in the store and is painted by the loop.

import type { Config, Hello } from './source/frames';
import type { DownloadInfo, LoadEvent, ModelsEvent, StatusEvent } from './source/messages';
import type { ReliefSource } from './render/relief-data';
import type { PendingLoad } from './models/catalog';
import { readRecents, type RecentPair } from './models/suggested';

export interface Toast {
  id: number;
  kind: 'error' | 'warning';
  text: string;
}

export type DockTab = 'timeline' | 'layers' | 'relief';
export type InspectorTab = 'candidates' | 'compare';

// Small per-browser preferences (dock tab and height, first-visit tips seen).
// Storage can be missing or refuse access: then the defaults hold.
type Pref = 'dockTab' | 'dockH' | 'hints' | 'reliefInfo';

export function readPref(key: Pref): string | null {
  try {
    return localStorage.getItem(`inside-llm.${key}`);
  } catch {
    return null;
  }
}

export function writePref(key: Pref, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(`inside-llm.${key}`);
    else localStorage.setItem(`inside-llm.${key}`, value);
  } catch {
    // Not stored: the default comes back on the next visit.
  }
}

function storedTab(): DockTab {
  const v = readPref('dockTab');
  return v === 'relief' || v === 'layers' ? v : 'timeline';
}

function storedHeight(): number | null {
  const v = Number(readPref('dockH'));
  return Number.isFinite(v) && v >= 100 ? v : null;
}

export type ModelsTab = 'local' | 'hub';

// The files chosen for slots A and B in the Models panel (names in the
// engine's models folder).
export interface ModelPick {
  a: string | null;
  b: string | null;
}

export interface Draft {
  prompt: string;
  format: 'raw' | 'chat';
  system: string;
  maxTokens: number; // 0: take the engine's current max_tokens
}

class Ui {
  mode = $state<'live' | 'replay'>('live');
  hello = $state.raw<Hello | null>(null);
  config = $state.raw<Config | null>(null);
  unsupported = $state(false);
  front = $state<0 | 1>(0); // the model in front (store.front)
  following = $state(true); // the viewed path follows the cursor (store.follow)
  firstDisagreement = $state(-1); // index in the viewed path, or -1
  msPerToken = $state.raw<[number, number]>([0, 0]); // mean decode_ms of A and B
  lens = $state(false); // the session has the logit lens (HELLO lens.enabled)
  generated = $state(false); // the viewed path has generated tokens (sampled)
  reliefSource = $state<ReliefSource>('alternatives'); // Layers only with the lens
  reliefInfo = $state(readPref('reliefInfo') !== '0'); // ticks, ruler, info card and legend over the Relief

  // Layout.
  helpOpen = $state(false); // the help modal
  dockTab = $state<DockTab>(storedTab()); // what the bottom dock shows
  dockH = $state<number | null>(storedHeight()); // dock height in px; null: the CSS default
  inspectorTab = $state<InspectorTab>('candidates'); // Compare only with two models
  // The ambient halos: recent uncertainty of A and B, 0..1 (sampled, not per step).
  ambient = $state.raw<[number, number]>([0, 0]);

  // Live.
  status = $state.raw<StatusEvent | null>(null);
  connected = $state(false);
  everConnected = $state(false);
  promptOpen = $state(false);
  gatesOpen = $state(false); // the gate configuration panel
  configErrors = $state(0); // `config` commands the engine has refused
  draft = $state<Draft>({ prompt: '', format: 'chat', system: '', maxTokens: 0 });

  // Models (live; rare events, fine for Svelte).
  models = $state.raw<ModelsEvent | null>(null); // the last `models` event
  modelsOpen = $state(false); // the Models panel
  modelsTab = $state<ModelsTab>('local');
  pick = $state.raw<ModelPick>({ a: null, b: null });
  load = $state.raw<LoadEvent | null>(null); // the last `load` event
  downloads = $state.raw<DownloadInfo[]>([]); // the queue, kept current by `download` events
  pending = $state.raw<PendingLoad | null>(null); // load once these downloads are done
  modelsError = $state(''); // why a load or a pending load did not happen
  recents = $state.raw<RecentPair[]>(readRecents());

  // Replay.
  loadError = $state('');
  time = $state(0);
  duration = $state(0);
  playing = $state(false);
  rate = $state(1);

  toasts = $state<Toast[]>([]);

  // ?debug
  debug = $state(false);
  fps = $state(0);
  maxFrameMs = $state(0); // longest gap between two painted frames in the last sample
  frames = $state(0);
  nodes = $state(0);
}

export const ui = new Ui();

let nextToast = 1;
const TOAST_MS = 5000;

// Shows a brief notice that goes away by itself.
export function toast(kind: Toast['kind'], text: string): void {
  const id = nextToast++;
  ui.toasts = [...ui.toasts.slice(-3), { id, kind, text }];
  setTimeout(() => {
    ui.toasts = ui.toasts.filter((t) => t.id !== id);
  }, TOAST_MS);
}
