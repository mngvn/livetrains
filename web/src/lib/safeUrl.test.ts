import { describe, expect, it } from 'vitest';
import { escapeHtml, linkHost, safeWebUrl } from './safeUrl.ts';

describe('safeWebUrl', () => {
  it('keeps ordinary web addresses', () => {
    expect(safeWebUrl('https://www.metrotransit.org/alerts')).toBe('https://www.metrotransit.org/alerts');
    expect(safeWebUrl('  http://example.com  ')).toBe('http://example.com/');
  });

  it('drops anything that could run code or is not a link at all', () => {
    expect(safeWebUrl('javascript:alert(1)')).toBeNull();
    expect(safeWebUrl('JaVaScRiPt:alert(1)')).toBeNull();
    expect(safeWebUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeWebUrl('vbscript:msgbox(1)')).toBeNull();
    expect(safeWebUrl('metrotransit.org')).toBeNull();
    expect(safeWebUrl('')).toBeNull();
    expect(safeWebUrl(undefined)).toBeNull();
  });

  it('can upgrade to https, for images loaded without a tap', () => {
    expect(safeWebUrl('http://example.com/a.jpg', { upgrade: true })).toBe('https://example.com/a.jpg');
    expect(safeWebUrl('https://example.com/a.jpg', { upgrade: true })).toBe('https://example.com/a.jpg');
    expect(safeWebUrl('javascript:alert(1)', { upgrade: true })).toBeNull();
  });
});

describe('linkHost', () => {
  it('names where a link goes', () => {
    expect(linkHost('https://www.metrotransit.org/x')).toBe('metrotransit.org');
  });
});

describe('escapeHtml', () => {
  it('leaves no markup behind', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).not.toMatch(/[<>"]/);
    expect(escapeHtml('AT&T Transit')).toBe('AT&#38;T Transit');
  });
});
