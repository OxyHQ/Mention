# Mention APK/AAB Builder

Automated Android build service for the Mention app. This service builds both APK (for direct distribution) and AAB (for Google Play Store) files automatically on every push to master, serves them via HTTP endpoints, and can optionally publish to Google Play Store.

## Overview

This service runs on DigitalOcean App Platform and provides:
- Automatic APK + AAB builds on GitHub push
- Production-ready signed builds (APK for sideloading, AAB for Play Store)
- Download endpoints at `/android-latest-apk` and `/android-latest-aab`
- Optional automated uploads to Google Play Console
- Build metadata API at `/build-info`
- Health monitoring at `/health`

## Architecture

```
GitHub Push → DigitalOcean → Docker Build → Expo Prebuild → Gradle → Signed APK + AAB → Express Server → (Optional) Play Store
```

**Build Process:**
1. Install dependencies (monorepo-aware)
2. Build shared-types package
3. Run `expo prebuild` to generate Android project
4. Configure signing (if credentials provided)
5. Build both APK and AAB with Gradle
6. Serve via Express server
7. (Optional) Upload AAB to Google Play Store

## Prerequisites

- DigitalOcean account
- GitHub repository
- Android keystore for signing (required for production)
- Google Play Developer account (optional, for automated publishing)
- Google Cloud service account (optional, for automated publishing)

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

### 4. Set Up Google Play Store Publishing (Optional)

If you want to automatically publish to Play Store:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable "Google Play Android Developer API"
4. Create a service account:
   - Go to IAM & Admin → Service Accounts
   - Create service account with name "play-store-uploader"
   - Grant "Service Account User" role
   - Create JSON key and download it
5. In [Google Play Console](https://play.google.com/console/):
   - Go to Users and permissions
   - Invite the service account email
   - Grant "Release manager" or "Admin" role
6. Encode the service account JSON:
```bash
base64 service-account.json > service-account.base64.txt
```

### 5. Configure Environment Variables

In DigitalOcean dashboard, add these environment variables:

**Required:**
- `NODE_ENV`: `production`
- `EXPO_PUBLIC_ENV`: `production`
- `API_URL`: `https://api.mention.earth`

**For Signed Builds (Secrets - Required for Production):**
- `KEYSTORE_BASE64`: Contents of keystore.base64.txt
- `KEYSTORE_PASSWORD`: Your keystore password
- `KEY_ALIAS`: Your key alias (e.g., "mention")
- `KEY_PASSWORD`: Your key password

**For Play Store Publishing (Optional):**
- `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`: Contents of service-account.base64.txt
- `PACKAGE_NAME`: `com.mention.earth` (your app's package name)
- `TRACK`: `internal` (or `alpha`, `beta`, `production`)
- `RELEASE_NOTES`: Optional custom release notes

### 6. Update GitHub Repository Reference

Edit `.do/app.yaml` and update:
```yaml
github:
  repo: YOUR_GITHUB_ORG/Mention  # Update this line
```

### 7. Configure Domain (Optional)

Point your domain to the app:
1. In DigitalOcean, go to App → Settings → Domains
2. Add custom domain: `builds.mention.earth` or configure routing at `mention.earth/android-latest-apk`

## Usage

### Download Latest APK (For Sideloading)

```bash
# Direct download
curl -O https://mention.earth/android-latest-apk

# Or visit in browser
open https://mention.earth/android-latest-apk
```

### Download Latest AAB (For Play Store Upload)

```bash
# Direct download
curl -O https://mention.earth/android-latest-aab

# Or visit in browser
open https://mention.earth/android-latest-aab
```

### Publish to Google Play Store

```bash
# Install dependencies first
npm install --workspace=@mention/apk-builder

# Publish to internal testing track
npm run publish:internal --workspace=@mention/apk-builder

# Or publish to other tracks
npm run publish:alpha --workspace=@mention/apk-builder
npm run publish:beta --workspace=@mention/apk-builder
npm run publish:production --workspace=@mention/apk-builder
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
  "apk": {
    "size": 52428800,
    "sizeMB": 50,
    "path": "/app/outputs/mention-latest.apk"
  },
  "aab": {
    "size": 48234567,
    "sizeMB": 46,
    "path": "/app/outputs/mention-latest.aab"
  },
  "buildType": "signed release",
  "platform": "android",
  "package": "com.mention.earth",
  "apkAvailable": true,
  "aabAvailable": true,
  "downloadUrls": {
    "apk": "/android-latest-apk",
    "aab": "/android-latest-aab"
  }
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
| `/android-latest-apk` | GET | Download latest APK (for sideloading) |
| `/android-latest-aab` | GET | Download latest AAB (for Play Store) |
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

## Play Store Publishing Workflow

### Automated Publishing on Every Build

To automatically publish to Play Store on every build:

1. Set environment variables in DigitalOcean:
   - `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`
   - `TRACK=internal` (or desired track)
2. Update build script or add post-build hook to run upload
3. Monitor DigitalOcean logs for upload status

### Manual Publishing

```bash
# Download AAB from build server
curl -O https://mention.earth/android-latest-aab

# Upload manually to Play Console
# Or use the upload script:
GOOGLE_SERVICE_ACCOUNT_JSON_BASE64="..." \
TRACK=beta \
AAB_PATH=./mention-latest.aab \
node packages/apk-builder/upload-to-playstore.js
```

### Release Tracks Explained

- **internal**: For internal testing (up to 100 testers, instant distribution)
- **alpha**: For alpha testing (limited testers, instant distribution)
- **beta**: For beta testing (larger audience, instant distribution)
- **production**: For public release (requires review, 1-3 days to rollout)

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

### Builds Not Signed

**Problem:** APK/AAB are debug builds, not signed
**Solution:**
- Ensure all keystore environment variables are set
- Verify KEYSTORE_BASE64 is correctly encoded
- Check build logs for signing errors

### Play Store Upload Fails

**Problem:** Upload to Play Store fails with authentication error
**Solution:**
- Verify GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is correctly encoded
- Ensure service account has proper permissions in Play Console
- Check that the Google Play Android Developer API is enabled

**Problem:** Upload fails with "Version already exists"
**Solution:**
- Increment version code in app.config.js or package.json
- Each upload requires a unique version code

**Problem:** Upload succeeds but app not visible
**Solution:**
- Apps on internal/alpha/beta tracks require opt-in testers
- Go to Play Console → Testing → Track → Manage testers
- Add testers or create opt-in URL

### expo prebuild Fails

**Problem:** Android project generation fails
**Solution:**
- Verify app.config.js is valid
- Ensure google-services.json exists in repo root
- Check Node version is 20.x

## File Structure

```
packages/apk-builder/
├── Dockerfile                 # Multi-stage Docker build
├── build-apk.sh               # Build orchestration script (builds APK + AAB)
├── server.js                  # Express server (serves APK + AAB)
├── upload-to-playstore.js     # Play Store upload automation
├── package.json               # Node dependencies
├── .dockerignore              # Docker build exclusions
├── .do/
│   └── app.yaml               # DigitalOcean configuration
├── scripts/
│   └── install-android-sdk.sh # SDK installation helper
├── outputs/                   # Built artifacts stored here
│   ├── mention-latest.apk     # APK for sideloading
│   ├── mention-latest.aab     # AAB for Play Store
│   └── build-info.json        # Build metadata
└── README.md                  # This file
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

### Without Auto-Publishing

1. Developer pushes code to `master` branch
2. GitHub webhook triggers DigitalOcean deployment
3. DigitalOcean rebuilds Docker container
4. Build script generates new APK + AAB
5. Express server starts serving new builds
6. Users download latest version from public URL
7. Manually publish AAB to Play Store when ready

### With Auto-Publishing

1. Developer pushes code to `master` branch
2. GitHub webhook triggers DigitalOcean deployment
3. DigitalOcean rebuilds Docker container
4. Build script generates new APK + AAB
5. Upload script automatically publishes AAB to Play Store
6. Express server starts serving new builds
7. Internal/beta testers receive update automatically

## Key Differences: APK vs AAB

| Feature | APK | AAB |
|---------|-----|-----|
| **Use Case** | Direct distribution, sideloading | Google Play Store only |
| **File Size** | Larger (contains all resources) | Smaller (optimized per device) |
| **Google Play** | Not accepted for new apps | Required for all apps |
| **Distribution** | Can install directly on device | Must go through Play Store |
| **Optimization** | One-size-fits-all | Device-specific APKs generated |
| **Endpoint** | `/android-latest-apk` | `/android-latest-aab` |

## Future Enhancements

- [x] AAB build support
- [x] Google Play Store automated publishing
- [ ] Webhook authentication for manual triggers
- [ ] Build queue for concurrent builds
- [ ] Slack/Discord notifications for successful uploads
- [ ] Version history storage (DigitalOcean Spaces)
- [ ] QR code generation for mobile downloads
- [ ] Build status badges
- [ ] Download analytics
- [ ] Automated rollout percentage control
- [ ] Screenshot/metadata updates via API

## Support

For issues or questions:
- Check DigitalOcean build logs
- Review Dockerfile and build script
- Verify environment variables are set correctly
- Test build locally with Docker

## License

ISC
