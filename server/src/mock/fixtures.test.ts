import { describe, expect, it } from 'vitest';
import { decodeAlerts } from '../realtime/decode.js';
import { encodeAlerts } from './fixtures.js';
import { createMockStore, MockSimulator } from './index.js';

describe('mock fixtures', () => {
  it('round-trips alerts with their effect, cause, periods and scope', () => {
    const simulator = new MockSimulator(createMockStore());
    const original = simulator.alerts();
    const decoded = decodeAlerts(encodeAlerts(simulator));

    expect(decoded).toHaveLength(original.length);
    for (const alert of original) {
      const match = decoded.find((d) => d.id === alert.id)!;
      expect(match.effect).toBe(alert.effect);
      expect(match.cause).toBe(alert.cause);
      expect(match.periods).toEqual(alert.periods);
      expect(match.informed).toEqual(alert.informed);
    }
  });
});
