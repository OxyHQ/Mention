import { afterEach, describe, expect, it, vi } from 'vitest';
import { backoffDelayMs } from '../../utils/backoff';
import { sleep } from '../../utils/sleep';

describe('backoffDelayMs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('doubles per attempt and adds jitter below the ratio', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(backoffDelayMs(0, { baseMs: 1000 })).toBe(1000);
    expect(backoffDelayMs(3, { baseMs: 1000 })).toBe(8000);
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    expect(backoffDelayMs(1, { baseMs: 1000, jitter: 0.2 })).toBe(2399);
  });

  it('caps the exponential part before jitter', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(backoffDelayMs(20, { baseMs: 1000, maxMs: 30_000 })).toBe(30_000);
  });
});

describe('sleep', () => {
  it('rejects with the abort reason and not after the timer', async () => {
    const controller = new AbortController();
    const pending = sleep(60_000, controller.signal);
    controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
    await expect(sleep(1, controller.signal)).rejects.toThrow('stop');
  });

  it('resolves when not aborted', async () => {
    await expect(sleep(1, new AbortController().signal)).resolves.toBeUndefined();
  });
});
