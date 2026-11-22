import { describe, expect, it } from 'vitest';
import { n, stamp, svgDocument, xmlEscape } from './export';

describe('xmlEscape', () => {
  it('escapes the five XML specials', () => {
    expect(xmlEscape(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });

  it('drops characters XML cannot hold, keeps tabs, newlines and emoji', () => {
    expect(xmlEscape('a\u0000b\u0008c\ud800d\udc00e')).toBe('abcde');
    expect(xmlEscape('t\tn\nr\r😀')).toBe('t\tn\nr\r😀');
  });
});

describe('n', () => {
  it('rounds to two decimals and never writes NaN, Infinity or -0', () => {
    expect(n(1.23456)).toBe('1.23');
    expect(n(NaN)).toBe('0');
    expect(n(Infinity)).toBe('0');
    expect(n(-0.001)).toBe('0');
  });
});

describe('svgDocument', () => {
  it('wraps a body with the size, a title and a background', () => {
    const svg = svgDocument(100, 50.123, '<g/>', { title: 'a & b', background: '#000' });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50.12"')).toBe(true);
    expect(svg).toContain('<title>a &amp; b</title>');
    expect(svg).toContain('fill="#000"');
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  it('can be transparent', () => {
    expect(svgDocument(10, 10, '', { background: null })).not.toContain('<rect');
  });
});

describe('stamp', () => {
  it('is sortable by time', () => {
    expect(stamp(new Date(2026, 10, 21, 3, 15, 42))).toBe('20261121-031542');
  });
});
