import { useCallback } from 'react';
import { Platform } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import { KeyManager } from '@oxyhq/core';
import type { UserNodeStatus } from '@oxyhq/core';
import { api } from '@/utils/api';
import { isAuthError } from '@/utils/authErrors';
import { createScopedLogger } from '@/lib/logger';

const nodeLogger = createScopedLogger('MentionNode');

/**
 * The caller's Mention node, as projected by the backend's `serializeNode`
 * (`routes/mtn-nodes.routes.ts`). It mirrors the SDK's {@link UserNodeStatus}
 * shape exactly — the Mention `/mtn/nodes/*` routes reuse the same projection as
 * Oxy's `/nodes/*` — so we reuse the published type instead of redeclaring it.
 */
export type MentionNode = UserNodeStatus;

/** `GET /mtn/nodes/me` returns the node or an explicit `null`. */
interface NodeMeResponse {
  node: MentionNode | null;
}

/** `POST /mtn/nodes/managed` returns the freshly materialized managed node. */
interface ManagedVaultResponse {
  node: MentionNode;
}

/** `DELETE /mtn/nodes/me` returns `{ success: true }`. */
interface DisconnectResponse {
  success: boolean;
}

/**
 * The query key for the caller's Mention node. Keyed on the viewer identity so
 * the web cold-boot session landing (`anon` -> `<viewerId>`) refetches
 * automatically — the same reactivity contract every other private read in the
 * app follows.
 */
function nodeQueryKey(viewerId: string | undefined): readonly unknown[] {
  return ['mtn-node', 'me', viewerId ?? 'anon'];
}

export interface UseMentionNodeResult {
  /** The caller's node, `null` when none is registered, `undefined` until loaded. */
  node: MentionNode | null | undefined;
  /** True only while the first authenticated fetch is in flight. */
  isLoading: boolean;
  /** A non-auth load error (auth errors fail quietly to "no node"). */
  isError: boolean;
  /** Refetch the node (e.g. after a manual retry). */
  refetch: () => void;

  /** Provision (or refresh) a Mention-operated managed vault. */
  createManagedVault: () => void;
  /** True while the managed-vault provision request is in flight. */
  isCreatingVault: boolean;
  /** The managed-vault provision error, if the last attempt failed. */
  createVaultError: unknown;

  /** Revoke the caller's node registration. */
  disconnect: () => void;
  /** True while the disconnect request is in flight. */
  isDisconnecting: boolean;
  /** The disconnect error, if the last attempt failed. */
  disconnectError: unknown;

  /**
   * Whether this device can sign a self-hosted node registration. Self-host
   * registration publishes a signed `app.mention.node` record with the on-device
   * identity key, which only exists on native (web `KeyManager` has no key).
   * `undefined` until resolved.
   */
  canSelfHostSign: boolean | undefined;
}

/**
 * Owns the "Your Mention node" data: the node status read plus the managed-vault
 * and disconnect mutations, all keyed/gated on the viewer identity and the SDK's
 * private-API readiness. Mutations invalidate the node query so the screen
 * re-reads the authoritative state after every write.
 *
 * The read is gated on `canUsePrivateApi` (never just `isAuthenticated`) so a
 * request never fires before a usable bearer exists — mirroring the documented
 * auth-cold-boot reactivity rules. Auth errors fail quietly to "no node"; other
 * errors surface so the screen can offer a retry.
 */
export function useMentionNode(): UseMentionNodeResult {
  const { user, isAuthenticated, canUsePrivateApi } = useAuth();
  const viewerId = user?.id;
  const queryClient = useQueryClient();

  const enabled = isAuthenticated && Boolean(viewerId) && canUsePrivateApi;

  const query = useQuery<MentionNode | null>({
    queryKey: nodeQueryKey(viewerId),
    queryFn: async () => {
      try {
        const { data } = await api.get<NodeMeResponse>('/mtn/nodes/me');
        return data.node ?? null;
      } catch (error) {
        if (isAuthError(error)) {
          nodeLogger.warn('Auth error loading Mention node, showing "no node"', { error });
          return null;
        }
        throw error;
      }
    },
    enabled,
    staleTime: 30_000,
  });

  // Native devices that hold an on-device identity key can sign a self-hosted
  // node registration; web (no key) and custodial accounts cannot. Resolved once
  // and cached — `KeyManager.hasIdentity()` is a stable per-install fact.
  const keyQuery = useQuery<boolean>({
    queryKey: ['mtn-node', 'can-self-host-sign'],
    queryFn: async () => {
      if (Platform.OS === 'web') return false;
      try {
        return await KeyManager.hasIdentity();
      } catch (error) {
        nodeLogger.warn('Failed to probe on-device identity key', { error });
        return false;
      }
    },
    staleTime: Infinity,
  });

  const invalidateNode = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: nodeQueryKey(viewerId) });
  }, [queryClient, viewerId]);

  const createVaultMutation = useMutation<MentionNode, unknown, void>({
    mutationFn: async () => {
      const { data } = await api.post<ManagedVaultResponse>('/mtn/nodes/managed');
      return data.node;
    },
    onSuccess: (node) => {
      queryClient.setQueryData(nodeQueryKey(viewerId), node);
      invalidateNode();
    },
    onError: (error) => {
      nodeLogger.error('Failed to create managed vault', { error });
    },
  });

  const disconnectMutation = useMutation<DisconnectResponse, unknown, void>({
    mutationFn: async () => {
      const { data } = await api.delete<DisconnectResponse>('/mtn/nodes/me');
      return data;
    },
    onSuccess: () => {
      queryClient.setQueryData(nodeQueryKey(viewerId), null);
      invalidateNode();
    },
    onError: (error) => {
      nodeLogger.error('Failed to disconnect Mention node', { error });
    },
  });

  return {
    node: enabled ? query.data : undefined,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,

    createManagedVault: createVaultMutation.mutate,
    isCreatingVault: createVaultMutation.isPending,
    createVaultError: createVaultMutation.error,

    disconnect: disconnectMutation.mutate,
    isDisconnecting: disconnectMutation.isPending,
    disconnectError: disconnectMutation.error,

    canSelfHostSign: keyQuery.data,
  };
}
