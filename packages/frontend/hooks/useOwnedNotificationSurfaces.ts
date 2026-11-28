// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useCallback, useLayoutEffect, useRef } from 'react';
import type { NotificationIntent } from '@/types/notificationIntent';
import { NotificationSurfaceOwner } from '@/utils/notificationSurfaceOwner';

export type OwnNotificationSurface = <Result>(
  intent: NotificationIntent,
  present: (signal: AbortSignal, onClosed: () => void) => Promise<Result>,
) => Promise<Result | undefined>;

/** Own each surface until its actual closure or its screen/session ends. */
export function useOwnedNotificationSurfaces(
  isCurrent: (intent: NotificationIntent) => boolean,
  subscribe: (listener: () => void) => () => void,
): OwnNotificationSurface {
  const ref = useRef<NotificationSurfaceOwner | null>(null);
  if (!ref.current) ref.current = new NotificationSurfaceOwner(isCurrent, subscribe);
  const owner = ref.current;

  useLayoutEffect(() => {
    owner.activate();
    return () => owner.dispose();
  }, [owner]);
  useLayoutEffect(() => owner.update(isCurrent, subscribe), [owner, isCurrent, subscribe]);

  return useCallback(
    <Result>(
      intent: NotificationIntent,
      present: (signal: AbortSignal, onClosed: () => void) => Promise<Result>,
    ): Promise<Result | undefined> => {
      if (!owner.usesSubscription(subscribe)) return Promise.resolve(undefined);
      return owner.open(intent, present);
    },
    [owner, subscribe],
  );
}
