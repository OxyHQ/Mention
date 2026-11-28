// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { PublicCase } from '@oxy.so/homiio-sdk/client';
import { VisibleReferenceStore } from './VisibleReferenceStore';

/**
 * No provider fetch or SDK initialization runs during feed hydration or import.
 * The `client` entry checks responses without Zod, so cards add no second way
 * for zod into the app (see `lib/notificationValidation`).
 */
export const homiioCases = new VisibleReferenceStore<PublicCase>(async (ids, options) => {
  const { HomiioClient } = await import('@oxy.so/homiio-sdk/client');
  return new HomiioClient().getPublicCases(ids, options);
});
