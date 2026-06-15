// Base module for type-checking / import resolution (tsc + ESLint).
// At build time Metro resolves useCurrentColor.native.ts or
// useCurrentColor.web.ts instead. See lib/livekit.ts for the same
// platform-split pattern.
export { useCurrentColor } from './useCurrentColor.web';
