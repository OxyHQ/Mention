// Base module for tsc / ESLint resolution.
// At bundle time, Metro resolves ExternalEmbedPlayer.native.tsx (react-native-webview
// + reanimated viewport pause) on native and ExternalEmbedPlayer.web.tsx (<iframe>) on
// web instead. The web variant carries NO native-only imports, so it is the safe base.
export { ExternalEmbedPlayer, type ExternalEmbedPlayerProps } from './ExternalEmbedPlayer.web';
