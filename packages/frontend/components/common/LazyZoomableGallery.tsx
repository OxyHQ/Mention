// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { forwardRef, useLayoutEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  ZoomableMediaGallery,
  type ZoomableMediaGalleryHandle,
  type ZoomableMediaGalleryProps,
} from '@oxy.so/bloom/zoomable-media-gallery';

type OpenArgs = Parameters<ZoomableMediaGalleryHandle['open']>;

/**
 * Bloom's `ZoomableMediaGallery`, mounted the first time it is OPENED.
 *
 * The gallery is a full viewer — pager, pinch/pan gestures, shared values,
 * keyboard handling — and holds ~100 hook slots while it sits closed. A feed
 * row with an image mounted one eagerly, so every image row in a fling paid for
 * a viewer almost nobody opens (issue #1103, measured with the row-cost
 * harness). It renders through Bloom's `Portal`, so WHERE it mounts changes
 * nothing about how it looks; only WHEN it mounts moves.
 *
 * The handle is the gallery's own: the first `open()` mounts the viewer and
 * replays the call in a layout effect once its ref exists, before paint. The fly-in starts
 * from the rect measured at press time, so nothing visible is lost. After
 * that the viewer stays mounted for this owner, exactly as before.
 */
export const LazyZoomableGallery = forwardRef<
  ZoomableMediaGalleryHandle,
  ZoomableMediaGalleryProps
>(function LazyZoomableGallery(props, ref) {
  const galleryRef = useRef<ZoomableMediaGalleryHandle>(null);
  const [pending, setPending] = useState<OpenArgs | null>(null);
  const [mounted, setMounted] = useState(false);

  useImperativeHandle(
    ref,
    () => ({
      open: (...args: OpenArgs) => {
        if (galleryRef.current) {
          galleryRef.current.open(...args);
          return;
        }
        setPending(args);
        setMounted(true);
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    if (!pending || !galleryRef.current) return;
    galleryRef.current.open(...pending);
    setPending(null);
  }, [pending, mounted]);

  return mounted ? <ZoomableMediaGallery ref={galleryRef} {...props} /> : null;
});
