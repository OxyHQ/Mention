import React, { useRef } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { useScrollMarginOrigin } from '../useScrollMarginOrigin';

/**
 * The virtualizer's measurement origin, across a hide/show cycle.
 *
 * This exists because the shape it guards is invisible to any test that only
 * looks at a VISIBLE node: the old row-count-keyed measurement was correct
 * there, before and after the fix. What distinguishes them is a wrapper that is
 * collapsed (`display: none`, so `{top:0,height:0,width:0}`) while the DOCUMENT
 * is scrolled somewhere else — which is what a tab navigator produces, since it
 * keeps non-focused tabs mounted and hidden.
 *
 * Both assertions below are mutation-tested against the implementation:
 *  - remove the zero-box skip  -> "ignores a collapsed wrapper" fails
 *  - remove the ResizeObserver -> "re-measures when the wrapper is shown" fails
 * If either can pass without its half of the fix, this file is worthless.
 */

type Rect = { top: number; width: number; height: number };

/** The observer callbacks currently registered, so a test can fire a layout change. */
let observerCallbacks: (() => void)[] = [];

class FakeResizeObserver {
  constructor(private readonly cb: () => void) {
    observerCallbacks.push(() => this.cb());
  }
  observe() {}
  disconnect() {
    observerCallbacks = observerCallbacks.filter((fn) => fn !== this.cb);
  }
}

function fireLayoutChange() {
  act(() => {
    for (const fn of [...observerCallbacks]) fn();
  });
}

/** A stand-in for the wrapper whose box and document scroll the test drives. */
function makeNode(rect: Rect) {
  const current = { ...rect };
  return {
    node: { getBoundingClientRect: () => ({ ...current }) } as unknown as HTMLElement,
    setRect: (next: Rect) => Object.assign(current, next),
  };
}

function setScrollY(value: number) {
  Object.defineProperty(window, 'scrollY', { value, configurable: true, writable: true });
}

function renderHookWith(node: HTMLElement) {
  const seen: number[] = [];
  function Probe() {
    const ref = useRef<HTMLElement | null>(node);
    seen.push(useScrollMarginOrigin(ref));
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  return {
    latest: () => seen[seen.length - 1],
    unmount: () => act(() => renderer?.unmount()),
  };
}

describe('useScrollMarginOrigin', () => {
  const OriginalObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

  beforeEach(() => {
    observerCallbacks = [];
    setScrollY(0);
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  });

  afterEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = OriginalObserver;
  });

  it('measures a visible wrapper as its offset from the document top', () => {
    setScrollY(120);
    const { node } = makeNode({ top: 80, width: 600, height: 4000 });
    const hook = renderHookWith(node);
    // 80 above the viewport top, 120 already scrolled past = 200 from the document top.
    expect(hook.latest()).toBe(200);
    hook.unmount();
  });

  it('ignores a collapsed wrapper instead of storing the visible screen position', () => {
    // Visible and measured first, so there is a good value to destroy.
    setScrollY(0);
    const { node, setRect } = makeNode({ top: 300, width: 600, height: 4000 });
    const hook = renderHookWith(node);
    expect(hook.latest()).toBe(300);

    // The tab is hidden: the wrapper collapses, and the DOCUMENT is now showing
    // — and scrolled by — a different tab. The old code stored `0 + 5000`.
    setRect({ top: 0, width: 0, height: 0 });
    setScrollY(5000);
    fireLayoutChange();

    expect(hook.latest()).toBe(300);
    expect(hook.latest()).not.toBe(5000);
    hook.unmount();
  });

  it('re-measures when the wrapper is shown again', () => {
    setScrollY(0);
    const { node, setRect } = makeNode({ top: 300, width: 600, height: 4000 });
    const hook = renderHookWith(node);
    expect(hook.latest()).toBe(300);

    setRect({ top: 0, width: 0, height: 0 });
    setScrollY(5000);
    fireLayoutChange();
    expect(hook.latest()).toBe(300);

    // Shown again, at a different offset than before — chrome above it changed
    // while it was away. Without a re-measure the stale 300 would persist for
    // the rest of the session, because the row count never changes again.
    setScrollY(0);
    setRect({ top: 460, width: 600, height: 4000 });
    fireLayoutChange();

    expect(hook.latest()).toBe(460);
    hook.unmount();
  });

  it('re-measures when content ABOVE the wrapper grows without it resizing', () => {
    // The wrapper keeps its own size; only its top moves. This is why the
    // document is observed as well as the wrapper.
    setScrollY(0);
    const { node, setRect } = makeNode({ top: 200, width: 600, height: 4000 });
    const hook = renderHookWith(node);
    expect(hook.latest()).toBe(200);

    setRect({ top: 640, width: 600, height: 4000 });
    fireLayoutChange();

    expect(hook.latest()).toBe(640);
    hook.unmount();
  });

  it('still measures once where ResizeObserver does not exist', () => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = undefined;
    setScrollY(50);
    const { node } = makeNode({ top: 10, width: 600, height: 4000 });
    const hook = renderHookWith(node);
    expect(hook.latest()).toBe(60);
    hook.unmount();
  });
});
