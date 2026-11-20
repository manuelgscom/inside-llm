// The icon set: line icons on a 24 × 24 grid, drawn with a 1.5 px round
// stroke. One source for the DOM (panels/Icon.svelte) and for the canvases
// (drawIcon). No icon font and no dependency.

export const ICONS = {
  // The mark: a lens with a distribution inside.
  logo: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 14.5v-3M12 16.5v-9M16 14.5v-5',
  play: 'M7.5 4.5v15l12-7.5z',
  pause: 'M8.5 5v14M15.5 5v14',
  step: 'M6 5v14l10-7zM18.5 5v14',
  stop: 'M6.5 6.5h11v11h-11z',
  sliders: 'M4 7h8M16 7h4M4 17h3M11 17h9M14 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM9 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  download: 'M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  expand: 'M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5',
  shrink: 'M4 9h5V4M20 9h-5V4M15 20v-5h5M9 20v-5H4',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  plus: 'M12 5v14M5 12h14',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  arrowLeft: 'M19 12H5M11 6l-6 6 6 6',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  branch: 'M7 4.5v15M17 4.5V8c0 4.5-10 3-10 8',
  activity: 'M3 12h4l3-7 4 14 3-7h4',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.6 2.6 0 1 1 3.8 2.3c-.8.5-1.3 1-1.3 2M12 17h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5h.01',
  warning: 'M12 4 2.8 19.5h18.4zM12 10v4.5M12 17.2h.01',
  layers: 'M12 4 3 9l9 5 9-5zM3 14l9 5 9-5',
  chart: 'M4 19.5h16M4 15l4-5 4 3 4-7 4 4',
  cube: 'M12 3 4 7.5v9L12 21l8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  compare: 'M12 4v16M9 8H4v8h5M15 6h5v12h-5',
  list: 'M4 7h10M4 12h16M4 17h7',
  reset: 'M4 5v5h5M5.2 14a7.5 7.5 0 1 0 1.3-7.2L4 10',
  bolt: 'M13 3 5 13.5h6L10 21l8-10.5h-6z',
  target: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20c1-3.5 4-5 7.5-5s6.5 1.5 7.5 5',
  send: 'M4 12 20 4l-6 16-3-7z',
  sparkle: 'M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6z',
  pointer: 'M6 4l12 7-5.5 1.5L10 18z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  unlink: 'M13 6.3l1-1a4 4 0 0 1 5.7 5.7l-1 1M11 17.7l-1 1A4 4 0 0 1 4.3 13l1-1M8 4v2.5M4 8h2.5M16 20v-2.5M20 16h-2.5',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  rotate: 'M3 12a9 4 0 1 0 18 0 9 4 0 0 0-18 0zM12 3v18',
  // Models panel.
  chip: 'M7 7h10v10H7zM10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3',
  folder: 'M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z',
  trash: 'M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10.2 11v5.5M13.8 11v5.5',
  swap: 'M7.5 4.5 4 8l3.5 3.5M4 8h13M16.5 12.5 20 16l-3.5 3.5M20 16H7',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5 20 20',
  cloud: 'M7 18.5a4.5 4.5 0 0 1-.5-8.97A6 6 0 0 1 18 9.6a4.5 4.5 0 0 1-.5 8.9z',
  zoomIn: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5 20 20M8 10.5h5M10.5 8v5',
  zoomOut: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5 20 20M8 10.5h5',
  external: 'M13.5 4.5h6v6M19.5 4.5 11 13M17.5 14v5.5h-13v-13H10',
} as const;

export type IconName = keyof typeof ICONS;

// Path2D objects, built on first use (there is no Path2D outside a browser).
const paths = new Map<IconName, Path2D>();

// Strokes an icon with its top-left corner at (x, y), `size` CSS px wide.
// The caller's transform and line settings are restored.
export function drawIcon(
  ctx: CanvasRenderingContext2D,
  name: IconName,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  let p = paths.get(name);
  if (p === undefined) {
    p = new Path2D(ICONS[name]);
    paths.set(name, p);
  }
  const k = size / 24;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 / Math.max(k, 0.5);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(p);
  ctx.restore();
}
