// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { APP_ORIGIN, CANDIDATE_ORIGIN } from './environment';
import { loadColdEvidence, validateColdAppOrigin } from './coldIdentityEvidence';

// No HTTP preflight: both database absence reports precede every browser request.
export default function coldIdentityPreflight(): void {
  validateColdAppOrigin(CANDIDATE_ORIGIN, APP_ORIGIN);
  loadColdEvidence();
}
