import { useCallback, useRef, useState } from 'react';
import { useRouter, useIsFocused } from '@/lib/navigation/router';
import { logger } from '@oxy.so/core/logger';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxy.so/bloom/toast';

import { CameraCapture } from '@/components/Camera/CameraCapture';
import { CaptureReview } from '@/components/Camera/CaptureReview';
import { useCaptureUpload, type LocalCapture } from '@/components/Camera/useCaptureUpload';
import { BloomColorScope } from '@oxy.so/bloom/theme';
import { Screen } from '@oxy.so/bloom/screen';
import { useTabPager } from '@oxy.so/bloom/tab-pager';
import { usePostsStore } from '@/stores/postsStore';
import { setPendingShareMedia } from '@/utils/pendingShareMedia';
import { buildCapturePost } from '@/utils/postBuilder';
import { usePublicationContinuation } from '@/hooks/usePublicationContinuation';

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
 * An unconfirmed publication keeps the capture. The composer does not retry
 * an uncertain result: the server may have created the post before the response
 * was lost. Core's existing 401 refresh/replay policy is separate. A confirmed
 * publication may still return no local model when caching fails.
 *
 * THE COMPOSER IS PUSHED, NEVER SWITCHED TO. The "add text" exit hands the
 * upload over through `pendingShareMedia`, a consume-once buffer that the
 * always-mounted `/write` TAB deliberately does not read (`ComposeScreen.tsx`
 * documents why: it would drain the buffer before the pushed composer mounted).
 * So this pushes the `/compose` ROUTE, like the fourteen other call sites that
 * open the composer with something already in it.
 */
export default function CameraPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const isFocused = useIsFocused();
  const [capture, setCapture] = useState<LocalCapture | null>(null);
  const {
    upload,
    busy: uploading,
    failed: uploadFailed,
    progress,
    reset,
  } = useCaptureUpload(isFocused);
  const [publishing, setPublishing] = useState(false);
  const [publishFailed, setPublishFailed] = useState(false);
  // The synchronous half of `publishing`; see the note above on why both.
  const working = useRef(false);
  const { selectTab } = useTabPager();
  const createPost = usePostsStore((state) => state.createPost);
  const { capture: capturePublication, isMounted: isPublicationMounted } =
    usePublicationContinuation();

  const clearCapture = useCallback(() => {
    setCapture(null);
    setPublishFailed(false);
    reset();
  }, [reset]);

  const leaveToFeed = useCallback(() => {
    clearCapture();
    selectTab('index');
  }, [clearCapture, selectTab]);

  const retake = useCallback(() => {
    if (working.current) return;
    clearCapture();
  }, [clearCapture]);

  const publishNow = useCallback(async () => {
    const isCurrentOwner = capturePublication();
    if (!capture || working.current) return;
    if (!isCurrentOwner) {
      toast(t('common.error', { defaultValue: 'Something went wrong' }), { type: 'error' });
      return;
    }
    working.current = true;
    setPublishing(true);
    setPublishFailed(false);
    try {
      const uploaded = await upload(capture);
      // `upload` reports its own failure through `uploadFailed`, which the review
      // screen is showing. Leaving the reader on their capture is the only
      // outcome that does not lose it.
      if (!uploaded) return;
      if (!isCurrentOwner()) return;

      await createPost(buildCapturePost(uploaded.media));
      if (!isCurrentOwner()) return;
      leaveToFeed();
    } catch (error) {
      logger.warn('publishing a capture failed', { error });
      if (isCurrentOwner()) setPublishFailed(true);
    } finally {
      working.current = false;
      if (isPublicationMounted()) setPublishing(false);
    }
  }, [capture, upload, createPost, leaveToFeed, capturePublication, isPublicationMounted, t]);

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
  }, [capture, upload, clearCapture, router]);

  // A dark surface, so Bloom gives it light status-bar content while it is the
  // page in front. Black even before the camera mounts: the pager brings this
  // page in by position, and an empty page would flash the app background.
  return (
    <BloomColorScope mode="dark" asChild>
      <Screen scroll="none" style={{ backgroundColor: '#000' }}>
        {capture ? (
          <CaptureReview
            capture={capture}
            onPublish={publishNow}
            onAddText={addText}
            onRetake={retake}
            busy={uploading || publishing}
            uploadFailed={uploadFailed}
            uploadProgress={progress}
            publishFailed={publishFailed}
          />
        ) : isFocused ? (
          <CameraCapture onCaptured={setCapture} onClose={leaveToFeed} />
        ) : null}
      </Screen>
    </BloomColorScope>
  );
}
