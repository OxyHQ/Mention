import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('@/utils/feedTelemetry', () => ({ reportInterstitialEvent: jest.fn() }));

import { useInterstitialImpression } from '../interstitialTelemetry';

/**
 * The WEB half of the impression rule: a band counts as seen when half of it
 * is on screen, measured by an `IntersectionObserver` on its own element — not
 * when it merely mounts below the fold. (The native half, mount plus a delay,
 * is exercised through the bands in `FeedInterstitial.test.tsx`.)
 *
 * Jest runs without a DOM, so this file supplies the two globals the hook
 * reaches for: an `Element` to recognise the band's node, and an observer it can
 * drive by hand.
 */

class FakeElement {}

interface Entry {
  isIntersecting: boolean;
  intersectionRatio: number;
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  observed: unknown = null;
  disconnected = false;

  constructor(
    readonly callback: (entries: Entry[]) => void,
    readonly options: { threshold: number },
  ) {
    FakeIntersectionObserver.instances.push(this);
  }

  observe(element: unknown) {
    this.observed = element;
  }

  disconnect() {
    this.disconnected = true;
  }

  fire(entry: Entry) {
    act(() => this.callback([entry]));
  }
}

const globals = globalThis as { Element?: unknown; IntersectionObserver?: unknown };
const originalElement = globals.Element;
const originalObserver = globals.IntersectionObserver;

beforeEach(() => {
  globals.Element = FakeElement;
  globals.IntersectionObserver = FakeIntersectionObserver;
  FakeIntersectionObserver.instances = [];
});

afterEach(() => {
  globals.Element = originalElement;
  globals.IntersectionObserver = originalObserver;
});

/**
 * A bare host node rather than RN's `View`: jest's `View` is a mock component,
 * and only a host node receives `createNodeMock`.
 */
function Band({ report }: { report: jest.Mock }) {
  return React.createElement('band', { ref: useInterstitialImpression(report, true) });
}

function mountBand() {
  const report = jest.fn();
  const element = new FakeElement();
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    // What react-native-web attaches to the band's outermost `View` ref: its
    // DOM node.
    renderer = TestRenderer.create(<Band report={report} />, {
      createNodeMock: () => element,
    });
  });
  const [observer] = FakeIntersectionObserver.instances;
  return { report, element, observer, renderer: renderer! };
}

describe('useInterstitialImpression on the web', () => {
  it('observes the band’s own element at the 50% threshold', () => {
    const { element, observer } = mountBand();

    expect(observer.observed).toBe(element);
    expect(observer.options.threshold).toBe(0.5);
  });

  it('reports nothing while the band is below the fold or barely showing', () => {
    const { report, observer } = mountBand();

    observer.fire({ isIntersecting: false, intersectionRatio: 0 });
    observer.fire({ isIntersecting: true, intersectionRatio: 0.2 });

    expect(report).not.toHaveBeenCalled();
    expect(observer.disconnected).toBe(false);
  });

  it('reports ONE impression once half the band is seen, then stops observing', () => {
    const { report, observer } = mountBand();

    observer.fire({ isIntersecting: true, intersectionRatio: 0.6 });
    observer.fire({ isIntersecting: true, intersectionRatio: 1 });

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith('impression');
    expect(observer.disconnected).toBe(true);
  });

  it('stops observing when the band unmounts unseen', () => {
    const { report, observer, renderer } = mountBand();

    act(() => renderer.unmount());

    expect(observer.disconnected).toBe(true);
    expect(report).not.toHaveBeenCalled();
  });
});
