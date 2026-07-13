/**
 * Config plugin: withSharedIdentityReader (reader RPs — Mention, etc.).
 *
 * Reader apps do NOT host the shared identity — they only READ it from the
 * Commons-hosted `OxyIdentityProvider` to enable silent "Sign in with Oxy".
 * This plugin wires the minimal Android side of `@oxyhq/expo-oxy-identity`:
 *
 *  - Requests the `signature`-level permission `so.oxy.shared.permission.READ_IDENTITY`
 *    (defined by Commons). Because it is `signature`, it is only granted when
 *    this app is signed with the SAME certificate as Commons (the shared Oxy
 *    release keystore) — that is the entire trust boundary.
 *  - Adds a `<queries>` entry for the Commons provider authorities so
 *    package-visibility filtering (Android 11+) never hides the provider from
 *    `ContentResolver.call`.
 *
 * The provider itself is declared only in Commons (`withSharedIdentityProvider`).
 */
const { withAndroidManifest } = require('@expo/config-plugins');

const READ_IDENTITY_PERMISSION = 'so.oxy.shared.permission.READ_IDENTITY';
const PROVIDER_AUTHORITIES = ['so.oxy.commons.identity', 'so.oxy.commons.dev.identity'];

module.exports = function withSharedIdentityReader(config) {
  return withAndroidManifest(config, (modConfig) => {
    const manifest = modConfig.modResults.manifest;

    manifest['uses-permission'] = manifest['uses-permission'] ?? [];
    if (!manifest['uses-permission'].some((p) => p.$['android:name'] === READ_IDENTITY_PERMISSION)) {
      manifest['uses-permission'].push({ $: { 'android:name': READ_IDENTITY_PERMISSION } });
    }

    manifest['queries'] = manifest['queries'] ?? [];
    if (manifest['queries'].length === 0) {
      manifest['queries'].push({});
    }
    const queries = manifest['queries'][0];
    queries.provider = queries.provider ?? [];
    for (const authority of PROVIDER_AUTHORITIES) {
      if (!queries.provider.some((p) => p.$['android:authorities'] === authority)) {
        queries.provider.push({ $: { 'android:authorities': authority } });
      }
    }

    return modConfig;
  });
};
