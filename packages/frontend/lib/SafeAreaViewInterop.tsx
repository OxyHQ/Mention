// Base module for type-checking / import resolution (tsc + ESLint).
// At build time Metro resolves SafeAreaViewInterop.native.tsx or
// SafeAreaViewInterop.web.tsx instead. See livekit.ts / shareIntent.ts for the
// same platform-split pattern.
export { SafeAreaView } from './SafeAreaViewInterop.web';
