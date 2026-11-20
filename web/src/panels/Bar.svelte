<script lang="ts">
  // Top bar in three zones, each a group on a slightly raised ground:
  //   Models    logo and state, the model chips, start-up warnings
  //   Playback  mode and driver, Run / Play, Step, scrubber, speed, t/s,
  //             New prompt, Follow / Resume here (while the viewed path is
  //             chosen by hand)
  //   Settings  (right) the Models and Samplers panels, the session
  //             download and help
  // Under it, live only, a strip while the connection to the engine is lost;
  // the engine controls are disabled and dimmed meanwhile.
  import {
    exportJson,
    follow,
    noModel,
    openModels,
    resumeHere,
    seek,
    send,
    setDriver,
    setFront,
    setMode,
    setRate,
    stepOnce,
    toggleModels,
    togglePlay,
  } from '../app';
  import { bytes, clock, count } from '../format';
  import { STATIC } from '../gallery';
  import { ui } from '../ui.svelte';
  import Icon from './Icon.svelte';

  const ENGINE_SPEEDS = [0, 1, 2, 5, 10, 20, 50];
  const RATES = [0.25, 0.5, 1, 2, 4, 8];
  const DRIVERS = ['A', 'B'] as const;

  const TIP_LOCKSTEP =
    "Both models read the same text; the driver's pick is written, the other's pick is shown alongside. (M)";
  const TIP_FREE = 'Each model follows its own picks; the texts part at the first disagreement. (M)';

  const models = $derived(ui.hello?.models ?? []);
  const two = $derived(models.length > 1);
  const live = $derived(ui.mode === 'live');
  const mode = $derived(ui.config?.mode ?? 'lockstep');
  const driver = $derived(ui.config?.driver ?? 'A');
  // A recorded session takes no commands: its controls show, disabled.
  const canConfigure = $derived(live && ui.connected);
  const warnings = $derived(ui.hello?.warnings ?? []);

  function slotOf(s: 'A' | 'B'): 0 | 1 {
    return s === 'B' ? 1 : 0;
  }

  // A model chip: the one behind comes to the front; the one in front (or
  // the only one) opens the Models panel, live.
  function onModel(slot: 0 | 1): void {
    if (two && ui.front !== slot) setFront(slot);
    else if (live && !lost) openModels();
  }

  // Enter and Space act on the model chip as on a button. Space must not
  // also reach the window's Space (generate / pause).
  function onModelKey(e: KeyboardEvent, slot: 0 | 1): void {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    onModel(slot);
  }
  const loadingModels = $derived(live && ui.connected && ((ui.models?.loading ?? false) || ui.load?.state === 'loading'));
  const engineState = $derived(ui.status?.state ?? 'idle');
  const tpsLimit = $derived(ui.status?.tps_limit ?? 0);
  const speeds = $derived(
    ENGINE_SPEEDS.includes(tpsLimit) ? ENGINE_SPEEDS : [...ENGINE_SPEEDS, tpsLimit].sort((a, b) => a - b),
  );
  const canDrive = $derived(ui.connected && engineState !== 'idle');
  const running = $derived(live ? engineState === 'running' : ui.playing);
  const lost = $derived(live && ui.everConnected && !ui.connected);
  // The model chip that opens the Models panel: not while the engine is away.
  const opensModels = (slot: 0 | 1): boolean => live && (!two || ui.front === slot);
  // How far the replay is, for the filled part of the scrubber track.
  const progress = $derived(ui.duration > 0 ? Math.min(100, Math.max(0, (ui.time / ui.duration) * 100)) : 0);
</script>

<header class="bar" class:running class:lost>
  <div class="zone z-models" role="group" aria-label="Models">
    <div class="group brand">
      <span class="mark"><Icon name="logo" size={20} /></span>
      <span class="logo">
        <span class="wordmark">inside-llm</span>
        {#if live}
          <span class="pill state {engineState}"><span class="led"></span>{engineState}</span>
        {:else}
          <span
            class="pill state tag"
            class:running
            data-tip="Replaying a recorded file: commands to the engine are off"
            data-tip-start><span class="led"></span>Recorded session</span
          >
        {/if}
      </span>
      {#if STATIC}
        <a class="button ghost back-link" href="./" data-tip="Back to the recorded sessions" data-tip-start>
          <Icon name="arrowLeft" size={14} />Sessions
        </a>
      {/if}
    </div>

    <div class="group models">
      {#each models as model (model.slot)}
        {@const slot = slotOf(model.slot)}
        {@const ms = ui.msPerToken[slot]}
        <span
          class="model"
          class:b={slot === 1}
          class:solo={!two}
          class:front={two && ui.front === slot}
          class:back={two && ui.front !== slot}
          class:opens={opensModels(slot) && !lost}
          class:gated={opensModels(slot) && lost}
          tabindex="0"
          role="button"
          aria-pressed={two ? ui.front === slot : undefined}
          aria-disabled={opensModels(slot) && lost ? true : undefined}
          aria-label="Model {model.slot}: {model.name} {model.quant}"
          onclick={() => onModel(slot)}
          onkeydown={(e) => onModelKey(e, slot)}
        >
          <span class="slot">{model.slot}</span>
          <span class="ident">
            <span class="name">{model.name}</span>
            <span class="meta">
              <span class="quant">{model.quant}</span>
              <span class="ms">{ms > 0 ? `${ms.toFixed(1)} ms/tok` : ''}</span>
            </span>
          </span>
          <span class="card glass">
            <span class="card-title"><span class="card-dot"></span>Model {model.slot}</span>
            <span>file</span><b>{model.file}</b>
            <span>arch</span><b>{model.arch}</b>
            <span>params</span><b>{count(model.n_params)}</b>
            <span>size</span><b>{bytes(model.size_bytes)}</b>
            <span>layers</span><b>{model.n_layer}</b>
            <span>dim</span><b>{model.n_embd}</b>
            <span>context</span><b>{model.n_ctx}</b>
            <span>ms/token</span><b>{ms > 0 ? ms.toFixed(1) : '–'}</b>
            {#if two && ui.front !== slot}
              <span class="hint">Click or Tab: put in front</span>
            {:else if live && lost}
              <span class="hint">{two ? 'In front: its data leads the panels. ' : ''}Models: back with the engine</span>
            {:else if live}
              <span class="hint">{two ? 'In front: its data leads the panels. ' : ''}Click: change models (L)</span>
            {:else if two}
              <span class="hint">In front: its data leads the panels</span>
            {/if}
          </span>
        </span>
      {:else}
        {#if live && loadingModels}
          <span class="pill waiting"><span class="led"></span>Loading models…</span>
        {:else if live && ui.connected && noModel()}
          <button class="pill choose" onclick={openModels} data-tip="Choose, download and load models (L)" data-tip-start
            ><Icon name="chip" size={15} />No model loaded — choose one</button
          >
        {:else if live}
          <span class="pill waiting"><span class="led"></span>{ui.connected ? 'Waiting for the engine…' : 'Connecting…'}</span>
        {/if}
      {/each}

      {#each warnings as w (w)}
        <span class="pill warn" data-tip={w}><Icon name="warning" size={14} /><span class="warn-text">{w}</span></span>
      {/each}
    </div>
  </div>

  <div class="zone z-play" class:replay={!live} role="group" aria-label="Playback">
    {#if two}
      <div class="group mode">
        <span class="seg" role="group" aria-label="Mode">
          <button
            class:on={mode === 'lockstep'}
            disabled={!canConfigure}
            onclick={() => setMode('lockstep')}
            data-tip={TIP_LOCKSTEP}>Same text</button
          >
          <button class:on={mode === 'free'} disabled={!canConfigure} onclick={() => setMode('free')} data-tip={TIP_FREE}
            >Each its own</button
          >
        </span>
        {#if mode === 'lockstep'}
          <span class="driven" role="group" aria-label="Driver">
            <span class="label">driven by</span>
            <span class="seg">
              {#each DRIVERS as d (d)}
                <button
                  class="driver"
                  class:b={d === 'B'}
                  class:on={driver === d}
                  disabled={!canConfigure}
                  onclick={() => setDriver(d)}
                  data-tip="Model {d}'s pick is written">{d}</button
                >
              {/each}
            </span>
          </span>
        {/if}
      </div>
    {/if}

    <div class="group transport" class:replay={!live}>
      {#if live}
        <button
          class="primary run"
          onclick={togglePlay}
          disabled={!canDrive}
          data-tip={running ? 'Pause (Space)' : 'Generate (Space)'}
        >
          {#if running}<Icon name="pause" size={15} />Pause{:else}<Icon name="play" size={14} filled />Run{/if}
        </button>
        <button class="ghost step" onclick={stepOnce} disabled={!canDrive || running} data-tip="One token (→)">
          <Icon name="step" size={14} />Step
        </button>
        <label class="field" data-tip="Tokens per second at most">
          <select
            value={tpsLimit}
            disabled={!ui.connected}
            aria-label="Speed limit"
            onchange={(e) => send({ cmd: 'speed', tps: Number(e.currentTarget.value) })}
          >
            {#each speeds as s (s)}
              <option value={s}>{s === 0 ? 'max speed' : `${s} t/s`}</option>
            {/each}
          </select>
        </label>
        <span class="figure" data-tip="Actual speed">{(ui.status?.tps ?? 0).toFixed(1)} <small>t/s</small></span>
        <button
          class="ghost"
          onclick={() => (ui.promptOpen = true)}
          disabled={!ui.connected || noModel()}
          data-tip="Write a new prompt"
        >
          <Icon name="edit" size={14} />New prompt
        </button>
      {:else}
        <button class="primary run" onclick={togglePlay} disabled={ui.duration === 0} data-tip="Play / pause (Space)">
          {#if running}<Icon name="pause" size={15} />Pause{:else}<Icon name="play" size={14} filled />Play{/if}
        </button>
        <button class="ghost step" onclick={stepOnce} disabled={ui.duration === 0} data-tip="Next step (→)">
          <Icon name="step" size={14} />Step
        </button>
        <input
          class="scrub"
          type="range"
          min="0"
          max={ui.duration}
          step="1"
          value={ui.time}
          style:--p="{progress}%"
          oninput={(e) => seek(Number(e.currentTarget.value))}
          aria-label="Session time"
        />
        <span class="figure clock">{clock(ui.time)}<span class="of">/</span>{clock(ui.duration)}</span>
        <select class="rate" value={ui.rate} aria-label="Playback rate" onchange={(e) => setRate(Number(e.currentTarget.value))}>
          {#each RATES as r (r)}
            <option value={r}>{r}×</option>
          {/each}
        </select>
      {/if}
    </div>

    {#if !ui.following}
      <div class="group viewing">
        <span class="pill away" role="group" aria-label="Viewed path">
          <Icon name="branch" size={14} />
          <span class="away-text">Viewing another branch</span>
          <button class="ghost" onclick={follow} data-tip="Back to where the model is writing (Esc)">Follow</button>
          <button
            class="ghost"
            onclick={resumeHere}
            disabled={!canConfigure}
            data-tip={live ? 'Generate from the end of this path (Enter)' : 'Recorded session'}>Resume here</button
          >
        </span>
      </div>
    {/if}
  </div>

  <span class="break"></span>

  <div class="zone z-settings" role="group" aria-label="Settings">
    {#if live}
      <button
        class="ghost tool"
        class:on={ui.modelsOpen}
        aria-expanded={ui.modelsOpen}
        disabled={lost}
        onclick={toggleModels}
        data-tip="Choose, download and load models (L)"
        data-tip-end><Icon name="chip" size={16} />Models</button
      >
    {/if}
    <button
      class="ghost tool"
      class:on={ui.gatesOpen}
      aria-expanded={ui.gatesOpen}
      disabled={lost}
      onclick={() => {
        ui.gatesOpen = !ui.gatesOpen;
        if (ui.gatesOpen) ui.modelsOpen = false;
      }}
      data-tip="The gate chain applied to each decision"
      data-tip-end><Icon name="sliders" size={16} />Samplers</button
    >
    {#if live && lost}
      <!-- A link cannot be disabled: a disabled button stands in for it. -->
      <button class="ghost tool" disabled data-tip="Download this session" data-tip-end
        ><Icon name="download" size={16} />Session</button
      >
    {:else if live}
      <a class="button ghost tool" href="api/session.ils" download="session.ils" data-tip="Download this session" data-tip-end
        ><Icon name="download" size={16} />Session</a
      >
    {/if}
    {#if !live || !lost}
      <button class="ghost tool" onclick={exportJson} data-tip="Download this session as JSON, with the metrics and the 3D relief data" data-tip-end
        ><Icon name="download" size={16} />JSON</button
      >
    {/if}
    <button
      class="ghost tool icon-only help"
      class:on={ui.helpOpen}
      onclick={() => (ui.helpOpen = !ui.helpOpen)}
      aria-label="Help"
      data-tip="Help, legend and keys (?)"
      data-tip-end><Icon name="help" size={17} /></button
    >
  </div>
</header>

{#if live}
  <!-- Always there while live, so that screen readers hear it change. -->
  <div class="conn" role="status" aria-live="polite">
    {#if lost}
      <div class="conn-strip">
        <span class="led"></span>Connection lost — reconnecting. Engine controls are paused.
      </div>
    {/if}
  </div>
{/if}

<style>
  .bar {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-height: 60px;
    padding: 7px var(--gutter);
    background:
      linear-gradient(90deg, rgba(var(--front-rgb), 0.05), transparent 30%),
      linear-gradient(180deg, rgba(var(--surface-rgb), 0.78), rgba(var(--bg-rgb), 0.45));
    box-shadow:
      inset 0 -1px 0 rgba(0, 0, 0, 0.35),
      0 8px 24px rgba(0, 0, 0, 0.25);
    font-size: var(--fs-label);
    /* Tabular figures by font-variant only: the global 'tnum' feature also
       widens hyphens in names. */
    font-feature-settings: 'cv11';
    font-variant-numeric: tabular-nums;
  }
  /* While generating: a thin moving line along the bottom edge. */
  .bar::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 2px;
    opacity: 0;
    background: linear-gradient(90deg, transparent 0%, var(--front) 50%, transparent 100%) 0 0 / 40% 100% no-repeat;
    filter: drop-shadow(0 0 4px rgba(var(--front-rgb), 0.9));
    transition: opacity 200ms var(--ease);
    pointer-events: none;
  }
  .bar.running::after {
    opacity: 0.85;
    animation: sweep 1.6s linear infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .bar.running::after {
      background: var(--front);
      opacity: 0.4;
    }
  }
  @keyframes sweep {
    from {
      background-position: -60% 0;
    }
    to {
      background-position: 160% 0;
    }
  }
  .group {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  /* The three zones: groups on a slightly raised ground, no borders. */
  .zone {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 14px;
    min-height: 46px;
    padding: 2px 10px;
    border-radius: var(--radius);
    background: rgba(var(--surface-2-rgb), 0.55);
  }
  .z-models {
    gap: 6px 12px;
    padding-left: 7px;
  }
  /* Right-aligned on whichever line it lands. */
  .z-settings {
    margin-left: auto;
    gap: 2px;
    padding: 2px 6px;
  }
  /* A replay: the playback zone takes the free room, for a longer scrubber. */
  .z-play.replay {
    flex: 1 1 auto;
  }
  /* Secondary controls: no box until hovered, quieter text. */
  button.ghost,
  .button.ghost {
    font-weight: 400;
  }
  /* While the connection is lost the engine controls are off: dimmed alike. */
  .bar.lost button:disabled,
  .bar.lost select:disabled,
  .bar.lost .seg:has(button:disabled),
  .bar.lost .figure,
  .bar.lost .driven .label {
    opacity: 0.4;
  }
  .bar.lost .seg button:disabled {
    opacity: 1;
  }
  .model.gated {
    cursor: default;
  }
  .model.gated > :not(.card) {
    opacity: 0.4;
  }
  /* A line break, used only when the bar wraps (see the media query). */
  .break {
    display: none;
  }

  /* ------------------------------------------------------------ brand */

  .brand {
    gap: 10px;
  }
  /* The name over a small status pill: the engine's state, or the replay. */
  .logo {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    padding-right: 2px;
    white-space: nowrap;
  }
  .logo .pill {
    gap: 6px;
    min-height: 18px;
    padding: 0 8px 0 6px;
    font-size: var(--fs-small);
    line-height: 16px;
  }
  .logo .led {
    width: 6px;
    height: 6px;
  }
  .mark {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border: 1px solid rgba(var(--front-rgb), 0.35);
    border-radius: 10px;
    background: radial-gradient(circle at 50% 30%, rgba(var(--front-rgb), 0.28), rgba(var(--front-rgb), 0.06) 70%);
    color: var(--front);
    box-shadow:
      var(--edge),
      0 0 18px -4px rgba(var(--front-rgb), 0.75);
    transition:
      color 240ms var(--ease),
      border-color 240ms var(--ease),
      box-shadow 240ms var(--ease);
  }
  .mark :global(svg) {
    filter: drop-shadow(0 0 4px rgba(var(--front-rgb), 0.8));
  }
  .wordmark {
    font-feature-settings: 'cv11';
    font-variant-numeric: normal;
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--high);
  }
  .back-link {
    min-height: 28px;
    padding: 2px 10px 2px 7px;
    gap: 5px;
    font-size: var(--fs-label);
  }

  /* ---------------------------------------------------------- models */

  .model {
    --c: var(--a); /* the model's own colour */
    --c-rgb: var(--a-rgb);
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 9px;
    height: 42px;
    padding: 0 14px 0 7px;
    border: 1px solid var(--hairline);
    border-radius: 11px;
    background: linear-gradient(180deg, rgba(var(--surface-2-rgb), 0.85), rgba(var(--surface-rgb), 0.85));
    box-shadow: var(--edge);
    cursor: default;
    outline: none;
    white-space: nowrap;
    transition:
      border-color 180ms var(--ease),
      background-color 180ms var(--ease),
      box-shadow 180ms var(--ease),
      transform 140ms var(--ease);
  }
  .model.b {
    --c: var(--b);
    --c-rgb: var(--b-rgb);
  }
  .model.front,
  .model.back,
  .model.opens {
    cursor: pointer;
  }
  .model.back:active {
    transform: translateY(1px) scale(0.985);
  }
  .model:focus-visible {
    outline: 2px solid rgba(var(--high-rgb), 0.6);
    outline-offset: 2px;
  }
  .slot {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border: 1px solid rgba(var(--c-rgb), 0.4);
    border-radius: 8px;
    background: rgba(var(--c-rgb), 0.14);
    color: var(--c);
    font-size: var(--fs-body);
    font-weight: 600;
    transition:
      background-color 180ms var(--ease),
      color 180ms var(--ease),
      box-shadow 180ms var(--ease);
  }
  .ident {
    display: flex;
    flex-direction: column;
    gap: 1px;
    line-height: 1.2;
  }
  .name {
    color: var(--high);
    font-variant-numeric: normal;
    font-size: var(--fs-body);
    font-weight: 600;
    letter-spacing: -0.005em;
  }
  .meta {
    display: flex;
    align-items: baseline;
    gap: 7px;
    color: var(--muted);
    font-size: var(--fs-small);
  }
  .quant {
    color: rgba(var(--c-rgb), 0.9);
    font-weight: 500;
  }
  .ms {
    color: var(--low);
  }
  .ms:empty {
    display: none;
  }
  /* One model, or the one in front: lit in its colour. */
  .model.solo,
  .model.front {
    border-color: rgba(var(--c-rgb), 0.5);
    background:
      linear-gradient(180deg, rgba(var(--c-rgb), 0.16), rgba(var(--c-rgb), 0.04)),
      rgba(var(--surface-rgb), 0.9);
    box-shadow:
      var(--edge),
      0 0 0 1px rgba(var(--c-rgb), 0.12),
      0 0 26px -6px rgba(var(--c-rgb), 0.65);
  }
  .model.front .slot,
  .model.solo .slot {
    border-color: var(--c);
    background: var(--c);
    color: var(--bg);
    box-shadow: 0 0 12px rgba(var(--c-rgb), 0.7);
  }
  /* The other one: dimmed, lights up a little when hovered. */
  .model.back > :not(.card) {
    opacity: 0.5;
    transition: opacity 180ms var(--ease);
  }
  .model.back:hover > :not(.card) {
    opacity: 0.9;
  }
  .model.back:hover {
    border-color: rgba(var(--c-rgb), 0.4);
    box-shadow:
      var(--edge),
      0 0 18px -8px rgba(var(--c-rgb), 0.6);
  }
  .card {
    position: absolute;
    top: calc(100% + 10px);
    left: 0;
    z-index: 50;
    display: grid;
    grid-template-columns: auto auto;
    gap: 5px 18px;
    padding: 14px 16px;
    font-size: var(--fs-small);
    white-space: nowrap;
    cursor: default;
    opacity: 0;
    visibility: hidden;
    transform: translateY(-4px);
    transition:
      opacity 160ms var(--ease),
      transform 160ms var(--ease),
      visibility 0s linear 160ms;
  }
  .model:hover .card,
  .model:focus-visible .card {
    opacity: 1;
    visibility: visible;
    transform: none;
    transition-delay: 0s;
  }
  .card-title {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
    color: var(--high);
    font-weight: 600;
    font-size: var(--fs-body);
  }
  .card-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--c);
    box-shadow: 0 0 8px var(--c);
  }
  .card > span:not(.card-title) {
    color: var(--muted);
  }
  .card b {
    font-weight: 500;
    color: var(--high);
  }
  .card .hint {
    grid-column: 1 / -1;
    margin-top: 6px;
    padding-top: 8px;
    border-top: 1px solid var(--hairline);
  }

  /* ------------------------------------------------------------ pills */

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 28px;
    padding: 2px 12px 2px 10px;
    border: 1px solid var(--hairline);
    border-radius: 999px;
    background: rgba(var(--surface-rgb), 0.75);
    box-shadow: var(--edge);
    color: var(--muted);
    font-weight: 500;
    white-space: nowrap;
  }
  /* A start-up warning can be long: cut, the whole text in the tooltip. */
  .warn {
    border-color: var(--line-strong);
    background: rgba(var(--surface-3-rgb), 0.8);
    color: var(--high);
  }
  .warn-text {
    max-width: 32ch;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .state {
    text-transform: capitalize;
  }
  .tag {
    text-transform: none;
  }
  .led {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--low);
    transition:
      background-color 200ms var(--ease),
      box-shadow 200ms var(--ease);
  }
  .state.running {
    color: var(--high);
    border-color: rgba(var(--front-rgb), 0.45);
    background: linear-gradient(180deg, rgba(var(--front-rgb), 0.12), rgba(var(--front-rgb), 0.04));
  }
  .state.running .led,
  .waiting .led {
    background: var(--front);
    box-shadow: 0 0 8px var(--front);
    animation: pulse 1.2s ease-in-out infinite;
  }
  .state.paused .led {
    background: var(--high);
    box-shadow: 0 0 6px rgba(var(--high-rgb), 0.5);
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
      box-shadow: 0 0 2px var(--front);
    }
  }
  /* No model loaded: an invitation, lit in the colour in front. */
  button.choose {
    border-color: rgba(var(--front-rgb), 0.5);
    background: linear-gradient(180deg, rgba(var(--front-rgb), 0.14), rgba(var(--front-rgb), 0.04));
    color: var(--high);
    box-shadow:
      var(--edge),
      0 0 18px -6px rgba(var(--front-rgb), 0.6);
  }
  button.choose :global(svg) {
    color: var(--front);
  }
  button.choose:hover {
    border-color: var(--front);
    background: rgba(var(--front-rgb), 0.2);
  }
  /* Viewing a branch by hand: noticeable, in the colour of the model in front. */
  .away {
    gap: 6px;
    padding: 2px 3px 2px 10px;
    border-color: rgba(var(--front-rgb), 0.5);
    background: linear-gradient(180deg, rgba(var(--front-rgb), 0.16), rgba(var(--front-rgb), 0.05));
    box-shadow:
      var(--edge),
      0 0 18px -6px rgba(var(--front-rgb), 0.6);
    color: var(--high);
  }
  .away > :global(svg) {
    color: var(--front);
  }
  .away button {
    min-height: 22px;
    padding: 1px 10px;
    border-radius: 999px;
    color: var(--high);
  }
  .away-text {
    margin-right: 2px;
  }

  /* ----------------------------------------------------- mode, transport */

  .driven {
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }
  .label {
    color: var(--muted);
  }
  .seg .driver {
    min-width: 28px;
    padding: 2px 8px;
    font-weight: 600;
  }
  .seg .driver.on:not(:disabled) {
    color: var(--a);
    border-color: rgba(var(--a-rgb), 0.5);
    background: rgba(var(--a-rgb), 0.14);
    box-shadow: 0 0 12px -2px rgba(var(--a-rgb), 0.55);
  }
  .seg .driver.b.on:not(:disabled) {
    color: var(--b);
    border-color: rgba(var(--b-rgb), 0.5);
    background: rgba(var(--b-rgb), 0.14);
    box-shadow: 0 0 12px -2px rgba(var(--b-rgb), 0.55);
  }
  .seg .driver.on:disabled {
    color: var(--high);
  }
  .transport {
    gap: 6px;
  }
  .transport.replay {
    flex: 1 1 auto;
    flex-wrap: nowrap;
  }
  .run {
    min-width: 86px;
    min-height: 32px;
    gap: 7px;
  }
  .step {
    gap: 6px;
  }
  .figure {
    min-width: 6ch;
    color: var(--muted);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .figure small {
    color: var(--low);
    font-size: var(--fs-small);
  }
  .clock {
    min-width: 0;
    color: var(--high);
  }
  .of {
    margin: 0 5px;
    color: var(--low);
  }
  .field {
    display: inline-flex;
  }
  /* Speed and rate: secondary, so ghost selects (a box only on hover). */
  select {
    min-height: 30px;
    padding: 4px 6px;
    border-color: transparent;
    background-color: transparent;
    color: var(--muted);
    cursor: pointer;
    transition:
      border-color 140ms var(--ease),
      background-color 140ms var(--ease),
      color 140ms var(--ease),
      box-shadow 140ms var(--ease);
  }
  select:hover:not(:disabled) {
    border-color: var(--line-strong);
    background-color: rgba(var(--surface-3-rgb), 0.8);
    color: var(--high);
  }
  option {
    background: var(--surface-2);
    color: var(--high);
  }
  select:disabled {
    color: var(--low);
    cursor: default;
  }
  .rate {
    width: 64px;
  }

  /* The scrubber: a thin track, filled in the colour in front up to the
     playhead; the thumb has a halo that grows on hover. */
  .scrub {
    --p: 0%;
    flex: 1 1 100px;
    width: 100px;
    min-width: 100px;
    max-width: 380px;
    height: 20px;
    margin: 0 4px;
    appearance: none;
    -webkit-appearance: none;
    background: transparent;
    cursor: pointer;
  }
  .scrub:focus {
    box-shadow: none;
  }
  .scrub::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(90deg, var(--front) var(--p), rgba(var(--high-rgb), 0.14) var(--p));
    box-shadow: 0 0 10px -2px rgba(var(--front-rgb), 0.5);
  }
  .scrub::-moz-range-track {
    height: 4px;
    border-radius: 2px;
    background: rgba(var(--high-rgb), 0.14);
  }
  .scrub::-moz-range-progress {
    height: 4px;
    border-radius: 2px;
    background: var(--front);
  }
  .scrub::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    margin-top: -5px;
    border: 2px solid var(--front);
    border-radius: 50%;
    background: var(--high);
    box-shadow:
      0 0 0 4px rgba(var(--front-rgb), 0.18),
      0 0 12px rgba(var(--front-rgb), 0.7);
    transition: box-shadow 140ms var(--ease);
  }
  .scrub::-moz-range-thumb {
    width: 10px;
    height: 10px;
    border: 2px solid var(--front);
    border-radius: 50%;
    background: var(--high);
    box-shadow:
      0 0 0 4px rgba(var(--front-rgb), 0.18),
      0 0 12px rgba(var(--front-rgb), 0.7);
    transition: box-shadow 140ms var(--ease);
  }
  .scrub:hover::-webkit-slider-thumb,
  .scrub:focus-visible::-webkit-slider-thumb {
    box-shadow:
      0 0 0 7px rgba(var(--front-rgb), 0.22),
      0 0 16px rgba(var(--front-rgb), 0.85);
  }
  .scrub:hover::-moz-range-thumb,
  .scrub:focus-visible::-moz-range-thumb {
    box-shadow:
      0 0 0 7px rgba(var(--front-rgb), 0.22),
      0 0 16px rgba(var(--front-rgb), 0.85);
  }
  .scrub:focus-visible {
    outline: none;
  }

  /* -------------------------------------------------------------- right */

  .tool {
    gap: 7px;
    color: var(--muted);
  }
  a.tool {
    font-weight: 400;
  }
  .tool.on {
    border-color: rgba(var(--front-rgb), 0.45);
    background: rgba(var(--front-rgb), 0.12);
    color: var(--high);
    box-shadow: 0 0 14px -4px rgba(var(--front-rgb), 0.6);
  }
  .help {
    border-radius: 50%;
  }

  /* ------------------------------------------------------------ narrow */

  /* The bar wraps by zones: Models and Settings on the first line,
     Playback below, across the width. */
  @media (max-width: 1520px) {
    .z-models {
      order: 0;
    }
    .z-settings {
      order: 1;
    }
    .break {
      display: block;
      order: 2;
      flex-basis: 100%;
      height: 0;
    }
    .z-play {
      order: 3;
      flex: 1 1 auto;
    }
  }

  /* ------------------------------------------------------- connection */

  /* Connection lost: a neutral strip across the page, under the bar. Its
     light is the only thing that blinks. */
  .conn-strip {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 32px;
    padding: 6px var(--gutter);
    background: var(--surface-3);
    color: var(--high);
    font-size: var(--fs-label);
    font-weight: 500;
  }
  .conn-strip .led {
    background: var(--high);
    box-shadow: 0 0 8px rgba(var(--high-rgb), 0.7);
    animation: blink 1.2s ease-in-out infinite;
  }
  @keyframes blink {
    50% {
      opacity: 0.3;
      box-shadow: 0 0 2px rgba(var(--high-rgb), 0.4);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .conn-strip .led {
      animation: none;
    }
  }
</style>
