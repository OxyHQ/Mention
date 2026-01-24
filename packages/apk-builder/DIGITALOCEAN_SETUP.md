# DigitalOcean App Platform Setup Guide

Complete guide for deploying the APK/AAB builder on DigitalOcean with automated Play Store publishing.

## Prerequisites

Before starting, ensure you have:
- [ ] DigitalOcean account
- [ ] Android signing keystore (see main README)
- [ ] Google Play Developer account ($25 one-time fee)
- [ ] Google Cloud Platform project

## Step 1: Set Up Google Play Store Access

### 1.1 Create Google Cloud Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Enable the **Google Play Android Developer API**:
   - Navigate to "APIs & Services" → "Library"
   - Search for "Google Play Android Developer API"
   - Click "Enable"

### 1.2 Create Service Account

1. Go to "IAM & Admin" → "Service Accounts"
2. Click "Create Service Account"
3. Fill in details:
   - **Name**: `play-store-uploader`
   - **Description**: `Service account for automated Play Store uploads`
4. Click "Create and Continue"
5. Grant role: **Service Account User**
6. Click "Done"

### 1.3 Generate JSON Key

1. Click on the newly created service account
2. Go to "Keys" tab
3. Click "Add Key" → "Create new key"
4. Select **JSON** format
5. Click "Create" (file downloads automatically)
6. **Save this file securely!**

### 1.4 Grant Play Console Access

1. Go to [Google Play Console](https://play.google.com/console/)
2. Select your app (or create it if it doesn't exist)
3. Go to "Users and permissions" (in left sidebar)
4. Click "Invite new users"
5. Enter the service account email (found in the JSON file: `client_email`)
6. Grant permissions:
   - **Recommended**: Release manager (can upload and manage releases)
   - **Alternative**: Admin (full access)
7. Click "Invite user"

### 1.5 Encode Service Account for DigitalOcean

```bash
# Encode the JSON file to base64
base64 -w 0 path/to/service-account.json > service-account.base64.txt

# On macOS, use:
base64 -i path/to/service-account.json -o service-account.base64.txt

# Copy the contents
cat service-account.base64.txt
```

## Step 2: Encode Android Keystore

If you haven't already:

```bash
# Encode your keystore
base64 -w 0 mention-release.keystore > keystore.base64.txt

# On macOS, use:
base64 -i mention-release.keystore -o keystore.base64.txt

# Copy the contents
cat keystore.base64.txt
```

## Step 3: Deploy to DigitalOcean

### Option A: Using the Dashboard (Recommended)

1. Go to [DigitalOcean App Platform](https://cloud.digitalocean.com/apps)
2. Click **"Create App"**
3. **Source**: Connect your GitHub repository
   - Repository: `YourOrg/Mention`
   - Branch: `master`
4. **Resources**:
   - Type: Web Service
   - Dockerfile Path: `packages/apk-builder/Dockerfile`
   - Build Context: `/` (root of repository)
5. **Instance Size**:
   - **Professional M** (4GB RAM) - Minimum required for Android builds
6. Click **"Next"** → **"Environment Variables"**

### Option B: Using doctl CLI

```bash
# Install doctl
brew install doctl  # macOS
# or snap install doctl  # Linux

# Authenticate
doctl auth init

# Deploy (after updating .do/app.yaml with your settings)
doctl apps create --spec packages/apk-builder/.do/app.yaml
```

## Step 4: Configure Environment Variables

In the DigitalOcean App Platform dashboard, add these environment variables:

### Required Variables

| Variable | Value | Type | Description |
|----------|-------|------|-------------|
| `NODE_ENV` | `production` | Plain | Node environment |
| `EXPO_PUBLIC_ENV` | `production` | Plain | Expo environment |
| `API_URL` | `https://api.mention.earth` | Plain | Your API URL |

### Android Signing (Required for Release Builds)

| Variable | Value | Type | Description |
|----------|-------|------|-------------|
| `KEYSTORE_BASE64` | Contents of `keystore.base64.txt` | **Secret** | Encoded keystore file |
| `KEYSTORE_PASSWORD` | Your keystore password | **Secret** | Keystore password |
| `KEY_ALIAS` | `mention` | **Secret** | Key alias |
| `KEY_PASSWORD` | Your key password | **Secret** | Key password |

### Play Store Auto-Publishing (Optional)

| Variable | Value | Type | Description |
|----------|-------|------|-------------|
| `AUTO_PUBLISH_TO_PLAYSTORE` | `true` | Plain | Enable auto-publish |
| `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` | Contents of `service-account.base64.txt` | **Secret** | Service account credentials |
| `PACKAGE_NAME` | `com.mention.earth` | Plain | Your Android package name |
| `TRACK` | `internal` | Plain | Release track (internal/alpha/beta/production) |
| `RELEASE_NOTES` | `Automated build from CI/CD` | Plain | Optional release notes |

### How to Add Variables

1. In DigitalOcean dashboard, go to your app
2. Click **"Settings"** → **"App-Level Environment Variables"**
3. Click **"Edit"**
4. For each variable:
   - Click **"Add Variable"**
   - Enter variable name and value
   - Select **"Encrypt"** for secrets (passwords, keys, credentials)
   - Click **"Save"**
5. Click **"Save"** at the bottom

**Important**: Use "Encrypt" checkbox for all sensitive values!

## Step 5: Deploy and Monitor

### Trigger Deployment

1. **Automatic**: Push to `master` branch
   ```bash
   git push origin master
   ```

2. **Manual**: In DigitalOcean dashboard
   - Go to your app
   - Click **"Actions"** → **"Force Rebuild and Deploy"**

### Monitor Build Progress

1. Go to **"Activity"** tab in DigitalOcean dashboard
2. Click on the latest deployment
3. View **"Build Logs"** to see:
   - Dependency installation
   - Android project generation
   - APK/AAB building
   - (Optional) Play Store upload

### Expected Build Times

- **First build**: 20-30 minutes (downloads Android SDK)
- **Subsequent builds**: 5-15 minutes (cached dependencies)

### Check Build Success

```bash
# Check health endpoint
curl https://your-app.ondigitalocean.app/health

# Get build info
curl https://your-app.ondigitalocean.app/build-info

# Download APK
curl -O https://your-app.ondigitalocean.app/android-latest-apk

# Download AAB
curl -O https://your-app.ondigitalocean.app/android-latest-aab
```

## Step 6: Configure Custom Domain (Optional)

### Add Domain in DigitalOcean

1. Go to your app → **"Settings"** → **"Domains"**
2. Click **"Add Domain"**
3. Enter your domain: `builds.mention.earth`
4. Follow DNS configuration instructions

### Update DNS Records

Add CNAME record in your DNS provider:

```
Type: CNAME
Name: builds
Value: your-app.ondigitalocean.app
TTL: 3600
```

### Alternative: Subdomain Routing

If you want to serve builds from `mention.earth/android-latest-apk`:

1. Set up a reverse proxy on your main server
2. Proxy requests to DigitalOcean app URL

## Automated Publishing Workflow

### What Happens on Every Build

1. Developer pushes code to `master`
2. GitHub webhook triggers DigitalOcean rebuild
3. DigitalOcean builds Docker container
4. Build script runs:
   - Installs dependencies
   - Builds shared-types
   - Runs expo prebuild
   - Builds APK + AAB
5. **If** `AUTO_PUBLISH_TO_PLAYSTORE=true`:
   - Uploads AAB to Play Store
   - Publishes to specified track
   - Testers receive update notification
6. Express server starts serving builds

### Release Tracks

Choose the appropriate track for your needs:

- **internal** (recommended for CI/CD)
  - Up to 100 internal testers
  - Instant availability
  - No review process
  - Perfect for team testing

- **alpha**
  - Limited testers (set in Play Console)
  - Instant availability
  - No review process

- **beta**
  - Larger audience (open or closed beta)
  - Instant availability
  - No review process

- **production**
  - Public release
  - Google review required (1-3 days)
  - Rollout percentage control
  - Use manually for releases, not CI/CD

## Troubleshooting

### Build Fails: Out of Memory

**Problem**: Build exits with OOM error

**Solution**:
- Ensure instance size is **Professional M** (4GB RAM)
- DO NOT use Basic instance (insufficient RAM)

### Play Store Upload Fails: Authentication Error

**Problem**: 401 or 403 error during upload

**Solution**:
1. Verify `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` is correctly encoded
2. Check service account email has permissions in Play Console
3. Ensure Google Play Android Developer API is enabled

### Play Store Upload Fails: Version Code Exists

**Problem**: "Version code already exists" error

**Solution**:
1. Increment version code in `packages/frontend/app.config.js`:
   ```javascript
   android: {
     versionCode: 2, // Increment this
   }
   ```
2. Commit and push changes

### App Uploaded but Not Visible

**Problem**: Upload succeeds but testers can't see the app

**Solution**:
1. Go to Play Console → **Testing** → **Internal testing**
2. Click **"Testers"** tab
3. Create email list or opt-in URL
4. Share opt-in URL with testers

### Build Takes Too Long / Timeout

**Problem**: Build exceeds 30 minutes

**Solution**:
- First build is always slow (downloads SDK)
- Subsequent builds should be 5-15 minutes
- If still slow, check build logs for issues

## Security Best Practices

- ✅ **Never** commit keystore or service account JSON to Git
- ✅ Always use "Encrypt" for sensitive environment variables
- ✅ Use `internal` or `beta` track for automated CI/CD
- ✅ Use `production` track only for manual releases
- ✅ Rotate keystore and service account credentials annually
- ✅ Limit service account permissions to minimum required
- ✅ Monitor build logs for exposed secrets

## Cost Estimation

| Resource | Cost |
|----------|------|
| DigitalOcean App Platform (Professional M) | ~$36/month |
| Outbound bandwidth (APK downloads) | $0.01/GB |
| Google Play Developer account | $25 one-time |
| **Total monthly** | **~$36-40/month** |

## Next Steps

1. ✅ Deploy to DigitalOcean
2. ✅ Verify builds are working
3. ✅ Test APK download
4. ✅ Test AAB download
5. ✅ Enable auto-publish (optional)
6. ✅ Add internal testers to Play Console
7. ✅ Test Play Store distribution
8. ✅ Share opt-in URL with team

## Support

Having issues? Check:
- Build logs in DigitalOcean Activity tab
- [Main README](README.md) for detailed documentation
- [GitHub Issues](https://github.com/mention/mention/issues)
