#!/bin/bash
set -e  # Exit on error

echo "========================================="
echo "Starting Mention APK Build Process"
echo "========================================="

# Set environment variables
export EAS_BUILD_PLATFORM=android
export EXPO_PUBLIC_ENV=${EXPO_PUBLIC_ENV:-production}
export API_URL=${API_URL:-https://api.mention.earth}
export NODE_OPTIONS="--max-old-space-size=4096"

echo "Environment:"
echo "  - EXPO_PUBLIC_ENV: $EXPO_PUBLIC_ENV"
echo "  - API_URL: $API_URL"
echo "  - Node: $(node --version)"
echo "  - npm: $(npm --version)"
echo ""

# Navigate to repo root
cd /app

echo "[1/8] Building shared-types package..."
npm run build --workspace=@mention/shared-types
echo "✓ shared-types built successfully"
echo ""

echo "[2/8] Installing frontend dependencies..."
cd packages/frontend
npm install
echo "✓ Frontend dependencies installed"
echo ""

echo "[3/8] Running expo prebuild to generate Android project..."
npx expo prebuild --platform android --clean
echo "✓ Android project generated"
echo ""

echo "[4/8] Copying google-services.json..."
if [ -f "../../google-services.json" ]; then
    cp ../../google-services.json android/app/google-services.json
    echo "✓ google-services.json copied to android/app/"
else
    echo "⚠ Warning: google-services.json not found at repo root"
fi
echo ""

echo "[5/8] Configuring APK signing..."
# Create signing configuration if keystore credentials are provided
if [ -n "$KEYSTORE_BASE64" ]; then
    echo "Decoding keystore from environment variable..."
    echo "$KEYSTORE_BASE64" | base64 -d > /tmp/release.keystore

    # Inject signing config into build.gradle
    cat >> android/app/build.gradle << 'EOF'

android {
    signingConfigs {
        release {
            storeFile file('/tmp/release.keystore')
            storePassword System.getenv('KEYSTORE_PASSWORD')
            keyAlias System.getenv('KEY_ALIAS')
            keyPassword System.getenv('KEY_PASSWORD')
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
}
EOF
    echo "✓ Signing configuration added"
    BUILD_TYPE="signed release"
else
    echo "⚠ No keystore provided - building unsigned debug APK"
    echo "  To build signed APK, provide: KEYSTORE_BASE64, KEYSTORE_PASSWORD, KEY_ALIAS, KEY_PASSWORD"
    BUILD_TYPE="unsigned debug"
fi
echo ""

echo "[6/8] Building APK ($BUILD_TYPE)..."
cd android
chmod +x gradlew

# Build based on whether signing is configured
if [ -n "$KEYSTORE_BASE64" ]; then
    ./gradlew assembleRelease --no-daemon --stacktrace
    APK_SOURCE="app/build/outputs/apk/release/app-release.apk"
else
    ./gradlew assembleDebug --no-daemon --stacktrace
    APK_SOURCE="app/build/outputs/apk/debug/app-debug.apk"
fi

echo "✓ APK built successfully"
echo ""

echo "[7/8] Copying APK to outputs directory..."
mkdir -p /app/outputs
cp "$APK_SOURCE" /app/outputs/mention-latest.apk

# Get APK size
APK_SIZE=$(stat -c%s "/app/outputs/mention-latest.apk" 2>/dev/null || echo "unknown")
APK_SIZE_MB=$((APK_SIZE / 1024 / 1024))
echo "✓ APK copied to /app/outputs/mention-latest.apk (${APK_SIZE_MB}MB)"
echo ""

echo "[8/8] Generating build metadata..."
# Extract version from package.json
VERSION=$(node -p "require('/app/packages/frontend/package.json').version" 2>/dev/null || echo "unknown")

# Get git hash if available
GIT_HASH=$(cd /app && git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Create build info JSON
cat > /app/outputs/build-info.json << EOF
{
  "version": "$VERSION",
  "buildDate": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "gitHash": "$GIT_HASH",
  "size": $APK_SIZE,
  "sizeMB": $APK_SIZE_MB,
  "buildType": "$BUILD_TYPE",
  "platform": "android",
  "package": "com.mention.earth"
}
EOF

echo "✓ Build metadata generated"
echo ""

echo "========================================="
echo "Build Complete!"
echo "========================================="
echo "APK Location: /app/outputs/mention-latest.apk"
echo "Size: ${APK_SIZE_MB}MB"
echo "Version: $VERSION"
echo "Git Hash: $GIT_HASH"
echo "Build Type: $BUILD_TYPE"
echo "========================================="

# Display build info
cat /app/outputs/build-info.json
