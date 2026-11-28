// Base module for ESLint import resolution.
// At build time, bundlers resolve livekit.native.ts or livekit.web.ts instead.
export { initLiveKit } from './livekit.web';
