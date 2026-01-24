# Building Mention

Quick commands for building the Mention app.

## Build APK (Android)

```bash
# Build locally (fastest, free)
npm run build:apk

# Build in cloud (signed, ready to distribute)
npm run build:apk:cloud

# Build for Play Store (AAB format)
npm run build:android
```

## Build iOS

```bash
npm run build:ios
```

## Build Web

```bash
npm run build-web
```

---

## First Time Setup

1. Install EAS CLI:
```bash
npm install -g eas-cli
```

2. Login to Expo:
```bash
eas login
```

3. Update native config:
```bash
npx expo prebuild --clean
```

4. Build:
```bash
npm run build:apk
```

---

## Full Documentation

See [BUILD_APK_GUIDE.md](../../BUILD_APK_GUIDE.md) for complete instructions.

## Authentication Setup

See [EXPO_54_AUTH_GUIDE.md](../../EXPO_54_AUTH_GUIDE.md) for authentication configuration.
