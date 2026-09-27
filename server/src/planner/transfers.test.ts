import { describe, expect, it } from 'vitest';
import { TRANSFER_HEADER as HEADER, tinyStore } from '../testing/tinyFeed.js';
import { TransferGraph } from './transfers.js';
import { DEFAULT_CIRCUITY } from './walk.js';

/** Builds the graph the planner would build, over the tiny feed. */
function graph(transfers?: string, maxWalkMeters = 800) {
  const store = tinyStore(transfers);
  const built = TransferGraph.build(store, maxWalkMeters, 1.33, 45, 12);
  const index = (id: string) => store.stopIndexById.get(id)!;

  /** The footpath from one stop to another, if the graph has one. */
  const path = (from: string, to: string) => {
    const f = index(from);
    const t = index(to);
    for (let i = built.offset[f]; i < built.offset[f + 1]; i++) {
      if (built.target[i] === t) return { meters: built.meters[i], seconds: built.seconds[i] };
    }
    return null;
  };
  return { store, path };
}

describe('TransferGraph', () => {
  it('links stops a short walk apart', () => {
    expect(graph().path('a', 'b')).not.toBeNull();
    expect(graph().path('a', 'c')).not.toBeNull();
  });

  it('quotes a longer walk than the straight line', () => {
    // a and b are about 33m apart as the crow flies.
    const walk = graph().path('a', 'b')!;
    expect(walk.meters).toBeGreaterThan(33);
    expect(walk.meters).toBeLessThan(33 * DEFAULT_CIRCUITY + 2);
  });

  it('leaves distant stops unlinked', () => {
    expect(graph().path('a', 'far')).toBeNull();
  });

  it('drops a footpath the feed forbids, however close the stops', () => {
    expect(graph(`${HEADER}\na,b,3,\n`).path('a', 'b')).toBeNull();
    // Only that direction, and only that pair.
    expect(graph(`${HEADER}\na,b,3,\n`).path('b', 'a')).not.toBeNull();
    expect(graph(`${HEADER}\na,b,3,\n`).path('a', 'c')).not.toBeNull();
  });

  it('adds a footpath the feed states, however far apart the stops', () => {
    const walk = graph(`${HEADER}\na,far,0,\n`).path('a', 'far');
    expect(walk).not.toBeNull();
    expect(walk!.meters).toBeGreaterThan(3_000);
  });

  it('raises a footpath to the feed s minimum transfer time', () => {
    const plain = graph().path('a', 'b')!;
    const timed = graph(`${HEADER}\na,b,2,600\n`).path('a', 'b')!;
    expect(plain.seconds).toBeLessThan(600);
    expect(timed.seconds).toBe(600);
  });

  it('leaves a generous minimum transfer time alone when the walk is longer', () => {
    const walk = graph(`${HEADER}\na,b,2,1\n`).path('a', 'b')!;
    expect(walk.seconds).toBeGreaterThan(1);
  });

  it('charges no connection slack on a timed transfer', () => {
    // Type 1 means the vehicle waits, so the rider needs only the walk.
    const held = graph(`${HEADER}\na,b,1,\n`).path('a', 'b')!;
    const ordinary = graph().path('a', 'b')!;
    expect(held.seconds).toBe(ordinary.seconds - 45);
  });

  it('measures the walking limit in walking metres', () => {
    // a to far is ~3.34km straight, so a 3.34km *straight-line* budget would
    // link them; a 3.34km walking budget must not, because the walk is longer.
    expect(graph(undefined, 3_340).path('a', 'far')).toBeNull();
    expect(graph(undefined, 3_340 * DEFAULT_CIRCUITY + 50).path('a', 'far')).not.toBeNull();
  });
});
