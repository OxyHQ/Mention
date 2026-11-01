// Base module for ESLint / tsc import resolution.
// At build time, bundlers resolve chunkReload.native.ts or chunkReload.web.ts instead.
export { recoverChunkError, registerChunkErrorRecovery } from './chunkReload.web';
