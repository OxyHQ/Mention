import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
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
 * replays the call once its ref exists (one commit later — the fly-in starts
 * from the rect measured at press time, so nothing visible is lost). After
 * that the viewer stays mounted for this owner, exactly as before.
 */
export const LazyZoomableGallery = forwardRef<ZoomableMediaGalleryHandle, ZoomableMediaGalleryProps>(
  function LazyZoomableGallery(props, ref) {
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

    useEffect(() => {
      if (!pending || !galleryRef.current) return;
      galleryRef.current.open(...pending);
      setPending(null);
    }, [pending, mounted]);

    return mounted ? <ZoomableMediaGallery ref={galleryRef} {...props} /> : null;
  },
);
