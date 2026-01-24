# ======================================
# Stage 1: Builder - Full build environment
# ======================================
FROM ubuntu:22.04 AS builder

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Set environment variables for build
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH=$PATH:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/build-tools/35.0.0
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV NODE_VERSION=20
ENV GRADLE_OPTS="-Xmx2048m -Dorg.gradle.daemon=false"
ENV GRADLE_USER_HOME=/root/.gradle

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    unzip \
    git \
    openjdk-17-jdk \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g npm@latest

# Install Android SDK Command Line Tools
RUN mkdir -p ${ANDROID_SDK_ROOT}/cmdline-tools && \
    cd ${ANDROID_SDK_ROOT}/cmdline-tools && \
    wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip && \
    unzip commandlinetools-linux-11076708_latest.zip && \
    mv cmdline-tools latest && \
    rm commandlinetools-linux-11076708_latest.zip

# Accept Android SDK licenses and install required components
RUN yes | sdkmanager --licenses && \
    sdkmanager --install \
    "platform-tools" \
    "platforms;android-35" \
    "build-tools;35.0.0" \
    "cmdline-tools;latest" && \
    sdkmanager --update

# Verify installations
RUN node --version && \
    npm --version && \
    java -version && \
    which sdkmanager

# Set working directory
WORKDIR /app

# Copy package files for dependency installation (leverage Docker cache)
COPY package.json package-lock.json* ./
COPY packages/apk-builder/package.json ./packages/apk-builder/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/backend/package.json ./packages/backend/

# Install all dependencies (monorepo)
RUN npm install --include=dev

# Copy entire monorepo
COPY . .

# Copy build script and make it executable
COPY packages/apk-builder/build-apk.sh /app/build-apk.sh
RUN chmod +x /app/build-apk.sh

# Run the build script
RUN /app/build-apk.sh

# ======================================
# Stage 2: Runtime - Lightweight server
# ======================================
FROM node:20-slim

WORKDIR /app

# Copy only necessary files from builder
COPY --from=builder /app/outputs /app/outputs
COPY --from=builder /app/packages/apk-builder/server.js /app/server.js
COPY --from=builder /app/packages/apk-builder/package.json /app/package.json

# Install only production dependencies
RUN npm install --production

# Create a non-root user for security
RUN useradd -m -u 1001 apkserver && \
    chown -R apkserver:apkserver /app
USER apkserver

# Expose the server port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=300s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start the Express server
CMD ["node", "server.js"]
