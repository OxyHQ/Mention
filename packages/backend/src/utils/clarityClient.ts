// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { ClarityClient } from '@clarity.surf/sdk' with { 'resolution-mode': 'import' };

import { config } from '../config';
import { getServiceOxyClient } from './oxyHelpers';

let client: Promise<ClarityClient> | undefined;

export function getClarityClient(): Promise<ClarityClient> {
  if (client) return client;
  client = import('@clarity.surf/sdk/server').then(({ clarityForOxyService }) =>
    clarityForOxyService(getServiceOxyClient(), { baseUrl: config.clarityApiUrl }),
  );
  return client;
}
