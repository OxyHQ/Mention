/**
 * NativeAuth - iOS/Android Authentication with KeyManager
 *
 * Provides cryptographic identity-based authentication for native platforms.
 * Uses shared keychain (iOS) and shared storage (Android) for cross-app SSO.
 *
 * Features:
 * - Cryptographic identity (ECDSA key pairs)
 * - Offline authentication
 * - Cross-app authentication (Mention <-> Homiio)
 * - Shared session storage
 *
 * Storage:
 * - iOS: Keychain with access group "group.so.oxy.shared"
 * - Android: Keystore + Account Manager with sharedUserId "com.oxy.shared"
 */

import { Platform } from 'react-native';
import { useState, useEffect, useCallback } from 'react';

// Conditionally import KeyManager only on native platforms
let KeyManager: any = null;
if (Platform.OS !== 'web') {
  try {
    KeyManager = require('@oxyhq/services/crypto').KeyManager;
  } catch (error) {
    console.warn('KeyManager not available:', error);
  }
}

export interface NativeAuthState {
  hasIdentity: boolean;
  publicKey: string | null;
  loading: boolean;
  error: Error | null;
}

export interface NativeAuthActions {
  createIdentity: () => Promise<string | null>;
  importIdentity: (privateKey: string) => Promise<string | null>;
  deleteIdentity: () => Promise<void>;
  getPrivateKey: () => Promise<string | null>;
  migrateToSharedIdentity: () => Promise<boolean>;
  refreshIdentity: () => Promise<void>;
}

export interface NativeAuth extends NativeAuthState, NativeAuthActions {}

/**
 * Hook for native platform authentication using KeyManager
 *
 * @returns NativeAuth state and actions, or null if not on native platform
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const nativeAuth = useNativeAuth();
 *
 *   if (!nativeAuth) {
 *     return <Text>Web platform - use CrossDomainAuth</Text>;
 *   }
 *
 *   const { hasIdentity, publicKey, createIdentity } = nativeAuth;
 *
 *   if (!hasIdentity) {
 *     return <Button title="Create Identity" onPress={createIdentity} />;
 *   }
 *
 *   return <Text>Identity: {publicKey}</Text>;
 * }
 * ```
 */
export function useNativeAuth(): NativeAuth | null {
  const [hasIdentity, setHasIdentity] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Check if KeyManager is available
  const isNative = Platform.OS !== 'web' && KeyManager !== null;

  /**
   * Check for existing identity in shared storage
   */
  const checkIdentity = useCallback(async () => {
    if (!isNative) {
      setLoading(false);
      return;
    }

    try {
      setError(null);
      const exists = await KeyManager.hasSharedIdentity();
      setHasIdentity(exists);

      if (exists) {
        const key = await KeyManager.getSharedPublicKey();
        setPublicKey(key);
      } else {
        setPublicKey(null);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('Failed to check identity:', error);
      setError(error);
      setHasIdentity(false);
      setPublicKey(null);
    } finally {
      setLoading(false);
    }
  }, [isNative]);

  /**
   * Create a new cryptographic identity
   *
   * @returns Public key of the created identity
   * @throws If identity creation fails
   *
   * @example
   * ```tsx
   * const publicKey = await createIdentity();
   * console.log('Created identity:', publicKey);
   * ```
   */
  const createIdentity = useCallback(async (): Promise<string | null> => {
    if (!isNative) {
      throw new Error('KeyManager only available on native platforms');
    }

    try {
      setError(null);
      setLoading(true);

      await KeyManager.createSharedIdentity();
      await checkIdentity();

      const newPublicKey = await KeyManager.getSharedPublicKey();
      return newPublicKey;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('Failed to create identity:', error);
      setError(error);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [isNative, checkIdentity]);

  /**
   * Import an existing identity from a private key
   *
   * @param privateKey - The private key to import (hex string)
   * @returns Public key of the imported identity
   * @throws If import fails
   *
   * @example
   * ```tsx
   * const publicKey = await importIdentity(privateKeyHex);
   * console.log('Imported identity:', publicKey);
   * ```
   */
  const importIdentity = useCallback(async (privateKey: string): Promise<string | null> => {
    if (!isNative) {
      throw new Error('KeyManager only available on native platforms');
    }

    try {
      setError(null);
      setLoading(true);

      await KeyManager.importSharedIdentity(privateKey);
      await checkIdentity();

      const newPublicKey = await KeyManager.getSharedPublicKey();
      return newPublicKey;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('Failed to import identity:', error);
      setError(error);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [isNative, checkIdentity]);

  /**
   * Delete the current identity
   *
   * WARNING: This will sign the user out and cannot be undone
   *
   * @throws If deletion fails
   */
  const deleteIdentity = useCallback(async (): Promise<void> => {
    if (!isNative) {
      throw new Error('KeyManager only available on native platforms');
    }

    try {
      setError(null);
      setLoading(true);

      await KeyManager.deleteSharedIdentity();
      setHasIdentity(false);
      setPublicKey(null);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('Failed to delete identity:', error);
      setError(error);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [isNative]);

  /**
   * Get the private key (for backup/export purposes)
   *
   * WARNING: Keep private keys secure! Never expose them.
   *
   * @returns Private key as hex string
   * @throws If retrieval fails
   */
  const getPrivateKey = useCallback(async (): Promise<string | null> => {
    if (!isNative) {
      throw new Error('KeyManager only available on native platforms');
    }

    try {
      return await KeyManager.getSharedPrivateKey();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('Failed to get private key:', error);
      setError(error);
      throw error;
    }
  }, [isNative]);

  /**
   * Migrate from legacy (non-shared) identity to shared identity
   *
   * This is useful when upgrading from older versions that didn't use
   * shared keychain groups.
   *
   * @returns true if migration succeeded, false if no legacy identity found
   */
  const migrateToSharedIdentity = useCallback(async (): Promise<boolean> => {
    if (!isNative) {
      throw new Error('KeyManager only available on native platforms');
    }

    try {
      setError(null);
      setLoading(true);

      const migrated = await KeyManager.migrateToSharedIdentity();

      if (migrated) {
        await checkIdentity();
      }

      return migrated;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('Failed to migrate identity:', error);
      setError(error);
      return false;
    } finally {
      setLoading(false);
    }
  }, [isNative, checkIdentity]);

  /**
   * Refresh identity state (useful after external changes)
   */
  const refreshIdentity = useCallback(async (): Promise<void> => {
    await checkIdentity();
  }, [checkIdentity]);

  // Check for identity on mount
  useEffect(() => {
    checkIdentity();
  }, [checkIdentity]);

  // Return null if not on native platform
  if (!isNative) {
    return null;
  }

  return {
    // State
    hasIdentity,
    publicKey,
    loading,
    error,
    // Actions
    createIdentity,
    importIdentity,
    deleteIdentity,
    getPrivateKey,
    migrateToSharedIdentity,
    refreshIdentity,
  };
}

/**
 * Session management for native platforms
 */
export interface NativeSession {
  sessionId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

/**
 * Store session in shared storage (cross-app accessible)
 *
 * @param session - Session data to store
 */
export async function storeSharedSession(session: NativeSession): Promise<void> {
  if (Platform.OS === 'web' || !KeyManager) {
    throw new Error('Session storage only available on native platforms');
  }

  try {
    await KeyManager.storeSharedSession(
      session.sessionId,
      session.accessToken,
      session.refreshToken,
      session.expiresAt
    );
  } catch (error) {
    console.error('Failed to store shared session:', error);
    throw error;
  }
}

/**
 * Get session from shared storage
 *
 * @returns Session data if found, null otherwise
 */
export async function getSharedSession(): Promise<NativeSession | null> {
  if (Platform.OS === 'web' || !KeyManager) {
    throw new Error('Session storage only available on native platforms');
  }

  try {
    const session = await KeyManager.getSharedSession();
    return session;
  } catch (error) {
    console.error('Failed to get shared session:', error);
    return null;
  }
}

/**
 * Clear session from shared storage
 */
export async function clearSharedSession(): Promise<void> {
  if (Platform.OS === 'web' || !KeyManager) {
    throw new Error('Session storage only available on native platforms');
  }

  try {
    await KeyManager.clearSharedSession();
  } catch (error) {
    console.error('Failed to clear shared session:', error);
    throw error;
  }
}
