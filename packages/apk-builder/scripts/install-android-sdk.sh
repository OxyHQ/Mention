#!/bin/bash
# Helper script to install Android SDK
# This is primarily for documentation - the Dockerfile handles SDK installation

set -e

ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT:-/opt/android-sdk}
ANDROID_COMPILE_SDK=${ANDROID_COMPILE_SDK:-35}
ANDROID_BUILD_TOOLS=${ANDROID_BUILD_TOOLS:-35.0.0}

echo "Installing Android SDK..."
echo "  - SDK Root: $ANDROID_SDK_ROOT"
echo "  - Compile SDK: $ANDROID_COMPILE_SDK"
echo "  - Build Tools: $ANDROID_BUILD_TOOLS"

# Create SDK directory
mkdir -p ${ANDROID_SDK_ROOT}/cmdline-tools

# Download Command Line Tools
cd ${ANDROID_SDK_ROOT}/cmdline-tools
wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
unzip -q commandlinetools-linux-11076708_latest.zip
mv cmdline-tools latest
rm commandlinetools-linux-11076708_latest.zip

# Add to PATH
export PATH=$PATH:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools

# Accept licenses and install components
yes | sdkmanager --licenses

sdkmanager --install \
  "platform-tools" \
  "platforms;android-${ANDROID_COMPILE_SDK}" \
  "build-tools;${ANDROID_BUILD_TOOLS}" \
  "cmdline-tools;latest"

# Update SDK
sdkmanager --update

echo "Android SDK installed successfully!"
echo "  - Platform Tools: $(which adb)"
echo "  - SDK Manager: $(which sdkmanager)"
