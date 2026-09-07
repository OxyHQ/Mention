import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router, useIsFocused } from 'expo-router';
import { logger } from '@oxyhq/core/logger';

import { CameraCapture } from '@/components/Camera/CameraCapture';
import { CaptureReview } from '@/components/Camera/CaptureReview';
import { useCaptureUpload, type LocalCapture } from '@/components/Camera/useCaptureUpload';
import { useTabPager } from '@/context/TabPagerContext';
import { pageIndexByName } from '@/components/navigation/tabs';
import { usePostsStore } from '@/stores/postsStore';
import { setPendingShareMedia } from '@/utils/pendingShareMedia';
import { buildCapturePost } from '@/utils/postBuilder';

/**
 * The camera, as a page of the tab pager — reached by swiping right off Home and
 * from the feed header's camera button.
 *
 * IT DRAWS NO BAR ITEM, which is what makes it a page rather than a tab, and the
 * reason `components/navigation/tabs.ts` separates those two index spaces at
 * all. The bar fades out as the finger brings this page in, driven by the same
 * pager frames that move the highlight (`chromeProgress`).
 *
 * THE PREVIEW IS UNMOUNTED THE MOMENT THE PAGE LOSES FOCUS. A live `CameraView`
 * holds the sensor: the OS capture indicator stays lit, the battery drains, and
 * on Android a second surface cannot open one. `useIsFocused` is the whole
 * mechanism — the page keeps its React state (a capture under review survives a
 * swipe away and back), but the hardware does not stay open behind the feed.
 * `preload: false` in the page table is the other half: a camera mounted merely
 * for being Home's NEIGHBOUR would do all of that without the reader ever
 * arriving.
 *
 * THE COMPOSER IS PUSHED, NEVER SWITCHED TO. The "add text" exit hands the
 * upload over through `pendingShareMedia`, a consume-once buffer that the
 * always-mounted `/write` TAB deliberately does not read (`ComposeScreen.tsx`
 * documents why: it would drain the buffer before the pushed composer mounted).
 * So this pushes the `/compose` ROUTE, like the fourteen other call sites that
 * open the composer with something already in it.
 */
export default function CameraPage() {
  const isFocused = useIsFocused();
  const [capture, setCapture] = useState<LocalCapture | null>(null);
  const { upload, busy, failed, reset } = useCaptureUpload();
  const { selectTab } = useTabPager();
  const createPost = usePostsStore((state) => state.createPost);

  const leaveToFeed = useCallback(() => {
    setCapture(null);
    reset();
    selectTab(pageIndexByName('index'));
  }, [reset, selectTab]);

  const retake = useCallback(() => {
    setCapture(null);
    reset();
  }, [reset]);

  const publishNow = useCallback(async () => {
    if (!capture) return;
    const uploaded = await upload(capture);
    // `upload` reports its own failure through `failed`, which the review screen
    // is showing. Leaving the reader on their capture is the only outcome that
    // does not lose it.
    if (!uploaded) return;
    try {
      await createPost(buildCapturePost(uploaded.media));
    } catch (error) {
      logger.warn('publishing a capture failed', { error });
      return;
    }
    leaveToFeed();
  }, [capture, upload, createPost, leaveToFeed]);

  const addText = useCallback(async () => {
    if (!capture) return;
    const uploaded = await upload(capture);
    if (!uploaded) return;
    setPendingShareMedia([{ id: uploaded.media.id, contentType: uploaded.contentType }]);
    setCapture(null);
    reset();
    router.push('/compose');
  }, [capture, upload, reset]);

  if (capture) {
    return (
      <CaptureReview
        capture={capture}
        onPublish={publishNow}
        onAddText={addText}
        onRetake={retake}
        busy={busy}
        failed={failed}
      />
    );
  }

  // A plain black view rather than nothing: this is a PAGE of the pager, and the
  // pager addresses its children by position — a page that rendered nothing
  // would still occupy its slot, but it would flash the app background through
  // as the finger brings it in.
  if (!isFocused) return <View style={{ flex: 1, backgroundColor: '#000' }} />;

  return <CameraCapture onCaptured={setCapture} onClose={leaveToFeed} />;
}
