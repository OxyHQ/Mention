import { FEDERATION_NETWORKS, upstreamProfileUrl } from '@oxy.so/federation';
import { scanTextEntities, trimUrlTrailingPunctuation } from '@mention/shared-types/textEntities';

/**
 * Hosts that republish another network's accounts so Mention can read a network
 * it cannot reach directly (`bird.makeup` carries X, `kilogram.makeup` carries
 * Instagram). The host is how a post ARRIVED, never something a reader should
 * meet: an account is `@elonmusk@x.com`, and a link to it is a link to x.com.
 *
 * Each entry says which network the host mirrors and, when the mirror's status
 * id IS the network's own post id (a tweet id; an Instagram shortcode), what such
 * an id looks like and how the network spells its URL. That id is what makes one
 * upstream post reached through several transports ONE post here (the upstream
 * post key, `connectors/shared/upstreamPostKey.ts`). A mirror without it is
 * KEYLESS: nothing in its posts names the upstream post, so it is read only for
 * history the keyed transports never delivered
 * (`connectors/activitypub/keylessTransport.ts`, `docs/federated-transports.md`). `bsky.brid.gy` is read by `./bridgy`, not here.
 *
 * THE one list of mirror hosts in Mention: the repost gate, the upstream post
 * key and the keyless-transport rule derive theirs from it, so a new mirror is
 * added here once.
 */
export type MirroredNetwork = 'x' | 'instagram';

interface Mirror {
  network: MirroredNetwork;
  /** Present when the mirror's status id is the upstream post id. */
  post?: {
    /** What an upstream post id looks like; anything else is not one. */
    id: RegExp;
    /** The upstream URL of one post, from the mirror's handle and the post id. */
    url: (handle: string, id: string) => string;
  };
}

const MIRRORS: Readonly<Record<string, Mirror>> = {
  'bird.makeup': {
    network: 'x',
    post: { id: /^\d{1,20}$/, url: (handle, id) => `${profileOf('x', handle)}/status/${id}` },
  },
  // A stock Mastodon: its status ids are its own, and nothing in a post names
  // the tweet it copies.
  'mastox.eu': { network: 'x' },
  'kilogram.makeup': {
    network: 'instagram',
    // Instagram's case-sensitive shortcode alphabet, length-bounded so junk
    // cannot become a key.
    post: {
      id: /^[A-Za-z0-9_-]{5,64}$/,
      url: (_handle, shortcode) =>
        `https://${FEDERATION_NETWORKS.instagram.profileHosts[0]}/p/${shortcode}`,
    },
  },
};

/** The hosts that republish `network`, or every mirror host when none is given. */
export function mirrorHosts(network?: MirroredNetwork): string[] {
  return Object.entries(MIRRORS)
    .filter(([, mirror]) => !network || mirror.network === network)
    .map(([host]) => host);
}

/** The mirror hosts of `network` whose posts carry the upstream post id. */
export function keyedMirrorHosts(network: MirroredNetwork): string[] {
  return Object.entries(MIRRORS)
    .filter(([, mirror]) => mirror.network === network && mirror.post)
    .map(([host]) => host);
}

/** The network a KEYLESS mirror host republishes, or undefined for any other host. */
export function keylessMirrorNetwork(host: string): MirroredNetwork | undefined {
  const mirror = mirrorOf(host.trim().toLowerCase());
  return mirror && !mirror.post ? mirror.network : undefined;
}

/**
 * `<network>:<post id>` for a keyed mirror's Note id
 * (`https://bird.makeup/users/<handle>/statuses/<tweet id>` → `x:<tweet id>`), or
 * undefined for every other URI — a keyless mirror, another path shape, a query
 * or fragment, or an id that is not the network's.
 */
export function mirrorPostKey(objectUri: string): string | undefined {
  let url: URL;
  try {
    url = new URL(objectUri);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.search || url.hash) return undefined;
  const mirror = mirrorOf(url.hostname.toLowerCase());
  if (!mirror?.post) return undefined;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 4 || segments[0] !== 'users' || segments[2] !== 'statuses')
    return undefined;
  return mirror.post.id.test(segments[3]) ? `${mirror.network}:${segments[3]}` : undefined;
}

function profileOf(network: MirroredNetwork, handle: string): string {
  return upstreamProfileUrl(FEDERATION_NETWORKS[network], handle);
}

function mirrorOf(host: string): Mirror | undefined {
  return Object.hasOwn(MIRRORS, host) ? MIRRORS[host] : undefined;
}

/** The identity domain (`x.com`) of the network a mirror host republishes, if it is one. */
export function mirroredNetworkDomain(host: string): string | undefined {
  const mirror = mirrorOf(host.trim().toLowerCase());
  return mirror ? FEDERATION_NETWORKS[mirror.network].domain : undefined;
}

/**
 * The upstream URL a mirror URL stands for — the account page or the post — or
 * `undefined` when the URL is not on a mirror or names something with no
 * upstream form (a mirror's own pages, or a post id that is not the upstream's).
 */
export function networkUrlOf(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  const mirror = mirrorOf(url.hostname.toLowerCase());
  if (!mirror) return undefined;

  const [first, second, third, fourth, ...rest] = url.pathname.split('/').filter(Boolean);
  if (rest.length > 0) return undefined;
  const handle = first?.startsWith('@') ? first.slice(1) : first === 'users' ? second : undefined;
  if (!handle || /[^A-Za-z0-9_.-]/.test(handle)) return undefined;

  const isAccountPath = first === 'users' ? third === undefined : second === undefined;
  if (isAccountPath) return profileOf(mirror.network, handle);
  if (first === 'users' && third === 'statuses' && fourth && mirror.post?.id.test(fourth)) {
    return mirror.post.url(handle, fourth);
  }
  return undefined;
}

/** A mention kept as a link to its source profile, spelled with the account on the real network. */
function mirrorMentionLink(entity: {
  value: string;
  label?: string;
  raw: string;
}): string | undefined {
  const upstream = /^https?:\/\//i.test(entity.value) ? networkUrlOf(entity.value) : undefined;
  if (!upstream || !entity.label) return undefined;
  const label = entity.label.replace(/@([^@]+)$/, (whole, host: string) => {
    const domain = mirroredNetworkDomain(host);
    return domain ? `@${domain}` : whole;
  });
  return `[@${label}](${upstream.replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
}

/**
 * `text` with every mirror URL in it replaced by its upstream URL, and every
 * mention kept as a mirror profile link rewritten to the account it republishes.
 * Pure.
 */
export function rewriteMirrorUrls(text: string): string {
  let out = '';
  let cursor = 0;
  for (const entity of scanTextEntities(text, { kinds: ['url', 'mentionDisplay'] })) {
    let replacement: string | undefined;
    let end = entity.end;
    if (entity.kind === 'mentionDisplay') {
      replacement = mirrorMentionLink(entity);
    } else {
      const { url } = trimUrlTrailingPunctuation(entity.value);
      replacement = url ? networkUrlOf(url) : undefined;
      end = entity.start + url.length;
    }
    if (!replacement) continue;
    out += `${text.slice(cursor, entity.start)}${replacement}`;
    cursor = end;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}
