/**
 * Authentication Utilities for Expo 54
 *
 * Provides platform-specific authentication features following Expo 54 best practices.
 *
 * Usage:
 * - Use `useOxy()` from @oxyhq/services for main authentication
 * - Use `useNativeAuth()` for iOS/Android cryptographic identity features
 * - Use migration utilities to migrate legacy users
 *
 * @example
 * ```tsx
 * import { useOxy } from '@oxyhq/services';
 * import { useNativeAuth } from '@/lib/auth';
 *
 * function MyComponent() {
 *   // Main auth (all platforms)
 *   const { user, isAuthenticated } = useOxy();
 *
 *   // Native-only features
 *   const nativeAuth = useNativeAuth();
 *   if (nativeAuth?.hasIdentity) {
 *     console.log('Identity:', nativeAuth.publicKey);
 *   }
 * }
 * ```
 */

export {
  useNativeAuth,
  storeSharedSession,
  getSharedSession,
  clearSharedSession,
  type NativeAuth,
  type NativeAuthState,
  type NativeAuthActions,
  type NativeSession,
} from './NativeAuth';

export {
  migrateLegacyAuth,
  shouldMigrate,
  getMigrationStatus,
  type MigrationResult,
} from './migration';
