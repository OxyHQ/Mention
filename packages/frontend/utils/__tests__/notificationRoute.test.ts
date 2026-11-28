// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { notificationSubjectHref } from '../notificationRoute';

it('routes a notification to the subject it names by id, and nothing else', () => {
  expect(notificationSubjectHref({ type: 'like', entityType: 'post', entityId: 'p1' })).toBe(
    '/p/p1',
  );
  expect(notificationSubjectHref({ type: 'reply', entityType: 'reply', entityId: 'r1' })).toBe(
    '/p/r1',
  );
  expect(
    notificationSubjectHref({ type: 'event_cancelled', entityType: 'event', entityId: 'e1' }),
  ).toBe('/events/e1');
  expect(notificationSubjectHref({ type: 'follow', entityType: 'profile', entityId: 'u1' })).toBe(
    null,
  );
  expect(notificationSubjectHref({ type: 'like', entityType: 'post', entityId: '' })).toBe(null);
});
