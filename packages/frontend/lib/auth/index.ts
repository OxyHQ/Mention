/**
 * Authentication for Mention
 *
 * Uses official @oxyhq/services for all authentication.
 * No custom auth code - just pure Oxy services.
 *
 * @example
 * ```tsx
 * import { useAuth } from '@oxyhq/services';
 *
 * function MyComponent() {
 *   const { user, isAuthenticated, loading } = useAuth();
 *
 *   if (loading) return <LoadingScreen />;
 *   if (!isAuthenticated) return <SignInScreen />;
 *
 *   return <Dashboard user={user} />;
 * }
 * ```
 *
 * @see https://docs.oxy.so/services for full documentation
 */

// This file exists for documentation purposes only.
// All authentication is handled by @oxyhq/services.
// Use `useAuth()` hook from '@oxyhq/services' for authentication.

export {};
