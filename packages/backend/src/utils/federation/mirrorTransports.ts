import { FEDERATION_NETWORKS, upstreamProfileUrl } from '@oxy.so/federation';
import { scanTextEntities, trimUrlTrailingPunctuation } from '@mention/shared-types/textEntities';

/**
 * Hosts that republish another network's accounts so Mention can read a network
 * it cannot reach directly (`bird.makeup` carries X, `kilogram.makeup` carries
 * Instagram). The host is how a post ARRIVED, never something a reader should
 * meet: an account is `@elonmusk@x.com`, and a link to it is a link to x.com.
 *
 * Each entry says which network the host mirrors and how that network spells a
 * post URL, because the mirror's status id IS the upstream id only on some of
 * them (a tweet id; an Instagram shortcode). A shape that cannot be derived is
 * left alone rather than guessed. `bsky.brid.gy` is read by `./bridgy`, not here.
 *
 * THE one list of mirror hosts in Mention: the repost gate and the Instagram
 * source-key reader derive theirs from it, so a new mirror is added here once.
 */
interface Mirror {
  network: 'x' | 'instagram';
  /** The upstream URL of one post, from the mirror's handle and status id. */
  postUrl?: (handle: string, statusId: string) => string;
}

const MIRRORS: Readonly<Record<string, Mirror>> = {
  'bird.makeup': {
    network: 'x',
    postUrl: (handle, id) => `${profileOf('x', handle)}/status/${id}`,
  },
  'mastox.eu': { network: 'x' },
  'kilogram.makeup': {
    network: 'instagram',
    postUrl: (_handle, shortcode) =>
      `https://${FEDERATION_NETWORKS.instagram.profileHosts[0]}/p/${shortcode}`,
  },
};

/** The hosts that republish `network`, or every mirror host when none is given. */
export function mirrorHosts(network?: Mirror['network']): string[] {
  return Object.entries(MIRRORS)
    .filter(([, mirror]) => !network || mirror.network === network)
    .map(([host]) => host);
}

function profileOf(network: Mirror['network'], handle: string): string {
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
  if (first === 'users' && third === 'statuses' && fourth && mirror.postUrl) {
    return mirror.postUrl(handle, fourth);
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
