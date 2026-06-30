// Base module for type-checking / import resolution (tsc + ESLint).
// At build time Metro resolves IconSvg.native.tsx (native) or IconSvg.web.tsx
// (web) instead. Mirrors the platform-split pattern in lib/livekit.ts.
//
// Why the split: react-native-svg resolves `fill/stroke="currentColor"` from
// the <Svg> `color` prop on native, but from the CSS cascade on web. The two
// platforms therefore deliver the icon's `text-*` color through different
// channels — see the per-platform files for the full explanation.
export { IconSvg } from './IconSvg.web';
