/**
 * Expo Config Plugin: withMentionWidgets
 *
 * Points the Android home-screen widgets at the right backend.
 *
 * A widget runs OUTSIDE the JS runtime — it can be placed on the home screen
 * before the app has ever been opened, and its refresh worker runs while the app
 * is dead — so it cannot read `config.ts`. Its endpoints are Android string
 * resources instead, declared with production defaults in the module's own
 * `res/values/config.xml` and `res/values/config_posts.xml`.
 *
 * This plugin writes the same three resource names into the APP module's strings.
 * App resources take priority over a library dependency's at merge time, so that
 * is all it takes to repoint a development or staging build; a production build
 * passes no options and the module's own defaults stand.
 *
 * All THREE have to be repointable together, not just the two that address our own
 * backend. A build pointed at a development API still resolves avatars against the
 * media origin, and a file id that exists on a dev backend does not exist on the
 * production CDN — so repointing `apiBaseUrl` alone yields a widget whose text is
 * from one environment and whose pictures are broken. The media origin is also half
 * of the trending-posts widget's download allowlist (`PostsImageCache`), so leaving
 * it behind would silently refuse the dev host's images too.
 *
 * The native module itself is autolinked from `modules/` like any local Expo
 * module — this plugin exists only for the configuration above.
 *
 * `android/` is gitignored (CNG), so this lands at the next prebuild / EAS
 * build. It does NOT ship over OTA.
 */

const { withStringsXml, AndroidConfig } = require('expo/config-plugins');

const API_BASE_URL_RESOURCE = 'mention_widget_api_base_url';
const WEB_BASE_URL_RESOURCE = 'mention_widget_web_base_url';
const MEDIA_BASE_URL_RESOURCE = 'mention_widget_media_base_url';

/**
 * Reject anything that is not an absolute http(s) origin.
 *
 * The value is concatenated with a path and handed to `URL(...)` in Kotlin and
 * to `Intent.ACTION_VIEW` on tap, so a relative or malformed one does not fail
 * at build time — it fails on a user's home screen, where it looks like a broken
 * widget rather than a misconfigured build. A trailing slash is tolerated
 * because the Kotlin side trims one, but nothing else is.
 */
function assertBaseUrl(option, value) {
  if (typeof value !== 'string' || value.trim() !== value || value === '') {
    throw new Error(
      `withMentionWidgets: \`${option}\` must be a non-empty URL with no surrounding whitespace, got ${JSON.stringify(value)}.`,
    );
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`withMentionWidgets: \`${option}\` must be an absolute URL, got ${JSON.stringify(value)}.`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(
      `withMentionWidgets: \`${option}\` must use http or https, got ${JSON.stringify(parsed.protocol)}.`,
    );
  }

  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error(
      `withMentionWidgets: \`${option}\` must be a bare origin with no path, query or fragment, got ${JSON.stringify(value)}.`,
    );
  }
}

module.exports = function withMentionWidgets(config, options = {}) {
  const overrides = [];

  if (options.apiBaseUrl !== undefined) {
    assertBaseUrl('apiBaseUrl', options.apiBaseUrl);
    overrides.push([API_BASE_URL_RESOURCE, options.apiBaseUrl]);
  }

  if (options.webBaseUrl !== undefined) {
    assertBaseUrl('webBaseUrl', options.webBaseUrl);
    overrides.push([WEB_BASE_URL_RESOURCE, options.webBaseUrl]);
  }

  if (options.mediaBaseUrl !== undefined) {
    assertBaseUrl('mediaBaseUrl', options.mediaBaseUrl);
    overrides.push([MEDIA_BASE_URL_RESOURCE, options.mediaBaseUrl]);
  }

  if (overrides.length === 0) {
    return config;
  }

  return withStringsXml(config, (config) => {
    for (const [name, value] of overrides) {
      config.modResults = AndroidConfig.Strings.setStringItem(
        [AndroidConfig.Resources.buildResourceItem({ name, value, translatable: false })],
        config.modResults,
      );
    }
    return config;
  });
};

// Exported for the unit tests, which cover the validation above — a bad origin
// has to fail the build rather than ship.
module.exports.assertBaseUrl = assertBaseUrl;
