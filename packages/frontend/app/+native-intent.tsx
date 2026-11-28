// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { requestSettings } from '@/components/settings/settingsRoutes';

/**
 * The path an incoming URL addresses: `https://mention.earth/settings` and
 * `mention://settings` both mean `/settings` (a custom scheme's "host" is the
 * first path segment, which is how Expo Router reads it too).
 */
export function linkPath(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)(.*)$/i.exec(url);
  if (!match) return url;
  const [, authority, rest] = match;
  if (/^https?:/i.test(url) || !authority) return rest || '/';
  return `/${authority}${rest}`;
}

/**
 * Every native link passes through here before Expo Router navigates.
 *
 * Settings is a modal, so its links open the modal and never navigate: a warm
 * link returns null (stay where the reader is), a cold one lands on Home with
 * the modal over it. See `components/settings/settingsRoutes.ts` for why a
 * settings screen in the native stack is not an option.
 */
export function redirectSystemPath({
  path,
  initial,
}: {
  path: string;
  initial: boolean;
}): string | null {
  try {
    if (requestSettings(linkPath(path))) return initial ? '/' : null;
  } catch {
    // A throw here crashes the app; an unhandled link must still open normally.
  }
  return path;
}
