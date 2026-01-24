/**
 * Authentication Migration Utilities
 *
 * Helps migrate from legacy authentication to Expo 54 Universal Auth.
 *
 * Migration scenarios:
 * 1. Legacy token-based auth → KeyManager identity (native)
 * 2. Non-shared keychain → Shared keychain (iOS)
 * 3. Non-shared storage → Shared storage (Android)
 */

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

/**
 * Migration result
 */
export interface MigrationResult {
  success: boolean;
  migrated: boolean;
  error?: Error;
  details?: {
    legacyTokenFound: boolean;
    identityCreated: boolean;
    sharedStorageMigrated: boolean;
  };
}

/**
 * Migrate legacy authentication data to new system
 *
 * Steps:
 * 1. Check for legacy access token in AsyncStorage/SecureStore
 * 2. If found and no identity exists, create new identity
 * 3. Migrate to shared keychain/storage
 * 4. Clean up legacy data (optional)
 *
 * @param cleanup - Whether to remove legacy data after migration (default: false)
 * @returns Migration result
 *
 * @example
 * ```tsx
 * const result = await migrateLegacyAuth({ cleanup: true });
 * if (result.success) {
 *   console.log('Migration successful:', result.details);
 * }
 * ```
 */
export async function migrateLegacyAuth(options: {
  cleanup?: boolean;
} = {}): Promise<MigrationResult> {
  const { cleanup = false } = options;

  if (Platform.OS === 'web') {
    return {
      success: true,
      migrated: false,
      details: {
        legacyTokenFound: false,
        identityCreated: false,
        sharedStorageMigrated: false,
      }
    };
  }

  try {
    // Check for legacy tokens
    const legacyToken = await getLegacyToken();
    const legacyTokenFound = !!legacyToken;

    // Import KeyManager
    const KeyManager = require('@oxyhq/services/crypto').KeyManager;

    // Check if identity already exists
    const hasIdentity = await KeyManager.hasSharedIdentity();

    let identityCreated = false;
    let sharedStorageMigrated = false;

    // If no identity exists but we have a legacy token, create identity
    if (!hasIdentity && legacyToken) {
      console.log('Creating new identity for legacy user...');
      await KeyManager.createSharedIdentity();
      identityCreated = true;
    }

    // Attempt to migrate from non-shared to shared storage
    if (!hasIdentity) {
      const migrated = await KeyManager.migrateToSharedIdentity();
      if (migrated) {
        sharedStorageMigrated = true;
        console.log('Migrated identity to shared storage');
      }
    }

    // Clean up legacy data if requested
    if (cleanup && (identityCreated || sharedStorageMigrated)) {
      await cleanupLegacyData();
    }

    return {
      success: true,
      migrated: identityCreated || sharedStorageMigrated,
      details: {
        legacyTokenFound,
        identityCreated,
        sharedStorageMigrated,
      }
    };
  } catch (error) {
    console.error('Migration failed:', error);
    return {
      success: false,
      migrated: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Get legacy access token from AsyncStorage or SecureStore
 */
async function getLegacyToken(): Promise<string | null> {
  try {
    // Try AsyncStorage first (common location)
    let token = await AsyncStorage.getItem('oxy_example_access_token');
    if (token) return token;

    // Try SecureStore
    if (Platform.OS !== 'web') {
      token = await SecureStore.getItemAsync('oxy_example_access_token');
      if (token) return token;
    }

    // Try other common keys
    const commonKeys = [
      'accessToken',
      'access_token',
      'oxy_token',
      'auth_token',
    ];

    for (const key of commonKeys) {
      token = await AsyncStorage.getItem(key);
      if (token) return token;

      if (Platform.OS !== 'web') {
        token = await SecureStore.getItemAsync(key);
        if (token) return token;
      }
    }

    return null;
  } catch (error) {
    console.error('Failed to get legacy token:', error);
    return null;
  }
}

/**
 * Clean up legacy authentication data
 */
async function cleanupLegacyData(): Promise<void> {
  try {
    const keysToRemove = [
      'oxy_example_access_token',
      'oxy_example_refresh_token',
      'oxy_example_session_id',
      'accessToken',
      'access_token',
      'refresh_token',
      'oxy_token',
      'auth_token',
    ];

    // Remove from AsyncStorage
    await Promise.all(
      keysToRemove.map(key => AsyncStorage.removeItem(key))
    );

    // Remove from SecureStore
    if (Platform.OS !== 'web') {
      await Promise.all(
        keysToRemove.map(key =>
          SecureStore.deleteItemAsync(key).catch(() => {})
        )
      );
    }

    console.log('Cleaned up legacy authentication data');
  } catch (error) {
    console.error('Failed to cleanup legacy data:', error);
  }
}

/**
 * Check if migration is needed
 *
 * @returns true if user has legacy data but no identity
 */
export async function shouldMigrate(): Promise<boolean> {
  if (Platform.OS === 'web') {
    return false;
  }

  try {
    const KeyManager = require('@oxyhq/services/crypto').KeyManager;

    // Check for identity
    const hasIdentity = await KeyManager.hasSharedIdentity();
    if (hasIdentity) {
      return false; // Already migrated
    }

    // Check for legacy token
    const legacyToken = await getLegacyToken();
    if (legacyToken) {
      return true; // Has legacy data, needs migration
    }

    // Check if can migrate from non-shared storage
    const hasLegacyIdentity = await KeyManager.hasIdentity();
    if (hasLegacyIdentity) {
      return true; // Has legacy identity, needs migration
    }

    return false;
  } catch (error) {
    console.error('Failed to check migration status:', error);
    return false;
  }
}

/**
 * Get migration status for debugging
 */
export async function getMigrationStatus(): Promise<{
  platform: string;
  hasSharedIdentity: boolean;
  hasLegacyIdentity: boolean;
  hasLegacyToken: boolean;
  needsMigration: boolean;
}> {
  if (Platform.OS === 'web') {
    return {
      platform: 'web',
      hasSharedIdentity: false,
      hasLegacyIdentity: false,
      hasLegacyToken: false,
      needsMigration: false,
    };
  }

  try {
    const KeyManager = require('@oxyhq/services/crypto').KeyManager;

    const hasSharedIdentity = await KeyManager.hasSharedIdentity();
    const hasLegacyIdentity = await KeyManager.hasIdentity?.() || false;
    const hasLegacyToken = !!(await getLegacyToken());
    const needsMigration = await shouldMigrate();

    return {
      platform: Platform.OS,
      hasSharedIdentity,
      hasLegacyIdentity,
      hasLegacyToken,
      needsMigration,
    };
  } catch (error) {
    console.error('Failed to get migration status:', error);
    return {
      platform: Platform.OS,
      hasSharedIdentity: false,
      hasLegacyIdentity: false,
      hasLegacyToken: false,
      needsMigration: false,
    };
  }
}
