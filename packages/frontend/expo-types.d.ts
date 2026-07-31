// Expo's ambient module declarations (`*.css`, `*.svg`, image assets, the
// react-native-web globals) — the same set Expo's own generated `expo-env.d.ts`
// pulls in.
//
// That generated file cannot carry this for us: it is gitignored (Expo owns it
// and rewrites it), so on a fresh checkout — CI included — it simply does not
// exist. TypeScript <=5 did not care, because a side-effect import of a module
// it could not resolve was silently allowed. TypeScript 7 reports it (TS2882),
// which makes `import '../global.css'` in `app/_layout.tsx` a hard error unless
// the declaration is committed. Referencing Expo's own declarations keeps that
// contract owned by the package that ships the loaders, rather than restating
// `declare module '*.css'` here.
/// <reference types="expo/types" />
