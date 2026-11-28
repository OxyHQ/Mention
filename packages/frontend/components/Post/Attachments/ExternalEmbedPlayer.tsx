// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

// Base module for tsc / ESLint resolution.
// At bundle time, Metro resolves ExternalEmbedPlayer.native.tsx (react-native-webview
// + reanimated viewport pause) on native and ExternalEmbedPlayer.web.tsx (<iframe>) on
// web instead. The web variant carries NO native-only imports, so it is the safe base.
export { ExternalEmbedPlayer, type ExternalEmbedPlayerProps } from './ExternalEmbedPlayer.web';
