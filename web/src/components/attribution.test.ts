import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as maplibregl from 'maplibre-gl';
import { quietAttribution, type AttributionState } from './attribution.ts';

/** Just enough of MapLibre's compact credit, a <details>, to drive the code. */
class FakeCredit {
  readonly classes = new Set(['maplibregl-ctrl-attrib', 'maplibregl-compact', 'maplibregl-compact-show']);
  readonly attributes = new Set(['open']);
  readonly listeners: { type: string; fn: (event: Event) => void; capture: boolean }[] = [];
  readonly classList = {
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force?: boolean) => {
      const on = force ?? !this.classes.has(name);
      if (on) this.classes.add(name);
      else this.classes.delete(name);
      return on;
    },
  };
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  toggleAttribute(name: string, force?: boolean) {
    const on = force ?? !this.attributes.has(name);
    if (on) this.attributes.add(name);
    else this.attributes.delete(name);
    return on;
  }
  addEventListener(type: string, fn: (event: Event) => void, capture: boolean) {
    this.listeners.push({ type, fn, capture });
  }
  removeEventListener(type: string, fn: (event: Event) => void) {
    const at = this.listeners.findIndex((l) => l.type === type && l.fn === fn);
    if (at >= 0) this.listeners.splice(at, 1);
  }
  /** A click whose target is, or is not, the (i) button. */
  click(onButton: boolean) {
    const event = {
      target: { closest: (selector: string) => (onButton && selector === '.maplibregl-ctrl-attrib-button' ? {} : null) },
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    for (const l of [...this.listeners]) if (l.type === 'click') l.fn(event as unknown as Event);
    return event;
  }
  get open() {
    return this.attributes.has('open') && this.classes.has('maplibregl-compact-show');
  }
  get folded() {
    return !this.attributes.has('open') && !this.classes.has('maplibregl-compact-show');
  }
}

/** Mutation observers fire when told to, so a test can play MapLibre's part. */
const observers: { callback: () => void; disconnected: boolean }[] = [];
class FakeObserver {
  private readonly entry: { callback: () => void; disconnected: boolean };
  constructor(callback: () => void) {
    this.entry = { callback, disconnected: false };
    observers.push(this.entry);
  }
  observe() {}
  disconnect() {
    this.entry.disconnected = true;
  }
}
const mutate = () => observers.filter((o) => !o.disconnected).forEach((o) => o.callback());

function setup(state: AttributionState = { open: true, settled: false }) {
  const credit = new FakeCredit();
  const map = { getContainer: () => ({ querySelector: () => credit }) } as unknown as maplibregl.Map;
  return { credit, state, quiet: quietAttribution(map, state) };
}

describe('quietAttribution', () => {
  beforeEach(() => {
    observers.length = 0;
    vi.stubGlobal('MutationObserver', FakeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the credit on arrival and folds it, open attribute and all', () => {
    const { credit, quiet } = setup();
    expect(credit.open).toBe(true);
    quiet.fold();
    expect(credit.folded).toBe(true);
  });

  it("puts the state back when MapLibre reopens the credit on its own", () => {
    const { credit, quiet } = setup();
    quiet.fold();
    credit.toggleAttribute('open', true);
    credit.classList.toggle('maplibregl-compact-show', true);
    mutate();
    expect(credit.folded).toBe(true);
  });

  it("answers a tap on the (i) itself, and then stops folding on its own", () => {
    const { credit, state, quiet } = setup();
    quiet.fold();
    const tap = credit.click(true);
    expect(tap.preventDefault).toHaveBeenCalled();
    expect(tap.stopImmediatePropagation).toHaveBeenCalled();
    expect(credit.open).toBe(true);
    expect(state).toEqual({ open: true, settled: true });
    // The timer or a touch of the map no longer closes what the rider opened.
    quiet.fold();
    expect(credit.open).toBe(true);
    credit.click(true);
    expect(credit.folded).toBe(true);
  });

  it('leaves clicks elsewhere in the credit, such as its links, alone', () => {
    const { credit, quiet } = setup();
    const click = credit.click(false);
    expect(click.preventDefault).not.toHaveBeenCalled();
    expect(credit.open).toBe(true);
    quiet.fold();
    expect(credit.folded).toBe(true);
  });

  it('carries the state across a rebuilt control', () => {
    const first = setup();
    first.quiet.fold();
    first.quiet.dispose();
    const second = setup(first.state);
    expect(second.credit.folded).toBe(true);
  });

  it('lets go of the control when disposed', () => {
    const { credit, quiet } = setup();
    quiet.dispose();
    expect(credit.listeners).toHaveLength(0);
    expect(observers.every((o) => o.disconnected)).toBe(true);
  });
});
