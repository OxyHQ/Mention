# Authentication for Expo 54

Expo 54 universal authentication following official best practices.

## Overview

Mention uses **@oxyhq/services** for authentication across all platforms (iOS, Android, Web).

Platform-specific features:
- **iOS/Android**: KeyManager for cryptographic identity + shared keychain/storage
- **Web**: Standard OxyProvider authentication

## Usage

### Basic Authentication (All Platforms)

Use `useOxy()` from @oxyhq/services:

```tsx
import { useOxy } from '@oxyhq/services';

function MyComponent() {
  const { user, isAuthenticated, loading } = useOxy();

  if (loading) return <LoadingScreen />;
  if (!isAuthenticated) return <SignInScreen />;

  return <Dashboard user={user} />;
}
```

### Native Features (iOS/Android Only)

Use `useNativeAuth()` for platform-specific features:

```tsx
import { Platform } from 'react-native';
import { useOxy } from '@oxyhq/services';
import { useNativeAuth } from '@/lib/auth';

function MyComponent() {
  // Main auth (all platforms)
  const { user, isAuthenticated } = useOxy();

  // Native-only features
  const nativeAuth = useNativeAuth();

  if (Platform.OS !== 'web' && nativeAuth) {
    const { hasIdentity, publicKey, createIdentity } = nativeAuth;

    if (!hasIdentity) {
      return <Button title="Create Identity" onPress={createIdentity} />;
    }

    console.log('Identity:', publicKey);
  }

  return <Dashboard user={user} />;
}
```

## Configuration

### iOS - Keychain Sharing

Configured in [app.config.js:165-170](../../../app.config.js#L165-L170):

```javascript
ios: {
  entitlements: {
    'keychain-access-groups': [
      '$(AppIdentifierPrefix)group.so.oxy.shared'
    ]
  }
}
```

This enables cross-app authentication between Oxy apps (Mention ↔ Homiio).

### Android - Shared User ID

Configured in [plugins/withSharedUserId.js](../../../plugins/withSharedUserId.js):

```javascript
androidManifest.$ = {
  ...androidManifest.$,
  'android:sharedUserId': 'com.oxy.shared'
};
```

This enables cross-app authentication between Oxy apps (Mention ↔ Homiio).

## API

### useNativeAuth()

Returns `null` on web, or native auth capabilities on iOS/Android:

```typescript
{
  hasIdentity: boolean;
  publicKey: string | null;
  loading: boolean;
  error: Error | null;
  createIdentity: () => Promise<string | null>;
  importIdentity: (key: string) => Promise<string | null>;
  deleteIdentity: () => Promise<void>;
  migrateToSharedIdentity: () => Promise<boolean>;
  refreshIdentity: () => Promise<void>;
}
```

### Migration Utilities

```tsx
import {
  migrateLegacyAuth,
  shouldMigrate,
  getMigrationStatus
} from '@/lib/auth';

// Check if migration needed
if (await shouldMigrate()) {
  // Migrate legacy data
  const result = await migrateLegacyAuth({ cleanup: true });
  console.log('Migration result:', result);
}

// Debug migration status
const status = await getMigrationStatus();
console.log(status);
```

## Platform Behavior

| Feature | iOS | Android | Web |
|---------|-----|---------|-----|
| Auth Provider | OxyProvider | OxyProvider | OxyProvider |
| Cryptographic Identity | KeyManager | KeyManager | ❌ |
| Storage | Keychain (shared) | Keystore (shared) | Cookies + localStorage |
| Cross-app SSO | ✅ | ✅ | ✅ (via browser) |
| Offline Auth | ✅ | ✅ | ❌ |

## Files

```
lib/auth/
├── index.ts           # Exports
├── NativeAuth.ts      # iOS/Android KeyManager integration
├── migration.ts       # Legacy data migration
└── README.md          # This file
```

## Next Steps

1. **Prebuild** to apply native configurations:
```bash
npx expo prebuild --clean
```

2. **Test on iOS**:
```bash
npx expo run:ios
```

3. **Test on Android**:
```bash
npx expo run:android
```

4. **Test cross-app auth**:
   - Install Mention and Homiio
   - Sign in to one → Other should auto-sign in

## More Info

See [EXPO_54_AUTH_COMPLIANCE_REPORT.md](../../../EXPO_54_AUTH_COMPLIANCE_REPORT.md) for full compliance details.
