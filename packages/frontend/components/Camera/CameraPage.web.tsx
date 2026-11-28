import { Redirect } from '@/lib/navigation/router';

/**
 * `/camera` on WEB, where there is no camera.
 *
 * The capture surface is `expo-camera`, a native module with no web
 * implementation, and web has no pager to swipe onto this page with either
 * (`(tabs)/_layout.tsx` renders a bare `<Slot/>`). Instagram's web app makes the
 * same call. So the page exists here only because the route file does, and it
 * sends the reader to the composer — the thing they were going to reach anyway.
 *
 * This fork is ALSO what keeps `expo-camera` out of the web bundle. It is a
 * MODULE fork, which Metro resolves per platform, so on web nothing names
 * `CameraPage.tsx` or the capture surface it imports. A route fork does not do
 * that: expo-router bundles every route file for every platform, so a native
 * `camera.tsx` beside a `camera.web.tsx` shipped anyway — its 31KB of
 * `expo-camera` once, and later the composer's post builders, which it shared
 * with the composer and so dragged into the startup chunk.
 * `components/Camera/__tests__/cameraWebBoundary.test.ts` pins it.
 */
export default function CameraPageWeb() {
  return <Redirect href="/write" />;
}
