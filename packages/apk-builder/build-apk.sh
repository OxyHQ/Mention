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

echo "[6/8] Building APK and AAB ($BUILD_TYPE)..."
cd android
chmod +x gradlew

# Build based on whether signing is configured
if [ -n "$KEYSTORE_BASE64" ]; then
    echo "Building signed release APK and AAB..."
    ./gradlew assembleRelease bundleRelease --no-daemon --stacktrace
    APK_SOURCE="app/build/outputs/apk/release/app-release.apk"
    AAB_SOURCE="app/build/outputs/bundle/release/app-release.aab"
else
    echo "Building unsigned debug APK and AAB..."
    ./gradlew assembleDebug bundleDebug --no-daemon --stacktrace
    APK_SOURCE="app/build/outputs/apk/debug/app-debug.apk"
    AAB_SOURCE="app/build/outputs/bundle/debug/app-debug.aab"
fi

echo "✓ APK and AAB built successfully"
echo ""

echo "[7/8] Copying APK and AAB to outputs directory..."
mkdir -p /app/outputs

# Copy APK
cp "$APK_SOURCE" /app/outputs/mention-latest.apk
APK_SIZE=$(stat -c%s "/app/outputs/mention-latest.apk" 2>/dev/null || echo "0")
APK_SIZE_MB=$((APK_SIZE / 1024 / 1024))
echo "✓ APK copied to /app/outputs/mention-latest.apk (${APK_SIZE_MB}MB)"

# Copy AAB
cp "$AAB_SOURCE" /app/outputs/mention-latest.aab
AAB_SIZE=$(stat -c%s "/app/outputs/mention-latest.aab" 2>/dev/null || echo "0")
AAB_SIZE_MB=$((AAB_SIZE / 1024 / 1024))
echo "✓ AAB copied to /app/outputs/mention-latest.aab (${AAB_SIZE_MB}MB)"
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
  "apk": {
    "size": $APK_SIZE,
    "sizeMB": $APK_SIZE_MB,
    "path": "/app/outputs/mention-latest.apk"
  },
  "aab": {
    "size": $AAB_SIZE,
    "sizeMB": $AAB_SIZE_MB,
    "path": "/app/outputs/mention-latest.aab"
  },
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
echo "APK Size: ${APK_SIZE_MB}MB"
echo "AAB Location: /app/outputs/mention-latest.aab"
echo "AAB Size: ${AAB_SIZE_MB}MB"
echo "Version: $VERSION"
echo "Git Hash: $GIT_HASH"
echo "Build Type: $BUILD_TYPE"
echo "========================================="

# Display build info
cat /app/outputs/build-info.json

# ======================================
# Optional: Upload to Google Play Store
# ======================================
if [ "$AUTO_PUBLISH_TO_PLAYSTORE" = "true" ]; then
    echo ""
    echo "========================================="
    echo "Auto-Publishing to Google Play Store"
    echo "========================================="

    # Check if we have the required credentials
    if [ -z "$GOOGLE_SERVICE_ACCOUNT_JSON_BASE64" ]; then
        echo "⚠ Warning: AUTO_PUBLISH_TO_PLAYSTORE is enabled but GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is not set"
        echo "⚠ Skipping Play Store upload"
        echo "========================================="
    else
        # Navigate to apk-builder directory
        cd /app/packages/apk-builder

        # Set default track if not specified
        export TRACK=${TRACK:-internal}
        export PACKAGE_NAME=${PACKAGE_NAME:-com.mention.earth}
        export AAB_PATH=${AAB_PATH:-/app/outputs/mention-latest.aab}

        echo "Publishing to track: $TRACK"
        echo "Package: $PACKAGE_NAME"

        # Run the upload script
        node upload-to-playstore.js

        if [ $? -eq 0 ]; then
            echo "✓ Successfully published to Play Store ($TRACK track)"
        else
            echo "✗ Failed to publish to Play Store"
            echo "⚠ Build artifacts are still available for manual upload"
        fi

        echo "========================================="
    fi
else
    echo ""
    echo "ℹ Auto-publish to Play Store: DISABLED"
    echo "  To enable, set AUTO_PUBLISH_TO_PLAYSTORE=true"
    echo "  Manual publish: npm run publish:internal --workspace=@mention/apk-builder"
fi
