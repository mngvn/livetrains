import { describe, expect, it } from 'vitest';
import { forEachRow, formatGtfsTime, parseCsv, parseGtfsTime } from './csv.js';

describe('parseCsv', () => {
  it('reads a plain GTFS file', () => {
    const rows = parseCsv('stop_id,stop_name\nS1,Nicollet Mall\nS2,Union Depot\n');
    expect(rows).toEqual([
      { stop_id: 'S1', stop_name: 'Nicollet Mall' },
      { stop_id: 'S2', stop_name: 'Union Depot' },
    ]);
  });

  it('handles quoted fields containing commas', () => {
    const rows = parseCsv('stop_id,stop_name\nS1,"Lake St & Nicollet Ave, Minneapolis"\n');
    expect(rows[0].stop_name).toBe('Lake St & Nicollet Ave, Minneapolis');
  });

  it('unescapes doubled quotes', () => {
    const rows = parseCsv('id,name\n1,"The ""Blue"" Line"\n');
    expect(rows[0].name).toBe('The "Blue" Line');
  });

  it('handles quoted fields containing newlines', () => {
    const rows = parseCsv('id,note\n1,"line one\nline two"\n2,plain\n');
    expect(rows).toHaveLength(2);
    expect(rows[0].note).toBe('line one\nline two');
    expect(rows[1].note).toBe('plain');
  });

  it('accepts CRLF line endings', () => {
    const rows = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
    expect(rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('strips a UTF-8 byte order mark', () => {
    const rows = parseCsv('﻿stop_id,stop_name\nS1,Target Field\n');
    expect(rows[0].stop_id).toBe('S1');
  });

  it('pads rows that are shorter than the header', () => {
    const rows = parseCsv('a,b,c\n1,2\n');
    expect(rows[0]).toEqual({ a: '1', b: '2', c: '' });
  });

  it('ignores a trailing newline rather than emitting a blank row', () => {
    expect(parseCsv('a\n1\n\n')).toEqual([{ a: '1' }]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('only_a_header\n')).toEqual([]);
  });
});

describe('forEachRow', () => {
  it('reuses one row object across the whole file', () => {
    const seen: unknown[] = [];
    forEachRow('a\n1\n2\n', (row) => seen.push(row));
    // Both pushes are the same object — callers must copy what they keep.
    expect(seen[0]).toBe(seen[1]);
  });
});

describe('parseGtfsTime', () => {
  it('parses a normal time to seconds after midnight', () => {
    expect(parseGtfsTime('00:00:00')).toBe(0);
    expect(parseGtfsTime('09:30:15')).toBe(9 * 3600 + 30 * 60 + 15);
    expect(parseGtfsTime('23:59:59')).toBe(86_399);
  });

  it('keeps hours past 24, which GTFS uses for after-midnight service', () => {
    // 00:40 the next morning, still part of the previous service day.
    expect(parseGtfsTime('24:40:00')).toBe(24 * 3600 + 40 * 60);
    expect(parseGtfsTime('26:15:30')).toBe(26 * 3600 + 15 * 60 + 30);
  });

  it('accepts unpadded hours', () => {
    expect(parseGtfsTime('9:05:00')).toBe(9 * 3600 + 5 * 60);
  });

  it('returns -1 for blank or unparseable input', () => {
    expect(parseGtfsTime('')).toBe(-1);
    expect(parseGtfsTime('   ')).toBe(-1);
  });

  it('round-trips through formatGtfsTime', () => {
    for (const time of ['05:00:00', '13:45:30', '24:40:00', '27:05:09']) {
      expect(formatGtfsTime(parseGtfsTime(time))).toBe(time);
    }
  });
});
