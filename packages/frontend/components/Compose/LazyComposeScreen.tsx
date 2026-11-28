// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { FormSkeleton } from '@/components/loading/ContentSkeleton';
import { lazy, Suspense } from 'react';
import type { ComposeScreenProps } from './ComposeScreen';

// The composer is served by two routes, `/compose` and the `/write` tab. Each
// route is its own async chunk, so a static import from both would make Metro
// share the composer between them and hoist it into `__common`, which every
// page load downloads. Both routes render through this one boundary instead,
// so the composer is a single chunk fetched when someone opens it.
const ComposeScreen = lazy(() => import('./ComposeScreen'));

export default function LazyComposeScreen(props: ComposeScreenProps) {
  return (
    <Suspense fallback={<FormSkeleton />}>
      <ComposeScreen {...props} />
    </Suspense>
  );
}
