# Building APKs for Mention

Quick guide to build Android APKs using EAS (Expo Application Services).

## Quick Start

### Option 1: Build Locally (Fastest, Free)

```bash
cd packages/frontend
npm run build:apk
```

**Output:** APK file in current directory (ready to install)

### Option 2: Build in Cloud (Recommended for Distribution)

```bash
cd packages/frontend
npm run build:apk:cloud
```

**Output:** Download link from EAS (sign + distribute via Play Store or direct download)

---

## Available Build Commands

| Command | Description | Where | Output |
|---------|-------------|-------|--------|
| `npm run build:apk` | Build APK locally | Local machine | `./build-*.apk` |
| `npm run build:apk:cloud` | Build APK in cloud | EAS servers | Download link |
| `npm run build:android` | Build AAB for Play Store | EAS servers | App Bundle (AAB) |
| `npm run build:ios` | Build iOS app | EAS servers | IPA file |
| `npm run build:preview` | Preview build (APK) | EAS servers | Internal testing APK |

---

## Prerequisites

### 1. Install EAS CLI

```bash
npm install -g eas-cli
```

### 2. Login to Expo

```bash
eas login
```

### 3. Configure Project (First Time Only)

```bash
cd packages/frontend
eas build:configure
```

---

## Build Profiles

Configured in [eas.json](packages/frontend/eas.json):

### `apk` Profile (Quick APK)
```json
{
  "android": {
    "buildType": "apk",
    "gradleCommand": ":app:assembleRelease"
  },
  "distribution": "internal"
}
```

**Use for:**
- Quick testing
- Direct distribution (outside Play Store)
- Sending to testers

### `production` Profile (Play Store)
```json
{
  "android": {
    "buildType": "apk"  // or "app-bundle" for Play Store
  },
  "autoIncrement": true
}
```

**Use for:**
- Google Play Store submissions
- Official releases
- Production deployments

### `preview` Profile (Testing)
```json
{
  "extends": "production",
  "distribution": "internal"
}
```

**Use for:**
- Internal testing
- QA builds
- Beta testers

---

## Local vs Cloud Builds

### Local Builds

**Pros:**
- ✅ Free (no EAS build minutes used)
- ✅ Faster (no queue)
- ✅ Full control
- ✅ Works offline (after initial setup)

**Cons:**
- ❌ Requires Android Studio/SDK
- ❌ Requires Java/JDK
- ❌ Mac required for iOS
- ❌ Large downloads (~2GB first time)

**Setup for local builds:**
```bash
# Install Android SDK
brew install android-studio  # macOS
# OR download from: https://developer.android.com/studio

# Set environment variables
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/tools:$ANDROID_HOME/platform-tools
```

### Cloud Builds

**Pros:**
- ✅ No local setup required
- ✅ Works on any OS
- ✅ Signed automatically
- ✅ Can submit directly to stores
- ✅ Build history/logs

**Cons:**
- ❌ Requires EAS subscription (or free tier limits)
- ❌ Queue wait time
- ❌ Slower than local

---

## Step-by-Step: Build Your First APK

### 1. Ensure Native Config is Updated

```bash
cd packages/frontend
npx expo prebuild --clean
```

This applies:
- iOS Keychain Sharing (`group.so.oxy.shared`)
- Android SharedUserId (`so.oxy.shared`)

### 2. Build the APK

**Local:**
```bash
npm run build:apk
```

**Cloud:**
```bash
npm run build:apk:cloud
```

### 3. Monitor Build

**Local:** Watch terminal output

**Cloud:**
```bash
# Check status
eas build:list

# View specific build
eas build:view <build-id>
```

### 4. Get the APK

**Local:**
```bash
ls -lh *.apk
# Output: build-1234567890.apk
```

**Cloud:**
```bash
# Download from EAS dashboard
open https://expo.dev/accounts/oxyhq/projects/mention/builds

# OR download via CLI
eas build:download <build-id>
```

### 5. Install on Device

**Via USB:**
```bash
adb install build-*.apk
```

**Via Link (cloud only):**
- Open EAS build page
- Share download link
- User clicks link on Android device
- APK downloads and installs

---

## Configuration Details

### Android Keystore

For production builds, you need a keystore to sign the APK.

**Create keystore (first time only):**
```bash
eas credentials
# Select: Android → Production → Keystore → Create new
```

**OR use existing keystore:**
```bash
eas credentials
# Select: Android → Production → Keystore → Upload existing
```

EAS stores your keystore securely in the cloud.

### Version Management

Versions are auto-incremented when `autoIncrement: true` is set.

**Manual version bump:**
```json
// app.config.js
version: "2.1.0"
```

**OR via package.json:**
```json
{
  "version": "2.1.0"
}
```

EAS reads version from `app.config.js` by default.

---

## Troubleshooting

### Build Fails: "Gradle error"

**Solution:** Update dependencies
```bash
cd packages/frontend
npm install
npx expo install --fix
```

### Build Fails: "Out of memory"

**Solution:** Increase heap size in `eas.json`:
```json
{
  "build": {
    "production": {
      "android": {
        "gradleCommand": ":app:assembleRelease -Dorg.gradle.jvmargs=-Xmx4g"
      }
    }
  }
}
```

### Local Build Fails: "Android SDK not found"

**Solution:** Set ANDROID_HOME:
```bash
export ANDROID_HOME=$HOME/Library/Android/sdk
# Add to ~/.zshrc or ~/.bashrc for persistence
```

### APK Won't Install: "App not installed"

**Possible causes:**
1. **Existing app with different signature**
   - Uninstall old app first
   - Or use different applicationId

2. **Min SDK version mismatch**
   - Check device Android version
   - Update minSdkVersion in app.config.js

3. **Unknown sources disabled**
   - Settings → Security → Unknown sources → Enable

### Cloud Build Stuck in Queue

**Solution:**
- Upgrade to paid EAS plan (priority queue)
- OR use local builds
- OR wait (free tier has shared queue)

---

## Advanced: Custom Build Configuration

### Change Build Type (APK vs AAB)

**Edit eas.json:**
```json
{
  "build": {
    "production": {
      "android": {
        "buildType": "app-bundle"  // For Play Store
        // OR
        "buildType": "apk"         // For direct download
      }
    }
  }
}
```

### Add Build Environment Variables

```json
{
  "build": {
    "production": {
      "env": {
        "EXPO_PUBLIC_API_URL": "https://api.mention.earth",
        "EXPO_PUBLIC_ENV": "production"
      }
    }
  }
}
```

### Custom Gradle Commands

```json
{
  "build": {
    "production": {
      "android": {
        "gradleCommand": ":app:assembleRelease --no-daemon"
      }
    }
  }
}
```

---

## Distribution

### Option 1: Google Play Store (Official)

1. Build AAB (not APK):
```bash
# Update eas.json to buildType: "app-bundle"
npm run build:android
```

2. Download AAB from EAS

3. Upload to Play Console:
   - https://play.google.com/console
   - Create release → Upload AAB

### Option 2: Direct Download (Beta/Testing)

1. Build APK:
```bash
npm run build:apk:cloud
```

2. Share download link from EAS dashboard

3. Users install directly (requires "Unknown sources" enabled)

### Option 3: Internal Testing (Team)

1. Build with `preview` profile:
```bash
npm run build:preview
```

2. Share EAS build link with team

3. Team installs via Expo Go or direct APK

---

## EAS Build Quotas

### Free Tier
- 30 builds/month (iOS + Android combined)
- Shared queue (slower)
- Public source code only

### Paid Plans
- Production: Unlimited builds
- Priority queue
- Private repos
- Team collaboration

**Check your quota:**
```bash
eas build:list
```

**Upgrade:**
```bash
# Visit: https://expo.dev/accounts/oxyhq/settings/billing
```

---

## Quick Reference

```bash
# Install EAS CLI
npm install -g eas-cli

# Login
eas login

# Build APK locally (fastest)
cd packages/frontend && npm run build:apk

# Build APK in cloud
cd packages/frontend && npm run build:apk:cloud

# Build for Play Store (AAB)
cd packages/frontend && npm run build:android

# Check build status
eas build:list

# Download build
eas build:download <build-id>

# Install APK on device
adb install build-*.apk
```

---

## Support

- **EAS Documentation:** https://docs.expo.dev/build/introduction/
- **Build Troubleshooting:** https://docs.expo.dev/build-reference/troubleshooting/
- **Expo Forums:** https://forums.expo.dev

---

**Ready to build!** 🚀

Run `npm run build:apk` to create your first APK.
