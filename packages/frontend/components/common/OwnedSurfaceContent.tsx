// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useCallback, useSyncExternalStore, type ReactNode } from 'react';

/** Hide session-owned content when its surface is invalidated, including during exit. */
export function OwnedSurfaceContent({
  signal,
  children,
}: {
  signal: AbortSignal;
  children: ReactNode;
}) {
  const subscribe = useCallback(
    (listener: () => void) => {
      signal.addEventListener('abort', listener);
      return () => signal.removeEventListener('abort', listener);
    },
    [signal],
  );
  const getSnapshot = useCallback(() => signal.aborted, [signal]);
  const aborted = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return aborted ? null : children;
}
