#!/usr/bin/env node

/**
 * Google Play Store Upload Script
 *
 * Uploads AAB files to Google Play Console using the Google Play Developer API
 *
 * Environment Variables Required:
 * - GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: Base64-encoded service account JSON key
 * - PACKAGE_NAME: Android package name (e.g., com.mention.earth)
 * - TRACK: Release track (internal, alpha, beta, production)
 * - AAB_PATH: Path to AAB file (defaults to outputs/mention-latest.aab)
 * - RELEASE_NOTES: Optional release notes for this version
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Configuration
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.mention.earth';
const TRACK = process.env.TRACK || 'internal';
const AAB_PATH = process.env.AAB_PATH || path.join(__dirname, 'outputs', 'mention-latest.aab');
const RELEASE_NOTES = process.env.RELEASE_NOTES || 'Automated build from CI/CD pipeline';

async function uploadToPlayStore() {
  console.log('========================================');
  console.log('Google Play Store Upload');
  console.log('========================================');
  console.log(`Package: ${PACKAGE_NAME}`);
  console.log(`Track: ${TRACK}`);
  console.log(`AAB: ${AAB_PATH}`);
  console.log('========================================\n');

  try {
    // Step 1: Validate environment variables
    console.log('[1/6] Validating configuration...');
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 environment variable is required');
    }

    // Step 2: Decode service account credentials
    console.log('[2/6] Decoding service account credentials...');
    const serviceAccountJson = Buffer.from(
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64,
      'base64'
    ).toString('utf8');
    const credentials = JSON.parse(serviceAccountJson);
    console.log(`✓ Service account: ${credentials.client_email}`);

    // Step 3: Authenticate with Google Play API
    console.log('[3/6] Authenticating with Google Play API...');
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    const authClient = await auth.getClient();
    const androidPublisher = google.androidpublisher({
      version: 'v3',
      auth: authClient,
    });
    console.log('✓ Authentication successful');

    // Step 4: Create a new edit
    console.log('[4/6] Creating new edit session...');
    const editResponse = await androidPublisher.edits.insert({
      packageName: PACKAGE_NAME,
    });
    const editId = editResponse.data.id;
    console.log(`✓ Edit created: ${editId}`);

    // Step 5: Upload AAB
    console.log('[5/6] Uploading AAB file...');
    if (!fs.existsSync(AAB_PATH)) {
      throw new Error(`AAB file not found at: ${AAB_PATH}`);
    }

    const fileStats = fs.statSync(AAB_PATH);
    const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2);
    console.log(`  - File size: ${fileSizeMB}MB`);

    const uploadResponse = await androidPublisher.edits.bundles.upload({
      packageName: PACKAGE_NAME,
      editId: editId,
      media: {
        mimeType: 'application/octet-stream',
        body: fs.createReadStream(AAB_PATH),
      },
    });

    const versionCode = uploadResponse.data.versionCode;
    console.log(`✓ AAB uploaded successfully (Version Code: ${versionCode})`);

    // Step 6: Assign to track and commit
    console.log('[6/6] Assigning to track and committing...');

    // Update track with new version
    await androidPublisher.edits.tracks.update({
      packageName: PACKAGE_NAME,
      editId: editId,
      track: TRACK,
      requestBody: {
        track: TRACK,
        releases: [
          {
            versionCodes: [versionCode.toString()],
            status: 'completed',
            releaseNotes: [
              {
                language: 'en-US',
                text: RELEASE_NOTES,
              },
            ],
          },
        ],
      },
    });

    // Commit the edit
    const commitResponse = await androidPublisher.edits.commit({
      packageName: PACKAGE_NAME,
      editId: editId,
    });

    console.log(`✓ Changes committed successfully`);
    console.log('');
    console.log('========================================');
    console.log('Upload Complete!');
    console.log('========================================');
    console.log(`Version Code: ${versionCode}`);
    console.log(`Track: ${TRACK}`);
    console.log(`Edit ID: ${commitResponse.data.id}`);
    console.log('========================================');
    console.log('');
    console.log(`Your app is now available on the ${TRACK} track.`);
    console.log('It may take a few hours to process and become available for testing.');
    console.log('');

    return {
      success: true,
      versionCode,
      track: TRACK,
      editId: commitResponse.data.id,
    };
  } catch (error) {
    console.error('');
    console.error('========================================');
    console.error('Upload Failed!');
    console.error('========================================');
    console.error('Error:', error.message);

    if (error.response?.data?.error) {
      console.error('API Error:', JSON.stringify(error.response.data.error, null, 2));
    }

    console.error('========================================');
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  uploadToPlayStore()
    .then(() => {
      console.log('✓ Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('✗ Script failed:', error.message);
      process.exit(1);
    });
}

module.exports = { uploadToPlayStore };
