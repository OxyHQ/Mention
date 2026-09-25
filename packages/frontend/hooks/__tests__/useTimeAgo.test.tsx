/**
 * Relative timestamps keep up with the clock — "25s" does not still say "25s" a
 * minute later (OxyHQ/Mention#1140) — and they do it from ONE shared ticker,
 * re-rendering a label only when its string changes.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { TICK_MS, timeAgoSubscriberCount, useTimeAgo } from '../useTimeAgo';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const renders = new Map<string, number>();

function Label({ id, date }: { id: string; date: number }) {
  renders.set(id, (renders.get(id) ?? 0) + 1);
  return <>{useTimeAgo(date)}</>;
}

const START = new Date('2026-09-25T12:00:00Z').getTime();

describe('useTimeAgo', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
    renders.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('moves on as time passes', () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<Label id="a" date={START - 25_000} />);
    });
    expect(tree.toJSON()).toBe('25s');

    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(tree.toJSON()).toBe('1m');

    act(() => tree.unmount());
  });

  it('runs one ticker for every label, and stops it when the last one goes', () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <>
          <Label id="a" date={START - 10_000} />
          <Label id="b" date={START - 3 * 3_600_000} />
          <Label id="c" date={START - 5_000} />
        </>,
      );
    });
    expect(timeAgoSubscriberCount()).toBe(3);
    expect(jest.getTimerCount()).toBe(1);

    act(() => tree.unmount());
    expect(timeAgoSubscriberCount()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('re-renders only the labels whose text changed on a tick', () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <>
          <Label id="fresh" date={START - 10_000} />
          <Label id="old" date={START - 3 * 3_600_000} />
        </>,
      );
    });
    const before = { fresh: renders.get('fresh')!, old: renders.get('old')! };

    act(() => {
      jest.advanceTimersByTime(TICK_MS);
    });

    // "10s" → "25s" re-renders; "3h" is still "3h" and does not.
    expect(renders.get('fresh')).toBeGreaterThan(before.fresh);
    expect(renders.get('old')).toBe(before.old);

    act(() => tree.unmount());
  });
});
