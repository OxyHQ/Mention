import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * The two ways the camera's "post now" exit can lose or duplicate a capture.
 *
 * Both are ORDERING bugs, both survive a type check and a render, and neither
 * shows up in a screenshot — which is why they are pinned here rather than left
 * to a device pass.
 *
 * ONE. The upload hook's `busy` ends when the UPLOAD ends, not when the post is
 * created. Between those two moments the review's buttons were live again, and a
 * second press went straight through: the upload is cached by URI, so it
 * returned instantly and created a SECOND post from one capture.
 *
 * TWO. `postsStore.createPost` returns `null` on three paths that never
 * throw — the response reported no success, it carried no post, or the viewer
 * changed mid-flight. Treating a resolved promise as a published post threw the
 * capture away with nothing published.
 *
 * The upload here is the REAL hook against a mocked `assetUpload`, because the
 * gap between the two `busy` flags is the whole bug — mocking the hook would
 * measure the mock.
 */

let capturedProps: Record<string, unknown> = {};
const mockCreatePost = jest.fn();
const mockSetPendingShareMedia = jest.fn();
let mockResolveUpload: ((value: unknown) => void) | undefined;

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useIsFocused: () => true,
}));

jest.mock('@/lib/oxyServices', () => ({
  oxyServices: {
    assetUpload: jest.fn(
      () =>
        new Promise((resolve) => {
          mockResolveUpload = resolve;
        }),
    ),
  },
}));

jest.mock('@/stores/postsStore', () => ({
  usePostsStore: (selector: (state: unknown) => unknown) => selector({ createPost: mockCreatePost }),
}));

jest.mock('@/context/TabPagerContext', () => ({
  useTabPager: () => ({ selectTab: jest.fn() }),
}));

let viewfinderProps: Record<string, unknown> = {};
jest.mock('@/components/Camera/CameraCapture', () => ({
  CameraCapture: (props: Record<string, unknown>) => {
    viewfinderProps = props;
    return null;
  },
}));

jest.mock('@/components/Camera/CaptureReview', () => ({
  CaptureReview: (props: Record<string, unknown>) => {
    capturedProps = props;
    return null;
  },
}));

jest.mock('@/utils/pendingShareMedia', () => ({
  setPendingShareMedia: (...args: unknown[]) => mockSetPendingShareMedia(...args),
}));

import CameraPage from '../camera';

/**
 * Every mount is torn down, following `TabsPager.test.tsx`'s own note that this
 * is not tidiness: several cases here deliberately leave `createPost` pending,
 * and a renderer left standing keeps that unresolved update in React's act queue
 * — where the NEXT test's synchronous `act` flushes it instead of its own first
 * render, and that test then finds no viewfinder to capture with.
 */
const mounted: TestRenderer.ReactTestRenderer[] = [];

afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) renderer.unmount();
  });
});

/** Mounts the page and puts it on the review screen with a capture in hand. */
function mountWithCapture() {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(<CameraPage />);
  });
  // The page starts on the viewfinder; hand it a capture the way the camera does.
  act(() => {
    (viewfinderProps.onCaptured as (c: unknown) => void)({
      uri: 'file:///tmp/shot.jpg',
      kind: 'image',
      mimeType: 'image/jpeg',
    });
  });
  mounted.push(renderer!);
  return renderer!;
}

const settleUpload = async () => {
  await act(async () => {
    mockResolveUpload?.({ file: { id: 'file_1', contentType: 'image/jpeg' } });
    await Promise.resolve();
  });
};

/** Let every pending continuation run before asserting. */
const flushMicrotasks = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

/**
 * Press "post" and let the whole exit run to a stop.
 *
 * The press cannot be awaited directly: `publishNow` awaits the upload, and the
 * mocked `assetUpload` only settles when this helper says so — which is the
 * point, since the window between the two awaits is where the duplicate-post bug
 * lived.
 */
const pressPublishAndSettle = async () => {
  act(() => {
    void (capturedProps.onPublish as () => Promise<void>)();
  });
  await settleUpload();
  await flushMicrotasks();
};

beforeEach(() => {
  capturedProps = {};
  viewfinderProps = {};
  mockResolveUpload = undefined;
  mockCreatePost.mockReset();
  mockSetPendingShareMedia.mockReset();
});

describe('posting a capture', () => {
  it('creates ONE post however many times the button is pressed', async () => {
    // `createPost` never settles, which is exactly the window the bug lived in.
    mockCreatePost.mockReturnValue(new Promise(() => {}));
    mountWithCapture();

    const publish = capturedProps.onPublish as () => void;
    act(() => {
      void publish();
    });
    await settleUpload();
    // The upload has resolved; the post has not. Press again.
    act(() => {
      void publish();
    });
    // The second press returns at its first `await` and continues in a
    // microtask, so the second `createPost` would land AFTER this line without
    // a flush — and the assertion would pass over the bug it exists to catch.
    await flushMicrotasks();

    expect(mockCreatePost).toHaveBeenCalledTimes(1);
  });

  it('does not let the other exit race it either', async () => {
    mockCreatePost.mockReturnValue(new Promise(() => {}));
    mountWithCapture();

    act(() => {
      void (capturedProps.onPublish as () => void)();
    });
    await settleUpload();
    act(() => {
      void (capturedProps.onAddText as () => void)();
    });
    await flushMicrotasks();

    // Both exits are upload-then-do, and one capture must produce one of them.
    expect(mockSetPendingShareMedia).not.toHaveBeenCalled();
  });

  it('reports busy for the WHOLE operation, not just the upload', async () => {
    mockCreatePost.mockReturnValue(new Promise(() => {}));
    mountWithCapture();

    act(() => {
      void (capturedProps.onPublish as () => void)();
    });
    await settleUpload();

    // This is the flag the review disables its buttons on. It stayed true only
    // as long as the upload before the fix.
    expect(capturedProps.busy).toBe(true);
  });

  it('KEEPS the capture when the store creates no post', async () => {
    // `null` is a resolved promise and three real paths return it.
    mockCreatePost.mockResolvedValue(null);
    mountWithCapture();

    await pressPublishAndSettle();

    expect(capturedProps.capture).toBeTruthy();
    expect(capturedProps.publishFailed).toBe(true);
  });

  it('keeps it when the store throws, too', async () => {
    mockCreatePost.mockRejectedValue(new Error('offline'));
    mountWithCapture();

    await pressPublishAndSettle();

    expect(capturedProps.capture).toBeTruthy();
    expect(capturedProps.publishFailed).toBe(true);
  });

  it('and lets the reader try again after a failure', async () => {
    mockCreatePost.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ id: 'post_1' });
    mountWithCapture();

    await pressPublishAndSettle();
    // The upload is cached by URI now, so the second press goes straight to the
    // store — which is exactly why the guard has to release on the failure path.
    await act(async () => {
      await (capturedProps.onPublish as () => Promise<void>)();
    });

    // The guard released on the failure path — otherwise the second press would
    // be a no-op and the capture would be stuck.
    expect(mockCreatePost).toHaveBeenCalledTimes(2);
  });
});
