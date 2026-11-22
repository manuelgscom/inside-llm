<script lang="ts">
  // Layout: bar on top; the stage with the Stream and the Inspector
  // (Candidates or Compare over the gate strip); the strip of live figures;
  // the dock with Timeline, Layers and Relief as tabs; a thin legend at the
  // foot. Samplers and Models slide over from the right, help is a modal, the composer
  // floats over the stage. Two ambient halos lie behind it all. The panels
  // are painted by the loop, not by Svelte.
  import { onMount } from 'svelte';
  import {
    exportRelief,
    exportTimeline,
    noModel,
    resetReliefView,
    setDockTab,
    setInspectorTab,
    setReliefSource,
    start,
    toggleReliefFullscreen,
    toggleReliefInfo,
    zoomRelief,
    zoomTimeline,
  } from './app';
  import Bar from './panels/Bar.svelte';
  import Composer from './panels/Composer.svelte';
  import Debug from './panels/Debug.svelte';
  import Gates from './panels/Gates.svelte';
  import Help from './panels/Help.svelte';
  import Hints from './panels/Hints.svelte';
  import Icon from './panels/Icon.svelte';
  import Legend from './panels/Legend.svelte';
  import Models from './panels/Models.svelte';
  import Toasts from './panels/Toasts.svelte';
  import { ui, writePref } from './ui.svelte';

  const DOCK_MIN = 220;
  const DOCK_MAX_VH = 0.7;

  let streamEl: HTMLElement;
  let candidatesEl: HTMLCanvasElement;
  let gatesEl: HTMLCanvasElement;
  let fxEl: HTMLCanvasElement;
  let timelineEl: HTMLCanvasElement;
  let metricsEl: HTMLCanvasElement;
  let lensEl: HTMLCanvasElement;
  let compareEl: HTMLCanvasElement;
  let reliefEl: HTMLElement;
  let reliefCanvasEl: HTMLCanvasElement;
  let reliefLabelsEl: HTMLElement;
  let dockEl: HTMLElement;
  let barH = $state(0);

  onMount(() =>
    start({
      stream: streamEl,
      candidates: candidatesEl,
      gates: gatesEl,
      fx: fxEl,
      timeline: timelineEl,
      metrics: metricsEl,
      lens: lensEl,
      compare: compareEl,
      relief: reliefEl,
      reliefCanvas: reliefCanvasEl,
      reliefLabels: reliefLabelsEl,
    }),
  );

  const emptyText = $derived(
    ui.mode === 'replay'
      ? ui.loadError
        ? ''
        : 'Loading session…'
      : noModel()
        ? 'No model loaded. Choose one in Models (L).'
        : 'No prompt yet. Press “New prompt” to start.',
  );
  const onRelief = $derived(ui.dockTab === 'relief');
  const onLayers = $derived(ui.dockTab === 'layers');
  const onCompare = $derived(ui.inspectorTab === 'compare');
  const twoModels = $derived((ui.hello?.models.length ?? 0) > 1);

  // The ambient halos: brighter and further in as the model gets less sure.
  // -1: no such model, the halo is off.
  function halo(e: number, dir: 1 | -1): string {
    if (e < 0) return 'opacity: 0';
    const shift = 4 + e * 10;
    return `opacity: ${(0.45 + 0.55 * e).toFixed(2)}; transform: translate(${dir * shift}vmax, ${dir * shift * 0.7}vmax) scale(${(1 + e * 0.15).toFixed(2)})`;
  }
  const dockStyle = $derived(
    ui.dockH === null ? undefined : `clamp(${DOCK_MIN}px, ${Math.round(ui.dockH)}px, ${DOCK_MAX_VH * 100}vh)`,
  );

  // Dock resize: drag its top edge. The height is kept per browser.
  let drag: { y: number; h: number } | null = $state(null);

  function onHandleDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag = { y: e.clientY, h: dockEl.getBoundingClientRect().height };
  }

  function onHandleMove(e: PointerEvent): void {
    if (!drag) return;
    const max = Math.max(DOCK_MIN, window.innerHeight * DOCK_MAX_VH);
    ui.dockH = Math.min(max, Math.max(DOCK_MIN, drag.h + drag.y - e.clientY));
  }

  function onHandleUp(): void {
    if (!drag) return;
    drag = null;
    writePref('dockH', ui.dockH === null ? null : String(Math.round(ui.dockH)));
  }

  // Double click: back to the default height.
  function onHandleReset(): void {
    ui.dockH = null;
    writePref('dockH', null);
  }
</script>

{#snippet sourceToggle()}
  {#if ui.lens}
    <span
      class="seg"
      role="group"
      aria-label="Relief source"
    >
      <button
        class:on={ui.reliefSource === 'alternatives'}
        onclick={() => setReliefSource('alternatives')}
        data-tip="Height = probability of each candidate, most likely at the back">Alternatives</button
      >
      <button
        class:on={ui.reliefSource === 'layers'}
        onclick={() => setReliefSource('layers')}
        data-tip="Height = probability of the final answer at each layer (logit lens)">Layers</button
      >
    </span>
  {/if}
{/snippet}

{#snippet viewTools(kind: 'relief' | 'timeline')}
  <span class="tools-group" role="group" aria-label="Zoom">
    <button
      class="ghost icon-only"
      onclick={() => (kind === 'relief' ? zoomRelief(-1) : zoomTimeline(-1))}
      aria-label="Zoom out"
      title={kind === 'relief' ? 'Zoom out (wheel)' : 'Zoom out (wheel)'}><Icon name="zoomOut" /></button
    >
    <button
      class="ghost icon-only"
      onclick={() => (kind === 'relief' ? zoomRelief(1) : zoomTimeline(1))}
      aria-label="Zoom in"
      title={kind === 'relief' ? 'Zoom in (wheel); right-drag pans' : 'Zoom in (wheel); shift+wheel pans'}
      ><Icon name="zoomIn" /></button
    >
    {#if kind === 'timeline'}
      <button class="ghost" onclick={() => zoomTimeline(0)} title="Show the whole path">Fit</button>
    {/if}
  </span>
  <span class="tools-group" role="group" aria-label="Export">
    <button
      class="ghost"
      onclick={() => (kind === 'relief' ? exportRelief('svg') : exportTimeline('svg'))}
      title="Save as SVG (vector, as shown now)"><Icon name="download" />SVG</button
    >
    <button
      class="ghost"
      onclick={() => (kind === 'relief' ? exportRelief('png') : exportTimeline('png'))}
      title="Save as PNG (picture, at twice the size)"><Icon name="download" />PNG</button
    >
  </span>
{/snippet}

<div class="app" style:--bar-h="{barH}px" style:--dock-h={dockStyle}>
  <div class="ambient" aria-hidden="true">
    <i class="halo a" style={halo(ui.ambient[0], 1)}></i>
    <i class="halo b" style={halo(ui.ambient[1], -1)}></i>
  </div>
  <div class="bar-wrap" bind:offsetHeight={barH}>
    <Bar />
  </div>
  {#if ui.unsupported}
    <div class="banner">
      This session uses protocol version {ui.hello?.protocol}; this viewer reads version 1. Nothing is shown.
    </div>
  {/if}
  {#if ui.loadError}
    <div class="banner">Cannot load the session: {ui.loadError}</div>
  {/if}

  <main class="stage">
    <section class="stream panel" bind:this={streamEl} data-empty={emptyText}></section>
    <section class="inspector panel" aria-label="Candidates, comparison and gates">
      <div class="panel-head">
        <div class="tabs" role="tablist" aria-label="Inspector view">
          <button
            class="tab"
            class:on={!onCompare}
            role="tab"
            aria-selected={!onCompare}
            onclick={() => setInspectorTab('candidates')}
            data-tip-start
            data-tip="What the model considered for the selected token. Click an alternative to branch."
            ><Icon name="list" />Candidates</button
          >
          {#if twoModels}
            <button
              class="tab"
              class:on={onCompare}
              role="tab"
              aria-selected={onCompare}
              onclick={() => setInspectorTab('compare')}
              data-tip="The two models side by side on the selected token: where they agree and how far apart they are."
              ><Icon name="compare" />Compare</button
            >
          {/if}
        </div>
      </div>
      <div class="inspector-body">
        <div class="inspector-main">
          <div class="cand" class:hidden={onCompare} aria-hidden={onCompare}><canvas bind:this={candidatesEl}></canvas></div>
          <div class="compare" class:hidden={!onCompare} aria-hidden={!onCompare}>
            <canvas bind:this={compareEl}></canvas>
          </div>
        </div>
        <div class="gates"><canvas bind:this={gatesEl}></canvas></div>
        <canvas class="fx" class:hidden={onCompare} bind:this={fxEl}></canvas>
      </div>
    </section>
    {#if ui.mode === 'live' && ui.promptOpen && !noModel()}
      <Composer />
    {:else}
      <Hints />
    {/if}
  </main>

  <section class="metrics panel" aria-label="Live figures">
    <canvas bind:this={metricsEl}></canvas>
  </section>

  <section class="dock panel" bind:this={dockEl}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="dock-handle"
      class:dragging={drag !== null}
      title="Drag to resize · double click to reset"
      onpointerdown={onHandleDown}
      onpointermove={onHandleMove}
      onpointerup={onHandleUp}
      onpointercancel={onHandleUp}
      ondblclick={onHandleReset}
    ></div>
    <div class="panel-head">
      <div class="tabs" role="tablist" aria-label="Bottom view">
        <button
          class="tab"
          class:on={ui.dockTab === 'timeline'}
          role="tab"
          aria-selected={ui.dockTab === 'timeline'}
          onclick={() => setDockTab('timeline')}
          data-tip-start
          data-tip-up
          data-tip="Entropy and divergence per position, and the tree of branches. Hover to sweep the selection."
          ><Icon name="chart" />Timeline</button
        >
        {#if ui.lens}
          <button
            class="tab"
            class:on={onLayers}
            role="tab"
            aria-selected={onLayers}
            onclick={() => setDockTab('layers')}
            data-tip-up
            data-tip="Logit lens: how the answer takes shape layer by layer, for every position."
            ><Icon name="layers" />Layers</button
          >
        {/if}
        <button
          class="tab"
          class:on={onRelief}
          role="tab"
          aria-selected={onRelief}
          onclick={() => setDockTab('relief')}
          data-tip-up
          data-tip="The viewed path as a 3D surface. Drag to orbit, wheel to zoom, right-drag to pan. Hover to inspect, click to pin."
          ><Icon name="cube" />Relief 3D</button
        >
      </div>
      {#if onRelief}
        <div class="panel-tools">
          {@render sourceToggle()}
          <button
            class="ghost"
            class:on={ui.reliefInfo}
            aria-pressed={ui.reliefInfo}
            onclick={toggleReliefInfo}
            title="Ticks, probability ruler, info card and legend"><Icon name="info" />Info</button
          >
          {@render viewTools('relief')}
          <button class="ghost" onclick={resetReliefView} title="Camera back to the start"
            ><Icon name="reset" />Reset view</button
          >
          <button class="ghost" onclick={toggleReliefFullscreen} title="Full screen (F)"
            ><Icon name="expand" />Full screen</button
          >
        </div>
      {:else if ui.dockTab === 'timeline'}
        <div class="panel-tools">
          {@render viewTools('timeline')}
        </div>
      {/if}
    </div>
    <div class="dock-body">
      <section
        class="timeline"
        class:hidden={ui.dockTab !== 'timeline'}
        aria-hidden={ui.dockTab !== 'timeline'}
      >
        <canvas bind:this={timelineEl}></canvas>
      </section>
      <section class="lens" class:hidden={!onLayers} aria-hidden={!onLayers}>
        <canvas bind:this={lensEl}></canvas>
      </section>
      <section class="relief" class:hidden={!onRelief} aria-hidden={!onRelief} bind:this={reliefEl}>
        <canvas bind:this={reliefCanvasEl}></canvas>
        <div class="relief-labels" bind:this={reliefLabelsEl}></div>
        <div class="relief-head">
          <span class="relief-name"><Icon name="cube" />Relief 3D</span>
          {@render sourceToggle()}
          <span class="grow"></span>
          <button class:on={ui.reliefInfo} aria-pressed={ui.reliefInfo} onclick={toggleReliefInfo}><Icon name="info" />Info</button>
          {@render viewTools('relief')}
          <button onclick={resetReliefView}><Icon name="reset" />Reset view</button>
          <button onclick={toggleReliefFullscreen} title="Exit full screen (Esc)"
            ><Icon name="shrink" />Exit full screen</button
          >
        </div>
      </section>
    </div>
  </section>

  <Legend />

  {#if ui.gatesOpen}
    <Gates />
  {/if}
  {#if ui.modelsOpen && ui.mode === 'live'}
    <Models />
  {/if}
  {#if ui.helpOpen}
    <Help />
  {/if}
  <Toasts />
  {#if ui.debug}
    <Debug />
  {/if}
</div>

<style>
  .bar-wrap {
    flex: none;
    position: relative;
    z-index: 20;
  }
</style>
