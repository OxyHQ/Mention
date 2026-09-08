import React from 'react';
import { Redirect } from 'expo-router';

/**
 * `/camera` on WEB, where there is no camera.
 *
 * The capture surface is `expo-camera`, a native module with no web
 * implementation, and web has no pager to swipe onto this page with either
 * (`(tabs)/_layout.tsx` renders a bare `<Slot/>`). Instagram's web app makes the
 * same call. So the page exists here only because the route file does, and it
 * sends the reader to the composer — the thing they were going to reach anyway.
 *
 * This fork is ALSO what keeps `expo-camera` out of the web bundle: the import
 * lives in `camera.tsx`, which a web build never resolves. Same mechanism, and
 * the same reason, as `components/navigation/TabsPager.web.tsx` and
 * `react-native-pager-view`, and it is checked the same way — the bundle
 * analyzer must not find the package in `dist/`.
 */
export default function CameraPageWeb() {
  return <Redirect href="/write" />;
}
