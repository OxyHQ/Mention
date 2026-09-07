import type { LocalCapture } from './useCaptureUpload';

interface CameraCaptureProps {
  onCaptured: (capture: LocalCapture) => void;
  onClose: () => void;
}

/**
 * There is no camera on web, and this fork is what keeps its cost there at zero.
 *
 * `expo-camera` HAS a web build, so nothing fails if it reaches a web bundle —
 * it simply ships. And it did: expo-router puts every route file in the graph,
 * so `app/(app)/(tabs)/camera.web.tsx` did not keep `camera.tsx` out, and `dist/`
 * carried a 31KB chunk of a capture surface that platform never renders.
 *
 * Metro resolves `./CameraCapture` to THIS file on web, so the package is not
 * named on that side at all. The route fork above still exists and still does
 * its own job — sending a reader who typed `/camera` to the composer — but the
 * BUNDLE boundary is this one. `components/Camera/__tests__/cameraWebBoundary.test.ts`
 * pins both halves.
 *
 * It renders nothing rather than an explanation: the route never mounts it.
 */
export function CameraCapture(_props: CameraCaptureProps) {
  return null;
}
