import { describe, expect, it } from 'vitest';
import { plateLabel } from './format.ts';

describe('plateLabel', () => {
  it('keeps short route numbers as they are', () => {
    expect(plateLabel('21')).toBe('21');
    expect(plateLabel('Blue')).toBe('Blue');
  });

  it('cuts a long line name down to what the signs say', () => {
    expect(plateLabel('METRO Green Line')).toBe('Green');
    expect(plateLabel('METRO Blue Line')).toBe('Blue');
    expect(plateLabel('A Line')).toBe('A');
    expect(plateLabel('Northstar Commuter Rail')).toBe('Northstar');
  });
});
