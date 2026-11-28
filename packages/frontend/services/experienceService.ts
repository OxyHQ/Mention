// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { ClarityClient, clarityForOxySession } from '@clarity.surf/sdk';
import type { Experience, ExperienceInput } from '@clarity.surf/sdk/experience';
import { CLARITY_API_URL } from '@/config';
import { oxyServices } from '@/lib/oxyServices';

const publicClarity = new ClarityClient({ baseUrl: CLARITY_API_URL });
const authenticatedClarity = clarityForOxySession(oxyServices, {
  baseUrl: CLARITY_API_URL,
  timeoutMs: 15_000,
});

/** Clarity is the canonical store; Mention never persists a second work history. */
export const experienceService = {
  async list(userId: string, authenticated = false): Promise<Experience[]> {
    const result = await (authenticated ? authenticatedClarity : publicClarity).experience.list(
      userId,
    );
    return result.items;
  },
  create(input: ExperienceInput): Promise<Experience> {
    return authenticatedClarity.experience.create(input);
  },
  update(id: string, input: ExperienceInput): Promise<Experience> {
    return authenticatedClarity.experience.update(id, input);
  },
  async remove(id: string): Promise<void> {
    await authenticatedClarity.experience.delete(id);
  },
};
