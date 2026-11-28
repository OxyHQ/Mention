// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { User } from '@oxy.so/core';

/** Native documents carry no server bootstrap; see `documentBootstrap.web.ts`. */
export function bootstrapProfileFor(_handle: string): User | null {
  return null;
}
