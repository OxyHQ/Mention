// The page is a MODULE fork (`CameraPage.tsx` / `CameraPage.web.tsx`), not a
// route fork: expo-router bundles every route file for every platform, so a
// native route body here would ship to web — and share the composer's post
// builders with it, which hoisted them into the startup chunk.
export { default } from '@/components/Camera/CameraPage';
