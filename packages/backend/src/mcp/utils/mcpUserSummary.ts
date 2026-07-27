import { getNormalizedUserHandle, type User } from '@oxyhq/core';
import { degradedActorSummary } from '../../utils/degradedActorSummary';

export interface McpUserSummary {
  oxyUserId: string;
  username: string;
  handle: string;
  displayName: string;
}

function safeVisualValue(value: unknown, rawIds: Set<string>): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  if (!normalized) return '';
  const withoutAt = normalized.startsWith('@') ? normalized.slice(1) : normalized;
  return rawIds.has(normalized) || rawIds.has(withoutAt) ? '' : normalized;
}

/** Build an MCP-facing identity without ever promoting an Oxy id to a visual field. */
export function toMcpUserSummary(
  oxyUserId: string,
  user?: User | null,
): McpUserSummary {
  const fallback = degradedActorSummary(oxyUserId);
  const rawIds = new Set(
    [oxyUserId, typeof user?.id === 'string' ? user.id : ''].filter(Boolean),
  );
  const username = safeVisualValue(user?.username, rawIds);
  const normalizedHandle = username && user
    ? getNormalizedUserHandle(user) ?? username
    : '';
  const handle = safeVisualValue(normalizedHandle, rawIds);
  const displayName = safeVisualValue(user?.name?.displayName, rawIds)
    || handle
    || fallback.name.displayName;

  return {
    oxyUserId,
    username: username || fallback.username,
    handle,
    displayName,
  };
}
