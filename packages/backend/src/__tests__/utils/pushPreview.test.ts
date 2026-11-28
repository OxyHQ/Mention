// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it } from 'vitest';
import { formatPushForNotification } from '../../utils/push';

describe('out-of-band notification privacy', () => {
  it.each(['post', 'reply', 'mention', 'quote', 'boost'])(
    'keeps %s body text behind the authenticated read',
    async (type) => {
      const push = await formatPushForNotification(
        { id: 'notice', type, entityId: 'post', entityType: 'post', actorId: 'author' },
        { actor: async () => ({ name: { displayName: 'Ada' } }) },
      );
      expect(push.data).not.toHaveProperty('preview');
      expect(push.body).not.toContain('undefined');
      expect(push.body).toMatch(/^Ada /);
    },
  );
});
