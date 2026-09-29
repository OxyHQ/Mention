/**
 * Web: point dotLottie at the WebAssembly renderer SERVED BY THIS ORIGIN.
 *
 * dotLottie draws with ThorVG compiled to WebAssembly and, left alone, fetches
 * that binary from a public npm CDN — which Mention's CSP refuses
 * (`connect-src`), and which would make every sticker depend on a third party
 * being up. Bundled as an asset instead, it ships under `/assets` with a
 * content hash and the immutable cache header `public/_headers` gives that
 * path. Compiling it needs `'wasm-unsafe-eval'` in `script-src`
 * (`packages/backend/src/app.ts`).
 *
 * If this is ever skipped, Bloom's `Sticker` does not break: it shows the
 * sticker's still image instead of the animation.
 */
import { setWasmUrl } from '@lottiefiles/dotlottie-react';
import { Asset } from 'expo-asset';

let configured = false;

export function configureLottieWeb(): void {
  if (configured) return;
  configured = true;
  const wasm = Asset.fromModule(require('@lottiefiles/dotlottie-web/dotlottie-player.wasm'));
  setWasmUrl(wasm.uri);
}
