// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useEffect } from 'react';
import { recordBootMilestone, type BootMilestone as BootMilestoneName } from '@/lib/webTelemetry';

/**
 * Records a boot milestone when this element first commits. Placed where a
 * gate opens, so the milestone is the moment the gated tree actually mounted.
 * Renders nothing; a no-op on native.
 */
export function BootMilestone({ name }: { name: BootMilestoneName }) {
  useEffect(() => {
    recordBootMilestone(name);
  }, [name]);
  return null;
}
