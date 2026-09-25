/**
 * Messaging a person happens in ALLO, Oxy's messaging app, not in Mention.
 *
 * Mention has no direct messages of its own (#1140). The profile's envelope
 * button used to push `/ai?userId=…`, which rendered the Alia assistant and
 * ignored both params; this module is what it does instead.
 *
 * WHERE IN ALLO. Allo's `/c/:id` takes a conversation id OR an Oxy account id:
 * an id it does not know as a conversation is treated as an account, a direct
 * conversation with that person is created (idempotent on Allo's server) and
 * the route is replaced with the conversation's own id
 * (`Allo/packages/frontend/app/(chat)/c/[id]/index.tsx`). That lands the reader
 * IN the chat, one step shorter than Allo's `/@handle` profile, whose "Message"
 * button pushes the same `/c/:id`. It is keyed by id rather than handle because
 * Allo's `/c/` resolves no handles, and a handle can change under a link.
 *
 * WHICH URL. Two, and the choice between them is deliberate:
 *
 * - `allo://c/<id>` on native. The custom scheme is the only link that reaches
 *   the installed app today: `allo.chat`, the https host Allo's Android intent
 *   filter claims, does not resolve in DNS (measured 2026-09-25), and
 *   `allo.you`, where the web app IS served, publishes no `assetlinks.json` or
 *   apple-app-site-association and is in no intent filter. An https link would
 *   therefore always open the browser, installed app or not.
 * - `https://allo.you/c/<id>` on web, and as the native fallback.
 *
 * NO `canOpenURL`. Asking first needs a `<queries>` entry on Android 11+ and
 * `LSApplicationQueriesSchemes` on iOS, and still races an install. Instead the
 * app link is simply opened: `Linking.openURL` REJECTS when no app handles the
 * scheme (Android: `ActivityNotFoundException`; iOS: the completion handler
 * reports failure), and that rejection is the "Allo is not installed" signal.
 * Package visibility does not restrict `startActivity` for an implicit intent,
 * so nothing has to be declared for this to work.
 *
 * Everything here is free of React and of Bloom so it can be unit-tested; the
 * profile binds it to `Linking`, the in-app browser and the action menu.
 */

import { ALLO_APP_STORE_URL, ALLO_PLAY_STORE_URL } from '@/config';

/** Where Allo is listed, per platform (`EXPO_PUBLIC_ALLO_*_STORE_URL`). */
export interface AlloStoreListings {
  ios: string | undefined;
  android: string | undefined;
}

/** The origin that serves Allo's web app (`Allo/packages/frontend/wrangler.toml`). */
export const ALLO_WEB_ORIGIN = 'https://allo.you';

/** Allo's custom URL scheme (`scheme` in `Allo/packages/frontend/app.config.js`). */
export const ALLO_APP_SCHEME = 'allo';

/**
 * An Oxy account id as it may appear in a path segment. Both shapes Oxy issues
 * (uuid v7, and the 24-hex ObjectId the Mongo backfill kept) fit; anything that
 * could escape the segment (`/`, `?`, `#`, `%`, whitespace) does not, so a
 * malformed id yields no link rather than one that opens some other screen.
 */
const ACCOUNT_ID = /^[A-Za-z0-9_-]+$/;

export interface AlloDirectMessageLinks {
  /** Opens the installed app straight into the conversation. */
  app: string;
  /** The same conversation in Allo's web app. */
  web: string;
}

/**
 * The links that open a direct conversation with `oxyUserId` in Allo, or `null`
 * when the id cannot address one.
 */
export function alloDirectMessageLinks(
  oxyUserId: string | null | undefined,
): AlloDirectMessageLinks | null {
  if (typeof oxyUserId !== 'string') return null;
  const id = oxyUserId.trim();
  if (!ACCOUNT_ID.test(id)) return null;
  return {
    app: `${ALLO_APP_SCHEME}://c/${id}`,
    web: `${ALLO_WEB_ORIGIN}/c/${id}`,
  };
}

/**
 * Where to get Allo on this platform, or `undefined` where no listing is
 * configured.
 *
 * Allo has no store listing as of this writing (`com.allo.app` is 404 on Google
 * Play, `com.allo.ios` has no App Store record), so these are env-provided and
 * never hardcoded — the same arrangement `@oxy.so/services` uses for "Get
 * Commons" (`commonsStoreLinks`). Once Allo ships, setting the variable turns
 * the "Get Allo" option on with no code change; until then a reader without the
 * app goes straight to the web app. Only an https URL is accepted, so a
 * misconfigured value cannot become a scheme the OS hands to something else.
 * The variables are read in `config.ts`, the one place the app reads the env.
 */
export function getAlloStoreUrl(
  platformOS: string,
  listings: AlloStoreListings = { ios: ALLO_APP_STORE_URL, android: ALLO_PLAY_STORE_URL },
): string | undefined {
  const candidate =
    platformOS === 'ios' ? listings.ios : platformOS === 'android' ? listings.android : undefined;
  const url = candidate?.trim();
  return url && url.startsWith('https://') ? url : undefined;
}

/** What `openAlloDirectMessage` did, for the caller and the tests. */
export type AlloOpenOutcome =
  /** The id could not address a conversation; nothing was opened. */
  | 'invalid'
  /** Web: Allo's web app opened in a new tab. */
  | 'web'
  /** Native: the installed app took the link. */
  | 'app'
  /** Native, no app: the reader was offered the store or the web app. */
  | 'offered'
  /** Native, no app and no store listing: Allo's web app opened in the browser. */
  | 'browser';

export interface OpenAlloDirectMessageDeps {
  /** `Platform.OS`. */
  platformOS: string;
  /** Hands a URL to the OS; rejects when nothing handles it (`Linking.openURL`). */
  openAppUrl: (url: string) => Promise<unknown>;
  /** Opens an https URL in the browser (`openExternalLink`). */
  openWebUrl: (url: string) => Promise<void>;
  /** From `getAlloStoreUrl`; the install offer is made only when present. */
  storeUrl?: string;
  /** Presents "Get Allo" / "Open Allo on the web" to the reader. */
  offerInstall: (choice: { storeUrl: string; webUrl: string }) => void;
}

/**
 * Open a direct conversation with `oxyUserId` in Allo: the web app in a new tab
 * on web; on native, the installed app, or — when it is not installed — an offer
 * to get it or to continue on the web, or the web app itself when there is
 * nothing to install from.
 */
export async function openAlloDirectMessage(
  oxyUserId: string | null | undefined,
  deps: OpenAlloDirectMessageDeps,
): Promise<AlloOpenOutcome> {
  const links = alloDirectMessageLinks(oxyUserId);
  if (links === null) return 'invalid';

  if (deps.platformOS === 'web') {
    await deps.openWebUrl(links.web);
    return 'web';
  }

  try {
    await deps.openAppUrl(links.app);
    return 'app';
  } catch {
    // No app handles `allo://` — Allo is not installed. Fall through.
  }

  if (deps.storeUrl) {
    deps.offerInstall({ storeUrl: deps.storeUrl, webUrl: links.web });
    return 'offered';
  }

  await deps.openWebUrl(links.web);
  return 'browser';
}
