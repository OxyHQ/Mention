import { StrictMode, Suspense, useEffect } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { consumePendingShareMedia, setPendingShareMedia } from '@/utils/pendingShareMedia';
import { usePendingShareMedia } from '../usePendingShareMedia';
import type { ComposePresentation } from '../useComposeExit';

const uploaded = [{ id: 'uploaded-camera-video', contentType: 'video/mp4' }];
const neverResolves = new Promise<void>(() => {});

function PendingChild({ suspend }: { suspend: boolean }) {
  if (suspend) throw neverResolves;
  return null;
}

function Composer({
  suspend = false,
  presentation = 'pushed',
  attach,
}: {
  suspend?: boolean;
  presentation?: ComposePresentation;
  attach: jest.Mock;
}) {
  const media = usePendingShareMedia(presentation);
  useEffect(() => {
    attach(media.current);
  }, [attach, media]);
  return <PendingChild suspend={suspend} />;
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  consumePendingShareMedia();
});

it('preserves an uploaded attachment when an initial render suspends and is discarded', async () => {
  setPendingShareMedia(uploaded);
  const attach = jest.fn();
  let tree: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    tree = TestRenderer.create(
      <Suspense fallback={null}>
        <Composer suspend attach={attach} />
      </Suspense>,
    );
  });
  expect(attach).not.toHaveBeenCalled();
  await act(async () => {
    tree?.unmount();
  });
  await act(async () => {
    tree = TestRenderer.create(<Composer attach={attach} />);
  });
  expect(attach).toHaveBeenLastCalledWith(uploaded);
  expect(consumePendingShareMedia()).toEqual([]);
  await act(async () => {
    tree?.unmount();
  });
});

it('leaves shared files for a pushed composer when the persistent compose tab mounts', async () => {
  setPendingShareMedia(uploaded);
  const attach = jest.fn();
  let tree: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    tree = TestRenderer.create(<Composer presentation="tab" attach={attach} />);
  });
  expect(attach).toHaveBeenLastCalledWith([]);
  expect(consumePendingShareMedia()).toEqual(uploaded);
  await act(async () => {
    tree?.unmount();
  });
});

it('does not reattach an earlier upload when a later blank composer opens', async () => {
  setPendingShareMedia(uploaded);
  const attach = jest.fn();
  let tree: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    tree = TestRenderer.create(<Composer attach={attach} />);
  });
  expect(attach).toHaveBeenLastCalledWith(uploaded);
  await act(async () => {
    tree?.unmount();
  });
  await act(async () => {
    tree = TestRenderer.create(<Composer attach={attach} />);
  });
  expect(attach).toHaveBeenLastCalledWith([]);
  await act(async () => {
    tree?.unmount();
  });
});

it('keeps the claimed files through StrictMode effect replay and leaves later handoffs untouched', async () => {
  setPendingShareMedia(uploaded);
  const attach = jest.fn();
  let tree: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    tree = TestRenderer.create(
      <StrictMode>
        <Composer attach={attach} />
      </StrictMode>,
    );
  });
  expect(
    attach.mock.calls.every(([files]) => JSON.stringify(files) === JSON.stringify(uploaded)),
  ).toBe(true);
  const later = [{ id: 'next-camera-photo', contentType: 'image/jpeg' }];
  setPendingShareMedia(later);
  await act(async () => {
    tree?.update(
      <StrictMode>
        <Composer attach={attach} />
      </StrictMode>,
    );
  });
  expect(consumePendingShareMedia()).toEqual(later);
  await act(async () => {
    tree?.unmount();
  });
});
