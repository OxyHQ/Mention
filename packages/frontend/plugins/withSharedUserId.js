/**
 * Expo Config Plugin: withSharedUserId
 *
 * Adds android:sharedUserId to AndroidManifest.xml to enable
 * cross-app data sharing between Oxy apps (Mention, Homiio, etc.)
 *
 * This allows:
 * - Shared cryptographic identity storage
 * - Cross-app authentication (sign in once, use everywhere)
 * - Shared session tokens
 *
 * IMPORTANT:
 * - All Oxy apps MUST use the same sharedUserId: "so.oxy.shared"
 * - Apps MUST be signed with the same certificate
 * - Cannot change sharedUserId after publishing (requires reinstall)
 *
 * @see https://developer.android.com/guide/topics/manifest/manifest-element#uid
 */

const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withSharedUserId(config) {
  return withAndroidManifest(config, async (config) => {
    const androidManifest = config.modResults.manifest;

    // Add sharedUserId to the manifest root element
    androidManifest.$ = {
      ...androidManifest.$,
      'android:sharedUserId': 'so.oxy.shared'
    };

    return config;
  });
};
