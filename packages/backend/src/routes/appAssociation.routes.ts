/**
 * The two documents that let the native apps own `https://mention.earth/...`
 * links: Android App Links (`/.well-known/assetlinks.json`) and iOS Universal
 * Links (`/.well-known/apple-app-site-association`).
 *
 * They are served HERE, by the backend, because `mention.earth` resolves to this
 * process and `/.well-known/*` is the backend's namespace (docs/AWS_DEPLOYMENT.md).
 * Before this router existed nothing claimed these two paths, so they fell through
 * to the apex proxy and the shell Worker answered with its SPA fallback:
 * `200 text/html`, which neither Android nor iOS accepts, and every Mention link
 * opened in the browser. `app.ts` now also ends `/.well-known` with a 404, so a
 * missing document can never again masquerade as the SPA.
 *
 * Both verifiers require the document at exactly this path, with no redirect and
 * a JSON body. `__tests__/appAssociation.test.ts` pins the ids below to
 * `packages/frontend/app.config.js`, so renaming the app cannot silently break
 * verification.
 */
import express from 'express';

/** `android.package` / `ios.bundleIdentifier` of the production app. */
export const MENTION_APP_ID = 'earth.mention.app';

/**
 * SHA-256 fingerprints of every certificate a production Android build of
 * Mention can be signed with.
 *
 * - The Oxy ecosystem release key (`CN=Oxy, OU=Oxy Ecosystem`, alias `oxy`,
 *   `~/.config/oxy/oxy-ecosystem-release.keystore`). Every app sharing
 *   `android:sharedUserId="so.oxy.shared"` MUST be signed with it
 *   (`plugins/withAndroidReleaseBuild.js`), so it is both the upload key and the
 *   key a directly-installed release APK carries.
 *
 * NOT listed, deliberately:
 *
 * - The Google Play app-signing key. Mention is not yet published on Play, so
 *   none has been read from Play Console. When Play App Signing is enabled, add
 *   its fingerprint (Play Console -> Test and release -> App integrity) here, or
 *   every Play-installed copy fails verification.
 * - `FA:C6:17:45:...:3B:9C`, the React Native template DEBUG keystore
 *   (`CN=Android Debug`, password `android`). Its private key ships inside
 *   countless npm packages, so trusting it would let anyone sign an
 *   `earth.mention.app` that owns our links. A build made without the
 *   `OXY_UPLOAD_*` Gradle properties falls back to that key and will never
 *   verify, by design.
 */
export const ANDROID_SIGNING_CERT_SHA256 = [
  'B8:AB:37:46:46:6C:E4:56:9D:7A:6A:0F:FA:1E:ED:91:BC:37:51:74:D5:03:61:39:87:CA:09:CB:33:D6:A5:8D',
] as const;

/**
 * Apple Developer Team ID that signs the iOS app. It appears nowhere in this
 * repository, EAS config or the App Store (Mention is not listed yet), and a
 * guessed value would publish a wrong association, so it is `null` until it is
 * read from the Apple Developer account (Membership details). While it is
 * `null` the AASA answers 404 JSON instead of a document that cannot verify.
 */
export const APPLE_TEAM_ID: string | null = null;

/**
 * Paths an iOS Universal Link may open in the app, first match wins. The
 * exclusions are the backend's own non-app surfaces on the apex (federation,
 * bridges, media, OAuth handshakes a browser must complete); everything else on
 * `mention.earth` is an app route, the same set the Android `autoVerify` intent
 * filter claims.
 */
export const APPLE_APP_LINK_COMPONENTS = [
  { '/': '/.well-known/*', exclude: true },
  { '/': '/ap/*', exclude: true },
  { '/': '/ap-bridge/*', exclude: true },
  { '/': '/xrpc/*', exclude: true },
  { '/': '/nodeinfo/*', exclude: true },
  { '/': '/media/*', exclude: true },
  { '/': '/mcp/*', exclude: true },
  { '/': '/oauth/*', exclude: true },
  { '/': '/*' },
] as const;

export function buildAssetLinks() {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: MENTION_APP_ID,
        sha256_cert_fingerprints: [...ANDROID_SIGNING_CERT_SHA256],
      },
    },
  ];
}

export function buildAppleAppSiteAssociation(teamId: string | null = APPLE_TEAM_ID) {
  if (!teamId) return null;
  return {
    applinks: {
      details: [
        {
          appIDs: [`${teamId}.${MENTION_APP_ID}`],
          components: APPLE_APP_LINK_COMPONENTS,
        },
      ],
    },
  };
}

/** Verifiers re-fetch on their own schedule; an hour keeps a key rotation quick. */
const CACHE_CONTROL = 'public, max-age=3600';

export function createAppAssociationRouter(
  teamId: string | null = APPLE_TEAM_ID,
): express.Router {
  const router = express.Router();
  const assetLinks = buildAssetLinks();
  const aasa = buildAppleAppSiteAssociation(teamId);

  router.get('/.well-known/assetlinks.json', (_req, res) => {
    res.setHeader('Cache-Control', CACHE_CONTROL);
    res.json(assetLinks);
  });

  router.get('/.well-known/apple-app-site-association', (_req, res) => {
    if (!aasa) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.setHeader('Cache-Control', CACHE_CONTROL);
    res.json(aasa);
  });

  return router;
}

/**
 * Terminal handler for `/.well-known`. Mounted after every router that serves a
 * well-known document, so an unknown one is a JSON 404 rather than a fall
 * through to the apex SPA proxy, which answers `200 text/html` for any path.
 */
export const wellKnownNotFound: express.RequestHandler = (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(404).json({ error: 'Not found' });
};
