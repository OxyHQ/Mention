// Base module for ESLint / tsc import resolution.
// At build time, bundlers resolve socketBfcache.native.ts or socketBfcache.web.ts instead.
export { registerSocketBfcacheRelease } from './socketBfcache.web';
