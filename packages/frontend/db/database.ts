// TypeScript fallback. Metro resolves database.native.ts or database.web.ts
// first for platform builds; using the web contract here keeps editor and
// non-Metro tooling free of expo-sqlite.
export * from './database.web';
