// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

// The page is a MODULE fork (`CameraPage.tsx` / `CameraPage.web.tsx`), not a
// route fork: expo-router bundles every route file for every platform, so a
// native route body here would ship to web — and share the composer's post
// builders with it, which hoisted them into the startup chunk.
export { default } from '@/components/Camera/CameraPage';
