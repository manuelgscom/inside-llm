// Wiring: the store and view, the frame source (live or recorded), the paint
// loop and the keyboard. Svelte panels call the actions exported here.

import { flushSync } from 'svelte';
import { bootMode, STATIC } from './gallery';
import { LiveSource, liveUrl } from './source/live';
import type {
  Command,
  ConfigChange,
  DownloadEvent,
  EngineEvent,
  LoadEvent,
  ModelsEvent,
  Slots,
  StartCommand,
} from './source/messages';
import { decodeSession, loadSession, Player } from './source/recorded';
import { sessionJsonText } from './source/export-json';
import { downloadBlob, downloadText, stamp } from './render/export';
import { NONE, type Config, type Frame } from './source/frames';
import { Store, type Slot } from './store/store';
import { View } from './store/view';
import { toast, ui, writePref, type DockTab, type InspectorTab } from './ui.svelte';
import { Birth } from './render/birth';
import { CandidatesPanel } from './render/candidates';
import { ComparePanel } from './render/comparepanel';
import { GateRun } from './render/gaterun';
import { GatesPanel } from './render/gates';
import { LensPanel } from './render/lens';
import { startLoop, type ReliefPart } from './render/loop';
import { MetricsPanel } from './render/metrics';
import type { ReliefSource } from './render/relief-data';
import { Particles } from './render/particles';
import { Split } from './render/split';
import { StreamPanel } from './render/stream';
import { TimelinePanel } from './render/timeline';
import { MODEL_COLOR } from './render/theme';
import {
  applyDownload,
  basename,
  findFile,
  pendingBrokenBy,
  pendingStep,
  sameDownload,
  usable,
  type PendingLoad,
} from './models/catalog';
import { pushRecent } from './models/suggested';

type Mode = Config['mode'];
type Driver = Config['driver'];

export const store = new Store();
export const view = new View(store);

let live: LiveSource | null = null;
let player: Player | null = null;
let replayFrames: Frame[] | null = null;
let stream: StreamPanel | null = null;
let reliefBox: HTMLElement | null = null;
let relief:
  | (ReliefPart & {
      dispose(): void;
      resetView(): void;
      zoomBy(factor: number): void;
      setInfo(on: boolean): void;
      save(kind: 'svg' | 'png'): Promise<void>;
    })
  | null = null;
let timelinePanel: TimelinePanel | null = null;

export interface Surfaces {
  stream: HTMLElement;
  candidates: HTMLCanvasElement;
  gates: HTMLCanvasElement; // the gate strip, under Candidates
  fx: HTMLCanvasElement; // particles, over Candidates and the strip
  timeline: HTMLCanvasElement;
  metrics: HTMLCanvasElement; // the strip of live figures
  lens: HTMLCanvasElement; // the Layers view of the dock
  compare: HTMLCanvasElement; // the Compare view of the Inspector
  relief: HTMLElement; // the Relief section: what goes full screen
  reliefCanvas: HTMLCanvasElement;
  reliefLabels: HTMLElement; // the Layers labels, over the canvas
}

// Starts everything once the panels are in the DOM. Returns the teardown.
export function start(el: Surfaces): () => void {
  const params = new URLSearchParams(location.search);
  ui.debug = params.has('debug');
  const boot = bootMode(location.search, STATIC);

  stream = new StreamPanel(el.stream, store, view);
  const candidates = new CandidatesPanel(el.candidates, store, view, { can: canCommand, branch: branchTo });
  const gates = new GatesPanel(el.gates, store, view);
  const particles = new Particles(el.fx, MODEL_COLOR); // palette index = slot
  const timeline = new TimelinePanel(el.timeline, store, view);
  timelinePanel = timeline;
  const metrics = new MetricsPanel(el.metrics, store, view);
  const lens = new LensPanel(el.lens, store, view);
  const compare = new ComparePanel(el.compare, store, view);
  const birth = new Birth(store, view, stream, candidates);
  const run = new GateRun(store, view, candidates, particles);
  const split = new Split(store, stream);
  reliefBox = el.relief;
  let stopped = false;

  const stopLoop = startLoop({
    store,
    view,
    stream,
    candidates,
    gates,
    timeline,
    birth,
    run,
    particles,
    split,
    metrics,
    lens,
    compare,
    shown: (v) => (v === 'lens' ? ui.dockTab === 'layers' : ui.inspectorTab === 'compare'),
    relief: () => relief,
    tick: (ms) => player?.tick(ms),
    meta: () => {
      ui.hello = store.hello;
      ui.config = store.config;
      ui.unsupported = store.unsupported;
      ui.front = store.front;
      ui.following = store.follow;
      // Without the lens there is no Layers source.
      ui.lens = store.hello?.lens.enabled ?? false;
      if (!ui.lens) ui.reliefSource = 'alternatives';
      // Views that need what this session lacks fall back to the default one.
      if (!ui.lens && ui.dockTab === 'layers') ui.dockTab = 'timeline';
      if (!store.twoModels) ui.inspectorTab = 'candidates';
      // The CSS colour of the model in front (--front).
      document.documentElement.dataset.front = store.front === 1 ? 'b' : 'a';
    },
    slow: (fps, maxFrameMs) => {
      if (player) syncReplay();
      ui.firstDisagreement = store.firstDisagreement();
      const ms = [meanDecodeMs(0), meanDecodeMs(1)] as [number, number];
      if (ms[0] !== ui.msPerToken[0] || ms[1] !== ui.msPerToken[1]) ui.msPerToken = ms;
      const generated = store.path.length > store.promptLength;
      if (generated !== ui.generated) ui.generated = generated;
      const amb = [uncertainty(0), store.twoModels ? uncertainty(1) : -1] as [number, number];
      if (amb[0] !== ui.ambient[0] || amb[1] !== ui.ambient[1]) ui.ambient = amb;
      if (ui.debug) {
        ui.fps = Math.round(fps);
        ui.maxFrameMs = Math.round(maxFrameMs);
        ui.frames = store.framesApplied;
        ui.nodes = ui.status?.nodes ?? store.nodeCount;
      }
    },
  });

  // Canvas text needs the web font: repaint once it is there.
  document.fonts?.ready.then(() => {
    store.dirty.candidates = true;
    store.dirty.timeline = true;
    store.dirty.metrics = true;
    store.dirty.lens = true;
    store.dirty.compare = true;
    gates.invalidate();
  });

  if (boot.mode === 'replay') {
    ui.mode = 'replay';
    loadSession(boot.session)
      .then((frames) => {
        replayFrames = frames;
        player = new Player(frames, store);
        player.play();
        syncReplay();
      })
      .catch((e: unknown) => {
        ui.loadError = e instanceof Error ? e.message : String(e);
      });
  } else if (boot.mode === 'live') {
    // The static build never connects to an engine (main.ts shows the gallery).
    ui.mode = 'live';
    live = new LiveSource(liveUrl(location), {
      onFrames: (frames) => {
        for (const f of frames) store.apply(f);
      },
      onEvent,
      onConnection: (connected) => {
        ui.connected = connected;
        if (connected) ui.everConnected = true;
      },
    });
  }

  window.addEventListener('keydown', onKey);

  // The relief last, in a chunk of its own: the page is usable before
  // three.js has loaded. Without WebGL2 the panel stays empty.
  import('./render/relief')
    .then(({ Relief }) => {
      if (stopped) return;
      try {
        relief = new Relief(el.reliefCanvas, el.reliefLabels, store, view, () => ui.reliefSource);
        relief.setInfo(ui.reliefInfo);
        store.dirty.relief = true;
      } catch (e) {
        console.warn('Relief: WebGL2 is not available; the panel stays empty.', e);
      }
    })
    .catch((e: unknown) => console.warn('Relief: could not load the 3D scene.', e));

  return () => {
    stopped = true;
    window.removeEventListener('keydown', onKey);
    stopLoop();
    relief?.dispose();
    relief = null;
    timelinePanel = null;
    reliefBox = null;
    birth.cancel();
    run.cancel();
    split.cancel();
    candidates.dispose();
    gates.dispose();
    particles.dispose();
    timeline.dispose();
    metrics.dispose();
    lens.dispose();
    compare.dispose();
    live?.close();
    live = null;
    player = null;
  };
}

// ------------------------------------------------------------- live

function onEvent(ev: EngineEvent): void {
  switch (ev.ev) {
    case 'status': {
      const prev = ui.status;
      ui.status = ev;
      // The prompt drawer opens by itself while there is no prompt yet.
      if (ev.state === 'idle' && prev?.state !== 'idle') ui.promptOpen = true;
      break;
    }
    case 'error':
      if (ev.cmd === 'config') ui.configErrors++; // the gate panel goes back to the CONFIG in force
      if (ev.cmd === 'branch' || ev.cmd === 'goto') store.cancelAwait(); // no CURSOR will come
      if (ev.cmd === 'load' || ev.cmd === 'download') onModelsRefused(ev.cmd, ev.msg);
      toast('error', ev.cmd ? `${ev.cmd}: ${ev.msg}` : ev.msg);
      break;
    case 'warning':
      toast('warning', ev.msg);
      break;
    case 'models':
      onModels(ev);
      break;
    case 'load':
      onLoad(ev);
      break;
    case 'download':
      onDownload(ev);
      break;
  }
}

// ------------------------------------------------------------- models

// No model to run (live only): none loaded, or a load in progress. Until
// the engine has sent a `models` event, nothing is assumed.
export function noModel(): boolean {
  const m = ui.models;
  if (ui.mode !== 'live' || m === null) return false;
  return m.loaded.a === null || m.loading || ui.load?.state === 'loading';
}

function onModels(ev: ModelsEvent): void {
  const prev = ui.models;
  ui.models = ev;
  ui.downloads = ev.downloads;
  // A `load` event missed (a reconnection mid-load): the snapshot decides.
  if (!ev.loading && ui.load?.state === 'loading') ui.load = null;
  // The slots follow what got loaded; a chosen file that left the folder
  // leaves its slot, unless a pending load is waiting for it.
  const loadedChanged = !prev || prev.loaded.a !== ev.loaded.a || prev.loaded.b !== ev.loaded.b;
  let { a, b } = loadedChanged && ev.loaded.a ? ev.loaded : ui.pick;
  const p = ui.pending;
  const keep = (f: string | null) => usable(findFile(ev.files, f)) || (p !== null && f !== null && (f === p.a || f === p.b));
  if (!keep(a)) a = null;
  if (!a || !keep(b)) b = null;
  if (a !== ui.pick.a || b !== ui.pick.b) ui.pick = { a, b };

  if (ev.loaded.a === null) {
    // Nothing loaded: what the view still shows is a session that is gone.
    if (store.hello !== null) store.reset();
    // Open the panel when that becomes the case (not on every refresh).
    const before = prev !== null && prev.loaded.a === null && !prev.loading;
    if (!ev.loading && !before && ui.pending === null) openModels();
  }
  if (ui.pending) advancePending(ev);
}

// The configuration in force when a load began. A new session starts from
// the engine's defaults: this one is sent again once the models are ready,
// so changing models keeps the Samplers panel.
let carriedConfig: Config | null = null;

function onLoad(ev: LoadEvent): void {
  ui.load = ev;
  if (ev.state === 'loading') {
    ui.modelsError = '';
    carriedConfig = ui.config ?? carriedConfig;
  } else if (ev.state === 'ready') {
    ui.modelsError = '';
    const c = carriedConfig;
    carriedConfig = null;
    if (c) {
      const change: ConfigChange = { gates: c.gates, seed: c.seed, max_tokens: c.max_tokens };
      if (ev.b) Object.assign(change, { mode: c.mode, driver: c.driver }); // two models only
      sendConfig(change);
    }
    const a = ev.a ?? ui.models?.loaded.a ?? null;
    if (a) ui.recents = pushRecent({ a, b: ev.b ?? null });
    // On to the prompt.
    ui.modelsOpen = false;
    ui.promptOpen = true;
  } else {
    ui.modelsError = ev.msg ? `Load failed: ${ev.msg}` : 'Load failed';
    openModels();
  }
}

function onDownload(ev: DownloadEvent): void {
  ui.downloads = applyDownload(ui.downloads, ev);
  if (ev.state === 'error') toast('error', `Download of ${ev.file} failed${ev.msg ? `: ${ev.msg}` : ''}`);
  const p = ui.pending;
  if (p && pendingBrokenBy(p, ev)) {
    ui.pending = null;
    ui.modelsError = `${ev.file}: download ${ev.state === 'error' ? 'failed' : 'cancelled'}. Nothing was loaded.`;
  }
}

// The engine refused a `load` or a `download`: a pending load waiting for
// it would wait forever.
function onModelsRefused(cmd: 'load' | 'download', msg: string): void {
  if (cmd === 'download' && ui.pending) {
    ui.pending = null;
    ui.modelsError = `Download refused: ${msg}. Nothing was loaded.`;
  } else if (cmd === 'load') {
    ui.modelsError = `Load refused: ${msg}`;
  }
}

function advancePending(ev: ModelsEvent): void {
  const p = ui.pending;
  if (!p) return;
  const step = pendingStep(p, ev);
  if (step.kind === 'wait') return;
  ui.pending = null;
  if (step.kind === 'fail') ui.modelsError = step.msg;
  else loadModels(step.a, step.b);
}

export function openModels(): void {
  if (ui.mode !== 'live') return;
  ui.modelsOpen = true;
  ui.gatesOpen = false; // both slide in from the right
}

export function toggleModels(): void {
  if (ui.modelsOpen) ui.modelsOpen = false;
  else openModels();
}

// Re-reads the engine's folder; answered with a `models` event.
export function requestCatalog(): void {
  send({ cmd: 'models' });
}

export function loadModels(a: string, b: string | null): void {
  ui.modelsError = '';
  ui.pick = { a, b };
  send({ cmd: 'load', a, b });
}

export function download(repo: string, path: string): void {
  if (ui.downloads.some((d) => sameDownload(d, { repo, path }))) return;
  send({ cmd: 'download', repo, path });
}

export function cancelDownload(repo: string, path: string): void {
  send({ cmd: 'cancel_download', repo, path });
}

export function deleteModel(file: string): void {
  send({ cmd: 'delete', file });
}

// Forgets a pending "download, then load" (its downloads go on).
export function dropPending(): void {
  ui.pending = null;
}

// Loads `a` (and `b`) from `repo`, downloading first the files that are not
// in the folder; the load happens once both are there and their tokenizer
// fingerprints match. Paths are paths in the repo.
export function fetchAndLoad(repo: string, aPath: string, bPath: string | null): void {
  const m = ui.models;
  if (!m || !ui.connected) {
    toast('error', 'Not connected to the engine.');
    return;
  }
  const pending: PendingLoad = { a: basename(aPath), b: bPath ? basename(bPath) : null, sources: [] };
  for (const path of bPath ? [aPath, bPath] : [aPath]) {
    if (!findFile(m.files, basename(path))) pending.sources.push({ repo, path });
  }
  if (pending.sources.length > 0 && !m.download) {
    ui.modelsError = 'This engine was built without downloads.';
    return;
  }
  ui.modelsError = '';
  ui.pick = { a: pending.a, b: pending.b };
  ui.pending = pending;
  for (const s of pending.sources) download(s.repo, s.path);
  advancePending(m);
}

export function send(cmd: Command): boolean {
  if (live?.send(cmd)) return true;
  toast('error', 'Not connected to the engine.');
  return false;
}

export function startPrompt(): void {
  const d = ui.draft;
  if (!d.prompt.trim()) return;
  const max = d.maxTokens > 0 ? d.maxTokens : (ui.config?.max_tokens ?? 256);
  // `start` begins from the engine's defaults plus what it carries: send the
  // current chain, seed and mode, or the Samplers panel would be reset.
  const c = ui.config;
  const config: ConfigChange = c
    ? { max_tokens: max, gates: c.gates, seed: c.seed, mode: c.mode, driver: c.driver }
    : { max_tokens: max };
  const cmd: StartCommand = { cmd: 'start', prompt: d.prompt, format: d.format, config };
  if (d.format === 'chat' && d.system.trim()) cmd.system = d.system;
  if (send(cmd) && send({ cmd: 'run' })) ui.promptOpen = false;
}

// ----------------------------------------------------------- transport

// Generate or pause (live); play or pause (replay).
export function togglePlay(): void {
  if (player) {
    if (player.playing) player.pause();
    else player.play();
    syncReplay();
    return;
  }
  if (noModel()) {
    openModels();
    return;
  }
  const state = ui.status?.state ?? 'idle';
  if (state === 'idle') ui.promptOpen = true;
  else send({ cmd: state === 'running' ? 'pause' : 'run' });
}

// One token (live); the next frame group (replay).
export function stepOnce(): void {
  if (player) {
    player.stepForward();
    syncReplay();
  } else {
    send({ cmd: 'step' });
  }
}

export function seek(ms: number): void {
  player?.seek(ms);
  syncReplay();
}

export function setRate(rate: number): void {
  if (player) player.speed = rate;
  ui.rate = rate;
}

function syncReplay(): void {
  if (!player) return;
  ui.time = player.time;
  ui.duration = player.duration;
  ui.playing = player.playing;
}

// ---------------------------------------------------- configuration

// Changes gates, seed or max_tokens. A recorded session takes no commands.
// The engine answers with a CONFIG frame, or with an `error` event (shown as
// a notice) and nothing changes. Returns false if the command was not sent.
export function sendConfig(change: ConfigChange): boolean {
  if (player !== null || live === null) return false;
  return send({ cmd: 'config', config: change });
}

// ------------------------------------------------------- two models

// Mode and driver only reach a live engine with two models.
function canConfigure(): boolean {
  return player === null && live !== null && store.twoModels;
}

// Puts a model in front. Local: works the same live and in replay.
export function setFront(slot: Slot): void {
  store.setFront(slot);
}

export function toggleFront(): void {
  if (store.twoModels) store.setFront(store.other);
}

export function setMode(mode: Mode): void {
  if (canConfigure()) send({ cmd: 'config', config: { mode } });
}

export function toggleMode(): void {
  setMode(store.config?.mode === 'free' ? 'lockstep' : 'free');
}

export function setDriver(driver: Driver): void {
  if (canConfigure()) send({ cmd: 'config', config: { driver } });
}

// ------------------------------------------------------------ branches

// Commands that move the engine: live and connected only.
function canCommand(): boolean {
  return player === null && live !== null && ui.connected;
}

// The cursors a branch or goto moves: both in lockstep (or with a single
// model), the model in front's in free mode.
function slots(): Slots {
  if (!store.twoModels || store.config?.mode !== 'free') return 'AB';
  return store.front === 1 ? 'B' : 'A';
}

// Branches under `node` (the parent) with `token`, and follows the cursor
// again once the engine has moved it there.
export function branchTo(node: number, token: number): void {
  if (!canCommand() || node === NONE) return;
  if (send({ cmd: 'branch', node, token, slots: slots() })) store.setFollow(true);
}

// The engine goes on from the tip of the viewed path ("Resume here").
export function resumeHere(): void {
  if (!canCommand() || store.follow || store.path.length === 0) return;
  // Already at the cursor: nothing to move, only follow it again.
  if (store.viewEndsAtCursor()) {
    store.setFollow();
    return;
  }
  const tip = store.path[store.path.length - 1];
  if (send({ cmd: 'goto', node: tip, slots: slots() })) store.setFollow(true);
}

// The viewed path follows the cursor again. Local: works in replay too.
export function follow(): void {
  store.setFollow();
}

// B's pick at the selected disagreement becomes a branch (key B).
function branchToB(): void {
  if (!canCommand() || !store.twoModels) return;
  const sel = view.selected();
  if (!store.disagrees(sel)) return;
  const d = store.decisionOf(sel, 1);
  if (d && d.pick < d.tokens.length) branchTo(store.decisionNode(sel), d.tokens[d.pick]);
}

// Pins the selection on the first disagreement of the viewed path and
// scrolls it into view.
export function selectFirstDisagreement(): void {
  const i = store.firstDisagreement();
  if (i < 0) return;
  view.pin(i);
  stream?.reveal(i);
}

// ------------------------------------------------------------- relief

// What the bottom dock shows. The views stay mounted; the one coming into
// sight is repainted, since it may have missed changes while hidden. Layers
// only with the logit lens.
export function setDockTab(tab: DockTab): void {
  if (tab === 'layers' && !ui.lens) tab = 'timeline';
  if (ui.dockTab !== tab) {
    ui.dockTab = tab;
    writePref('dockTab', tab);
  }
  if (tab === 'relief') store.dirty.relief = true;
  else if (tab === 'layers') store.dirty.lens = true;
  else store.dirty.timeline = true;
}

// What the Inspector shows over the gate strip. Compare only with two models.
export function setInspectorTab(tab: InspectorTab): void {
  ui.inspectorTab = tab === 'compare' && store.twoModels ? 'compare' : 'candidates';
  store.dirty.candidates = true;
  store.dirty.compare = true;
}

// The relief camera back to its starting framing.
export function resetReliefView(): void {
  relief?.resetView();
}

// Each button press moves the view by this factor.
const ZOOM_STEP = 1.5;

// Relief: the camera closer (dir 1) or farther (-1).
export function zoomRelief(dir: 1 | -1): void {
  relief?.zoomBy(dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
}

// Ticks, ruler, info card and legend over the Relief, on or off.
export function toggleReliefInfo(): void {
  ui.reliefInfo = !ui.reliefInfo;
  writePref('reliefInfo', ui.reliefInfo ? null : '0');
  relief?.setInfo(ui.reliefInfo);
}

function exportFailed(what: string, e: unknown): void {
  toast('error', `${what} export failed: ${e instanceof Error ? e.message : String(e)}`);
}

// Saves what the Relief shows: vector (SVG) or picture (PNG).
export async function exportRelief(kind: 'svg' | 'png'): Promise<void> {
  try {
    if (!relief) throw new Error('the 3D view is not available');
    await relief.save(kind);
  } catch (e) {
    exportFailed('Relief', e);
  }
}

// Timeline: the position axis closer (dir 1), farther (-1), or all of it (0).
export function zoomTimeline(dir: 1 | -1 | 0): void {
  if (dir === 0) timelinePanel?.zoomFit();
  else timelinePanel?.zoomBy(dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
}

// Saves the Timeline as it is on screen (the zoomed window).
export async function exportTimeline(kind: 'svg' | 'png'): Promise<void> {
  try {
    if (!timelinePanel) throw new Error('the timeline is not available');
    const name = `inside-llm-timeline-${stamp()}`;
    if (kind === 'svg') downloadText(timelinePanel.exportSvg(), `${name}.svg`);
    else downloadBlob(await timelinePanel.exportPng(), `${name}.png`);
  } catch (e) {
    exportFailed('Timeline', e);
  }
}

// Alternatives or Layers; Layers only with the logit lens.
export function setReliefSource(source: ReliefSource): void {
  ui.reliefSource = source === 'layers' && ui.lens ? 'layers' : 'alternatives';
  store.dirty.relief = true;
}

// The Relief section in and out of full screen (key F, button ⤢). Its
// canvas follows the new size through its ResizeObserver. From the Timeline
// tab it switches to the Relief first, so the section is visible.
export function toggleReliefFullscreen(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {});
  } else if (reliefBox?.requestFullscreen) {
    if (ui.dockTab !== 'relief') {
      setDockTab('relief');
      flushSync(); // the section visible before it goes full screen
    }
    reliefBox.requestFullscreen().catch((e: unknown) => console.warn('Relief: full screen refused.', e));
  }
}

// Mean decode_ms of one model over the EVALs so far; 0 without any.
function meanDecodeMs(slot: Slot): number {
  let sum = 0;
  let n = 0;
  for (const e of store.evals[slot]) {
    if (e) {
      sum += e.decodeMs;
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

// How unsure a model has been lately, 0..1, for the ambient halos: the mean
// entropy of its last decisions on the viewed path, in steps of 0.05 (5 bits
// and above count as 1). 0 without any decision.
const AMBIENT_SPAN = 12;
const AMBIENT_BITS = 5;

function uncertainty(slot: Slot): number {
  let sum = 0;
  let n = 0;
  for (let i = store.path.length - 1; i >= 0 && n < AMBIENT_SPAN; i--) {
    const d = store.decisionOf(i, slot);
    if (d) {
      sum += d.entropy;
      n++;
    }
  }
  if (n === 0) return 0;
  return Math.round(Math.min(1, sum / n / AMBIENT_BITS) * 20) / 20;
}

// ---------------------------------------------------------------- keys

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  return t instanceof HTMLInputElement && !['range', 'checkbox', 'radio', 'button'].includes(t.type);
}

function isButtonLike(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && t.getAttribute('role') === 'button';
}

// Escape closes the topmost overlay first: help, models, samplers, composer
// (only once there is a session to go back to). Returns true if one was
// closed.
function closeOverlay(): boolean {
  if (ui.helpOpen) ui.helpOpen = false;
  else if (ui.modelsOpen) ui.modelsOpen = false;
  else if (ui.gatesOpen) ui.gatesOpen = false;
  else if (ui.promptOpen && hasSession()) ui.promptOpen = false;
  else return false;
  return true;
}

// A prompt has been started: there is something behind the composer.
export function hasSession(): boolean {
  return ui.mode === 'live' && (ui.status?.state ?? 'idle') !== 'idle';
}

function onKey(e: KeyboardEvent): void {
  if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    e.preventDefault();
    ui.helpOpen = !ui.helpOpen;
    return;
  }
  if (e.key === 'Escape' && closeOverlay()) {
    e.preventDefault();
    return;
  }
  // The help modal takes no other shortcuts.
  if (ui.helpOpen) return;
  const control = e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement;
  const pinned = view.pinnedIndex();

  switch (e.key) {
    case ' ':
      e.preventDefault();
      // A focused control would also act on the key: let go of it.
      if (control) (e.target as HTMLElement).blur();
      togglePlay();
      break;
    case 'ArrowRight':
    case 'ArrowLeft': {
      if (e.target instanceof HTMLInputElement) return; // a slider uses its arrows
      e.preventDefault();
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      if (pinned !== null) {
        view.move(delta);
        const i = view.pinnedIndex();
        if (i !== null) stream?.reveal(i);
      } else if (delta > 0) {
        const paused = player ? !player.playing : ui.status?.state === 'paused';
        if (paused) stepOnce();
      }
      break;
    }
    case 'Escape':
      view.unpin();
      follow();
      break;
    case 'Enter':
      // A focused button or link acts on Enter by itself.
      if (control || e.target instanceof HTMLAnchorElement || isButtonLike(e.target)) return;
      if (store.follow) return;
      e.preventDefault();
      resumeHere();
      break;
    case 'b':
    case 'B':
      branchToB();
      break;
    case 'Tab':
      // With a single model Tab keeps moving the focus, as usual.
      if (!store.twoModels) return;
      e.preventDefault();
      toggleFront();
      break;
    case 'm':
    case 'M':
      toggleMode();
      break;
    case 'f':
    case 'F':
      toggleReliefFullscreen();
      break;
    case 'l':
    case 'L':
      // Like the bar's Models button: no opening while the connection is lost.
      if (ui.modelsOpen || ui.connected || !ui.everConnected) toggleModels();
      break;
  }
}

// Downloads the whole session as JSON: every frame decoded plus what the
// panels derive from them (see source/export-json.ts). Live, the engine's
// log is fetched; in a replay, the frames already loaded are used.
export async function exportJson(): Promise<void> {
  try {
    const frames = replayFrames ?? (await fetchLiveSession());
    const blob = new Blob([sessionJsonText(frames)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'session.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (e) {
    toast('error', `JSON export failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function fetchLiveSession(): Promise<Frame[]> {
  const res = await fetch('api/session.ils', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return decodeSession(new Uint8Array(await res.arrayBuffer()));
}
