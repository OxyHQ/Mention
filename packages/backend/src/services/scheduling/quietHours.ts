// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { getRuntimeOxyClient } from '../../runtime/oxyClient';
import { logger } from '../../utils/logger';

/**
 * Quiet hours (oxy ADR 0068): Oxy answers which accounts are in theirs right
 * now, a minor's 22:00 to 07:00 on their own timezone. Mention holds no age and
 * no timezone, so it asks.
 *
 * Everything Mention pushes is social (a reply, a like, a follow) and can wait
 * until morning: the notification is written and sits in the inbox either way.
 */

/** Oxy takes at most this many accounts per question. */
const QUIET_HOURS_BATCH = 100;

/**
 * The accounts among `accountIds` that must not be pushed to right now.
 *
 * If Oxy cannot answer, nobody is treated as quiet. Failing the other way would
 * silence every push to everyone, adults included, for as long as the outage
 * lasted; the cost of this way is a late-night push to a minor during one.
 */
export async function accountsInQuietHours(accountIds: readonly string[]): Promise<Set<string>> {
  const quiet = new Set<string>();
  const unique = [...new Set(accountIds)];
  if (unique.length === 0) return quiet;
  const oxy = getRuntimeOxyClient();
  try {
    for (let start = 0; start < unique.length; start += QUIET_HOURS_BATCH) {
      const batch = unique.slice(start, start + QUIET_HOURS_BATCH);
      for (const id of await oxy.accountsInQuietHours(batch)) quiet.add(id);
    }
    return quiet;
  } catch (error: unknown) {
    logger.warn('[QuietHours] Oxy could not answer; no push is held', {
      accounts: unique.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Set();
  }
}
