# Mention APK Builder

Automated Android APK build service for the Mention app. This service builds signed APKs automatically on every push to master and serves them via a simple HTTP endpoint.

## Overview

This service runs on DigitalOcean App Platform and provides:
- Automatic APK builds on GitHub push
- Production-ready signed APK generation
- Simple download endpoint at `/android-latest-apk`
- Build metadata API at `/build-info`
- Health monitoring at `/health`

## Architecture

```
GitHub Push → DigitalOcean → Docker Build → Expo Prebuild → Gradle → Signed APK → Express Server
```

**Build Process:**
1. Install dependencies (monorepo-aware)
2. Build shared-types package
3. Run `expo prebuild` to generate Android project
4. Configure APK signing (if credentials provided)
5. Build APK with Gradle
6. Serve via Express server

## Prerequisites

- DigitalOcean account
- GitHub repository
- Android keystore for signing (optional but recommended)

## Setup Instructions

### 1. Generate Android Keystore (First Time Only)

```bash
# Generate a new keystore
keytool -genkey -v -keystore mention-release.keystore \
  -alias mention \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000

# Follow prompts to set passwords and information
# IMPORTANT: Save the passwords securely!
```

### 2. Encode Keystore to Base64

```bash
# Encode keystore to base64
base64 mention-release.keystore > keystore.base64.txt

# The contents of this file will be used as KEYSTORE_BASE64 env var
```

### 3. Deploy to DigitalOcean

#### Option A: Using DigitalOcean Dashboard

1. Go to [DigitalOcean App Platform](https://cloud.digitalocean.com/apps)
2. Click "Create App"
3. Select your GitHub repository
4. Choose "Dockerfile" as build method
5. Set Dockerfile path: `packages/apk-builder/Dockerfile`
6. Set instance size: Professional-M (4GB RAM minimum)
7. Configure environment variables (see below)
8. Deploy

#### Option B: Using App Spec YAML

```bash
# Deploy using the app.yaml configuration
doctl apps create --spec packages/apk-builder/.do/app.yaml
```

### 4. Configure Environment Variables

In DigitalOcean dashboard, add these environment variables:

**Required:**
- `NODE_ENV`: `production`
- `EXPO_PUBLIC_ENV`: `production`
- `API_URL`: `https://api.mention.earth`

**For Signed APKs (Secrets):**
- `KEYSTORE_BASE64`: Contents of keystore.base64.txt
- `KEYSTORE_PASSWORD`: Your keystore password
- `KEY_ALIAS`: Your key alias (e.g., "mention")
- `KEY_PASSWORD`: Your key password

### 5. Update GitHub Repository Reference

Edit `.do/app.yaml` and update:
```yaml
github:
  repo: YOUR_GITHUB_ORG/Mention  # Update this line
```

### 6. Configure Domain (Optional)

Point your domain to the app:
1. In DigitalOcean, go to App → Settings → Domains
2. Add custom domain: `builds.mention.earth` or configure routing at `mention.earth/android-latest-apk`

## Usage

### Download Latest APK

```bash
# Direct download
curl -O https://mention.earth/android-latest-apk

# Or visit in browser
open https://mention.earth/android-latest-apk
```

### Get Build Information

```bash
curl https://mention.earth/build-info
```

Response:
```json
{
  "version": "1.0.0",
  "buildDate": "2026-01-24T12:00:00Z",
  "gitHash": "abc1234",
  "size": 52428800,
  "sizeMB": 50,
  "buildType": "signed release",
  "platform": "android",
  "package": "com.mention.earth",
  "apkAvailable": true,
  "downloadUrl": "/android-latest-apk"
}
```

### Health Check

```bash
curl https://mention.earth/health
```

## Local Development

### Test Build Locally

```bash
# Build Docker image
cd packages/apk-builder
docker build -t mention-apk-builder -f Dockerfile ../..

# Run container (without signing)
docker run -p 8080:8080 mention-apk-builder

# Run with signing
docker run -p 8080:8080 \
  -e KEYSTORE_BASE64="$(cat keystore.base64.txt)" \
  -e KEYSTORE_PASSWORD="your-password" \
  -e KEY_ALIAS="mention" \
  -e KEY_PASSWORD="your-key-password" \
  mention-apk-builder

# Access locally
curl http://localhost:8080/health
curl -O http://localhost:8080/android-latest-apk
```

### Verify APK

```bash
# Check APK details
aapt dump badging mention-latest.apk | grep package

# Verify signature
jarsigner -verify -verbose -certs mention-latest.apk

# Install on device
adb install mention-latest.apk
```

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | API information |
| `/android-latest-apk` | GET | Download latest APK |
| `/build-info` | GET | Build metadata (JSON) |
| `/health` | GET | Health check status |

## Monitoring

### View Build Logs

```bash
# Using doctl CLI
doctl apps logs <app-id> --follow

# Or view in DigitalOcean dashboard
# App → Activity → Logs
```

### Check Build Status

```bash
# Monitor health
watch -n 10 curl -s https://mention.earth/health | jq

# Check build info
curl https://mention.earth/build-info | jq
```

## Troubleshooting

### Build Fails with OOM Error

**Problem:** Gradle runs out of memory
**Solution:**
- Ensure instance size is Professional-M (4GB RAM) or higher
- Check GRADLE_OPTS is set to `-Xmx2048m -Dorg.gradle.daemon=false`

### Build Takes Too Long

**Problem:** Build timeout after 30 minutes
**Solution:**
- First build takes 20-30 min (Android SDK download)
- Subsequent builds should be 5-15 min
- Check DigitalOcean logs for progress

### APK Not Signed

**Problem:** APK is debug build, not signed
**Solution:**
- Ensure all keystore environment variables are set
- Verify KEYSTORE_BASE64 is correctly encoded
- Check build logs for signing errors

### expo prebuild Fails

**Problem:** Android project generation fails
**Solution:**
- Verify app.config.js is valid
- Ensure google-services.json exists in repo root
- Check Node version is 20.x

## File Structure

```
packages/apk-builder/
├── Dockerfile              # Multi-stage Docker build
├── build-apk.sh            # Build orchestration script
├── server.js               # Express server
├── package.json            # Node dependencies
├── .dockerignore           # Docker build exclusions
├── .do/
│   └── app.yaml            # DigitalOcean configuration
├── scripts/
│   └── install-android-sdk.sh  # SDK installation helper
├── outputs/                # Built APKs stored here
│   ├── mention-latest.apk
│   └── build-info.json
└── README.md               # This file
```

## Cost Estimation

- **DigitalOcean App Platform:** ~$36/month (Professional-M instance)
- **Build Time:** 5-15 minutes per deploy
- **Bandwidth:** Pay-as-you-go for APK downloads
- **Total:** ~$36-50/month

## Security Considerations

- Never commit keystore files to Git
- Store keystore passwords as encrypted secrets in DigitalOcean
- Use signed APKs for production distribution
- Limit access to build server endpoints
- Regularly rotate keystore credentials

## CI/CD Flow

1. Developer pushes code to `master` branch
2. GitHub webhook triggers DigitalOcean deployment
3. DigitalOcean rebuilds Docker container
4. Build script generates new APK
5. Express server starts serving new APK
6. Users download latest version from public URL

## Future Enhancements

- [ ] Webhook authentication for manual triggers
- [ ] Build queue for concurrent builds
- [ ] Slack/Discord notifications
- [ ] Version history storage (DigitalOcean Spaces)
- [ ] QR code generation for mobile downloads
- [ ] Build status badges
- [ ] Download analytics

## Support

For issues or questions:
- Check DigitalOcean build logs
- Review Dockerfile and build script
- Verify environment variables are set correctly
- Test build locally with Docker

## License

ISC
