// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { watchPushOpens } from '../notifications';

/**
 * A tapped push must reach the app with Mention's payload — read from the FCM
 * remote message, where a tray tap carries it — exactly once, even though the
 * push that launched the app is reported both as the last response and through
 * the listener. A dismissal is not an open.
 */

const DEFAULT = 'expo.modules.notifications.actions.DEFAULT';

const response = (identifier: string, actionIdentifier = DEFAULT) =>
  ({
    actionIdentifier,
    notification: {
      request: {
        identifier,
        content: { data: null },
        trigger: { remoteMessage: { data: { notificationId: `n-${identifier}`, entityId: 'p1' } } },
      },
    },
  }) as never;

it('opens each tapped push once, with its FCM data, and ignores dismissals', () => {
  let listener: ((response: never) => void) | undefined;
  const onOpen = jest.fn();
  watchPushOpens(
    {
      DEFAULT_ACTION_IDENTIFIER: DEFAULT,
      addNotificationResponseReceivedListener: (fn) => {
        listener = fn;
        return { remove: () => undefined };
      },
      getLastNotificationResponse: () => response('cold'),
      clearLastNotificationResponse: () => undefined,
    },
    onOpen,
  );

  listener?.(response('cold'));
  listener?.(response('dismissed', 'expo.modules.notifications.actions.DISMISS'));
  listener?.(response('warm'));

  expect(onOpen.mock.calls).toEqual([
    [{ notificationId: 'n-cold', entityId: 'p1' }],
    [{ notificationId: 'n-warm', entityId: 'p1' }],
  ]);
});
