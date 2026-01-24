# Expo 54 Universal Authentication Compliance Report

**Generated:** 2026-01-24
**Project:** Mention
**Expo SDK:** 54.0.25
**@oxyhq/services:** 5.21.7

---

## Executive Summary

Mention is an Expo 54 project with multi-platform support (iOS, Android, Web). The app follows many best practices from the Expo 54 Universal Authentication Guide, but **requires updates** to fully implement the recommended cross-platform authentication architecture.

### Compliance Status

| Category | Status | Details |
|----------|--------|---------|
| **Expo 54 Setup** | ✅ Complete | SDK 54.0.25, multi-platform configured |
| **Web Configuration** | ✅ Complete | Metro bundler, static output |
| **Platform Detection** | ✅ Complete | Platform.OS used throughout |
| **Conditional Imports** | ✅ Complete | Native-only modules properly gated |
| **iOS Keychain Sharing** | ❌ **Missing** | No `group.com.oxy.shared` keychain group |
| **Android sharedUserId** | ❌ **Missing** | No shared user ID configured |
| **KeyManager Integration** | ❌ **Missing** | Not using cryptographic identity |
| **CrossDomainAuth (Web)** | ❌ **Missing** | Web uses same flow as native |
| **Universal Auth Provider** | ⚠️ **Partial** | Uses OxyProvider uniformly |

**Overall Compliance:** 🟡 **60%** - Core features work, but missing cross-app SSO capabilities

---

## Detailed Analysis

### ✅ What's Already Compliant

#### 1. Expo 54 Configuration
**Status:** ✅ Complete

**Evidence:**
- [app.config.js:45](packages/frontend/app.config.js#L45) - `expo: "~54.0.25"`
- Multi-platform support enabled
- TypedRoutes enabled (line 33)
- React Compiler enabled (line 34)
- New Architecture enabled (line 31)

#### 2. Web Configuration
**Status:** ✅ Complete

**Evidence:**
- [app.config.js:90-112](packages/frontend/app.config.js#L90-L112)
```javascript
web: {
    bundler: "metro",        // ✅ Matches guide
    output: "static",        // ✅ Matches guide
    favicon: "./assets/images/favicon.png",
    manifest: "./public/manifest.json",
    // ... meta tags configured
}
```

#### 3. Platform Detection & Conditional Code
**Status:** ✅ Complete

**Examples:**
- [utils/notifications.ts](packages/frontend/utils/notifications.ts) - Dynamic import on native only
- [components/RegisterPushToken.tsx](packages/frontend/components/RegisterPushToken.tsx) - `if (Platform.OS === 'web') return;`
- [lib/appInitializer.ts](packages/frontend/lib/appInitializer.ts) - Platform-specific initialization
- Platform-specific files: `useColorScheme.web.ts`, `sonner.web.ts`

#### 4. Secure Storage
**Status:** ✅ Complete

**Evidence:**
- [app.config.js:139-143](packages/frontend/app.config.js#L139-L143)
```javascript
[
    "expo-secure-store",
    {
        configureAndroidBackup: true,
        faceIDPermission: "Allow $(PRODUCT_NAME) to access your Face ID biometric data."
    }
]
```

- Token storage in both AsyncStorage and SecureStore ([debugToken.ts](packages/frontend/lib/debugToken.ts))

#### 5. @oxyhq/services Integration
**Status:** ✅ Complete

**Evidence:**
- Version: 5.21.7 ([package.json:36](package.json#L36))
- OxyProvider configured in [AppProviders.tsx](packages/frontend/components/AppProviders.tsx)
- Authentication hooks used throughout app
- Backend auth middleware in [middleware/auth.ts](packages/backend/src/middleware/auth.ts)

---

### ❌ What's Missing or Non-Compliant

#### 1. iOS Keychain Sharing
**Status:** ❌ **CRITICAL - Not Configured**

**What the guide requires:**
```xml
<!-- ios/YourApp/YourApp.entitlements -->
<key>keychain-access-groups</key>
<array>
    <string>$(AppIdentifierPrefix)group.com.oxy.shared</string>
</array>
```

**Current state:**
- ❌ No entitlements file exists
- ❌ No keychain access groups configured
- ❌ No shared keychain group: `group.com.oxy.shared`

**Impact:**
- ❌ Cross-app authentication between Oxy apps (Homiio → Mention) **will NOT work** on iOS
- ❌ Users must sign in separately to each Oxy app
- ❌ No shared cryptographic identity across apps

**Required Actions:**
1. Run `npx expo prebuild` to generate native iOS project
2. Open `packages/frontend/ios/Mention.xcworkspace` in Xcode
3. Select target → Signing & Capabilities → Add "Keychain Sharing"
4. Add keychain group: `group.com.oxy.shared`
5. Commit the generated entitlements file

**OR** configure via config plugin:
```javascript
// app.config.js - Add to plugins array
[
    'expo-build-properties',
    {
        ios: {
            entitlements: {
                'keychain-access-groups': [
                    '$(AppIdentifierPrefix)group.com.oxy.shared'
                ]
            }
        }
    }
]
```

---

#### 2. Android sharedUserId
**Status:** ❌ **CRITICAL - Not Configured**

**What the guide requires:**
```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.mention.earth"
    android:sharedUserId="com.oxy.shared">
```

**Current state:**
- ❌ No sharedUserId configured
- ❌ Package: `com.mention.earth` (unique, not shared)
- ❌ Apps cannot share storage/credentials

**Impact:**
- ❌ Cross-app authentication between Oxy apps (Homiio → Mention) **will NOT work** on Android
- ❌ Users must sign in separately to each Oxy app
- ❌ No shared identity/session storage

**Required Actions:**
1. Run `npx expo prebuild --platform android`
2. Edit `packages/frontend/android/app/src/main/AndroidManifest.xml`:
```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.mention.earth"
    android:sharedUserId="com.oxy.shared">
```

**OR** create config plugin:
```javascript
// plugins/withSharedUserId.js
const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withSharedUserId(config) {
  return withAndroidManifest(config, async (config) => {
    const androidManifest = config.modResults.manifest;
    androidManifest.$ = {
      ...androidManifest.$,
      'android:sharedUserId': 'com.oxy.shared'
    };
    return config;
  });
};
```

**⚠️ CRITICAL WARNING:**
- All Oxy apps **must** use the same `sharedUserId`
- Apps **must** be signed with the same certificate
- **Cannot change** `sharedUserId` after publishing (requires user reinstall)

---

#### 3. KeyManager Integration (Native Platforms)
**Status:** ❌ **Not Implemented**

**What the guide requires:**
```typescript
// Native platforms only
import { KeyManager } from '@oxyhq/services/crypto';

// Check for shared identity
const hasIdentity = await KeyManager.hasSharedIdentity();
const publicKey = await KeyManager.getSharedPublicKey();

// Create cryptographic identity
await KeyManager.createSharedIdentity();
```

**Current state:**
- ❌ No KeyManager usage found in codebase
- ❌ No cryptographic identity (ECDSA) implementation
- ⚠️ Relies entirely on @oxyhq/services token-based auth

**Impact:**
- ❌ No offline authentication on native platforms
- ❌ No cryptographic proof of identity
- ⚠️ Weaker security model than recommended

**Required Actions:**
1. Add conditional KeyManager import:
```typescript
// lib/auth/NativeAuth.ts
import { Platform } from 'react-native';

let KeyManager: any = null;
if (Platform.OS !== 'web') {
  KeyManager = require('@oxyhq/services/crypto').KeyManager;
}
```

2. Implement identity creation flow:
```typescript
export async function createIdentity() {
  if (Platform.OS === 'web') return null;

  const hasIdentity = await KeyManager.hasSharedIdentity();
  if (!hasIdentity) {
    await KeyManager.createSharedIdentity();
  }

  return await KeyManager.getSharedPublicKey();
}
```

3. Update authentication flow to use KeyManager on native platforms

---

#### 4. CrossDomainAuth (Web Platform)
**Status:** ❌ **Not Implemented**

**What the guide requires:**
```typescript
// Web platform only
import { createCrossDomainAuth } from '@oxyhq/services/core';

const crossDomainAuth = Platform.OS === 'web'
  ? createCrossDomainAuth(oxyServices)
  : null;

// Sign in with FedCM/Popup/Redirect fallback
await crossDomainAuth.signIn({ method: 'auto' });
```

**Current state:**
- ❌ No CrossDomainAuth usage found
- ❌ No FedCM implementation
- ⚠️ Web uses same auth flow as native (not optimal)

**Impact:**
- ❌ No browser-based SSO between Oxy domains (homiio.com → mention.earth)
- ❌ Users must sign in separately on each domain
- ❌ Missing modern web auth capabilities (FedCM)

**Required Actions:**
1. Create web-specific auth module:
```typescript
// lib/auth/WebAuth.ts
import { Platform } from 'react-native';
import { createCrossDomainAuth } from '@oxyhq/services/core';
import { oxyServices } from '../oxyServices';

export const crossDomainAuth = Platform.OS === 'web'
  ? createCrossDomainAuth(oxyServices)
  : null;

export async function signInWeb() {
  if (!crossDomainAuth) {
    throw new Error('CrossDomainAuth only available on web');
  }

  // Auto-fallback: FedCM → Popup → Redirect
  return await crossDomainAuth.signIn({ method: 'auto' });
}
```

2. Update web sign-in flow to use CrossDomainAuth

---

#### 5. Universal Auth Provider Pattern
**Status:** ⚠️ **Partial Implementation**

**What the guide requires:**
- Unified auth provider that handles platform differences internally
- Different auth strategies per platform:
  - **Native:** KeyManager + cryptographic identity
  - **Web:** CrossDomainAuth + browser SSO

**Current implementation:**
- Uses `OxyProvider` uniformly across all platforms
- No platform-specific auth strategy differentiation
- No unified hook that adapts to platform

**Guide's recommended pattern:**
```typescript
// UniversalAuthProvider.tsx
export function UniversalAuthProvider({ children }) {
  const platform = Platform.OS;

  // Native: use KeyManager
  const nativeAuth = platform !== 'web' ? useNativeAuth() : null;

  // Web: use CrossDomainAuth
  const webAuth = platform === 'web' ? useWebAuth() : null;

  const auth = {
    user: platform === 'web' ? webAuth?.user : nativeAuth?.user,
    loading: platform === 'web' ? webAuth?.loading : nativeAuth?.loading,
    platform,
    // Platform-specific methods
    ...(platform !== 'web' ? {
      hasIdentity: nativeAuth?.hasIdentity,
      createIdentity: nativeAuth?.createIdentity
    } : {
      signInWeb: webAuth?.signIn,
      crossDomainAuth: webAuth?.crossDomainAuth
    })
  };

  return (
    <AuthContext.Provider value={auth}>
      {children}
    </AuthContext.Provider>
  );
}
```

**Current state:**
- [AppProviders.tsx](packages/frontend/components/AppProviders.tsx) uses `OxyProvider` directly
- No platform-specific auth strategy
- No abstraction layer

**Impact:**
- ⚠️ Cannot leverage platform-specific features (KeyManager, CrossDomainAuth)
- ⚠️ Missing optimal auth flows per platform
- ⚠️ Harder to maintain platform-specific auth logic

**Required Actions:**
1. Create `UniversalAuthProvider` as shown in guide
2. Wrap existing `OxyProvider` with platform-specific logic
3. Update app to use new universal hook

---

## Priority Recommendations

### 🔴 High Priority (Critical for Cross-App SSO)

1. **Configure iOS Keychain Sharing**
   - **Effort:** Medium (30 minutes)
   - **Impact:** Enables cross-app auth on iOS
   - **Action:** Add entitlements with `group.com.oxy.shared`
   - **File:** Add to [app.config.js](packages/frontend/app.config.js#L163-L177) via expo-build-properties

2. **Configure Android sharedUserId**
   - **Effort:** Medium (30 minutes)
   - **Impact:** Enables cross-app auth on Android
   - **Action:** Create config plugin to add `android:sharedUserId="com.oxy.shared"`
   - **File:** Create `plugins/withSharedUserId.js`

### 🟡 Medium Priority (Enhanced Security & Features)

3. **Integrate KeyManager for Native Platforms**
   - **Effort:** High (4-6 hours)
   - **Impact:** Cryptographic identity, offline auth, better security
   - **Action:** Create `lib/auth/NativeAuth.ts` with KeyManager integration
   - **Dependencies:** Requires iOS Keychain Sharing + Android sharedUserId

4. **Integrate CrossDomainAuth for Web**
   - **Effort:** Medium (2-3 hours)
   - **Impact:** Browser SSO between Oxy domains, FedCM support
   - **Action:** Create `lib/auth/WebAuth.ts` with CrossDomainAuth
   - **Dependencies:** Requires auth.oxy.so server deployed

### 🟢 Low Priority (Architecture Improvements)

5. **Create UniversalAuthProvider**
   - **Effort:** High (6-8 hours)
   - **Impact:** Cleaner architecture, easier maintenance
   - **Action:** Refactor to match guide's pattern
   - **Dependencies:** Requires KeyManager + CrossDomainAuth integration

---

## Testing Checklist

Once updates are implemented, verify cross-platform authentication:

### iOS Testing
- [ ] Install Mention on iOS device
- [ ] Install Homiio on same device
- [ ] Sign in to Homiio
- [ ] Open Mention → Should auto-sign in ✅
- [ ] Check keychain item exists in `group.com.oxy.shared`

### Android Testing
- [ ] Install Mention on Android device
- [ ] Install Homiio on same device (must be signed with same certificate)
- [ ] Sign in to Homiio
- [ ] Open Mention → Should auto-sign in ✅
- [ ] Verify shared storage accessible

### Web Testing
- [ ] Open homiio.com in browser
- [ ] Sign in
- [ ] Navigate to mention.earth → Should auto-sign in ✅
- [ ] Check FedCM used if supported
- [ ] Verify fallback to popup/redirect if FedCM unavailable

### Cross-Platform Testing
- [ ] Sign in on iOS → Check web auto-signs in
- [ ] Sign in on web → Check native apps auto-sign in
- [ ] Sign out on one platform → Verify others also sign out
- [ ] Test offline mode on native (should work with KeyManager)

---

## Implementation Roadmap

### Phase 1: Foundation (Week 1)
- [ ] Configure iOS Keychain Sharing
- [ ] Configure Android sharedUserId
- [ ] Test cross-app storage access

### Phase 2: Native Enhancement (Week 2)
- [ ] Integrate KeyManager
- [ ] Implement cryptographic identity flow
- [ ] Add identity migration from legacy tokens
- [ ] Test offline authentication

### Phase 3: Web Enhancement (Week 3)
- [ ] Integrate CrossDomainAuth
- [ ] Implement FedCM flow with fallbacks
- [ ] Configure auth.oxy.so integration
- [ ] Test browser SSO

### Phase 4: Unification (Week 4)
- [ ] Create UniversalAuthProvider
- [ ] Refactor app to use unified auth hook
- [ ] Update documentation
- [ ] Full cross-platform testing

---

## Code Changes Required

### 1. app.config.js Updates

**Add iOS Keychain Sharing:**
```javascript
// In expo-build-properties plugin config
[
    'expo-build-properties',
    {
      ios: {
        deploymentTarget: '15.1',
        entitlements: {
          'keychain-access-groups': [
            '$(AppIdentifierPrefix)group.com.oxy.shared'
          ]
        }
      },
      android: {
        // ... existing android config
      },
    },
]
```

### 2. Create Config Plugin for Android sharedUserId

**File:** `packages/frontend/plugins/withSharedUserId.js`
```javascript
const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withSharedUserId(config) {
  return withAndroidManifest(config, async (config) => {
    const androidManifest = config.modResults.manifest;
    androidManifest.$ = {
      ...androidManifest.$,
      'android:sharedUserId': 'com.oxy.shared'
    };
    return config;
  });
};
```

**Update app.config.js:**
```javascript
plugins: [
  // ... existing plugins
  './plugins/withSharedUserId',
]
```

### 3. Create Native Auth Module

**File:** `packages/frontend/lib/auth/NativeAuth.ts`
```typescript
import { Platform } from 'react-native';
import { useState, useEffect } from 'react';

let KeyManager: any = null;
if (Platform.OS !== 'web') {
  KeyManager = require('@oxyhq/services/crypto').KeyManager;
}

export function useNativeAuth() {
  const [hasIdentity, setHasIdentity] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkIdentity();
  }, []);

  async function checkIdentity() {
    if (Platform.OS === 'web' || !KeyManager) {
      setLoading(false);
      return;
    }

    try {
      const exists = await KeyManager.hasSharedIdentity();
      setHasIdentity(exists);

      if (exists) {
        const key = await KeyManager.getSharedPublicKey();
        setPublicKey(key);
      }
    } catch (error) {
      console.error('Failed to check identity:', error);
    } finally {
      setLoading(false);
    }
  }

  async function createIdentity() {
    if (Platform.OS === 'web' || !KeyManager) return null;

    try {
      await KeyManager.createSharedIdentity();
      await checkIdentity();
      return await KeyManager.getSharedPublicKey();
    } catch (error) {
      console.error('Failed to create identity:', error);
      throw error;
    }
  }

  async function importIdentity(privateKey: string) {
    if (Platform.OS === 'web' || !KeyManager) return null;

    try {
      await KeyManager.importSharedIdentity(privateKey);
      await checkIdentity();
      return await KeyManager.getSharedPublicKey();
    } catch (error) {
      console.error('Failed to import identity:', error);
      throw error;
    }
  }

  return {
    hasIdentity,
    publicKey,
    loading,
    createIdentity,
    importIdentity,
  };
}
```

### 4. Create Web Auth Module

**File:** `packages/frontend/lib/auth/WebAuth.ts`
```typescript
import { Platform } from 'react-native';
import { createCrossDomainAuth } from '@oxyhq/services/core';
import { oxyServices } from '../oxyServices';
import { useState, useEffect } from 'react';

export const crossDomainAuth = Platform.OS === 'web'
  ? createCrossDomainAuth(oxyServices)
  : null;

export function useWebAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      setLoading(false);
      return;
    }

    checkSession();
  }, []);

  async function checkSession() {
    if (!crossDomainAuth) return;

    try {
      const session = await crossDomainAuth.getSession();
      if (session) {
        setUser(session.user);
      }
    } catch (error) {
      console.error('Failed to check web session:', error);
    } finally {
      setLoading(false);
    }
  }

  async function signIn() {
    if (!crossDomainAuth) {
      throw new Error('CrossDomainAuth only available on web');
    }

    try {
      // Auto-fallback: FedCM → Popup → Redirect
      const result = await crossDomainAuth.signIn({ method: 'auto' });
      setUser(result.user);
      return result;
    } catch (error) {
      console.error('Web sign-in failed:', error);
      throw error;
    }
  }

  async function signOut() {
    if (!crossDomainAuth) return;

    try {
      await crossDomainAuth.signOut();
      setUser(null);
    } catch (error) {
      console.error('Web sign-out failed:', error);
      throw error;
    }
  }

  return {
    user,
    loading,
    signIn,
    signOut,
    crossDomainAuth,
  };
}
```

### 5. Create Universal Auth Provider (Optional - Phase 4)

**File:** `packages/frontend/lib/auth/UniversalAuthProvider.tsx`
```typescript
import React, { createContext, useContext } from 'react';
import { Platform } from 'react-native';
import { useNativeAuth } from './NativeAuth';
import { useWebAuth } from './WebAuth';
import { useOxy } from '@oxyhq/services';

interface UniversalAuthContextType {
  user: any;
  loading: boolean;
  platform: 'ios' | 'android' | 'web';
  signOut: () => Promise<void>;
  // Native-only
  hasIdentity?: boolean;
  createIdentity?: () => Promise<string | null>;
  importIdentity?: (privateKey: string) => Promise<string | null>;
  // Web-only
  signInWeb?: () => Promise<any>;
  crossDomainAuth?: any;
}

const AuthContext = createContext<UniversalAuthContextType | null>(null);

export function UniversalAuthProvider({ children }: { children: React.ReactNode }) {
  const platform = Platform.OS as 'ios' | 'android' | 'web';
  const oxyAuth = useOxy();
  const nativeAuth = platform !== 'web' ? useNativeAuth() : null;
  const webAuth = platform === 'web' ? useWebAuth() : null;

  const auth: UniversalAuthContextType = {
    user: oxyAuth.user,
    loading: oxyAuth.loading || (platform === 'web' ? webAuth?.loading : nativeAuth?.loading) || false,
    platform,
    signOut: async () => {
      if (platform === 'web' && webAuth) {
        await webAuth.signOut();
      }
      await oxyAuth.signOut();
    },
    // Add platform-specific methods
    ...(platform !== 'web' && nativeAuth ? {
      hasIdentity: nativeAuth.hasIdentity,
      createIdentity: nativeAuth.createIdentity,
      importIdentity: nativeAuth.importIdentity,
    } : {}),
    ...(platform === 'web' && webAuth ? {
      signInWeb: webAuth.signIn,
      crossDomainAuth: webAuth.crossDomainAuth,
    } : {}),
  };

  return (
    <AuthContext.Provider value={auth}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within UniversalAuthProvider');
  }
  return context;
}
```

---

## Resources

- **Expo 54 Docs:** https://docs.expo.dev
- **Expo Build Properties:** https://docs.expo.dev/versions/latest/sdk/build-properties/
- **Expo Config Plugins:** https://docs.expo.dev/config-plugins/introduction/
- **@oxyhq/services Documentation:** Check internal docs for KeyManager and CrossDomainAuth APIs
- **Original Guide:** See provided Expo 54 Universal Authentication Guide

---

## Conclusion

Mention has a solid foundation with Expo 54 and @oxyhq/services, but **requires critical updates** to achieve the full cross-platform authentication experience outlined in the guide:

1. **iOS Keychain Sharing** - Required for cross-app SSO
2. **Android sharedUserId** - Required for cross-app SSO
3. **KeyManager integration** - Recommended for enhanced security
4. **CrossDomainAuth integration** - Recommended for web SSO

Implementing these changes will enable seamless authentication across:
- **Native apps** (Homiio ↔ Mention on iOS/Android)
- **Web domains** (homiio.com ↔ mention.earth)
- **Cross-platform** (Sign in on web, instant auth on mobile)

**Next Steps:**
1. Review this report with the team
2. Prioritize Phase 1 (Keychain + sharedUserId) for immediate cross-app SSO
3. Plan Phases 2-4 based on timeline and resources
4. Test thoroughly on all three platforms

---

**Report Author:** Claude Code
**Last Updated:** 2026-01-24
