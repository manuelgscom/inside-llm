// Shared by the Timeline and the Relief: building an SVG document and saving
// it, as SVG or rasterised to PNG. No DOM reading: the panels hand in their
// own geometry, so what is saved is what the data says at this moment.

import { COLOR, FONT, FONT_UI } from './theme';

export const SVG_NS = 'http://www.w3.org/2000/svg';

// CSS font stacks carry double quotes: inside an SVG attribute they must be
// single.
export const SVG_FONT_UI = FONT_UI.replace(/"/g, "'");
export const SVG_FONT_MONO = FONT.replace(/"/g, "'");

// C0 controls (except tab, newline, return), U+FFFE/U+FFFF and lone surrogates
// are not XML characters: one of them makes the whole document unreadable.
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function xmlEscape(s: string): string {
  return s.replace(NOT_XML, '').replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'));
}

// Numbers in attributes: at most two decimals, no "-0", no NaN.
export function n(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const s = (Math.round(v * 100) / 100).toString();
  return s === '-0' ? '0' : s;
}

// A complete SVG document of `w` × `h` CSS px, on the panel's colour (or
// `background`, null for transparent). `defs` and `body` are fragments.
export function svgDocument(w: number, h: number, body: string, opts: { defs?: string; background?: string | null; title?: string } = {}): string {
  const bg = opts.background === undefined ? COLOR.surface : opts.background;
  const title = opts.title ? `<title>${xmlEscape(opts.title)}</title>` : '';
  return (
    `<svg xmlns="${SVG_NS}" width="${n(w)}" height="${n(h)}" viewBox="0 0 ${n(w)} ${n(h)}" font-family="${SVG_FONT_UI}">` +
    title +
    (opts.defs ? `<defs>${opts.defs}</defs>` : '') +
    (bg ? `<rect width="${n(w)}" height="${n(h)}" fill="${bg}"/>` : '') +
    body +
    '</svg>'
  );
}

// "20261121-031542": file names sort by time.
export function stamp(d = new Date()): string {
  const p = (v: number): string => String(v).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function downloadBlob(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export function downloadText(text: string, name: string, mime = 'image/svg+xml'): void {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), name);
}

// Loads an image from a Blob or data URL.
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('the SVG could not be rasterised'));
    img.src = src;
  });
}

// Rasterises an SVG document (the size it declares, times `scale`) to a PNG.
// `under`, when given, is drawn first at the same size (the Relief's WebGL
// image, with the annotations of the SVG over it).
export async function svgToPngBlob(svg: string, w: number, h: number, scale = 2, under?: CanvasImageSource): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = await loadImage(url);
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    if (under) ctx.drawImage(under, 0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
