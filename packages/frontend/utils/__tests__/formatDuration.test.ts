/**
 * Tests run under either jest (frontend `jest-expo` preset) or vitest (workspace
 * runner). Both provide the same describe/it/expect globals.
 *
 * The cases below pin the contract the module's docstring publishes, plus the
 * two boundaries an implementation gets wrong by default: a fractional second
 * must FLOOR (a rounding implementation would show a duration the clip has not
 * reached), and the minute field must switch from unpadded to padded exactly at
 * the hour, never before.
 */

import { formatDuration } from '../formatDuration';

describe('formatDuration', () => {
  it('renders sub-minute durations with a padded seconds field', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(7)).toBe('0:07');
    expect(formatDuration(59)).toBe('0:59');
  });

  it('floors a fractional second rather than rounding up', () => {
    expect(formatDuration(6.9)).toBe('0:06');
    expect(formatDuration(59.999)).toBe('0:59');
  });

  it('leaves minutes unpadded below an hour', () => {
    expect(formatDuration(83)).toBe('1:23');
    expect(formatDuration(725)).toBe('12:05');
    expect(formatDuration(3599)).toBe('59:59');
  });

  it('pads minutes once the hour field appears', () => {
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3723)).toBe('1:02:03');
    expect(formatDuration(45296)).toBe('12:34:56');
  });

  it('renders 0:00 for anything that is not a finite, non-negative number', () => {
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(NaN)).toBe('0:00');
    expect(formatDuration(Infinity)).toBe('0:00');
    expect(formatDuration(-Infinity)).toBe('0:00');
    expect(formatDuration('90' as unknown as number)).toBe('0:00');
  });
});
