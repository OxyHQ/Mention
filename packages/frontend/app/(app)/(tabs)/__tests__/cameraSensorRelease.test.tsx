import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * The camera page must not hold the sensor once the reader has swiped away.
 *
 * THIS WAS ON THE "NEEDS A DEVICE" LIST, and it does not belong there. What a
 * phone shows you — the OS capture indicator staying lit behind the feed, the
 * battery draining, a second app unable to open the camera on Android — is the
 * CONSEQUENCE. The cause is one React question with a yes-or-no answer: is
 * `CameraCapture`, and therefore `CameraView`, still mounted after the page
 * loses focus? A renderer can answer that, so it does.
 *
 * What still needs a device is whether the OS actually releases the hardware
 * when `CameraView` unmounts. That is expo-camera's contract, not this app's,
 * and this file is deliberately not pretending to check it.
 *
 * The page's ORDER of checks is the other half, and it is easy to invert: a
 * capture under review renders BEFORE the focus gate, so swiping away mid-review
 * keeps the capture — while still not holding the sensor, because the review
 * screen has no preview in it. Putting the focus gate first would throw a
 * reader's photo behind a black rectangle.
 */

let mockFocused = true;
let previewMounts = 0;
let previewLive = false;
let reviewLive = false;

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useIsFocused: () => mockFocused,
}));

jest.mock('@/lib/oxyServices', () => ({ oxyServices: { assetUpload: jest.fn() } }));

jest.mock('@/stores/postsStore', () => ({
  usePostsStore: (selector: (state: unknown) => unknown) => selector({ createPost: jest.fn() }),
}));

jest.mock('@/context/TabPagerContext', () => ({
  useTabPager: () => ({ selectTab: jest.fn() }),
}));

let viewfinderProps: Record<string, unknown> = {};
jest.mock('@/components/Camera/CameraCapture', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  return {
    // Stands in for the real preview, which is `CameraView` and therefore the
    // sensor. Mounting is the thing being measured, so it is counted here.
    CameraCapture: (props: Record<string, unknown>) => {
      viewfinderProps = props;
      ReactModule.useEffect(() => {
        previewMounts += 1;
        previewLive = true;
        return () => {
          previewLive = false;
        };
      }, []);
      return null;
    },
  };
});

jest.mock('@/components/Camera/CaptureReview', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  return {
    CaptureReview: () => {
      ReactModule.useEffect(() => {
        reviewLive = true;
        return () => {
          reviewLive = false;
        };
      }, []);
      return null;
    },
  };
});

jest.mock('@/utils/pendingShareMedia', () => ({ setPendingShareMedia: jest.fn() }));

import CameraPage from '../camera';

const mounted: TestRenderer.ReactTestRenderer[] = [];

beforeEach(() => {
  mockFocused = true;
  previewMounts = 0;
  previewLive = false;
  reviewLive = false;
  viewfinderProps = {};
});

afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) renderer.unmount();
  });
});

function mountPage() {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(<CameraPage />);
  });
  mounted.push(renderer!);
  return renderer!;
}

/** A blur or a re-focus, the way the pager delivers one: a re-render. */
function setFocus(renderer: TestRenderer.ReactTestRenderer, focused: boolean) {
  mockFocused = focused;
  act(() => {
    renderer.update(<CameraPage />);
  });
}

describe('holding the sensor', () => {
  it('opens the preview while the page is focused', () => {
    mountPage();

    expect(previewLive).toBe(true);
    expect(previewMounts).toBe(1);
  });

  it('LETS IT GO the moment the page loses focus', () => {
    // The whole point. A `CameraView` left mounted behind the feed keeps the
    // OS capture indicator lit and the sensor claimed.
    const renderer = mountPage();

    setFocus(renderer, false);

    expect(previewLive).toBe(false);
  });

  it('never opens it at all on a page that mounts unfocused', () => {
    // `preload: false` in the page table is what should prevent this, but the
    // page must be correct on its own: a camera mounted merely for being Home's
    // neighbour would claim the sensor with the reader still on the feed.
    mockFocused = false;
    mountPage();

    expect(previewLive).toBe(false);
    expect(previewMounts).toBe(0);
  });

  it('opens it again when the reader comes back', () => {
    const renderer = mountPage();

    setFocus(renderer, false);
    setFocus(renderer, true);

    expect(previewLive).toBe(true);
    // A fresh mount, not the same one revived — which is the point: the sensor
    // was genuinely released in between.
    expect(previewMounts).toBe(2);
  });
});

describe('a capture under review', () => {
  function captureSomething() {
    act(() => {
      (viewfinderProps.onCaptured as (capture: unknown) => void)({
        uri: 'file:///tmp/shot.jpg',
        kind: 'image',
        mimeType: 'image/jpeg',
      });
    });
  }

  it('closes the preview as soon as there is something to review', () => {
    // Still focused — the reason the preview goes is the capture, not the blur.
    mountPage();
    captureSomething();

    expect(reviewLive).toBe(true);
    expect(previewLive).toBe(false);
  });

  it('SURVIVES a swipe away, rather than being replaced by the black view', () => {
    // The check order this pins: `capture` is answered before `isFocused`.
    // Inverted, a reader who swipes to the feed and back loses their photo.
    const renderer = mountPage();
    captureSomething();

    setFocus(renderer, false);

    expect(reviewLive).toBe(true);
    // And still no sensor: the review screen has no preview in it.
    expect(previewLive).toBe(false);
  });

  it('does not reopen the preview on the way back — the capture still owns the screen', () => {
    const renderer = mountPage();
    captureSomething();

    setFocus(renderer, false);
    setFocus(renderer, true);

    expect(reviewLive).toBe(true);
    expect(previewLive).toBe(false);
  });
});
