import React, { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { router, useIsFocused } from 'expo-router';
import { logger } from '@oxy.so/core/logger';

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
 * ONE EXIT AT A TIME, AND ALL THE WAY THROUGH. Both exits are upload-then-do,
 * and the upload hook's own `busy` ends when the UPLOAD does — so between that
 * and `createPost` resolving, the review's buttons were live again and a second
 * press published the same capture twice (the upload is cached by URI, so it
 * returned instantly and went straight to a second create). The guard here spans
 * the whole operation, covers BOTH exits so they cannot race each other, and is
 * a ref as well as state: state lands on the next render and the second press
 * arrives before that.
 *
 * A POST THAT DID NOT HAPPEN KEEPS THE CAPTURE. `createPost` RETURNS `null` on
 * three paths that never throw — the response reported no success, it carried no
 * post, or the viewer changed mid-flight — and treating a resolved promise as a
 * published post threw the capture away with nothing to show for it. Nothing is
 * retried automatically either: on the viewer-epoch path the request may well
 * have reached the server, so re-sending it is how one capture becomes two
 * posts. The reader is left on their capture, told, and decides.
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
  const { upload, busy: uploading, failed: uploadFailed, reset } = useCaptureUpload();
  const [publishing, setPublishing] = useState(false);
  const [publishFailed, setPublishFailed] = useState(false);
  // The synchronous half of `publishing`; see the note above on why both.
  const working = useRef(false);
  const { selectTab } = useTabPager();
  const createPost = usePostsStore((state) => state.createPost);

  const clearCapture = useCallback(() => {
    setCapture(null);
    setPublishFailed(false);
    reset();
  }, [reset]);

  const leaveToFeed = useCallback(() => {
    clearCapture();
    selectTab(pageIndexByName('index'));
  }, [clearCapture, selectTab]);

  const retake = useCallback(() => {
    if (working.current) return;
    clearCapture();
  }, [clearCapture]);

  const publishNow = useCallback(async () => {
    if (!capture || working.current) return;
    working.current = true;
    setPublishing(true);
    setPublishFailed(false);
    try {
      const uploaded = await upload(capture);
      // `upload` reports its own failure through `uploadFailed`, which the review
      // screen is showing. Leaving the reader on their capture is the only
      // outcome that does not lose it.
      if (!uploaded) return;

      const created = await createPost(buildCapturePost(uploaded.media));
      if (!created) {
        // Resolved, but nothing was published. Deliberately not retried: on the
        // viewer-epoch path the request may have reached the server anyway.
        logger.warn('publishing a capture produced no post');
        setPublishFailed(true);
        return;
      }
      leaveToFeed();
    } catch (error) {
      logger.warn('publishing a capture failed', { error });
      setPublishFailed(true);
    } finally {
      working.current = false;
      setPublishing(false);
    }
  }, [capture, upload, createPost, leaveToFeed]);

  const addText = useCallback(async () => {
    if (!capture || working.current) return;
    working.current = true;
    setPublishing(true);
    setPublishFailed(false);
    try {
      const uploaded = await upload(capture);
      if (!uploaded) return;
      setPendingShareMedia([{ id: uploaded.media.id, contentType: uploaded.contentType }]);
      clearCapture();
      router.push('/compose');
    } finally {
      working.current = false;
      setPublishing(false);
    }
  }, [capture, upload, clearCapture]);

  if (capture) {
    return (
      <CaptureReview
        capture={capture}
        onPublish={publishNow}
        onAddText={addText}
        onRetake={retake}
        busy={uploading || publishing}
        uploadFailed={uploadFailed}
        publishFailed={publishFailed}
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
