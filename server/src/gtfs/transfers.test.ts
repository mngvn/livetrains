import { describe, expect, it } from 'vitest';
import { TRANSFER_HEADER as HEADER, tinyStore } from '../testing/tinyFeed.js';

describe('transfers.txt', () => {
  const rule = (transfers: string | undefined, from: string, to: string) => {
    const store = tinyStore(transfers);
    return store.transferRule(store.stopIndexById.get(from)!, store.stopIndexById.get(to)!);
  };

  it('is optional', () => {
    expect(tinyStore().transferRules.size).toBe(0);
  });

  it('records a minimum transfer time', () => {
    expect(rule(`${HEADER}\na,b,2,300\n`, 'a', 'b')).toEqual({ type: 2, minSeconds: 300 });
  });

  it('records a forbidden transfer', () => {
    expect(rule(`${HEADER}\na,c,3,\n`, 'a', 'c')?.type).toBe(3);
  });

  it('treats an absent transfer_type as "recommended", per the spec', () => {
    expect(rule('from_stop_id,to_stop_id\na,b\n', 'a', 'b')).toEqual({ type: 0, minSeconds: null });
  });

  it('is directional', () => {
    const forbid = `${HEADER}\na,b,3,\n`;
    expect(rule(forbid, 'a', 'b')?.type).toBe(3);
    expect(rule(forbid, 'b', 'a')).toBeUndefined();
  });

  it('ignores rules qualified by route or trip', () => {
    // These constrain one connection rather than the pair of stops, so
    // applying them to every transfer between the stops would forbid
    // connections the feed never spoke about.
    expect(rule(`${HEADER},from_route_id\na,b,3,,r\n`, 'a', 'b')).toBeUndefined();
  });

  it('skips rows naming a stop the feed does not have', () => {
    expect(tinyStore(`${HEADER}\na,ghost,3,\nghost,a,3,\n`).transferRules.size).toBe(0);
  });

  it('skips a stop transferring to itself', () => {
    expect(tinyStore(`${HEADER}\na,a,2,120\n`).transferRules.size).toBe(0);
  });

  it('keys pairs without collision', () => {
    const transfers = `${HEADER}\na,b,2,300\nc,far,2,60\n`;
    expect(rule(transfers, 'a', 'b')?.minSeconds).toBe(300);
    expect(rule(transfers, 'c', 'far')?.minSeconds).toBe(60);
    expect(rule(transfers, 'a', 'far')).toBeUndefined();
  });
});
