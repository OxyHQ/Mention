/**
 * Web-only replacement for Bloom's generated base64 font-data module.
 *
 * Expo copies `public/` to the web export root, so Bloom's existing
 * `applyFontFaces()` implementation can keep creating the same @font-face
 * declarations while the browser downloads and caches the binary assets
 * independently from the application JavaScript.
 */
export const blomusModernusRegular =
  '/fonts/BlomusModernus-Regular-19002cade532.woff2';
export const blomusModernusBold =
  '/fonts/BlomusModernus-Bold-e51f23ca66ee.woff2';
export const interVariable = '/fonts/InterVariable-3100e775e861.woff2';
export const geistMonoVariable =
  '/fonts/GeistMono-Variable-af61b969e7f9.woff2';
