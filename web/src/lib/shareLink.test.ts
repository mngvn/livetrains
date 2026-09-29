import { describe, expect, it } from 'vitest';
import type { Place } from './api.ts';
import { hasSharedState, readSharedState, shareUrl, writeSharedState } from './shareLink.ts';

const stop: Place = { id: 'BL03', name: 'Nicollet Mall Station', lat: 44.978412, lon: -93.269934, kind: 'stop' };
const depot: Place = { id: 'GR18', name: 'Union Depot, St Paul', lat: 44.9479, lon: -93.0855, kind: 'stop' };
const here: Place = { id: 'current-location', name: 'My location', lat: 44.95, lon: -93.2, kind: 'current-location' };

describe('share links', () => {
  it('round-trips a trip, keeping names with commas intact', () => {
    const state = readSharedState(writeSharedState({ from: stop, to: depot }));
    expect(state.from).toMatchObject({ name: 'Nicollet Mall Station', lat: 44.97841, lon: -93.26993 });
    expect(state.to).toMatchObject({ name: 'Union Depot, St Paul', lat: 44.9479, lon: -93.0855 });
  });

  it('never writes the sender’s own location into a link', () => {
    const query = writeSharedState({ from: here, to: depot });
    expect(query).not.toContain('44.95');
    expect(query).not.toContain('My');
    expect(readSharedState(query)).toEqual({ to: expect.objectContaining({ name: 'Union Depot, St Paul' }) });
  });

  it('carries a stop or a route', () => {
    expect(readSharedState(writeSharedState({ stop: 'BL03' }))).toEqual({ stop: 'BL03' });
    expect(readSharedState(writeSharedState({ route: '921' }))).toEqual({ route: '921' });
  });

  it('leaves parameters it does not own alone', () => {
    const query = writeSharedState({ stop: 'BL03' }, '?utm_source=chat&stop=OLD&from=1,2');
    const params = new URLSearchParams(query);
    expect(params.get('utm_source')).toBe('chat');
    expect(params.get('stop')).toBe('BL03');
    expect(params.has('from')).toBe(false);
  });

  it('ignores coordinates that are not coordinates', () => {
    expect(readSharedState('?from=abc,def&to=91,0')).toEqual({});
    expect(hasSharedState(readSharedState('?utm_source=x'))).toBe(false);
  });

  it('labels an unnamed shared point by its coordinates', () => {
    expect(readSharedState('?to=44.9,-93.2').to?.name).toBe('44.9000, -93.2000');
  });

  it('builds a full URL on the page’s own path', () => {
    expect(shareUrl({ route: 'Blue' }, { origin: 'https://mngvn.github.io', pathname: '/livetrains/' })).toBe(
      'https://mngvn.github.io/livetrains/?route=Blue',
    );
  });
});
