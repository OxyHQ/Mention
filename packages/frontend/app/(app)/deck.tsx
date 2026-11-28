// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { Redirect } from '@/lib/navigation/router';

/** Keep deep links safe on native; the Deck workspace is desktop web only. */
export default function DeckScreen() {
  return <Redirect href="/" />;
}
