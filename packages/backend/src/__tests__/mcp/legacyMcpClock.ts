import { afterEach, beforeEach, vi } from 'vitest';
import { MENTION_LEGACY_MCP_AUTH_CUTOFF_MS } from '@mention/shared-types/mcpCapabilities';

/** A day before Mention-issued (legacy) MCP tokens stopped being honoured. */
export const BEFORE_LEGACY_MCP_CUTOFF_MS = MENTION_LEGACY_MCP_AUTH_CUTOFF_MS - 24 * 60 * 60 * 1000;

/**
 * Run the enclosing suite on a clock before the legacy MCP cutoff.
 *
 * The legacy token path is still in the tree, but since the cutoff it refuses
 * every token, so a suite exercising what it does with one has to be on a
 * clock that still reaches it. Only `Date` is faked: supertest and the
 * middleware's own awaits keep real timers. Delete the suites that use this
 * together with the legacy path.
 */
export function onLegacyMcpClock(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BEFORE_LEGACY_MCP_CUTOFF_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
